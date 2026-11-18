package diag

import (
	"fmt"
	"io"
	"strconv"
	"strings"
)

// The text of the system state, hang analysis and deadlock readings, for the digest (docs/PLAN-DIAG.md § Clients:
// text and UI equal in numbers). A list a reading bounds is printed to a shorter bound here and says so; idle
// background processes of a system state are left out of the table and counted.

const (
	// DigestProcRows is how many rows of the process table the text digest prints.
	DigestProcRows = 150
	// DigestTreeNodes is how many nodes of the blocker tree the text digest prints.
	DigestTreeNodes = 60
	// DigestChains and DigestChainSessions bound the chains of a hang analysis in the text.
	DigestChains        = 12
	DigestChainSessions = 12
	// DigestStatement is how many bytes of a statement a one-line mention keeps.
	DigestStatement = 90
	// DigestStack is how many bytes of a short stack the text keeps.
	DigestStack = 200
	// DigestNodeRows is how many rows of a hang analysis node table the text prints.
	DigestNodeRows = 20
)

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		s = strings.TrimRight(s[:n], " ") + "..."
	}
	return s
}

func secs(f *float64) string {
	if f == nil {
		return ""
	}
	return strconv.FormatFloat(*f, 'f', -1, 64) + " s"
}

func writeSysStateText(w io.Writer, indent string, st *SysState) {
	p := func(format string, a ...any) { fmt.Fprintf(w, indent+format+"\n", a...) }
	head := "system state, " + st.Level
	if st.Command != "" {
		head += " (taken by oradebug \"" + st.Command + "\")"
	}
	p("%s", head)
	if st.Session != "" {
		p("written by session %s", st.Session)
	}
	if c := st.Caller; c != nil {
		p("caller's stack (line %d): %s", c.Line, oneLine(c.StackNoOwn, DigestStack))
	}
	c := st.Counts
	p("%s: %s user, %s background, %s pseudo; %s idle (%s background), %s without a session",
		plural(c.Processes, "process", "processes"), th64(int64(c.User)), th64(int64(c.Background)), th64(int64(c.Pseudo)),
		th64(int64(c.Idle)), th64(int64(c.IdleBackground)), th64(int64(c.WithoutSession)))
	switch {
	case st.SummaryMarks || st.BodyMarks:
		var from []string
		if st.SummaryMarks {
			from = append(from, "the summary's Blocked by / Final Blocker lines")
		}
		if st.BodyMarks {
			from = append(from, "the bodies' direct blocker lines")
		}
		p("blockers named in: %s", strings.Join(from, ", "))
	default:
		p("blockers named in: nowhere (no process is blocked)")
	}
	// the tree's sessions always show in the table
	inTree := map[string]bool{}
	var walk func(ns []SysTreeNode)
	walk = func(ns []SysTreeNode) {
		for _, n := range ns {
			inTree[n.Session] = true
			walk(n.Children)
		}
	}
	walk(st.Tree)
	var rows [][]string
	left, shown := 0, 0
	for _, r := range st.Processes {
		if r.Idle && r.Background && len(r.BlockedBy) == 0 && r.FinalBlocker == nil && r.Blocks == 0 && !inTree[r.Session] && !r.Caller {
			left++
			continue
		}
		shown++
		if len(rows) >= DigestProcRows {
			continue
		}
		ev := r.Event
		if ev != "" {
			ev = "'" + ev + "'"
			if r.Class != "" {
				ev += " (" + r.Class + ")"
			}
		} else if r.Session == "" {
			ev = "(no session)"
		} else if r.InWait {
			ev = "(waiting)"
		} else {
			ev = "(not in wait)"
		}
		if r.BodyEvent != "" {
			ev += " [body: '" + r.BodyEvent + "']"
		}
		wait := secs(r.WaitSec)
		who := strings.Join(nonEmpty(r.User, strings.Trim(r.Module+" / "+r.Action, " /")), " ")
		stmt := ""
		switch {
		case r.SqlID != "":
			stmt = r.SqlID + " " + oneLine(r.SqlText, DigestStatement)
		case r.SqlHandle != "":
			stmt = "handle " + r.SqlHandle
		}
		flags := ""
		if r.Caller {
			flags = "caller"
		}
		rows = append(rows, []string{strconv.Itoa(r.Pid), r.Name, r.OSPid, orDash(r.Session), ev, wait, who, r.Cmd, stmt, flags})
	}
	if len(rows) > 0 {
		hide := ""
		if left > 0 {
			hide = fmt.Sprintf(" (%s left out)", plural(left, "idle background process", "idle background processes"))
		}
		p("process table%s: pid, name, ospid, session, waiting for, time in wait, user module / action, command, statement", hide)
		table(w, indent+"  ", rows, true)
		if shown > len(rows) {
			p("  ... %d more rows not printed", shown-len(rows))
		}
	} else if left > 0 {
		p("process table: %s left out", plural(left, "idle background process", "idle background processes"))
	}
	if st.ProcessesOmitted > 0 {
		p("%s are not in the reading at all (bound %d rows)", plural(st.ProcessesOmitted, "process", "processes"), SysRowCap)
	}
	if len(st.Tree) == 0 {
		p("blocker tree: no session is blocked")
	} else {
		p("blocker tree: %s in %s, %d blocked (roots are the final blockers):", plural(st.TreeNodes, "session", "sessions"), plural(st.Roots, "chain", "chains"), st.Blocked)
		count := 0
		var out func(ns []SysTreeNode, depth int)
		out = func(ns []SysTreeNode, depth int) {
			for _, n := range ns {
				if count >= DigestTreeNodes {
					return
				}
				count++
				pad := strings.Repeat("  ", depth)
				line := n.Session
				if n.Foreign {
					line += " (not in this dump"
					if n.Inst != nil {
						line += ": instance " + strconv.Itoa(*n.Inst)
					}
					line += ")"
				} else {
					var bits []string
					if n.Pid != nil {
						bits = append(bits, "pid "+strconv.Itoa(*n.Pid))
					}
					if n.User != "" {
						bits = append(bits, n.User)
					}
					if m := strings.Trim(n.Module+" / "+n.Action, " /"); m != "" {
						bits = append(bits, m)
					}
					if len(bits) > 0 {
						line += " (" + strings.Join(bits, ", ") + ")"
					}
					switch {
					case n.Event != "":
						line += " " + "'" + n.Event + "'"
						if n.WaitSec != nil {
							line += " " + secs(n.WaitSec)
						}
					case !n.InWait:
						line += " not in wait"
					}
				}
				if n.Blocks > 0 {
					line += ", blocks " + strconv.Itoa(n.Blocks)
				}
				if n.Cycle {
					line += ", cycle cut here"
				}
				p("  %s%s", pad, line)
				switch {
				case n.SqlID != "":
					p("  %s    statement %s: %s", pad, n.SqlID, oneLine(n.SqlText, DigestStatement))
				case n.Cmd != "":
					p("  %s    command %s", pad, n.Cmd)
				}
				if len(n.AlsoBlockedBy) > 0 {
					p("  %s    also blocked by %s", pad, strings.Join(n.AlsoBlockedBy, ", "))
				}
				out(n.Children, depth+1)
			}
		}
		out(st.Tree, 0)
		if st.TreeNodes > count {
			p("  ... %d more sessions not printed", st.TreeNodes-count)
		}
		if st.TreeOmitted > 0 {
			p("  ... %d more sessions are not in the reading (bound %d nodes)", st.TreeOmitted, SysTreeCap)
		}
	}
	for _, n := range st.Notes {
		p("note: %s", n)
	}
}

func nonEmpty(ss ...string) []string {
	var out []string
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func writeHangText(w io.Writer, indent string, h *HangReading) {
	p := func(format string, a ...any) { fmt.Fprintf(w, indent+format+"\n", a...) }
	head := "hang analysis"
	if len(h.Instances) > 0 {
		head += ", instances " + strings.Join(h.Instances, ", ")
	}
	if h.Level != nil {
		head += ", node dump level " + strconv.Itoa(*h.Level)
	}
	if h.InitiatedBy != "" {
		head += ", initiated by " + h.InitiatedBy
	}
	p("%s", head)
	if len(h.Listed) > 0 {
		p("chains most likely to have caused the hang (%d; each signature lists the head's event first):", len(h.Listed))
		for _, l := range h.Listed {
			p("  [%s] chain %d: %s  hash %s", l.Letter, l.Chain, strings.Join(quoteAll(l.Events), " <= "), l.Hash)
		}
	}
	for i, c := range h.Chains {
		if i == DigestChains {
			p("... %d more chains", len(h.Chains)-i)
			break
		}
		grp := ""
		if c.Group != "" {
			grp = c.Group + ", "
		}
		lt := ""
		if c.Listed {
			lt = " [" + c.Letter + "]"
		}
		p("chain %d%s (%slines %d-%d): %s; the first session waits, each next one blocks the one before it", c.N, lt, grp, c.From, c.To, plural(c.SessionsTotal, "session", "sessions"))
		for j, s := range c.Sessions {
			if j == DigestChainSessions {
				p("  ... %d more sessions", len(c.Sessions)-j)
				break
			}
			who := "session " + s.Key
			var bits []string
			if s.Instance != "" {
				bits = append(bits, "instance "+s.Instance)
			}
			if s.OSId != "" {
				bits = append(bits, "os id "+s.OSId)
			}
			if s.ProcessID != nil {
				bits = append(bits, "process "+strconv.Itoa(*s.ProcessID))
			}
			if s.PDB != "" {
				bits = append(bits, "pdb "+s.PDB)
			}
			if s.Module != "" {
				bits = append(bits, "module "+s.Module)
			}
			p("  %d. %s (%s)", s.Position, who, strings.Join(bits, ", "))
			if s.Waiting {
				wl := "waits for '" + s.Event + "'"
				if s.TimeInWaitSec != nil {
					wl += " " + secs(s.TimeInWaitSec)
				}
				if s.TimeoutText != "" {
					wl += ", timeout after " + s.TimeoutText
				}
				if s.Blocking != nil {
					wl += ", blocking " + strconv.Itoa(*s.Blocking)
				}
				p("     %s", wl)
				for _, pr := range s.Params {
					p("       %s", pr)
				}
			} else {
				st := s.State
				if st == "" {
					st = "no wait state printed"
				}
				p("     %s", st)
			}
			if s.SqlIdHigh != nil {
				txt := ""
				if s.SqlText != "" {
					txt = ": " + oneLine(s.SqlText, DigestStatement)
				}
				if *s.SqlIdHigh == 0 {
					p("     statement: none (current sql_id 0)")
				} else {
					p("     statement: current sql_id %d (the high 32 bits of the sql_id, not a hash value)%s", *s.SqlIdHigh, txt)
				}
			}
			if s.ShortStack != "" {
				p("     short stack: %s", oneLine(s.ShortStackNoOwn, DigestStack))
			}
			if s.HistoryTotal > 0 {
				var hs []string
				for k, e := range s.History {
					if k == DigestHistory {
						break
					}
					hs = append(hs, e.Event+" "+secs(e.WaitedS))
				}
				more := ""
				if s.HistoryTotal > len(hs) {
					more = fmt.Sprintf(", and %d more", s.HistoryTotal-len(hs))
				}
				p("     wait history (latest first): %s%s", strings.Join(hs, "; "), more)
			}
		}
	}
	if n := h.Nodes; n != nil {
		p("state of all nodes (%s; adjacency is the node the session is blocked by):", plural(n.Total, "node", "nodes"))
		rows := [][]string{}
		for i, r := range n.Rows {
			if i == DigestNodeRows {
				break
			}
			adj := make([]string, len(r.Adj))
			for k, a := range r.Adj {
				adj[k] = strconv.Itoa(a)
			}
			rows = append(rows, []string{"[" + strconv.Itoa(r.Num) + "]", r.Key, r.OSPid, r.State, strings.Join(adj, ",")})
		}
		table(w, indent+"  ", rows)
		if n.Total > len(rows) {
			p("  ... %d more nodes", n.Total-len(rows))
		}
	}
	if d := h.Dumps; d != nil {
		var bits []string
		if d.Level != nil {
			bits = append(bits, "level "+strconv.Itoa(*d.Level))
		}
		if d.Local != nil {
			bits = append(bits, plural(d.Local.Total, "local node", "local nodes"))
		}
		bits = append(bits, d.Lines...)
		p("analysis dumps (line %d): %s", d.Line, strings.Join(bits, "; "))
	}
	for _, n := range h.Notes {
		p("note: %s", n)
	}
}

func quoteAll(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = "'" + s + "'"
	}
	return out
}

func writeDeadlockText(w io.Writer, indent string, d *Deadlock) {
	p := func(format string, a ...any) { fmt.Fprintf(w, indent+format+"\n", a...) }
	head := "deadlock " + d.ORA
	if d.Type != "" {
		head += " [" + d.Type + "]"
	}
	if d.Victim != nil {
		head += ", the trace was written by session " + d.Victim.Session + " (the victim)"
	}
	p("%s", head)
	if len(d.Graph.Rows) > 0 {
		p("deadlock graph (%s; line %d):", plural(d.Graph.Total, "row", "rows"), d.Graph.Line)
		rows := [][]string{{"resource", "blocker process", "session", "holds", "waits", "serial", "waiter process", "session", "holds", "waits", "serial"}}
		for _, r := range d.Graph.Rows {
			rows = append(rows, []string{r.Resource,
				ip(r.Blocker.Process), ip(r.Blocker.Session), r.Blocker.Holds, r.Blocker.Waits, ip(r.Blocker.Serial),
				ip(r.Waiter.Process), ip(r.Waiter.Session), r.Waiter.Holds, r.Waiter.Waits, ip(r.Waiter.Serial)})
		}
		table(w, indent+"  ", rows)
	}
	if c := d.Cycle; c.Closed {
		var parts []string
		for _, e := range c.Edges {
			parts = append(parts, e.Waiter+" waits for "+e.Resource+" held by "+e.Blocker)
		}
		p("cycle (closes): %s", strings.Join(parts, "; "))
	} else if len(d.Graph.Rows) > 0 {
		p("cycle: the rows do not close one")
	}
	for _, s := range d.Sessions {
		var bits []string
		if s.User != "" {
			bits = append(bits, s.User)
		}
		if s.Container != "" {
			bits = append(bits, "container "+s.Container)
		}
		if s.Program != "" {
			bits = append(bits, s.Program)
		}
		if m := strings.Trim(s.Module+" / "+s.Action, " /"); m != "" {
			bits = append(bits, "module / action "+m)
		}
		p("session %s (lines %d-%d): %s", s.Key, s.From, s.To, strings.Join(bits, ", "))
		if s.HeldResource != "" {
			p("  holds %s, acquired %s", s.HeldResource, s.Acquired)
		}
		if s.SqlText != "" {
			p("  current SQL (line %d): %s", s.SqlLine, oneLine(s.SqlText, 200))
		}
	}
	if rw := d.RowsWaited; rw != nil {
		for _, r := range rw.Rows {
			switch {
			case r.NoRow:
				p("rows waited on: session %d: no row", r.Session)
			default:
				extra := ""
				if r.Objn != nil && r.File != nil && r.Block != nil && r.Slot != nil {
					extra = fmt.Sprintf(" (object %d, file %d, block %d, slot %d)", *r.Objn, *r.File, *r.Block, *r.Slot)
				}
				p("rows waited on: session %d: rowid %s%s", r.Session, r.RowID, extra)
			}
		}
	}
	if d.Dump != nil {
		p("followed by the %s, lines %d-%d (its call stack reading is under that node)", strings.ToLower(d.Dump.Title), d.Dump.From, d.Dump.To)
	}
	for _, n := range d.Notes {
		p("note: %s", n)
	}
}

func ip(p *int) string {
	if p == nil {
		return ""
	}
	return strconv.Itoa(*p)
}
