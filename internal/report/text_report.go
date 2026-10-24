package report

import (
	"bufio"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

type textWriter struct {
	w     *bufio.Writer
	m     *model.Model
	o     TextOptions
	stats []analyze.StmtStats
	rank  map[model.ID]int // statement -> rank number in the listing
	loc   *time.Location
}

func writeText(out io.Writer, m *model.Model, o TextOptions) error {
	if o.Width < 80 {
		o.Width = 120
	}
	t := &textWriter{w: bufio.NewWriter(out), m: m, o: o, stats: analyze.Statements(m), rank: map[model.ID]int{}, loc: zone(m)}
	t.header()
	t.files()
	t.traceProfile()
	order := t.ranking()
	t.findings()
	for i, sid := range order {
		t.statement(i+1, sid)
	}
	t.sessions()
	t.timeBuckets()
	t.footer()
	return t.w.Flush()
}

// ---- formatting helpers ---------------------------------------------------

func secs(us int64) string { return fmt.Sprintf("%.3f", float64(us)/1e6) }
func ms(us float64) string { return fmt.Sprintf("%.3f", us/1e3) }

func commas(n int64) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := fmt.Sprint(n)
	if len(s) > 3 {
		var b strings.Builder
		pre := len(s) % 3
		if pre > 0 {
			b.WriteString(s[:pre])
		}
		for i := pre; i < len(s); i += 3 {
			if b.Len() > 0 {
				b.WriteByte(',')
			}
			b.WriteString(s[i : i+3])
		}
		s = b.String()
	}
	if neg {
		return "-" + s
	}
	return s
}

func pct(part, total int64) string {
	if total <= 0 {
		return "   -  "
	}
	return fmt.Sprintf("%5.1f%%", 100*float64(part)/float64(total))
}

// zone returns the time zone the trace file was written in.
func zone(m *model.Model) *time.Location {
	for _, mk := range m.Markers {
		if mk.HasTime {
			return mk.Time.Location()
		}
	}
	return time.UTC
}

func (t *textWriter) wall(us int64) string {
	if us == 0 {
		return "-"
	}
	return time.UnixMicro(us).In(t.loc).Format("2006-01-02 15:04:05.000")
}

func (t *textWriter) wallZ(us int64) string {
	if us == 0 {
		return "-"
	}
	return time.UnixMicro(us).In(t.loc).Format("2006-01-02 15:04:05.000 -07:00")
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// preview collapses the statement text to one line of at most max bytes.
func preview(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		if max < 4 {
			return s[:max]
		}
		cut := max - 3
		for cut > 0 && s[cut]&0xC0 == 0x80 { // do not split a UTF-8 sequence
			cut--
		}
		return s[:cut] + "..."
	}
	return s
}

func (t *textWriter) p(format string, a ...any) { fmt.Fprintf(t.w, format, a...) }
func (t *textWriter) nl()                       { t.w.WriteByte('\n') }
func (t *textWriter) rule(c byte) {
	t.w.WriteString(strings.Repeat(string(c), t.o.Width))
	t.nl()
}

// ---- sections -------------------------------------------------------------

func (t *textWriter) header() {
	m := t.m
	t.p("mtkprof %s - Oracle SQL trace profile\n", Version)
	t.rule('=')
	if n := len(m.File.Files); n > 1 {
		t.p("Trace files: %d files (%s%s); see FILES\n", n, m.File.Files[0].Name, map[bool]string{true: ", ...", false: ""}[n > 2])
		if n == 2 {
			t.p("             second file: %s\n", m.File.Files[1].Name)
		}
	} else {
		t.p("Trace file : %s\n", dash(m.File.TraceFile))
	}
	t.p("Database   : Oracle %s  instance %s  node %s (%s %s)\n", dash(m.File.Version), dash(m.File.Instance), dash(m.File.Node), dash(m.File.SystemName), dash(m.File.Machine))
	if len(m.Contexts) > 0 {
		c := m.Contexts[0]
		t.p("Session    : %s  service %s  module %s  action %s  client id %s  container %s  driver %s\n",
			dash(c.SessionID), dash(c.Service), dash(c.Module), dash(c.Action), dash(c.ClientID), dash(c.ContainerID), dash(c.ClientDriver))
		if len(m.File.Files) > 1 {
			t.p("             (first of %d session contexts in %d files; see SESSIONS)\n", len(m.Contexts), len(m.File.Files))
		} else if len(m.Contexts) > 1 {
			t.p("             (%d context changes in the file: session / module / action switches)\n", len(m.Contexts)-1)
		}
	}
	span := m.Span
	if span.FirstWallUs != 0 {
		t.p("Span       : %s -> %s  (%s s)\n", t.wallZ(span.FirstWallUs), t.wallZ(span.LastWallUs), secs(span.Us()))
	} else {
		t.p("Span       : tim %d -> %d  (%s s, no wall-clock marker found)\n", span.FirstTim, span.LastTim, secs(span.Us()))
	}
	t.p("Volume     : %s lines (%.1f MB)  calls %s  waits %s  cursors %s  statements %s  bind sets %s  plans %s  transactions %s  errors %s\n",
		commas(int64(m.Diag.Lines)), float64(m.Diag.Bytes)/1e6, commas(int64(len(m.Calls))), commas(int64(len(m.Waits))), commas(int64(len(m.Cursors))),
		commas(int64(len(m.Statements))), commas(int64(len(m.BindSets))), commas(int64(len(m.Plans))), commas(int64(len(m.Transactions))), commas(int64(len(m.Errors))))
	var notes []string
	if m.File.Truncated {
		notes = append(notes, fmt.Sprintf("trace truncated by max_dump_file_size (%d bytes)", m.File.DumpSizeLimit))
	}
	if len(m.File.Files) == 1 {
		if len(m.File.ContinuedFrom) > 0 {
			notes = append(notes, "continues an earlier trace file")
		}
		if len(m.File.ContinuesIn) > 0 {
			notes = append(notes, "continues in "+m.File.ContinuesIn[0])
		}
	} else {
		chains := map[int]bool{}
		for _, f := range m.File.Files {
			chains[f.Chain] = true
		}
		notes = append(notes, fmt.Sprintf("%d files in %d chain(s)/sessions", len(m.File.Files), len(chains)))
		if px := analyze.PX(m); px.Sessions > 0 {
			notes = append(notes, fmt.Sprintf("%d PX slave process(es) attached to their coordinator", px.Sessions))
		}
	}
	if m.Diag.UnknownLines > 0 {
		notes = append(notes, fmt.Sprintf("%d unrecognised lines", m.Diag.UnknownLines))
	}
	if m.Diag.ImplicitCursors > 0 {
		notes = append(notes, fmt.Sprintf("%d cursors used before being parsed in this file", m.Diag.ImplicitCursors))
	}
	if m.Diag.OrphanCalls > 0 {
		notes = append(notes, fmt.Sprintf("%d recursive calls without a parent call", m.Diag.OrphanCalls))
	}
	if m.Diag.UnattributedWaits > 0 {
		notes = append(notes, fmt.Sprintf("%d waits after the last call of their cursor", m.Diag.UnattributedWaits))
	}
	if bm := m.Diag.BindMode; bm == "redacted" || bm == "none" {
		notes = append(notes, "bind values "+map[string]string{"redacted": "redacted (type, length, stable hash)", "none": "dropped"}[bm])
	}
	if len(notes) > 0 {
		t.p("Notes      : %s\n", strings.Join(notes, "; "))
	}
	t.nl()
}

// files lists the files of a trace set (nothing for a single file).
func (t *textWriter) files() {
	m := t.m
	if len(m.File.Files) < 2 {
		return
	}
	t.p("FILES  (one logical trace; files of a chain are parsed as one stream, independent files are separate sessions)\n")
	t.rule('-')
	t.p("%3s %5s %-44s %10s %9s  %-12s %-12s  %s\n", "#", "chain", "file", "bytes", "lines", "first", "last", "process")
	for _, f := range m.File.Files {
		name := f.Name
		if len(name) > 44 {
			name = name[:41] + "..."
		}
		first, last := t.clock(f.FirstTim), t.clock(f.LastTim)
		proc := dash(leadingPID(f.ProcessPID))
		if f.PX {
			proc += " PX slave"
		}
		if f.Followed {
			proc += " (followed)"
		}
		t.p("%3d %5d %-44s %10s %9s  %-12s %-12s  %s\n", f.Idx, f.Chain, name, commas(f.Size), commas(int64(f.Lines)), first, last, proc)
	}
	t.nl()
}

func leadingPID(v string) string {
	if i := strings.IndexAny(v, ", "); i > 0 {
		v = v[:i]
	}
	return v
}

func (t *textWriter) profileTable(p analyze.Profile, title string) {
	t.p("%s\n", title)
	t.rule('-')
	t.p("%-52s %12s %7s %10s %10s %10s  %s\n", "Component", "Seconds", "%", "Count", "Avg ms", "Max ms", "Class")
	for _, r := range p.Rows {
		if r.Us == 0 && r.Count == 0 {
			continue
		}
		name := r.Component
		if r.Kind == "idle" {
			name += " (idle)"
		}
		if len(name) > 52 {
			name = name[:49] + "..."
		}
		cnt, avg, max := "", "", ""
		if r.Count > 0 {
			cnt, avg, max = commas(r.Count), ms(r.AvgUs), ms(float64(r.MaxUs))
		}
		t.p("%-52s %12s %6.1f%% %10s %10s %10s  %s\n", name, secs(r.Us), r.Pct, cnt, avg, max, r.Class)
	}
	t.rule('-')
	t.p("%-52s %12s %6.1f%%\n", "Total response time", secs(p.TotalUs), 100.0)
	t.nl()
}

func (t *textWriter) traceProfile() {
	p := analyze.TraceProfile(t.m)
	t.profileTable(p, "RESOURCE PROFILE - whole trace (response time = trace span; CPU of top-level calls; every wait)")
	if px := analyze.PX(t.m); px.Sessions > 0 {
		t.p("PX slaves: %d process(es) attached to their coordinator, run in parallel with it and are not in the profile above:\n", px.Sessions)
		t.p("           cpu %s s, waits %s s, idle %s s (their own sessions are listed under the coordinator in SESSIONS)\n\n", secs(px.CPUUs), secs(px.WaitUs), secs(px.IdleUs))
	}
}

func (t *textWriter) sortKey(s *analyze.StmtStats) int64 {
	switch t.o.Sort {
	case "self":
		return s.SelfElapsed
	case "cpu":
		return s.CPU
	case "execs":
		return s.Executions
	case "disk":
		return s.AllCalls.Disk
	case "query":
		return s.AllCalls.Query
	case "rows":
		return s.AllCalls.Rows
	case "line":
		return -int64(t.m.Statements[s.ID].FirstLine)
	}
	return s.Elapsed + s.IdleUs
}

func (t *textWriter) include(s *analyze.StmtStats) bool {
	if s.AllCalls.Count == 0 && s.Errors == 0 && s.PXElapsed == 0 {
		return false
	}
	if !t.o.Sys {
		st := &t.m.Statements[s.ID]
		if st.UID == 0 && s.MinDep > 0 && st.Kind == model.StmtSQL {
			return false
		}
	}
	return true
}

// ranking prints the statement summary and returns the statement order.
func (t *textWriter) ranking() []model.ID {
	m := t.m
	var ids []model.ID
	for i := range t.stats {
		if t.include(&t.stats[i]) {
			ids = append(ids, model.ID(i))
		}
	}
	sort.SliceStable(ids, func(a, b int) bool { return t.sortKey(&t.stats[ids[a]]) > t.sortKey(&t.stats[ids[b]]) })
	if t.o.Top > 0 && len(ids) > t.o.Top {
		ids = ids[:t.o.Top]
	}
	for i, id := range ids {
		t.rank[id] = i + 1
	}
	span := m.Span.Us()
	t.p("STATEMENTS BY %s  (elapsed includes recursive children and idle time between the statement's calls)\n", strings.ToUpper(t.o.Sort))
	t.rule('-')
	t.p("%4s %11s %6s %11s %10s %9s %11s %9s %11s  %-13s %3s  %s\n", "#", "Elapsed s", "%", "Self s", "CPU s", "Execs", "Rows", "Disk", "Query", "SQL ID", "Dep", "Statement")
	for i, id := range ids {
		s := &t.stats[id]
		st := &m.Statements[id]
		textW := t.o.Width - 112
		if textW < 20 {
			textW = 20
		}
		t.p("%4d %11s %6s %11s %10s %9s %11s %9s %11s  %-13s %3d  %s\n", i+1, secs(s.Elapsed+s.IdleUs), pct(s.Elapsed+s.IdleUs, span), secs(s.SelfElapsed), secs(s.CPU),
			commas(s.Executions), commas(s.AllCalls.Rows), commas(s.AllCalls.Disk), commas(s.AllCalls.Query), t.sqlID(st), s.MinDep, preview(st.Text, textW))
		if s.PXElapsed > 0 || s.PXSessions > 0 {
			t.p("%4s %11s %6s %s\n", "", secs(s.PXElapsed), "", fmt.Sprintf("  \\ PX slaves: %d sessions (work in their own sessions, not in the elapsed above)", s.PXSessions))
		}
		for _, ch := range s.Children {
			cs := &m.Statements[ch.Statement]
			t.p("%4s %11s %6s %-58s %-13s  %s\n", "", secs(ch.Elapsed), pct(ch.Elapsed, s.Elapsed), fmt.Sprintf("  \\ recursive: %s calls", commas(ch.Calls)), t.sqlID(cs), preview(cs.Text, textW))
		}
	}
	t.nl()
	return ids
}

func (t *textWriter) sqlID(st *model.Statement) string {
	switch st.Kind {
	case model.StmtSQL:
		if st.SQLID != "" {
			return st.SQLID
		}
		return fmt.Sprintf("hv:%d", st.HV)
	case model.StmtCommit:
		return "(commit)"
	case model.StmtRollback:
		return "(rollback)"
	case model.StmtLob:
		return "(lob)"
	case model.StmtRPC:
		return "(rpc)"
	case model.StmtUnknown:
		return "(unknown)"
	case model.StmtParseError:
		return "(parse err)"
	}
	return "?"
}

func (t *textWriter) statement(rank int, sid model.ID) {
	m := t.m
	s := &t.stats[sid]
	st := &m.Statements[sid]
	t.rule('=')
	plans := "-"
	if len(s.PlanHashes) > 0 {
		var hs []string
		for _, h := range s.PlanHashes {
			hs = append(hs, fmt.Sprint(h))
		}
		plans = strings.Join(hs, ",")
	} else if len(st.Cursors) > 0 && m.Cursors[st.Cursors[0]].PLH != 0 {
		plans = fmt.Sprint(m.Cursors[st.Cursors[0]].PLH)
	}
	t.p("STATEMENT %d   sql_id %s   hash %d   plan %s   %s   dep %d", rank, t.sqlID(st), st.HV, plans, ref.CommandName(st.OCT), s.MinDep)
	if s.MaxDep != s.MinDep {
		t.p("-%d", s.MaxDep)
	}
	t.p("   uid %d", st.UID)
	if u := m.UserName(int64(st.UID)); u != "" {
		t.p(" (%s)", u)
	}
	t.nl()
	t.p("elapsed %s s (%s of trace)   self %s s   cpu %s s   waits %s s   idle between calls %s s   execs %s   rows %s   cursors %d   errors %d\n",
		secs(s.Elapsed), strings.TrimSpace(pct(s.Elapsed, m.Span.Us())), secs(s.SelfElapsed), secs(s.CPU), secs(s.WaitUs), secs(s.IdleUs), commas(s.Executions), commas(s.AllCalls.Rows), s.Cursors, s.Errors)
	if s.PXSessions > 0 {
		t.p("PX slaves: %d sessions, %s s elapsed, %s s cpu (their own sessions, not included above)\n", s.PXSessions, secs(s.PXElapsed), secs(s.PXCPU))
	}
	if s.FirstWallUs != 0 {
		t.p("first call %s   last call %s   first line %d\n", t.wall(s.FirstWallUs), t.wall(s.LastWallUs), st.FirstLine)
	} else {
		t.p("first line %d\n", st.FirstLine)
	}
	if len(st.Cursors) > 0 {
		c := m.Contexts[m.Cursors[st.Cursors[0]].Context]
		t.p("module %s   action %s   client id %s   session %s   service %s\n", dash(c.Module), dash(c.Action), dash(c.ClientID), dash(c.SessionID), dash(c.Service))
	}
	t.rule('-')
	t.p("%s\n\n", strings.TrimRight(st.Text, "\n"))

	t.callTable(s)
	p := analyze.StatementProfile(m, s)
	t.profileTable(p, fmt.Sprintf("Resource profile - statement %d (response time %s s + %s s idle between calls)", rank, secs(s.Elapsed), secs(s.IdleUs)))
	t.waitDetail(sid)
	t.executions(sid, s)
	t.binds(sid)
	t.plans(sid, s)
	t.links(s)
	t.errors(sid)
	t.nl()
}

func (t *textWriter) callTable(s *analyze.StmtStats) {
	row := func(name string, c analyze.CallStats, hasRes bool) {
		if c.Count == 0 {
			return
		}
		if hasRes {
			t.p("%-8s %7s %7s %10s %10s %10s %11s %10s %11s\n", name, commas(c.Count), commas(c.Misses), secs(c.CPU), secs(c.Elapsed), commas(c.Disk), commas(c.Query), commas(c.Current), commas(c.Rows))
		} else {
			t.p("%-8s %7s %7s %10s %10s %10s %11s %10s %11s\n", name, commas(c.Count), "-", secs(c.CPU), secs(c.Elapsed), "-", "-", "-", "-")
		}
	}
	t.p("%-8s %7s %7s %10s %10s %10s %11s %10s %11s\n", "call", "count", "misses", "cpu s", "elapsed s", "disk", "query", "current", "rows")
	t.p("%-8s %7s %7s %10s %10s %10s %11s %10s %11s\n", "--------", "-------", "-------", "----------", "----------", "----------", "-----------", "----------", "-----------")
	row("Parse", s.Parse, true)
	row("Execute", s.Exec, true)
	row("Fetch", s.Fetch, true)
	row("Close", s.Close, false)
	row("Other", s.Other, true)
	t.p("%-8s %7s %7s %10s %10s %10s %11s %10s %11s\n", "--------", "-------", "-------", "----------", "----------", "----------", "-----------", "----------", "-----------")
	row("Total", s.Total, true)
	t.nl()
}

// waitDetail breaks the statement's top I/O events down by object.
func (t *textWriter) waitDetail(sid model.ID) {
	m := t.m
	in := func(w *model.Wait) bool { return w.Statement == sid && !w.Idle && !w.Between && !m.PXChild(w.Context) }
	evs := analyze.WaitsByEvent(m, in)
	shown := 0
	for _, ev := range evs {
		if shown >= 3 || ev.Us < 1000 {
			break
		}
		e := &m.Events[ev.Event]
		byObj := analyze.WaitsBy(m, func(w *model.Wait) bool { return in(w) && w.Event == ev.Event }, func(w *model.Wait) (int64, bool) { return w.ObjID, w.ObjID > 0 })
		if len(byObj) == 0 {
			continue
		}
		if shown == 0 {
			t.p("Wait detail by object (obj# from the WAIT lines; map with dba_objects.object_id)\n")
		}
		shown++
		t.p("  %s - %s s in %s waits\n", e.Name, secs(ev.Us), commas(ev.Count))
		for i, o := range byObj {
			if i >= 8 {
				t.p("    ... %d more objects\n", len(byObj)-8)
				break
			}
			if name := m.ObjectName(o.Key); name != "" {
				t.p("    obj# %-10d %-30s %10s s %9s waits %8s ms avg\n", o.Key, name, secs(o.Us), commas(o.Count), ms(float64(o.Us)/float64(o.Count)))
				continue
			}
			t.p("    obj# %-10d %10s s %9s waits %8s ms avg\n", o.Key, secs(o.Us), commas(o.Count), ms(float64(o.Us)/float64(o.Count)))
		}
	}
	if shown > 0 {
		t.nl()
	}
}

func (t *textWriter) executions(sid model.ID, s *analyze.StmtStats) {
	ex := analyze.Executions(t.m, sid)
	if len(ex) < 2 {
		return
	}
	var min, max, sum int64
	var slow *analyze.Execution
	for i := range ex {
		e := ex[i].Stats.Elapsed
		sum += e
		if i == 0 || e < min {
			min = e
		}
		if e > max {
			max = e
			slow = &ex[i]
		}
	}
	t.p("Executions: %d   elapsed min %s s  avg %s s  max %s s", len(ex), secs(min), secs(sum/int64(len(ex))), secs(max))
	if slow != nil {
		t.p("   slowest: exec %d of cursor at line %d (%s s, %s rows, %s disk)", slow.ExecNo, t.m.Cursors[slow.Cursor].Line, secs(slow.Stats.Elapsed), commas(slow.Stats.Rows), commas(slow.Stats.Disk))
	}
	t.nl()
	t.execTable(ex)
	t.nl()
}

// pickExecs chooses which executions to list: all of them when they fit in
// n, otherwise the first n/2 in file order plus the slowest of the rest
// (marked). The result is in file order.
func pickExecs(ex []analyze.Execution, n int) (idx []int, slow map[int]bool) {
	if n < 0 || len(ex) <= n {
		idx = make([]int, len(ex))
		for i := range idx {
			idx[i] = i
		}
		return idx, nil
	}
	first := (n + 1) / 2
	rest := make([]int, 0, len(ex)-first)
	for i := first; i < len(ex); i++ {
		rest = append(rest, i)
	}
	sort.SliceStable(rest, func(a, b int) bool { return ex[rest[a]].Stats.Elapsed > ex[rest[b]].Stats.Elapsed })
	rest = rest[:n-first]
	slow = map[int]bool{}
	for _, i := range rest {
		slow[i] = true
	}
	sort.Ints(rest)
	for i := 0; i < first; i++ {
		idx = append(idx, i)
	}
	return append(idx, rest...), slow
}

func (t *textWriter) execTable(ex []analyze.Execution) {
	n := t.o.Execs
	if n == 0 {
		return
	}
	m := t.m
	idx, slow := pickExecs(ex, n)
	if slow != nil {
		t.p("%d of %d executions: the first %d in file order and the %d slowest of the rest (marked *)\n", len(idx), len(ex), len(idx)-len(slow), len(slow))
	}
	const fixed = 87 // width of the columns before the binds
	bindW := t.o.Width - fixed
	if bindW < 20 {
		bindW = 20
	}
	t.p("%6s %7s %-12s %9s %9s %9s %8s %9s %7s  %s\n", "exec#", "cursor", "start", "elapsed s", "cpu s", "rows", "disk", "query", "fetches", "binds")
	prev := -1
	for _, i := range idx {
		if prev >= 0 && i != prev+1 {
			t.p("%6s\n", "...")
		}
		prev = i
		e := &ex[i]
		mark := " "
		if slow[i] {
			mark = "*"
		}
		start := "-"
		if w := m.WallOf(e.StartTim); w != 0 {
			start = time.UnixMicro(w).In(t.loc).Format("15:04:05.000")
		} else if e.StartTim != 0 {
			start = fmt.Sprintf("+%.3f", float64(e.StartTim-m.Span.FirstTim)/1e6)
		}
		t.p("%5d%s %7d %-12s %9s %9s %9s %8s %9s %7s  %s\n", e.ExecNo, mark, m.Cursors[e.Cursor].Line, start, secs(e.Stats.Elapsed), secs(e.Stats.CPU),
			commas(e.Stats.Rows), commas(e.Stats.Disk), commas(e.Stats.Query), commas(int64(len(e.Fetches))), bindPreview(m, e.BindSet, bindW))
	}
	if len(idx) < len(ex) && prev != len(ex)-1 {
		t.p("%6s\n", "...")
	}
}

// bindPreview renders a bind set compactly (:1=42 :2="abc"), cut to max bytes.
func bindPreview(m *model.Model, set model.ID, max int) string {
	if set == model.None || int(set) >= len(m.BindSets) {
		return ""
	}
	bs := &m.BindSets[set]
	var b strings.Builder
	for j := bs.First; j < bs.First+bs.N; j++ {
		x := &m.Binds[j]
		var v string
		switch {
		case x.NoDef:
			v = "(same)"
		case x.IsNull:
			v = "NULL"
		case x.IsDump:
			v = fmt.Sprintf("<%d bytes>", x.Avl)
		case quotedBind(x.Dty):
			v = fmt.Sprintf("%q", x.Value)
		default:
			v = x.Value
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		fmt.Fprintf(&b, ":%d=%s", x.Pos, v)
		if b.Len() > max {
			break
		}
	}
	out := b.String()
	if len(out) > max {
		cut := max - 3
		for cut > 0 && out[cut]&0xC0 == 0x80 {
			cut--
		}
		out = out[:cut] + "..."
	}
	return out
}

// quotedBind: character, LOB and similar values print quoted.
func quotedBind(dty int) bool {
	switch dty {
	case 1, 5, 8, 9, 96, 97, 112, 119:
		return true
	}
	return false
}

// sessions prints one row per session context.
func (t *textWriter) sessions() {
	m := t.m
	if len(m.Contexts) == 0 {
		return
	}
	cs := analyze.Contexts(m)
	t.rule('=')
	t.p("SESSIONS  (one row per session context; a *** marker changing session/module/action/client id/service starts one)\n")
	t.p("response = Σ elapsed of top-level calls; waits = non-idle wait events; idle = Idle-class events\n")
	t.rule('-')
	t.p("%4s %8s %-14s %8s %10s %10s %10s %10s %-12s %-12s  %s\n", "#", "line", "session", "calls", "response s", "cpu s", "waits s", "idle s", "first", "last", "module / action / client id / service")
	var tot, pxTot analyze.ContextStats
	multi := len(m.File.Files) > 1
	children := map[model.ID][]int{}
	for i := range m.Contexts {
		if m.PXChild(model.ID(i)) {
			p := m.Contexts[i].Parent
			children[p] = append(children[p], i)
		}
	}
	rows := 0
	var row func(i int, indent string)
	row = func(i int, indent string) {
		if rows++; rows > 200 {
			if rows == 201 {
				t.p("  ... more contexts\n")
			}
			return
		}
		c, x := cs[i], &m.Contexts[i]
		attrs := []string{dash(x.Module), dash(x.Action), dash(x.ClientID), dash(x.Service)}
		if x.ContainerID != "" {
			attrs = append(attrs, "container "+x.ContainerID)
		}
		if x.PX {
			attrs = append(attrs, "PX slave")
		}
		sess := indent + analyze.SessionName(x)
		if len(sess) > 14 {
			sess = sess[:14]
		}
		line := fmt.Sprint(x.Line)
		if multi {
			line = fmt.Sprintf("%d:%d", x.FileIdx, x.Line)
		}
		t.p("%4d %8s %-14s %8s %10s %10s %10s %10s %-12s %-12s  %s\n", i, line, sess, commas(c.Calls), secs(c.Elapsed), secs(c.CPU), secs(c.WaitUs), secs(c.IdleUs),
			t.clock(c.FirstTim), t.clock(c.LastTim), strings.Join(attrs, " / "))
		for _, ch := range children[model.ID(i)] {
			row(ch, "  \\ ")
		}
	}
	for i := range cs {
		if m.PXChild(model.ID(i)) {
			continue
		}
		row(i, "")
	}
	for i, c := range cs {
		dst := &tot
		if m.PXChild(model.ID(i)) {
			dst = &pxTot
		}
		dst.Calls += c.Calls
		dst.Elapsed += c.Elapsed
		dst.CPU += c.CPU
		dst.WaitUs += c.WaitUs
		dst.IdleUs += c.IdleUs
	}
	t.rule('-')
	t.p("%4s %8s %-14s %8s %10s %10s %10s %10s\n", "", "", "total", commas(tot.Calls), secs(tot.Elapsed), secs(tot.CPU), secs(tot.WaitUs), secs(tot.IdleUs))
	if pxTot.Calls > 0 {
		t.p("%4s %8s %-14s %8s %10s %10s %10s %10s   (PX slaves, run in parallel; not in the total)\n", "", "", "PX slaves", commas(pxTot.Calls), secs(pxTot.Elapsed), secs(pxTot.CPU), secs(pxTot.WaitUs), secs(pxTot.IdleUs))
	}
	t.nl()
}

// clock formats a tim value as wall-clock time of day, or +seconds from the
// trace start without a time anchor.
func (t *textWriter) clock(tim int64) string {
	if tim == 0 {
		return "-"
	}
	if w := t.m.WallOf(tim); w != 0 {
		return time.UnixMicro(w).In(t.loc).Format("15:04:05.000")
	}
	return fmt.Sprintf("+%.3f", float64(tim-t.m.Span.FirstTim)/1e6)
}

// timeBuckets prints the activity timeline in fixed buckets (same bucket
// size as the UI document).
func (t *textWriter) timeBuckets() {
	m := t.m
	bucket := analyze.TimelineBucket(m)
	bs := analyze.Timeline(m, bucket)
	if len(bs) < 2 {
		return
	}
	t.rule('=')
	// sub-second buckets read better in milliseconds
	unit, div, each := "s", 1e6, secs(bucket)+" s"
	if bucket < 1000000 {
		unit, div, each = "ms", 1e3, fmt.Sprintf("%g ms", float64(bucket)/1e3)
	}
	tm := func(us int64) string { return fmt.Sprintf("%.3f", float64(us)/div) }
	t.p("TIME BUCKETS  (%s each; calls and I/O by completion time; cpu/elapsed of top-level calls; busy = elapsed / bucket)\n", each)
	t.rule('-')
	const fixed = 113
	barW := t.o.Width - fixed
	if barW < 10 {
		barW = 10
	}
	if barW > 50 {
		barW = 50
	}
	t.p("%-12s %8s %9s %10s %9s %9s %9s %10s %10s %6s\n", "start", "calls", "cpu "+unit, "elapsed "+unit, "waits "+unit, "idle "+unit, "disk", "query", "rows", "busy")
	for _, b := range bs {
		start := "-"
		if m.Span.FirstWallUs != 0 {
			start = time.UnixMicro(b.StartUs).In(t.loc).Format("15:04:05.000")
		} else {
			start = fmt.Sprintf("+%.3f", float64(b.StartUs-m.Span.FirstTim)/1e6)
		}
		busy := float64(b.ElaUs) / float64(bucket)
		n := int(busy*float64(barW) + 0.5)
		if n > barW {
			n = barW
		}
		bar := strings.Repeat("#", n)
		if busy > 1 {
			bar += "+"
		}
		line := fmt.Sprintf("%-12s %8s %9s %10s %9s %9s %9s %10s %10s %5.0f%%  %s", start, commas(b.Calls), tm(b.CPUUs), tm(b.ElaUs), tm(b.WaitUs), tm(b.IdleUs),
			commas(b.Disk), commas(b.Query), commas(b.Rows), 100*busy, bar)
		t.p("%s\n", strings.TrimRight(line, " "))
	}
	t.nl()
}

func (t *textWriter) binds(sid model.ID) {
	if t.o.Binds <= 0 {
		return
	}
	m := t.m
	n := 0
	for i := range m.BindSets {
		bs := &m.BindSets[i]
		if bs.Statement != sid {
			continue
		}
		if n == 0 {
			t.p("Bind values (first %d bind sets)\n", t.o.Binds)
		}
		n++
		if n > t.o.Binds {
			continue
		}
		var parts []string
		for j := bs.First; j < bs.First+bs.N; j++ {
			b := &m.Binds[j]
			switch {
			case b.NoDef:
				parts = append(parts, fmt.Sprintf(":%d=(same as earlier bind)", b.Pos))
			case b.IsNull:
				parts = append(parts, fmt.Sprintf(":%d %s=NULL", b.Pos, b.TypeName))
			case b.IsDump:
				parts = append(parts, fmt.Sprintf(":%d %s=<%d-byte dump>", b.Pos, b.TypeName, b.Avl))
			default:
				v := b.Value
				if len(v) > 60 {
					v = v[:57] + "..."
				}
				if b.Mal > 0 {
					parts = append(parts, fmt.Sprintf(":%d %s[%d]=%q", b.Pos, b.TypeName, b.Mal, v))
				} else {
					parts = append(parts, fmt.Sprintf(":%d %s=%q", b.Pos, b.TypeName, v))
				}
			}
		}
		ela := "-"
		if bs.Call != model.None {
			ela = secs(m.Calls[bs.Call].E) + " s exec"
		}
		t.p("  line %-8d %-14s %s\n", bs.Line, ela, strings.Join(parts, "  "))
	}
	if n > t.o.Binds {
		t.p("  ... %d more bind sets\n", n-t.o.Binds)
	}
	if n > 0 {
		t.nl()
	}
}

func (t *textWriter) plans(sid model.ID, s *analyze.StmtStats) {
	m := t.m
	defer t.refPlan(&m.Statements[sid])
	if len(s.Plans) == 0 {
		return
	}
	// print the last dump of each distinct plan hash
	last := map[uint64]model.ID{}
	for _, pid := range s.Plans {
		last[m.Plans[pid].PLH] = pid
	}
	for _, h := range s.PlanHashes {
		pid := last[h]
		p := &m.Plans[pid]
		t.p("Execution plan (plan hash %d, row source statistics from STAT lines at line %d; %d dumps of this plan)\n", p.PLH, p.Line, countPlans(m, s, h))
		t.p("%4s %11s %8s %10s %9s %9s %11s  %s\n", "Id", "Rows", "Starts", "CR", "PR", "PW", "Time ms", "Operation")
		for i := p.First; i < p.First+p.N; i++ {
			l := &m.PlanLines[i]
			op := strings.Repeat(" ", l.Depth) + l.Op
			if l.Object != "" {
				op += " " + l.Object
			}
			if l.Obj != 0 {
				op += fmt.Sprintf(" (obj %d)", l.Obj)
			}
			if l.Cost >= 0 {
				op += fmt.Sprintf("  [cost %d card %d]", l.Cost, l.Card)
			}
			t.p("%4d %11s %8s %10s %9s %9s %11s  %s\n", l.ID, commas(l.Cnt), commas(l.Str), commas(l.CR), commas(l.PR), commas(l.PW), ms(float64(l.TimeUs)), op)
		}
		t.predicates(p)
		t.nl()
	}
}

// predicates prints the access / filter predicates a ref-bundle DBMS_XPLAN
// overlaid on a plan, one line per operation id.
func (t *textWriter) predicates(p *model.Plan) {
	m := t.m
	first := true
	for i := p.First; i < p.First+p.N; i++ {
		l := &m.PlanLines[i]
		if l.Access == "" && l.Filter == "" {
			continue
		}
		if first {
			t.p("Predicates (from ref bundle DBMS_XPLAN):\n")
			first = false
		}
		if l.Access != "" {
			t.p("  %4d: access(%s)\n", l.ID, l.Access)
		}
		if l.Filter != "" {
			t.p("  %4d: filter(%s)\n", l.ID, l.Filter)
		}
	}
}

// refPlan prints the DBMS_XPLAN text a reference bundle carries for the statement.
func (t *textWriter) refPlan(st *model.Statement) {
	if st.RefPlan == "" {
		return
	}
	t.p("DBMS_XPLAN from ref bundle (plans/%s.txt)\n", st.SQLID)
	for _, ln := range strings.Split(st.RefPlan, "\n") {
		t.p("  %s\n", strings.TrimRight(ln, " \t"))
	}
	t.nl()
}

func countPlans(m *model.Model, s *analyze.StmtStats, h uint64) int {
	n := 0
	for _, pid := range s.Plans {
		if m.Plans[pid].PLH == h {
			n++
		}
	}
	return n
}

func (t *textWriter) links(s *analyze.StmtStats) {
	m := t.m
	if len(s.Children) > 0 {
		t.p("Recursive statements executed by this statement (their time is included above):\n")
		for _, l := range s.Children {
			cs := &m.Statements[l.Statement]
			t.p("  %10s s %6s  %6s calls  %-13s #%-4s %s\n", secs(l.Elapsed), pct(l.Elapsed, s.Elapsed), commas(l.Calls), t.sqlID(cs), rankStr(t.rank[l.Statement]), preview(cs.Text, t.o.Width-60))
		}
	}
	if len(s.Parents) > 0 {
		t.p("Called recursively from:\n")
		for _, l := range s.Parents {
			ps := &m.Statements[l.Statement]
			t.p("  %10s s %6s calls  %-13s #%-4s %s\n", secs(l.Elapsed), commas(l.Calls), t.sqlID(ps), rankStr(t.rank[l.Statement]), preview(ps.Text, t.o.Width-52))
		}
	}
	if len(s.Children) > 0 || len(s.Parents) > 0 {
		t.nl()
	}
}

func rankStr(r int) string {
	if r == 0 {
		return "-"
	}
	return fmt.Sprint(r)
}

func (t *textWriter) errors(sid model.ID) {
	n := 0
	for i := range t.m.Errors {
		e := &t.m.Errors[i]
		if e.Statement != sid {
			continue
		}
		if n == 0 {
			t.p("Errors:\n")
		}
		n++
		if n > 10 {
			continue
		}
		kind := "ORA-"
		if e.ParseError {
			kind = "parse error ORA-"
		}
		t.p("  line %-8d %s%05d at %s\n", e.Line, kind, e.Err, t.wall(e.WallUs))
	}
	if n > 10 {
		t.p("  ... %d more\n", n-10)
	}
	if n > 0 {
		t.nl()
	}
}

func (t *textWriter) footer() {
	m := t.m
	t.rule('=')
	if len(m.Transactions) > 0 {
		var commits, rollbacks, ro int
		for _, x := range m.Transactions {
			if x.Rlbk != 0 {
				rollbacks++
			} else {
				commits++
			}
			if x.RdOnly != 0 {
				ro++
			}
		}
		t.p("Transactions: %d commits, %d rollbacks (%d read-only)\n", commits, rollbacks, ro)
	}
	if len(m.Unknown) > 0 {
		t.p("Unrecognised lines (first %d of %d):\n", len(m.Unknown), m.Diag.UnknownLines)
		for _, u := range m.Unknown {
			if len(u.Text) > 100 {
				u.Text = u.Text[:97] + "..."
			}
			t.p("  %7d: %s\n", u.Line, u.Text)
		}
	}
	t.p("Call kinds: ")
	kinds := map[trace.CallKind]int{}
	for i := range m.Calls {
		kinds[m.Calls[i].Kind]++
	}
	var ks []trace.CallKind
	for k := range kinds {
		ks = append(ks, k)
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i] < ks[j] })
	for _, k := range ks {
		t.p("%s=%d ", k, kinds[k])
	}
	t.nl()
}
