package diag

import (
	"fmt"
	"io"
	"strconv"
	"strings"
)

// The text of the call stack and process state readings, for the digest (docs/PLAN-DIAG.md § Clients). The
// numbers are those of the reading; a list the reading bounds is printed to a shorter bound here and says so.

const (
	// DigestFrames is how many frames of a call stack the text digest lists.
	DigestFrames = 20
	// DigestCursors is how many cursors, and DigestBinds how many binds of one, the text lists.
	DigestCursors = 8
	DigestBinds   = 6
	// DigestStatementLines is how many lines of the current statement the text prints.
	DigestStatementLines = 12
	// DigestHolds is how many rows of each list of holds (locks, pins, enqueues) the text prints.
	DigestHolds = 8
	// DigestHistory is how many waits of the wait history the text prints.
	DigestHistory = 5
	// manyProcs: a digest with more processes than this prints one line each.
	manyProcs = 12
)

func secText(f *float64) string {
	if f == nil {
		return "?"
	}
	return strconv.FormatFloat(*f, 'f', -1, 64) + " s"
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return th64(int64(n)) + " " + many
}

func writeCallStackText(w io.Writer, indent string, cs *CallStack) {
	p := func(format string, a ...any) { fmt.Fprintf(w, indent+format+"\n", a...) }
	st := cs.Start
	kind := "diagnostic dump"
	if st.Incident {
		kind = "incident default dumps"
	}
	if st.Line == 0 {
		p("call stack: no dump start line in lines %d-%d", cs.From, cs.To)
	} else {
		p("%s, level %d (flags %s), starts at line %s", kind, st.Level, st.Flags, th64(int64(st.Line)))
	}
	// the error
	if e := cs.Error; e != nil {
		if in := e.Incident; in != nil {
			args := ""
			if len(in.Args) > 0 {
				args = " with " + strings.Join(in.Args, ", ")
			}
			p("error: incident %s, problem key %s%s", in.ID, in.Problem, args)
		}
		for _, l := range e.Lines {
			p("error: %s (line %d)", l.Text, l.Line)
		}
		if sg := e.Signal; sg != nil {
			name := ""
			if sg.Name != "" {
				name = ", name " + sg.Name
			}
			p("error: about to signal %s (line %d)%s", sg.ORA, sg.Line, name)
		}
	} else {
		p("error: none named in the dump (taken on request, or by an event that names none)")
	}
	if len(cs.Barriers) > 0 {
		p("error barrier: %s (line %d)", strings.TrimPrefix(cs.Barriers[0].Text, "<error barrier> "), cs.Barriers[0].Line)
	}
	// the statement
	if s := cs.Statement; s != nil {
		if s.From > s.To {
			p("statement %s: (empty)", s.SQLID)
		} else {
			p("statement %s (lines %d-%d):", s.SQLID, s.From, s.To)
			lines := strings.Split(s.Text, "\n")
			for i, l := range lines {
				if i == DigestStatementLines {
					p("  ... %d more lines", len(lines)-i)
					break
				}
				p("  %s", l)
			}
			if s.Truncated {
				p("  (the text is cut)")
			}
		}
	}
	// the PL/SQL call stack
	if len(cs.PLSQL) > 0 {
		p("PL/SQL call stack (innermost first, line %d):", cs.PLSQLLine)
		rows := [][]string{}
		for _, f := range cs.PLSQL {
			name := f.Name
			if name == "" {
				name = f.Type
			} else {
				name += " (" + f.Type + ")"
			}
			rows = append(rows, []string{name, "line " + strconv.Itoa(f.Line), f.Handle})
		}
		table(w, indent+"  ", rows)
	}
	// the stack
	if len(cs.Frames) > 0 {
		src := map[string]string{"binary": "the Binary Stack Dump's frame headers", "table": "the Call Stack Trace table"}[cs.FramesSource]
		p("stack as one line (the form oradebug short_stack prints; %s, without the dump's own %s):", src, plural(cs.Own, "frame", "frames"))
		p("  %s", cs.ShortStackNoOwn)
		p("frames, innermost first (%d of %d; the dump's own %d are left out):", len(cs.Frames)-cs.Own, len(cs.Frames), cs.Own)
		rows := [][]string{}
		for _, f := range cs.Frames[cs.Own:] {
			sig := ""
			if f.ErrorSignaled {
				sig = "error signaled"
			}
			rows = append(rows, []string{strconv.Itoa(f.N), f.Text, "line " + strconv.Itoa(f.Line), f.Component, sig})
			if len(rows) == DigestFrames {
				break
			}
		}
		table(w, indent+"  ", rows, true)
		if rest := len(cs.Frames) - cs.Own - len(rows); rest > 0 {
			p("  ... %d more frames (the stack line above lists them all)", rest)
		}
	}
	// the cursors
	if cs.CursorsTotal > 0 {
		open := 0
		for _, c := range cs.Cursors {
			if c.Group == "open" {
				open++
			}
		}
		p("cursors: %s (%d open, %d cached among the %d listed):", plural(cs.CursorsTotal, "cursor", "cursors"), open, len(cs.Cursors)-open, len(cs.Cursors))
		for i, c := range cs.Cursors {
			if i == DigestCursors {
				p("  ... %d more cursors", len(cs.Cursors)-i)
				break
			}
			head := c.Group
			if c.Number > 0 {
				head += " #" + strconv.Itoa(c.Number)
			}
			p("  %s %s, %s: %s", head, c.SQLID, plural(c.BindCount, "bind", "binds"), c.Text)
			var bs []string
			for j, b := range c.Binds {
				if j == DigestBinds {
					bs = append(bs, fmt.Sprintf("... %d more", len(c.Binds)-j))
					break
				}
				v := ""
				switch {
				case b.NoDef:
					v = "no oacdef"
				case b.Line != 0:
					v = b.Value
				default:
					v = "no value"
				}
				bs = append(bs, fmt.Sprintf("#%d %s %s", b.Pos, orDash(b.Type), v))
			}
			if len(bs) > 0 {
				p("      binds: %s", strings.Join(bs, "; "))
			}
		}
	}
	for _, l := range cs.Links {
		p("nested: %s, lines %d-%d", strings.ToLower(l.Title), l.From, l.To)
	}
	for _, n := range cs.Notes {
		p("note: %s", n)
	}
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// who is "process 6 (Oracle pid 6, serial 35, OS pid 13832, PMON)".
func (ps *ProcState) who() string {
	pr := ps.Process
	if pr == nil {
		return "process (no process object in these lines)"
	}
	var parts []string
	if pr.Pid != nil {
		parts = append(parts, "Oracle pid "+strconv.Itoa(*pr.Pid))
	}
	if pr.Serial != nil {
		parts = append(parts, "serial "+strconv.Itoa(*pr.Serial))
	}
	if pr.OSPid != "" {
		parts = append(parts, "OS pid "+pr.OSPid)
	}
	if pr.Name != "" {
		parts = append(parts, pr.Name)
	}
	return "process (" + strings.Join(parts, ", ") + ")"
}

func (s *ProcSession) summary() string {
	out := "session " + s.Key
	if s.User != "" {
		out += " " + s.User
	}
	if s.Container != "" {
		out += " in " + s.Container
	}
	return out
}

func (w *ProcWait) summary() string {
	if w == nil {
		return "no wait recorded"
	}
	if w.InWait && len(w.Stack) > 0 {
		e := w.Stack[0]
		return "waiting for '" + e.Event + "' for " + secText(e.Seconds)
	}
	if w.LastEndedSec != nil {
		return "not in wait; last wait ended " + secText(w.LastEndedSec) + " ago"
	}
	return "no current wait recorded"
}

func writeProcText(w io.Writer, indent string, ps *ProcState, o textOpts) {
	p := func(format string, a ...any) { fmt.Fprintf(w, indent+format+"\n", a...) }
	if o.manyProcs {
		// one line per process
		line := ps.who()
		if len(ps.Sessions) > 0 {
			s := &ps.Sessions[0]
			line += ", " + s.summary() + ", " + s.Wait.summary()
			if s.Wait != nil && len(s.Wait.Blockers) > 0 {
				var ks []string
				for _, b := range s.Wait.Blockers {
					ks = append(ks, b.Key)
				}
				line += ", blocked by " + strings.Join(ks, ", ")
				if f := s.Wait.FinalBlocker; f != nil {
					line += " (final " + f.Key + ")"
				}
			}
			if s.Wait != nil && s.Wait.BlockedCount > 0 {
				line += ", blocks " + strconv.Itoa(s.Wait.BlockedCount)
			}
		}
		p("%s, %s", line, plural(ps.Objects.Total, "state object", "state objects"))
		return
	}
	p("%s, %s, depth %d", ps.who(), plural(ps.Objects.Total, "state object", "state objects"), ps.Objects.Depth)
	for i := range ps.Sessions {
		s := &ps.Sessions[i]
		desc := s.summary()
		var extra []string
		if s.Program != "" {
			e := s.Program
			if s.Machine != "" {
				e += " on " + s.Machine
			}
			extra = append(extra, e)
		}
		if s.Module != "" {
			extra = append(extra, "module "+s.Module)
		}
		if s.Action != "" {
			extra = append(extra, "action "+s.Action)
		}
		if s.Service != "" {
			extra = append(extra, "service "+s.Service)
		}
		if len(extra) > 0 {
			desc += "; " + strings.Join(extra, ", ")
		}
		p("%s (lines %d-%d)", desc, s.From, s.To)
		if s.Command != nil {
			cmd := "command " + strconv.Itoa(*s.Command)
			if s.CommandName != "" {
				cmd = s.CommandName + " (oct " + strconv.Itoa(*s.Command) + ")"
			}
			if s.Sql != "" {
				if s.SqlID != "" {
					cmd += "; statement " + s.SqlID + ": " + s.SqlText
				} else {
					cmd += "; statement at library handle " + s.Sql + " (not described in this dump)"
				}
			}
			p("  %s", cmd)
			if s.PrevSql != "" {
				if s.PrevSqlID != "" {
					p("  previous statement %s: %s", s.PrevSqlID, s.PrevSqlText)
				} else {
					p("  previous statement at library handle %s (not described in this dump)", s.PrevSql)
				}
			}
		}
		wt := s.Wait
		p("  wait: %s", wt.summary())
		if wt != nil {
			if len(wt.Stack) > 0 && wt.Stack[0].Params != "" {
				p("    %s", wt.Stack[0].Params)
			}
			if len(wt.Blockers) > 0 || wt.Blocked {
				var ks []string
				for _, b := range wt.Blockers {
					ks = append(ks, b.Key)
				}
				line := "blocked by " + strings.Join(ks, ", ")
				if f := wt.FinalBlocker; f != nil {
					line += "; final blocker " + f.Key
				}
				p("  %s", line)
			}
			if wt.BlockedCount > 0 {
				p("  blocks %s", plural(wt.BlockedCount, "session", "sessions"))
				for _, wr := range wt.Waiters {
					line := "    waiter " + wr.Key + " waits for '" + wr.Event + "'"
					if rw := wr.RowWait; rw != nil {
						line += fmt.Sprintf(" (row wait object %d, file %d, block %d, row %d)", rw.Obj, rw.File, rw.Block, rw.Row)
					}
					if wr.MinBlockedSec != nil {
						line += fmt.Sprintf(", blocked at least %d s", *wr.MinBlockedSec)
					}
					p("%s", line)
				}
			}
			if wt.HistoryTotal > 0 {
				var hs []string
				for i, h := range wt.History {
					if i == DigestHistory {
						break
					}
					hs = append(hs, h.Event+" "+secText(h.Seconds))
				}
				more := ""
				if wt.HistoryTotal > len(hs) {
					more = fmt.Sprintf(", and %d more", wt.HistoryTotal-len(hs))
				}
				p("  last waits (latest first): %s%s", strings.Join(hs, "; "), more)
			}
		}
	}
	if len(ps.Objects.ByType) > 0 {
		var ts []string
		for _, t := range ps.Objects.ByType {
			ts = append(ts, fmt.Sprintf("%s %s", t.Type, th64(int64(t.Count))))
		}
		p("state objects by type: %s", strings.Join(ts, ", "))
	}
	if ps.EnqueuesTotal > 0 {
		p("enqueues (%d):", ps.EnqueuesTotal)
		for i, e := range ps.Enqueues {
			if i == DigestHolds {
				p("  ... %d more", ps.EnqueuesTotal-i)
				break
			}
			how := "held"
			if e.Requested {
				how = "requested"
			}
			p("  %s  %s %s  (line %d)", e.Resource, how, orDash(e.Mode), e.Line)
		}
	}
	for _, t := range ps.Transactions {
		line := "transaction"
		if t.Xid != "" {
			line += " " + t.Xid
		}
		if t.UndoBlocks != nil && t.UndoRecords != nil {
			line += fmt.Sprintf(", undo %d blocks %d records", *t.UndoBlocks, *t.UndoRecords)
		}
		if t.Begin != "" {
			line += ", began " + t.Begin
		}
		p("%s (line %d)", line, t.Line)
		for _, b := range t.Blocks {
			p("  block list: itli %d rdba %s statement %s object %d", b.Itli, b.RDBA, b.SQLID, b.Obj)
		}
	}
	for i, d := range ps.DMLLocks {
		if i == DigestHolds {
			p("DML locks: ... %d more", ps.DMLLocksTotal-i)
			break
		}
		mode := ""
		if d.Mode != nil {
			mode = fmt.Sprintf(", mod %d", *d.Mode)
			if d.ModeName != "" {
				mode += " (" + d.ModeName + ")"
			}
		}
		p("DML lock on object %d%s (line %d)", d.Table, mode, d.Line)
	}
	libs := func(label string, list []ProcLibObject, total int) {
		if total == 0 {
			return
		}
		p("%s: %d", label, total)
		for i, l := range list {
			if i == DigestHolds {
				p("  ... %d more", total-i)
				break
			}
			what := l.Name
			if l.SQLID != "" && !strings.Contains(l.Name, l.SQLID) {
				what = l.SQLID + " " + l.Name
			}
			if what == "" {
				what = strings.TrimSpace(l.Namespace + " " + l.Type)
				if what == "" {
					what = "(the dump prints no text for it)"
				} else {
					what += " (no name printed)"
				}
			}
			p("  %s mode %s: %s", l.Handle, orDash(l.Mode), what)
		}
	}
	libs("library object locks", ps.Locks, ps.LocksTotal)
	libs("library object pins", ps.Pins, ps.PinsTotal)
	if ps.ShortStack != "" {
		p("short stack (%d entries of the signal handler left out): %s", ps.ShortStackOwn, ps.ShortStackNoOwn)
	}
	for _, n := range ps.Notes {
		p("note: %s", n)
	}
}
