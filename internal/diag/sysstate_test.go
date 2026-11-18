package diag

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// sysstateFiles are the system state fixtures: level 1 is committed, 2, 258 and 266 are in the ignored big set.
func sysstateFiles(t testing.TB) []string {
	files := []string{filepath.Join(diagDir, "diag_sysstate_l1.trc")}
	for _, n := range []string{"diag_sysstate_l2.trc", "diag_sysstate_l258.trc", "diag_sysstate_l266.trc"} {
		if _, err := os.Stat(filepath.Join(bigDir, n)); err == nil {
			files = append(files, filepath.Join(bigDir, n))
		}
	}
	return files
}

// sysStateOf reads the reading of the first system state of a file.
func sysStateOf(t testing.TB, r *Reader) (Node, *SysState) {
	t.Helper()
	for _, n := range r.Scan.Top {
		if n.Kind == "sysstate" {
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatal(err)
			}
			return n, rd.(*SysState)
		}
	}
	t.Fatal("no system state in the file")
	return Node{}, nil
}

func inNode(t testing.TB, what string, line, from, to int) {
	t.Helper()
	if line != 0 && (line < from || line > to) {
		t.Errorf("%s: line %d is outside the node %d-%d", what, line, from, to)
	}
}

// walkTree calls fn for every node of the forest with its parent ("" for a root).
func walkTree(ns []SysTreeNode, parent string, fn func(n SysTreeNode, parent string)) {
	for _, n := range ns {
		fn(n, parent)
		walkTree(n.Children, n.Session, fn)
	}
}

// TestSysStateInvariants holds on every system state of every fixture: the counts add up, every line reference is
// inside the node, the process nodes resolve to procstate readings that say the same, the tree has every session once
// and every session of it is in the table or marked foreign, and the idle flag is the event reference's.
func TestSysStateInvariants(t *testing.T) {
	for _, fx := range sysstateFiles(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			r := readerOf(t, fx)
			n, st := sysStateOf(t, r)
			sum := processSummary(t, fx)
			if st.From != n.From || st.To != n.To || st.Node != n.ID || n.Reading != "sysstate" {
				t.Errorf("node %+v reading %s %d-%d", n, st.Node, st.From, st.To)
			}
			c := st.Counts
			if c.User+c.Background+c.Pseudo != c.Processes || c.Processes != len(sum) {
				t.Errorf("counts %+v for %d summary entries", c, len(sum))
			}
			if len(st.Processes)+st.ProcessesOmitted != c.Processes || st.ProcessesOmitted != 0 {
				t.Errorf("%d rows + %d omitted for %d processes", len(st.Processes), st.ProcessesOmitted, c.Processes)
			}
			if c.IdleBackground > c.Idle || c.IdleBackground > c.Background || c.WithoutSession > c.Idle {
				t.Errorf("counts %+v", c)
			}
			idle, idleBg, user, bg, pseudo, noSess, moved := 0, 0, 0, 0, 0, 0, 0
			byKey := map[string]*SysProc{}
			ev := map[string]string{} // the events of the fixture and their classes
			for i := range st.Processes {
				p := &st.Processes[i]
				e := sum[i]
				if p.Pid != e.pid || p.Sid != e.sid || p.Serial != e.ser || p.Cmd != e.cmd {
					t.Errorf("row %d %+v: summary %+v", i, p, e)
				}
				wantName := e.name
				if p.Name != wantName {
					t.Errorf("row %d: name %q, summary %q", i, p.Name, e.name)
				}
				switch p.Kind {
				case ProcForeground:
					user++
					if p.Name != "USER" || p.Background {
						t.Errorf("row %+v", p)
					}
				case ProcBackground:
					bg++
					if !p.Background {
						t.Errorf("background row %+v is not flagged", p)
					}
				case ProcPseudo:
					pseudo++
					if p.Background || p.Session != "" {
						t.Errorf("pseudo row %+v", p)
					}
				default:
					t.Errorf("row kind %q", p.Kind)
				}
				if p.Session == "" {
					noSess++
				} else {
					if p.Session != fmt.Sprintf("%d.%d", p.Sid, p.Serial) {
						t.Errorf("row %d session %q for %d.%d", i, p.Session, p.Sid, p.Serial)
					}
					if byKey[p.Session] != nil {
						t.Errorf("session %s in two rows", p.Session)
					}
					byKey[p.Session] = p
				}
				// idle: the class of the event is Idle in the event reference, or the process has no session
				wantIdle := p.Session == "" || (p.Event != "" && ref.Event(p.Event).Class == "Idle")
				if p.Idle != wantIdle {
					t.Errorf("row %d (%s, event %q, class %q): idle %v, want %v", p.Pid, p.Name, p.Event, p.Class, p.Idle, wantIdle)
				}
				if p.Event != "" {
					if p.Class != ref.Event(p.Event).Class {
						t.Errorf("row %d: class %q for %q", p.Pid, p.Class, p.Event)
					}
					ev[p.Event] = p.Class
				}
				if p.Idle {
					idle++
					if p.Background {
						idleBg++
					}
				}
				// line references
				inNode(t, "summary line", p.Line, st.From, st.To)
				inNode(t, "node line", p.NodeLine, st.From, st.To)
				inNode(t, "session line", p.SessionLine, st.From, st.To)
				inNode(t, "sql line", p.SqlLine, st.From, st.To)
				if p.Line < st.SummaryLine || p.Node == "" || !p.Body {
					t.Errorf("row %+v: no node or body", p)
				}
				for _, b := range p.BlockedBy {
					inNode(t, "blocker line", b.Line, st.From, st.To)
				}
				if p.FinalBlocker != nil {
					inNode(t, "final blocker line", p.FinalBlocker.Line, st.From, st.To)
				}
				// the node resolves to the procstate reading of the same process
				rd, err := r.Reading(p.Node)
				if err != nil {
					t.Errorf("row %d: node %s: %v", p.Pid, p.Node, err)
					continue
				}
				ps := rd.(*ProcState)
				if ps.Process == nil || intOf(ps.Process.Pid) != p.Pid || ps.From != p.NodeLine {
					t.Errorf("row %d: procstate reading %+v", p.Pid, ps.Process)
				}
				if p.Session != "" && len(ps.Sessions) > 0 {
					var s *ProcSession
					for k := range ps.Sessions {
						if ps.Sessions[k].Key == p.Session {
							s = &ps.Sessions[k]
						}
					}
					if s == nil {
						t.Errorf("row %d: procstate has no session %s", p.Pid, p.Session)
						continue
					}
					if s.User != p.User || s.Module != p.Module || s.Action != p.Action || s.Program != p.Program || s.SqlID != p.SqlID || s.SqlText != p.SqlText || s.Sql != p.SqlHandle || s.Line != p.SessionLine {
						t.Errorf("row %d: session fields differ: row %+v, procstate %+v", p.Pid, p, s)
					}
					if w := s.Wait; w != nil {
						if w.InWait != p.InWait || w.Blocked != p.Blocked || w.BlockedCount != p.Blocks {
							t.Errorf("row %d: wait %+v, row in wait %v blocked %v blocks %d", p.Pid, w, p.InWait, p.Blocked, p.Blocks)
						}
						if w.InWait && len(w.Stack) > 0 {
							ev := p.Event
							if p.BodyEvent != "" {
								ev = p.BodyEvent
								moved++
							}
							if w.Stack[0].Event != ev || (p.BodyEvent != "" && p.BodyEvent == p.Event) || (w.Stack[0].Seconds == nil) != (p.WaitSec == nil) || (p.WaitSec != nil && *w.Stack[0].Seconds != *p.WaitSec) {
								t.Errorf("row %d: wait stack %+v, row %q (body %q) %v", p.Pid, w.Stack[0], p.Event, p.BodyEvent, p.WaitSec)
							}
						}
						for _, b := range w.Blockers {
							found := false
							for _, x := range p.BlockedBy {
								found = found || x.Key == b.Key
							}
							if !found {
								t.Errorf("row %d: blocker %s of the body is not in the row", p.Pid, b.Key)
							}
						}
					}
				}
			}
			if moved > 0 {
				t.Logf("%d processes wait for another event in their bodies than in the summary", moved)
			}
			if idle != c.Idle || idleBg != c.IdleBackground || user != c.User || bg != c.Background || pseudo != c.Pseudo || noSess != c.WithoutSession {
				t.Errorf("counts %+v, recounted idle %d idleBg %d user %d bg %d pseudo %d noSess %d", c, idle, idleBg, user, bg, pseudo, noSess)
			}
			// the tree
			seen := map[string]bool{}
			count := 0
			walkTree(st.Tree, "", func(tn SysTreeNode, parent string) {
				count++
				if seen[tn.Session] {
					t.Errorf("session %s twice in the tree", tn.Session)
				}
				seen[tn.Session] = true
				if tn.Session != fmt.Sprintf("%d.%d", tn.Sid, tn.Serial) || tn.Children == nil {
					t.Errorf("tree node %+v", tn)
				}
				row := byKey[tn.Session]
				switch {
				case tn.Foreign:
					if row != nil || tn.Node != "" || tn.Pid != nil {
						t.Errorf("foreign node %+v has a row", tn)
					}
				case row == nil:
					t.Errorf("tree session %s is neither in the table nor foreign", tn.Session)
				case tn.Pid == nil || *tn.Pid != row.Pid || tn.Node != row.Node:
					t.Errorf("tree node %+v, row %+v", tn, row)
				}
				inNode(t, "tree line", tn.Line, st.From, st.To)
				d := 0
				walkTree(tn.Children, "", func(SysTreeNode, string) { d++ })
				if tn.Descendants != d && st.TreeOmitted == 0 {
					t.Errorf("node %s: %d descendants, %d below", tn.Session, tn.Descendants, d)
				}
			})
			if count != st.TreeNodes || st.TreeNodes+st.TreeOmitted < count {
				t.Errorf("%d tree nodes, TreeNodes %d omitted %d", count, st.TreeNodes, st.TreeOmitted)
			}
			// every session with a blocker in the table is in the tree, below a node for its first direct blocker
			blocked := 0
			for _, p := range st.Processes {
				if len(p.BlockedBy) > 0 {
					blocked++
					if !seen[p.Session] {
						t.Errorf("blocked session %s is not in the tree", p.Session)
					}
				}
			}
			if blocked != st.Blocked {
				t.Errorf("%d blocked sessions in the table, Blocked %d", blocked, st.Blocked)
			}
			if st.Caller == nil || st.Command == "" || !st.Ended || st.LevelNum == nil || st.Session == "" {
				t.Errorf("header facts %+v", st)
			}
			if !st.SummaryMarks || !st.BodyMarks {
				t.Errorf("marks: summary %v body %v", st.SummaryMarks, st.BodyMarks)
			}
			// the process that took the dump is the one of the header's session
			callers := 0
			for _, p := range st.Processes {
				if p.Caller {
					callers++
					if p.Session != st.Session {
						t.Errorf("caller row %s, session of the trace %s", p.Session, st.Session)
					}
				}
			}
			if callers != 1 {
				t.Errorf("%d caller rows", callers)
			}
			raw, _ := json.Marshal(st)
			if jsonNull.Match(raw) {
				i := jsonNull.FindIndex(raw)
				t.Errorf("a null in the reading: ...%s", raw[max(0, i[0]-60):i[1]])
			}
			// the classes of the events of the fixture: said once, with -v
			var idleEv, busyEv []string
			for e, cl := range ev {
				if ref.Event(e).Idle {
					idleEv = append(idleEv, e+" ("+cl+")")
				} else {
					busyEv = append(busyEv, e+" ("+cl+")")
				}
			}
			sort.Strings(idleEv)
			sort.Strings(busyEv)
			t.Logf("events classed idle: %s", strings.Join(idleEv, "; "))
			t.Logf("events not classed idle: %s", strings.Join(busyEv, "; "))
			if len(busyEv) == 0 || len(idleEv) == 0 {
				t.Errorf("the events of the fixture are all idle or none is: %v %v", idleEv, busyEv)
			}
		})
	}
}

// TestSysStateIdleReference: the event reference decides, an event it does not know is not idle, and a process with
// no session is idle.
func TestSysStateIdleReference(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("SYSTEM STATE (level=1)\n------------\nDumping the Process Summary\n")
	b.WriteString("       1: PSEUDO process\n")
	b.WriteString("       2: PMON ospid 10 sid 1 ser 5, waiting for 'pmon timer' \n")
	b.WriteString("       3: LGWR ospid 11 sid 2 ser 6, waiting for 'log file parallel write' \n")
	b.WriteString("       4: MYST ospid 12 sid 3 ser 7, waiting for 'an event nobody knows' \n")
	b.WriteString("       5: P000 ospid 13 sid 0 ser 0, \n")
	b.WriteString("       6: USER ospid 14 sid 4 ser 8, \n")
	b.WriteString("       7: USER ospid 15 sid 5 ser 9, waiting for 'SQL*Net message from client' \n")
	b.WriteString("System global information:\nEND OF SYSTEM STATE\n")
	r := readerOfBytes(t, b.Bytes())
	_, st := sysStateOf(t, r)
	want := map[int][2]bool{1: {true, false}, 2: {true, true}, 3: {false, true}, 4: {false, true}, 5: {true, true}, 6: {false, false}, 7: {true, false}} // idle, background
	for _, p := range st.Processes {
		w := want[p.Pid]
		if p.Idle != w[0] || p.Background != w[1] {
			t.Errorf("pid %d %s %q: idle %v background %v, want %v", p.Pid, p.Name, p.Event, p.Idle, p.Background, w)
		}
	}
	if ref.Event("an event nobody knows").Idle || ref.Event("log file parallel write").Class != "System I/O" {
		t.Errorf("reference: %+v %+v", ref.Event("an event nobody knows"), ref.Event("log file parallel write"))
	}
	if c := st.Counts; c.Processes != 7 || c.User != 2 || c.Background != 4 || c.Pseudo != 1 || c.Idle != 4 || c.IdleBackground != 2 || c.WithoutSession != 2 {
		t.Errorf("counts %+v", c)
	}
}

// TestSysStateChain: in every level present the tree is the final blocker, its waiter and that one's waiter, for the
// three sessions of the scenario (sc_diag_sysstate.sql / _diag_chain_*.sql), with their statements where the level
// prints the library object locks, and it agrees with the procstate readings of the same processes.
func TestSysStateChain(t *testing.T) {
	for _, fx := range sysstateFiles(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			r := readerOf(t, fx)
			_, st := sysStateOf(t, r)
			if len(st.Tree) != 1 || st.Roots != 1 || st.Blocked != 2 || st.TreeNodes != 3 || st.TreeOmitted != 0 {
				t.Fatalf("tree %d roots, %d blocked, %d nodes", st.Roots, st.Blocked, st.TreeNodes)
			}
			root := st.Tree[0]
			if len(root.Children) != 1 || len(root.Children[0].Children) != 1 || len(root.Children[0].Children[0].Children) != 0 {
				t.Fatalf("the tree is not a chain: %+v", root)
			}
			mid, last := root.Children[0], root.Children[0].Children[0]
			// roles: the final blocker holds a lock and sleeps, the middle waits for it and holds another, the last waits for that
			if root.Foreign || root.Blocks != 2 || root.Descendants != 2 || root.Event != "PL/SQL lock timer" || root.WaitSec == nil || *root.WaitSec <= 0 ||
				root.User != "MTK" || root.Module != "mtk_diag_chain" || root.Action != "s1_holds_301" || root.Cmd != "PL/SQL EXECUTE" || root.FinalBlocker != "" || root.Inst == nil || *root.Inst != 1 {
				t.Errorf("root %+v", root)
			}
			if mid.Blocks != 1 || mid.Descendants != 1 || mid.Event != "enq: TX - row lock contention" || mid.Action != "s2_holds_302_waits_301" || mid.Cmd != "SELECT" || mid.FinalBlocker != root.Session {
				t.Errorf("middle %+v", mid)
			}
			if last.Blocks != 0 || last.Event != "enq: TX - row lock contention" || last.Action != "s3_waits_302" || last.Cmd != "SELECT" || last.FinalBlocker != root.Session || last.WaitSec == nil || *last.WaitSec <= 0 {
				t.Errorf("last %+v", last)
			}
			if *root.WaitSec < *mid.WaitSec-60 || *mid.WaitSec < *last.WaitSec { // the middle waited before the last one
				t.Errorf("time in wait: root %v middle %v last %v", *root.WaitSec, *mid.WaitSec, *last.WaitSec)
			}
			// the statements, where the level prints them
			level := *st.LevelNum
			if level == 1 {
				if root.SqlID != "" || mid.SqlID != "" || last.SqlID != "" {
					t.Errorf("a level 1 dump resolves statements: %q %q %q", root.SqlID, mid.SqlID, last.SqlID)
				}
			} else {
				if !strings.HasPrefix(strings.ToLower(root.SqlText), "begin dbms_session.sleep(") || root.SqlID == "" {
					t.Errorf("root statement %q %q", root.SqlID, root.SqlText)
				}
				if mid.SqlText != "select id from mtk_cust where id = 301 for update wait 60" || last.SqlText != "select id from mtk_cust where id = 302 for update wait 60" {
					t.Errorf("statements %q / %q", mid.SqlText, last.SqlText)
				}
			}
			// the procstate readings of the same processes say the same
			for _, tn := range []SysTreeNode{root, mid, last} {
				rd, err := r.Reading(tn.Node)
				if err != nil {
					t.Fatal(err)
				}
				ps := rd.(*ProcState)
				if len(ps.Sessions) != 1 || ps.Sessions[0].Key != tn.Session || intOf(ps.Process.Pid) != *tn.Pid {
					t.Fatalf("procstate of %s: %+v", tn.Session, ps.Sessions)
				}
				s := ps.Sessions[0]
				if s.Wait == nil || !s.Wait.InWait || s.Wait.Stack[0].Event != tn.Event || s.Wait.Stack[0].Seconds == nil || *s.Wait.Stack[0].Seconds != *tn.WaitSec {
					t.Errorf("%s: wait %+v, tree event %q %v", tn.Session, s.Wait, tn.Event, tn.WaitSec)
				}
				if s.SqlID != tn.SqlID || s.SqlText != tn.SqlText || s.Module != tn.Module || s.Action != tn.Action || s.User != tn.User {
					t.Errorf("%s: procstate %+v, tree %+v", tn.Session, s, tn)
				}
			}
			ms := func(key string) *ProcSession {
				for _, p := range st.Processes {
					if p.Session == key {
						rd, _ := r.Reading(p.Node)
						return &rd.(*ProcState).Sessions[0]
					}
				}
				return nil
			}
			hs, mss, ls := ms(root.Session), ms(mid.Session), ms(last.Session)
			if hs.Wait.BlockedCount != 2 || hs.Wait.Waiters[0].Key != mid.Session || mss.Wait.BlockedCount != 1 || mss.Wait.Waiters[0].Key != last.Session ||
				mss.Wait.Blockers[0].Key != root.Session || ls.Wait.Blockers[0].Key != mid.Session || ls.Wait.FinalBlocker.Key != root.Session {
				t.Errorf("the procstate readings do not name each other as the tree does")
			}
			// the rows of the table
			byKey := map[string]SysProc{}
			for _, p := range st.Processes {
				byKey[p.Session] = p
			}
			if p := byKey[last.Session]; len(p.BlockedBy) != 1 || p.BlockedBy[0].Key != mid.Session || p.FinalBlocker == nil || p.FinalBlocker.Key != root.Session || !p.Blocked || p.Idle {
				t.Errorf("row of the last session %+v", p)
			}
			if p := byKey[root.Session]; len(p.BlockedBy) != 0 || p.Blocked || p.Blocks != 2 {
				t.Errorf("row of the root %+v", p)
			}
		})
	}
}

// ---- bounds, prefixes, mutations, speed

// syntheticSysState makes a system state of n processes: the pseudo process and n-1 others, a quarter of them
// foreground sessions with a wait; chain sessions (a chain of that length, the first one the final blocker) among
// the first foreground processes.
func syntheticSysState(n, chain int, bodies bool) []byte {
	var b bytes.Buffer
	b.WriteString("Trace file x.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\n\n")
	b.WriteString("*** SESSION ID:(1.1) 2026-11-17T21:34:58.590552+00:00\n \n")
	b.WriteString("Processing Oradebug command 'dump systemstate 10'\n\n===================================================\nSYSTEM STATE (level=10)\n------------\nDumping the Process Summary\n")
	b.WriteString("       1: PSEUDO process\n")
	type sess struct{ sid, ser int }
	fg := []sess{}
	for i := 2; i <= n; i++ {
		switch {
		case i%4 == 0:
			sid := 1000 + i
			fg = append(fg, sess{sid, 7})
			fmt.Fprintf(&b, "%8d: USER ospid %d sid %d ser 7, waiting for 'SQL*Net message from client' \n", i, 5000+i, sid)
			if len(fg) <= chain {
				// a chain: the first is the final blocker, each next one is blocked by the one before
				if len(fg) > 1 {
					prev := fg[len(fg)-2]
					fmt.Fprintf(&b, "          Blocked by inst: 1, sid: %d, ser: %d\n          Final Blocker inst: 1, sid: %d, ser: %d\n", prev.sid, prev.ser, fg[0].sid, fg[0].ser)
				}
			}
		case i%7 == 0:
			fmt.Fprintf(&b, "%8d: P%03d ospid %d sid 0 ser 0, \n", i, i%1000, 5000+i)
		default:
			fmt.Fprintf(&b, "%8d: M%03d ospid %d sid %d ser 3, waiting for 'rdbms ipc message' \n", i, i%1000, 5000+i, 20+i)
		}
	}
	b.WriteString("System global information:\n     processes: base 0xa252ed08, size 300\n")
	if bodies {
		for i := 1; i <= n; i++ {
			fmt.Fprintf(&b, "PROCESS %d: \n----------------------------------------\nSO: 0x%x, type: process (2), map: 0x1\n    state: LIVE (0x4532), flags: 0x1\n    owner: (nil), proc: 0x%x\n", i, 0x1000+i, 0x1000+i)
			fmt.Fprintf(&b, "(process) Oracle pid:%d, ser:1, calls cur/top: 0x1/0x1\n", i)
			if i%4 == 0 && i > 1 {
				fmt.Fprintf(&b, "SO: 0x%x, type: session (4), map: 0x2\n    owner: 0x%x, proc: 0x%x\n(session) sid: %d ser: 7 trans: 0x1, creator: 0x1\n          user#/name: 165/MTK\n          oct: 3, prv: 0, sql: 0x7977a128, psql: 0x0\nCurrent Wait Stack:\n 0: waiting for 'SQL*Net message from client'\n    wait times: snap=1.5 sec, exc=1.5 sec, total=1.5 sec\n", 0x9000+i, 0x1000+i, 0x1000+i, 1000+i)
			}
		}
	}
	b.WriteString("END OF SYSTEM STATE\n")
	return b.Bytes()
}

// TestSysStateBounds: a system state of 5,000 processes keeps its table and tree to the bounds and counts the rest;
// the sessions of a chain longer than the tree's bound are all counted.
func TestSysStateBounds(t *testing.T) {
	data := syntheticSysState(5000, 400, true)
	r := readerOfBytes(t, data)
	start := time.Now()
	_, st := sysStateOf(t, r)
	t.Logf("5,000 processes, %d lines: reading in %v", r.src.Lines(), time.Since(start))
	c := st.Counts
	if c.Processes != 5000 || c.Pseudo != 1 || c.User+c.Background != 4999 || c.Omitted != 0 {
		t.Errorf("counts %+v", c)
	}
	// the table: SysRowCap rows in file order, then the rows of blocked and blocking sessions beyond them
	if len(st.Processes) < SysRowCap || len(st.Processes)+st.ProcessesOmitted != 5000 || st.ProcessesOmitted == 0 {
		t.Errorf("%d rows, %d omitted", len(st.Processes), st.ProcessesOmitted)
	}
	if len(st.Processes) > 2*SysRowCap {
		t.Errorf("%d rows", len(st.Processes))
	}
	last := -1
	for i, p := range st.Processes {
		if p.Pid <= last {
			t.Fatalf("row %d: pid %d after %d", i, p.Pid, last)
		}
		last = p.Pid
	}
	// every blocked or blocking session of the chain is listed, though the chain's sessions go beyond row 3000
	chainRows := 0
	for _, p := range st.Processes {
		if len(p.BlockedBy) > 0 {
			chainRows++
		}
	}
	if chainRows != 399 || st.Blocked != 399 {
		t.Errorf("%d blocked rows, Blocked %d, want 399", chainRows, st.Blocked)
	}
	if st.TreeNodes != SysTreeCap || st.TreeOmitted != 400-SysTreeCap {
		t.Errorf("tree nodes %d, omitted %d", st.TreeNodes, st.TreeOmitted)
	}
	depth := 0
	for n := st.Tree[0]; ; n = n.Children[0] {
		depth++
		if len(n.Children) == 0 {
			break
		}
	}
	if depth != SysTreeCap {
		t.Errorf("tree depth %d", depth)
	}
	if st.Tree[0].Descendants != 399 || st.Tree[0].Blocks != 399 {
		t.Errorf("root %+v", st.Tree[0])
	}
	found := false
	for _, n := range st.Notes {
		found = found || strings.Contains(n, "are not listed")
	}
	if !found {
		t.Errorf("notes %v", st.Notes)
	}
	// the text digest says what it leaves out and stays short
	var b bytes.Buffer
	writeSysStateText(&b, "", st)
	if lines := strings.Count(b.String(), "\n"); lines > DigestProcRows+DigestTreeNodes*3+30 {
		t.Errorf("the text is %d lines", lines)
	}
	for _, want := range []string{"5,000 processes", "idle background", "more rows not printed", "more sessions not printed"} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("the text has no %q:\n%.600s", want, b.String())
		}
	}
	// JSON size of the reading
	raw, _ := json.Marshal(st)
	t.Logf("JSON of the reading: %d bytes", len(raw))
	if len(raw) > DigestReadingBytes {
		t.Errorf("the reading is %d bytes of JSON", len(raw))
	}
}

// TestSysStateForeignAndCycle: a blocker that is not a session of the dump is a foreign node, a cycle of direct blockers
// is cut at the session that closes it, a session with two direct blockers stands under the first.
func TestSysStateForeignAndCycle(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("SYSTEM STATE (level=1)\n------------\nDumping the Process Summary\n")
	b.WriteString("       2: USER ospid 10 sid 10 ser 1, waiting for 'enq: TX - row lock contention' \n          Blocked by inst: 2, sid: 99, ser: 5\n          Final Blocker inst: 2, sid: 99, ser: 5\n")
	b.WriteString("       3: USER ospid 11 sid 11 ser 1, waiting for 'enq: TX - row lock contention' \n          Blocked by inst: 1, sid: 12, ser: 1\n          Final Blocker inst: 1, sid: 12, ser: 1\n")
	b.WriteString("       4: USER ospid 12 sid 12 ser 1, waiting for 'enq: TX - row lock contention' \n          Blocked by inst: 1, sid: 11, ser: 1\n          Final Blocker inst: 1, sid: 11, ser: 1\n")
	b.WriteString("       5: USER ospid 13 sid 13 ser 1, waiting for 'enq: TX - row lock contention' \n          Blocked by inst: 1, sid: 10, ser: 1\n          Blocked by inst: 1, sid: 14, ser: 1\n          Final Blocker inst: 2, sid: 99, ser: 5\n")
	b.WriteString("       6: USER ospid 14 sid 14 ser 1, waiting for 'PL/SQL lock timer' \n")
	b.WriteString("       7: USER ospid 15 sid 15 ser 1, waiting for 'enq: TX - row lock contention' \n          Blocked by inst: 1, sid: 12, ser: 9\n")
	b.WriteString("System global information:\nEND OF SYSTEM STATE\n")
	r := readerOfBytes(t, b.Bytes())
	_, st := sysStateOf(t, r)
	nodes := map[string]SysTreeNode{}
	walkTree(st.Tree, "", func(n SysTreeNode, parent string) { nodes[n.Session] = n })
	if st.Blocked != 5 || len(nodes) != 8 {
		t.Fatalf("blocked %d, %d nodes: %+v", st.Blocked, len(nodes), st.Tree)
	}
	if n := nodes["99.5"]; !n.Foreign || n.Inst == nil || *n.Inst != 2 || n.Pid != nil || n.Line == 0 {
		t.Errorf("foreign blocker %+v", n)
	}
	if n := nodes["12.9"]; !n.Foreign {
		t.Errorf("a blocker with another serial than the session of the dump is not foreign: %+v", n)
	}
	cut := 0
	for _, n := range nodes {
		if n.Cycle {
			cut++
		}
	}
	if cut != 1 {
		t.Errorf("%d nodes cut for the cycle of 11 and 12", cut)
	}
	if n := nodes["13.1"]; len(n.AlsoBlockedBy) != 1 || n.AlsoBlockedBy[0] != "14.1" {
		t.Errorf("a session with two direct blockers: %+v", n)
	}
	// 13 stands under 10, its first blocker, which stands under the foreign session
	var path []string
	var find func(ns []SysTreeNode, trail []string) bool
	find = func(ns []SysTreeNode, trail []string) bool {
		for _, n := range ns {
			tr := append(append([]string{}, trail...), n.Session)
			if n.Session == "13.1" {
				path = tr
				return true
			}
			if find(n.Children, tr) {
				return true
			}
		}
		return false
	}
	find(st.Tree, nil)
	if strings.Join(path, ">") != "99.5>10.1>13.1" {
		t.Errorf("path to 13.1: %v", path)
	}
	found := false
	for _, n := range st.Notes {
		found = found || strings.Contains(n, "lead back to it")
	}
	if !found {
		t.Errorf("notes %v", st.Notes)
	}
}

// TestSysStatePrefixes: every prefix of the system state fixture reads without a panic and a cut dump says so.
func TestSysStatePrefixes(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_sysstate_l1.trc"))
	if err != nil {
		t.Fatal(err)
	}
	for k := 0; k <= 60; k++ {
		cut := len(data) * k / 60
		r := readerOfBytes(t, data[:cut])
		for _, n := range r.Scan.Top {
			if n.Kind != "sysstate" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatalf("prefix %d: %v", cut, err)
			}
			st := rd.(*SysState)
			if cut < len(data)-2 && st.Ended {
				t.Errorf("prefix %d of %d: ended", cut, len(data))
			}
			if !st.Ended {
				said := false
				for _, nn := range st.Notes {
					said = said || strings.Contains(nn, "cut short")
				}
				if !said {
					t.Errorf("prefix %d: a cut dump does not say so: %v", cut, st.Notes)
				}
			}
			var b bytes.Buffer
			writeSysStateText(&b, "", st)
			// every tree session is in the table or foreign
			byKey := map[string]bool{}
			for _, p := range st.Processes {
				byKey[p.Session] = true
			}
			walkTree(st.Tree, "", func(tn SysTreeNode, parent string) {
				if !tn.Foreign && !byKey[tn.Session] {
					t.Errorf("prefix %d: %s is neither in the table nor foreign", cut, tn.Session)
				}
			})
		}
	}
}

// TestSysStateMutations: damaged system states read without a panic and the tree keeps its invariants.
func TestSysStateMutations(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_sysstate_l1.trc"))
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Split(string(data), "\n")
	// the summary, the first process bodies, and the blocked ones
	ls := append(append([]string{}, all[:130]...), all[18490:18900]...)
	ls = append(ls, all[21490:21700]...)
	ls = append(ls, "END OF SYSTEM STATE")
	junk := []string{
		"          Blocked by inst: 1, sid: 52, ser: 41898", "          Final Blocker inst: 1, sid: 255, ser: 62769", "          Blocked by inst: 1, sid: 255, ser: 62769",
		"      61: USER ospid 13947 sid 255 ser 62769, waiting for 'x'", "       9999999999: USER", "PROCESS 61: ", "PROCESS 68: ", "PROCESS : ",
		"SYSTEM STATE (level=10, with short stacks)", "Dumping the Process Summary", "END OF SYSTEM STATE", "System global information:", "", " ", "(session) sid: 52 ser: 41898 trans: 0x1",
		"          Cmd: SELECT", "          Blocked by inst: x, sid: y", "SO: 0x1, type: session (4), map: 0x2",
	}
	rng := rand.New(rand.NewSource(7))
	for it := 0; it < 300; it++ {
		m := append([]string(nil), ls...)
		for k := rng.Intn(30) + 1; k > 0; k-- {
			i := rng.Intn(len(m))
			switch rng.Intn(5) {
			case 0:
				m = append(m[:i], m[i+1:]...)
			case 1:
				m = append(m[:i], append([]string{m[i]}, m[i:]...)...)
			case 2:
				j := rng.Intn(len(m))
				m[i], m[j] = m[j], m[i]
			case 3:
				m[i] = junk[rng.Intn(len(junk))]
			case 4:
				m = append(m[:i], append([]string{junk[rng.Intn(len(junk))]}, m[i:]...)...)
			}
		}
		r := readerOfBytes(t, []byte(strings.Join(m, "\n")))
		for _, n := range r.Scan.Top {
			if n.Kind != "sysstate" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatalf("mutation %d: %v", it, err)
			}
			st := rd.(*SysState)
			seen := map[string]bool{}
			walkTree(st.Tree, "", func(tn SysTreeNode, parent string) {
				if seen[tn.Session] {
					t.Fatalf("mutation %d: %s twice in the tree", it, tn.Session)
				}
				seen[tn.Session] = true
			})
			if st.Counts.User+st.Counts.Background+st.Counts.Pseudo != st.Counts.Processes {
				t.Fatalf("mutation %d: counts %+v", it, st.Counts)
			}
			var b bytes.Buffer
			writeSysStateText(&b, "", st)
			if _, err := json.Marshal(st); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// TestSysStateSpeed: the reading of the level-266 system state and of a synthetic large one (loose floors; the
// numbers are logged).
func TestSysStateSpeed(t *testing.T) {
	big := filepath.Join(bigDir, "diag_sysstate_l266.trc")
	if _, err := os.Stat(big); err == nil {
		r := readerOf(t, big)
		n, _ := sysStateOf(t, r)
		rr := NewReader(r.Scan, r.src)
		start := time.Now()
		if _, err := rr.Reading(n.ID); err != nil {
			t.Fatal(err)
		}
		d := time.Since(start)
		t.Logf("level 266: %d lines, reading in %v", n.Lines, d)
		if d > 3*time.Second {
			t.Errorf("the level 266 reading took %v", d)
		}
	} else {
		t.Logf("%s is not here: the level 266 timing is skipped", big)
	}
	data := syntheticSysState(5000, 10, true)
	r := readerOfBytes(t, data)
	n, _ := sysStateOf(t, r)
	rr := NewReader(r.Scan, r.src)
	start := time.Now()
	if _, err := rr.Reading(n.ID); err != nil {
		t.Fatal(err)
	}
	d := time.Since(start)
	t.Logf("synthetic, 5,000 processes, %d lines (%d MB): reading in %v", n.Lines, len(data)>>20, d)
	if d > 3*time.Second {
		t.Errorf("the reading of 5,000 processes took %v", d)
	}
	data = syntheticSysState(40000, 10, true)
	r = readerOfBytes(t, data)
	n, _ = sysStateOf(t, r)
	rr = NewReader(r.Scan, r.src)
	start = time.Now()
	if _, err := rr.Reading(n.ID); err != nil {
		t.Fatal(err)
	}
	d = time.Since(start)
	t.Logf("synthetic, 40,000 processes, %d lines (%d MB): reading in %v", n.Lines, len(data)>>20, d)
	if d > 10*time.Second {
		t.Errorf("the reading of 40,000 processes took %v", d)
	}
}

// TestSysStateDigest: the text digest of a system state leaves out the idle background processes and says how many,
// keeps the blocked and blocking sessions, and the document's digest holds the reading.
func TestSysStateDigest(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_sysstate_l1.trc"))
	_, st := sysStateOf(t, r)
	var b bytes.Buffer
	if err := WriteDigest(&b, r); err != nil {
		t.Fatal(err)
	}
	text := b.String()
	hidden := fmt.Sprintf("(%s left out)", plural(st.Counts.IdleBackground, "idle background process", "idle background processes"))
	for _, want := range []string{hidden, "52.41898", "45.12004", "255.62769", "PL/SQL lock timer", "blocker tree: 3 sessions in 1 chain, 2 blocked", "82 processes"} {
		if !strings.Contains(text, want) {
			t.Errorf("the text has no %q", want)
		}
	}
	// the table of the text: every row but the idle background ones, as "pid name ospid session ..."
	a, z := strings.Index(text, "process table"), strings.Index(text, "blocker tree")
	if a < 0 || z < a {
		t.Fatalf("no process table in the text")
	}
	inTable := map[string]bool{}
	for _, l := range strings.Split(text[a:z], "\n")[1:] {
		if f := strings.Fields(l); len(f) >= 2 {
			inTable[f[0]+" "+f[1]] = true
		}
	}
	listed := 0
	for _, p := range st.Processes {
		key := fmt.Sprintf("%d %s", p.Pid, p.Name)
		hide := p.Idle && p.Background && len(p.BlockedBy) == 0 && p.Blocks == 0 && !p.Caller
		if hide && inTable[key] {
			t.Errorf("idle background process %s is in the table", key)
		}
		if !hide {
			listed++
			if !inTable[key] {
				t.Errorf("process %s is not in the table", key)
			}
		}
	}
	if listed != len(inTable) {
		t.Errorf("%d rows listed, %d in the text", listed, len(inTable))
	}
	d, err := r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := d.Readings[st.Node]
	if !ok {
		t.Fatalf("the digest holds no system state reading")
	}
	var back SysState
	if err := json.Unmarshal(raw, &back); err != nil || back.Counts != st.Counts || len(back.Processes) != len(st.Processes) || back.TreeNodes != st.TreeNodes {
		t.Errorf("the digest's reading: %v %+v", err, back.Counts)
	}
}
