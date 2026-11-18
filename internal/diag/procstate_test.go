package diag

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// procStates gives the process state readings of a file: every node whose reading is "procstate", with the
// node.
func procStates(t testing.TB, r *Reader) (nodes []Node, out []*ProcState) {
	t.Helper()
	var walk func(n Node)
	walk = func(n Node) {
		if n.Reading == ReadingProcState {
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatalf("Reading(%s): %v", n.ID, err)
			}
			nodes = append(nodes, n)
			out = append(out, rd.(*ProcState))
			return
		}
		if !n.HasChildren || n.Kind == "heap" || n.Kind == "so" {
			return
		}
		for _, c := range allChildren(t, r, n.ID, Cap) {
			walk(c)
		}
	}
	for _, n := range r.Scan.Top {
		walk(n)
	}
	return
}

// jsonNull finds a JSON null value (not the word in a string).
var jsonNull = regexp.MustCompile(`[:\[,]null[,\]}]`)

var soLine = regexp.MustCompile(`^\s*SO: 0x[0-9a-f]+, type: `)

// TestProcStateInvariants holds on every process state of every fixture, the big ones when present: the
// counts by type sum to the state object count, the tree has a depth, every line reference is a line of the
// node and points at what it names, lists are bounded and say how many there are, sessions are named by
// sid.serial.
func TestProcStateInvariants(t *testing.T) {
	files := append(fixtures(t), bigFixtures()...)
	total := 0
	for _, fx := range files {
		r := readerOf(t, fx)
		nodes, pss := procStates(t, r)
		for i, ps := range pss {
			n := nodes[i]
			total++
			name := fixtureName(fx) + " " + n.ID
			// the counts by type
			sum := ps.Objects.TypesOther
			for _, ty := range ps.Objects.ByType {
				if ty.Count <= 0 {
					t.Errorf("%s: type %s with count %d", name, ty.Type, ty.Count)
				}
				sum += ty.Count
			}
			if sum != ps.Objects.Total {
				t.Errorf("%s: counts by type sum to %d, state objects %d", name, sum, ps.Objects.Total)
			}
			if ps.Objects.Total > 0 && (ps.Objects.Depth < 1 || ps.Objects.Depth > ps.Objects.Total) {
				t.Errorf("%s: depth %d of %d objects", name, ps.Objects.Depth, ps.Objects.Total)
			}
			// the total is the number of state object lines of the node (up to the end of the tree)
			raw, err := r.src.Read(n.From, n.Lines)
			if err != nil {
				t.Fatal(err)
			}
			count := 0
			for _, l := range strings.Split(string(raw), "\n") {
				if soLine.MatchString(l) {
					count++
				}
			}
			if count < ps.Objects.Total {
				t.Errorf("%s: %d state objects read, %d SO lines in the node", name, ps.Objects.Total, count)
			}
			if n.Kind == "process" && count != ps.Objects.Total {
				t.Errorf("%s: %d state objects read, %d SO lines in the node", name, ps.Objects.Total, count)
			}
			in := func(what string, line int) {
				if line != 0 && (line < ps.From || line > ps.To) {
					t.Errorf("%s: %s line %d outside the node %d-%d", name, what, line, ps.From, ps.To)
				}
			}
			if ps.Process != nil {
				in("process", ps.Process.Line)
				if ps.Process.Line != 0 && !soLine.MatchString(rawLine(t, r, ps.Process.Line)) {
					t.Errorf("%s: the process object line %d is %q", name, ps.Process.Line, rawLine(t, r, ps.Process.Line))
				}
			}
			if ps.SessionsTotal < len(ps.Sessions) || len(ps.Sessions) > ProcSessionCap {
				t.Errorf("%s: %d sessions listed of %d", name, len(ps.Sessions), ps.SessionsTotal)
			}
			prevTo := 0
			keys := map[string]bool{}
			for _, s := range ps.Sessions {
				in("session", s.Line)
				in("session from", s.From)
				in("session to", s.To)
				if s.From <= prevTo || s.To < s.From {
					t.Errorf("%s: session %s lines %d-%d after %d", name, s.Key, s.From, s.To, prevTo)
				}
				prevTo = s.To
				if s.Key != strconv.Itoa(s.Sid)+"."+strconv.Itoa(s.Serial) || !strings.Contains(rawLine(t, r, s.Line), "sid: "+strconv.Itoa(s.Sid)+" ser: "+strconv.Itoa(s.Serial)) {
					t.Errorf("%s: session %+v at line %q", name, s.Key, rawLine(t, r, s.Line))
				}
				keys[s.Key] = true
				if s.Command != nil && !strings.Contains(rawLine(t, r, s.CommandLine), "oct: "+strconv.Itoa(*s.Command)) {
					t.Errorf("%s: command line %d is %q", name, s.CommandLine, rawLine(t, r, s.CommandLine))
				}
				if s.SqlID != "" {
					// the state object of the lock on the handle: its LibraryObjectLock line names the handle
					found := false
					for k := 0; k < 12 && !found; k++ {
						found = strings.Contains(rawLine(t, r, s.SqlLine+k), "Handle="+s.Sql+" ")
					}
					if !soLine.MatchString(rawLine(t, r, s.SqlLine)) || !found {
						t.Errorf("%s: session %s: sql line %d is %q for handle %s", name, s.Key, s.SqlLine, rawLine(t, r, s.SqlLine), s.Sql)
					}
				}
				w := s.Wait
				if w == nil {
					continue
				}
				in("wait", w.Line)
				if w.InWait != (len(w.Stack) > 0) {
					t.Errorf("%s: session %s: inWait %v with %d stack entries", name, s.Key, w.InWait, len(w.Stack))
				}
				if w.InWait && w.LastEndedSec != nil || !w.InWait && w.Line > 0 && w.LastEndedSec == nil {
					t.Errorf("%s: session %s: in wait %v, last ended %v", name, s.Key, w.InWait, w.LastEndedSec)
				}
				for _, e := range w.Stack {
					in("stack", e.Line)
					if e.Event == "" || !strings.Contains(rawLine(t, r, e.Line), "waiting for '"+e.Event+"'") {
						t.Errorf("%s: wait stack entry %+v at line %q", name, e, rawLine(t, r, e.Line))
					}
				}
				refs := append([]SessionRef{}, w.Blockers...)
				if w.FinalBlocker != nil {
					refs = append(refs, *w.FinalBlocker)
				}
				for _, wr := range w.Waiters {
					refs = append(refs, wr.SessionRef)
					if wr.Event == "" || !strings.Contains(wr.Key, ".") {
						t.Errorf("%s: waiter %+v", name, wr)
					}
				}
				for _, ref := range refs {
					in("session ref", ref.Line)
					if ref.Key != strconv.Itoa(ref.Sid)+"."+strconv.Itoa(ref.Serial) || !strings.Contains(rawLine(t, r, ref.Line), "sid: "+strconv.Itoa(ref.Sid)+", ser: "+strconv.Itoa(ref.Serial)) {
						t.Errorf("%s: session ref %+v at line %q", name, ref, rawLine(t, r, ref.Line))
					}
					if ref.Key == s.Key {
						t.Errorf("%s: session %s names itself", name, s.Key)
					}
				}
				if (len(w.Blockers) > 0) && !w.Blocked {
					t.Errorf("%s: session %s has blockers and is not blocked", name, s.Key)
				}
				if len(w.Waiters) > 0 && w.BlockedCount == 0 {
					t.Errorf("%s: session %s has waiters and blocks none", name, s.Key)
				}
				if w.HistoryTotal < len(w.History) || len(w.History) > HistoryCap {
					t.Errorf("%s: %d history entries of %d", name, len(w.History), w.HistoryTotal)
				}
				prev := 0
				for _, h := range w.History {
					in("history", h.Line)
					if h.Line <= prev || h.Event == "" || !strings.Contains(rawLine(t, r, h.Line), "waited for '"+h.Event+"'") {
						t.Errorf("%s: history entry %+v at line %q", name, h, rawLine(t, r, h.Line))
					}
					prev = h.Line
				}
			}
			// the holds
			if len(ps.Enqueues) > EnqueueCap || ps.EnqueuesTotal < len(ps.Enqueues) || len(ps.Locks) > HoldCap || ps.LocksTotal < len(ps.Locks) ||
				len(ps.Pins) > HoldCap || ps.PinsTotal < len(ps.Pins) || ps.TransactionsTotal < len(ps.Transactions) || ps.DMLLocksTotal < len(ps.DMLLocks) {
				t.Errorf("%s: a list is longer than its total or its bound", name)
			}
			for _, e := range ps.Enqueues {
				in("enqueue", e.Line)
				if !strings.Contains(rawLine(t, r, e.Line), "(enqueue) "+e.Resource) || e.Mode == "" || e.Type == "" || !strings.HasPrefix(e.Resource, e.Type+"-") {
					t.Errorf("%s: enqueue %+v at line %q", name, e, rawLine(t, r, e.Line))
				}
				if e.Session != "" && !keys[e.Session] {
					t.Errorf("%s: enqueue %s belongs to the unknown session %s", name, e.Resource, e.Session)
				}
			}
			types := map[string]int{}
			for _, ty := range ps.Objects.ByType {
				types[ty.Type] = ty.Count
			}
			if ps.TransactionsTotal != types["transaction"] || ps.DMLLocksTotal != types["DML lock"] || ps.LocksTotal != types["LIBRARY OBJECT LOCK"] || ps.PinsTotal != types["LIBRARY OBJECT PIN"] {
				t.Errorf("%s: holds %d/%d/%d/%d against the counts by type %v", name, ps.TransactionsTotal, ps.DMLLocksTotal, ps.LocksTotal, ps.PinsTotal, types)
			}
			for _, tx := range ps.Transactions {
				in("transaction", tx.Line)
				if tx.BlocksTotal < len(tx.Blocks) || len(tx.Blocks) > BlockRowCap {
					t.Errorf("%s: transaction blocks %d of %d", name, len(tx.Blocks), tx.BlocksTotal)
				}
			}
			for _, l := range append(append([]ProcLibObject{}, ps.Locks...), ps.Pins...) {
				in("library object", l.Line)
				if l.Handle == "" || l.Mode == "" {
					t.Errorf("%s: library object %+v", name, l)
				}
			}
			if _, err := json.Marshal(ps); err != nil {
				t.Fatal(err)
			}
			b, _ := json.Marshal(ps)
			if m := jsonNull.FindIndex(b); m != nil {
				t.Errorf("%s: null in the JSON: ...%s", name, string(b)[max(0, m[0]-60):m[1]+10])
			}
		}
	}
	if total < 80 {
		t.Errorf("only %d process readings seen", total)
	}
}

func intOf(p *int) int {
	if p == nil {
		return -1
	}
	return *p
}

// TestProcStateFixture: the process of diag_procstate (scenario: testdata/gen/sc_diag_procstate.sql, a session
// that takes row locks with select ... for update, then runs mtk_diag_outer with processstate level 10).
func TestProcStateFixture(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_procstate.trc"))
	nodes, pss := procStates(t, r)
	if len(pss) != 1 || nodes[0].Kind != "procstate" {
		t.Fatalf("%d readings", len(pss))
	}
	ps := pss[0]
	if ps.Scope != "process state" || ps.Process == nil || intOf(ps.Process.Pid) != 6 || intOf(ps.Process.Serial) != 35 || ps.Process.OSPid != "13832" || ps.Process.OSUser != "oracle" || ps.Process.Flags != "-" {
		t.Errorf("process %+v", ps.Process)
	}
	if len(ps.Sessions) != 1 {
		t.Fatalf("%d sessions", len(ps.Sessions))
	}
	s := ps.Sessions[0]
	if s.Key != "61.21652" || s.User != "MTK" || intOf(s.UserID) != 165 || s.Container != "PDB1" || intOf(s.ContainerID) != 3 || s.Machine != "ol9-19-dg1.localdomain" ||
		s.Program != "sqlplus@ol9-19-dg1.localdomain (TNS V1-V3)" || s.Module != "mtk_diag_procstate" || s.Action != "processstate_10" || s.Service != "pdb1" ||
		intOf(s.Command) != 47 || s.CommandName != "PL/SQL EXECUTE" || s.ClientOSPid != "13830" {
		t.Errorf("session %+v", s)
	}
	if ps.Process.Program != s.Program {
		t.Errorf("process program %q", ps.Process.Program)
	}
	// the statement is found through its library handle: the session prints sql: 0x79a02048
	if s.Sql != "0x79a02048" || s.SqlID != "f3j90cdzgg7d2" || s.SqlText != "begin mtk_diag_outer(:ev, :cid); end;" || s.SqlLine != 667 {
		t.Errorf("statement %q %q %q line %d", s.Sql, s.SqlID, s.SqlText, s.SqlLine)
	}
	if s.PrevSql != "0x799d7ea0" || s.PrevSqlID != "" {
		t.Errorf("previous statement %q %q", s.PrevSql, s.PrevSqlID)
	}
	w := s.Wait
	if w == nil || w.InWait || w.LastEndedSec == nil || *w.LastEndedSec != 0.001319 || w.Blocked || len(w.Blockers) != 0 || w.BlockedCount != 0 || w.HistoryTotal != 10 || len(w.History) != 10 {
		t.Fatalf("wait %+v", w)
	}
	if h := w.History[0]; h.Event != "SQL*Net message from client" || h.Seconds == nil || *h.Seconds != 0.000156 || h.Params != "driver id=0x74637000, #bytes=0x1, =0x0" {
		t.Errorf("history %+v", h)
	}
	if w.ElapsedSec == nil || *w.ElapsedSec != 0.001335 {
		t.Errorf("elapsed %v", w.ElapsedSec)
	}
	// the state objects, by type as printed
	want := map[string]int{"LIBRARY OBJECT LOCK": 39, "LIBRARY OBJECT PIN": 2, "call": 2, "channel handle": 2, "Block List": 1, "DML lock": 1, "OS proc request holder": 1,
		"dummy": 1, "enqueue": 1, "ksz parent": 1, "process": 1, "session": 1, "transaction": 1}
	got := map[string]int{}
	for _, ty := range ps.Objects.ByType {
		got[ty.Type] = ty.Count
	}
	if fmt.Sprint(got) != fmt.Sprint(want) || ps.Objects.Total != 54 || ps.Objects.Depth != 4 {
		t.Errorf("objects %v total %d depth %d", got, ps.Objects.Total, ps.Objects.Depth)
	}
	// what the scenario took: a row lock on mtk_cust (a TX enqueue held X, a TM enqueue held SX, the transaction
	// with one undo block, a DML lock on the table, the block list naming it)
	enq := map[string]ProcEnqueue{}
	for _, e := range ps.Enqueues {
		enq[e.Type] = e
	}
	if len(ps.Enqueues) != 3 || ps.EnqueuesTotal != 3 || enq["TX"].Mode != "X" || enq["TX"].Requested || enq["TM"].Mode != "SX" || enq["AE"].Mode != "S" || enq["TX"].Session != "61.21652" ||
		enq["TX"].Resource != "TX-00050016-00005A54-ED94F66A-00000000" || enq["TM"].In != "DML lock" || enq["TX"].In != "transaction" {
		t.Errorf("enqueues %+v", ps.Enqueues)
	}
	if len(ps.Transactions) != 1 || ps.Transactions[0].Xid != "0x0005.016.00005a54" || intOf(ps.Transactions[0].UndoBlocks) != 1 || intOf(ps.Transactions[0].UndoRecords) != 3 ||
		ps.Transactions[0].Begin != "11/17/2026 21:34:26" || ps.Transactions[0].Session != "61.21652" {
		t.Errorf("transactions %+v", ps.Transactions)
	}
	if len(ps.DMLLocks) != 1 || ps.DMLLocks[0].Table != 108609 || intOf(ps.DMLLocks[0].Mode) != 3 || ps.DMLLocks[0].ModeName != "SX" {
		t.Errorf("DML locks %+v", ps.DMLLocks)
	}
	// the TM enqueue names the same table in hex, and the block list the same object
	if !strings.HasPrefix(enq["TM"].Resource, fmt.Sprintf("TM-%08X-", ps.DMLLocks[0].Table)) {
		t.Errorf("TM resource %s for object %d", enq["TM"].Resource, ps.DMLLocks[0].Table)
	}
	if b := ps.Transactions[0].Blocks; len(b) != 1 || b[0].Obj != ps.DMLLocks[0].Table || b[0].SQLID != "2t77xc2qrk3fy" || b[0].Itli != 2 || b[0].RDBA != "0x3028f75" {
		t.Errorf("block list %+v", b)
	}
	// library object locks and pins
	if ps.LocksTotal != 39 || len(ps.Locks) != HoldCap || ps.PinsTotal != 2 || len(ps.Pins) != 2 {
		t.Errorf("locks %d/%d pins %d/%d", len(ps.Locks), ps.LocksTotal, len(ps.Pins), ps.PinsTotal)
	}
	names := map[string]ProcLibObject{}
	for _, l := range ps.Locks {
		if l.Name != "" {
			names[l.Name] = l
		}
	}
	if l, ok := names["begin mtk_diag_outer(:ev, :cid); end;"]; !ok || l.SQLID != "f3j90cdzgg7d2" || l.Handle != "0x79a02048" || l.Mode != "N" || l.Namespace != "SQL AREA" || l.Type != "CURSOR" {
		t.Errorf("the lock on the session's statement: %+v", l)
	}
	if l, ok := names["PDB1.MTK.MTK_DIAG_INNER"]; !ok || l.Namespace != "TABLE/PROCEDURE" || l.Type != "PROCEDURE" {
		t.Errorf("the lock on the procedure: %+v", l)
	}
	for i, p := range ps.Pins {
		if p.Name != []string{"PDB1.MTK.MTK_DIAG_INNER", "PDB1.MTK.MTK_DIAG_OUTER"}[i] || p.Mode != "S" || intOf(p.Count) != 3 || p.Handle == "" {
			t.Errorf("pin %+v", p)
		}
	}
	if ps.ShortStack != "" {
		t.Errorf("a short stack %q where the dump prints none", ps.ShortStack)
	}
	// the nested process state of the errorstack has the same session and statement
	e := readerOf(t, filepath.Join(diagDir, "diag_errorstack_l2.trc"))
	_, eps := procStates(t, e)
	if len(eps) != 1 || eps[0].Sessions[0].Key != "22.14058" || eps[0].Sessions[0].SqlID != "f3j90cdzgg7d2" || eps[0].Sessions[0].Module != "mtk_diag_errorstack_l2" {
		t.Errorf("nested process state: %+v", eps[0].Sessions)
	}
}

// summaryEntry is a line of a system state's Process Summary with the lines under it.
type summaryEntry struct {
	pid          int
	name         string
	sid, ser     int
	cmd          string
	blocked, fin string // "sid.ser"
}

var (
	sumLine   = regexp.MustCompile(`^\s+(\d+): (\S+)(?: ospid \S+ sid (\d+) ser (\d+),)?`)
	sumBlock  = regexp.MustCompile(`^\s+Blocked by inst: \d+, sid: (\d+), ser: (\d+)`)
	sumFinal  = regexp.MustCompile(`^\s+Final Blocker inst: \d+, sid: (\d+), ser: (\d+)`)
	sumCmd    = regexp.MustCompile(`^\s+Cmd: (.*)$`)
	sumHeader = "Dumping the Process Summary"
)

// processSummary reads the dump's own Process Summary.
func processSummary(t testing.TB, path string) []summaryEntry {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []summaryEntry
	in := false
	for _, l := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(l, sumHeader) {
			in = true
			continue
		}
		if !in {
			continue
		}
		if m := sumLine.FindStringSubmatch(l); m != nil && !strings.HasPrefix(strings.TrimSpace(l), "Cmd:") && !strings.Contains(l, "Blocked by") && !strings.Contains(l, "Final Blocker") {
			e := summaryEntry{name: m[2]}
			e.pid, _ = strconv.Atoi(m[1])
			if m[3] != "" {
				e.sid, _ = strconv.Atoi(m[3])
				e.ser, _ = strconv.Atoi(m[4])
			}
			out = append(out, e)
			continue
		}
		if len(out) == 0 {
			continue
		}
		e := &out[len(out)-1]
		if m := sumCmd.FindStringSubmatch(l); m != nil {
			e.cmd = strings.TrimSpace(m[1])
		} else if m := sumBlock.FindStringSubmatch(l); m != nil {
			e.blocked = m[1] + "." + m[2]
		} else if m := sumFinal.FindStringSubmatch(l); m != nil {
			e.fin = m[1] + "." + m[2]
		} else if !sumLine.MatchString(l) {
			break
		}
	}
	return out
}

// sysstateProcesses reads every process of the system state of a file.
func sysstateProcesses(t testing.TB, r *Reader) map[int]*ProcState {
	t.Helper()
	out := map[int]*ProcState{}
	for _, n := range r.Scan.Top {
		if n.Kind != "sysstate" {
			continue
		}
		for _, c := range allChildren(t, r, n.ID, Cap) {
			if c.Kind != "process" {
				continue
			}
			rd, err := r.Reading(c.ID)
			if err != nil {
				t.Fatal(err)
			}
			out[c.N] = rd.(*ProcState)
		}
	}
	return out
}

// TestSysstateChain: in a system state the processes of the three chained sessions (the first holds a row
// lock, the second waits for it and holds another, the third waits for that) name each other as blocker and
// waiter; the sessions come from the dump's own Process Summary. Level 1 is committed; the level 266 dump is
// not in git and is used when present.
func TestSysstateChain(t *testing.T) {
	files := []string{filepath.Join(diagDir, "diag_sysstate_l1.trc")}
	for _, n := range []string{"diag_sysstate_l2.trc", "diag_sysstate_l258.trc", "diag_sysstate_l266.trc"} {
		if _, err := os.Stat(filepath.Join(bigDir, n)); err == nil {
			files = append(files, filepath.Join(bigDir, n))
		}
	}
	for _, p := range files {
		p := p
		t.Run(fixtureName(p), func(t *testing.T) {
			r := readerOf(t, p)
			sum := processSummary(t, p)
			procs := sysstateProcesses(t, r)
			if len(sum) < 60 || len(procs) < 60 {
				t.Fatalf("%d summary entries, %d process readings", len(sum), len(procs))
			}
			bySess := map[string]*ProcState{} // "sid.ser" -> its process reading
			for _, e := range sum {
				ps := procs[e.pid]
				if ps == nil {
					t.Errorf("no reading for process %d (%s)", e.pid, e.name)
					continue
				}
				if intOf(ps.Process.Pid) != e.pid {
					t.Errorf("process %d: reading says Oracle pid %d", e.pid, intOf(ps.Process.Pid))
				}
				wantName := e.name
				if e.name == "USER" || e.name == "PSEUDO" {
					wantName = ""
				}
				if ps.Process.Name != wantName && !(wantName == "" && ps.Process.Name == "") {
					t.Errorf("process %d: name %q, summary %q", e.pid, ps.Process.Name, e.name)
				}
				if e.sid != 0 || e.ser != 0 {
					if len(ps.Sessions) == 0 {
						// the summary names the session of a job process whose state object the dump does not print
						for _, ty := range ps.Objects.ByType {
							if ty.Type == "session" {
								t.Errorf("process %d: the summary names session %d.%d, the reading has none of its %d", e.pid, e.sid, e.ser, ty.Count)
							}
						}
						continue
					}
					found := false
					for _, s := range ps.Sessions {
						found = found || s.Key == fmt.Sprintf("%d.%d", e.sid, e.ser)
					}
					if !found {
						t.Errorf("process %d: the summary names session %d.%d, the reading %v", e.pid, e.sid, e.ser, ps.Sessions[0].Key)
					}
					bySess[fmt.Sprintf("%d.%d", e.sid, e.ser)] = ps
				}
			}
			blocked := 0
			for _, e := range sum {
				if e.sid == 0 && e.ser == 0 {
					continue
				}
				key := fmt.Sprintf("%d.%d", e.sid, e.ser)
				ps := bySess[key]
				if ps == nil {
					continue
				}
				var s *ProcSession
				for i := range ps.Sessions {
					if ps.Sessions[i].Key == key {
						s = &ps.Sessions[i]
					}
				}
				// the command the summary prints is the one named by the oct of the session, where we name it
				if e.cmd != "" && s.CommandName != "" && s.CommandName != e.cmd {
					t.Errorf("session %s: command %q, summary %q", key, s.CommandName, e.cmd)
				}
				if e.cmd == "" && s.Command != nil && *s.Command != 0 {
					t.Errorf("session %s: oct %d with no Cmd in the summary", key, *s.Command)
				}
				if e.cmd != "" && s.CommandName == "" {
					t.Errorf("session %s: the summary prints Cmd: %s, oct %d has no name here", key, e.cmd, intOf(s.Command))
				}
				if e.blocked == "" {
					if s.Wait != nil && len(s.Wait.Blockers) > 0 {
						t.Errorf("session %s: blockers %v where the summary names none", key, s.Wait.Blockers)
					}
					continue
				}
				blocked++
				w := s.Wait
				if w == nil || !w.Blocked || len(w.Blockers) == 0 || w.Blockers[0].Key != e.blocked || w.FinalBlocker == nil || w.FinalBlocker.Key != e.fin {
					t.Errorf("session %s: wait %+v, the summary says blocked by %s, final blocker %s", key, w, e.blocked, e.fin)
					continue
				}
				// the blocker's process says it blocks someone and the waiter it dumps is a session blocked by it
				bp := bySess[e.blocked]
				if bp == nil {
					t.Errorf("session %s: blocker %s has no process", key, e.blocked)
					continue
				}
				var bs *ProcSession
				for i := range bp.Sessions {
					if bp.Sessions[i].Key == e.blocked {
						bs = &bp.Sessions[i]
					}
				}
				if bs.Wait == nil || bs.Wait.BlockedCount < 1 || len(bs.Wait.Waiters) == 0 {
					t.Errorf("session %s: its blocker %s says it blocks %+v", key, e.blocked, bs.Wait)
					continue
				}
				for _, wr := range bs.Wait.Waiters {
					ok := false
					for _, o := range sum {
						if fmt.Sprintf("%d.%d", o.sid, o.ser) == wr.Key && (o.blocked == e.blocked || o.fin == e.blocked) {
							ok = true
						}
					}
					if !ok {
						t.Errorf("blocker %s dumps the waiter %s, which the summary does not say it blocks", e.blocked, wr.Key)
					}
				}
			}
			if blocked != 2 {
				t.Errorf("%d blocked sessions in the summary, the chain has 2", blocked)
			}
			// the three chained sessions: the one that blocks the other two, its direct waiter, and the one at the end
			var holder, middle, last string
			for _, e := range sum {
				key := fmt.Sprintf("%d.%d", e.sid, e.ser)
				switch {
				case e.fin != "" && e.blocked == e.fin:
					middle, holder = key, e.fin
				case e.fin != "" && e.blocked != e.fin:
					last = key
				}
			}
			if holder == "" || middle == "" || last == "" {
				t.Fatalf("chain %q <- %q <- %q", holder, middle, last)
			}
			hs, ms, ls := bySess[holder], bySess[middle], bySess[last]
			find := func(ps *ProcState, key string) *ProcSession {
				for i := range ps.Sessions {
					if ps.Sessions[i].Key == key {
						return &ps.Sessions[i]
					}
				}
				return nil
			}
			h, m, l := find(hs, holder), find(ms, middle), find(ls, last)
			if h.Wait.BlockedCount != 2 || h.Wait.Waiters[0].Key != middle || m.Wait.BlockedCount != 1 || m.Wait.Waiters[0].Key != last ||
				m.Wait.Blockers[0].Key != holder || l.Wait.Blockers[0].Key != middle || l.Wait.FinalBlocker.Key != holder {
				t.Errorf("the chain %s <- %s <- %s: holder %+v middle %+v last %+v", holder, middle, last, h.Wait, m.Wait, l.Wait)
			}
			if h.Wait.Blocked || h.Wait.InWait != true || h.Wait.Stack[0].Event != "PL/SQL lock timer" {
				t.Errorf("the holder waits %+v", h.Wait)
			}
			if !l.Wait.InWait || l.Wait.Stack[0].Event != "enq: TX - row lock contention" || l.Wait.Stack[0].Seconds == nil || *l.Wait.Stack[0].Seconds <= 0 {
				t.Errorf("the last session waits %+v", l.Wait.Stack)
			}
			rw := m.Wait.Waiters[0].RowWait
			if rw == nil || rw.Obj != 108609 || rw.File == 0 || m.Wait.Waiters[0].Event != "enq: TX - row lock contention" || len(m.Wait.Waiters[0].Params) != 3 {
				t.Errorf("the waiter of the middle session: %+v", m.Wait.Waiters[0])
			}
			// the level that prints child state objects: the statements are found, the TX enqueue requested by the middle
			// session is the one the holder's transaction holds
			if len(ms.Locks) > 0 {
				if m.SqlID == "" || !strings.Contains(m.SqlText, "mtk_cust") {
					t.Errorf("middle session statement %q %q", m.SqlID, m.SqlText)
				}
				requested := ""
				for _, e := range ms.Enqueues {
					if e.Requested && e.Type == "TX" {
						requested = e.Resource
					}
				}
				held := ""
				for _, e := range hs.Enqueues {
					if !e.Requested && e.Type == "TX" {
						held = e.Resource
					}
				}
				if requested == "" || held == "" || requested != held {
					t.Errorf("TX requested by the middle session %q, held by the holder %q", requested, held)
				}
				if m.Wait.Stack[0].Params == "" || len(h.Wait.History) == 0 {
					t.Errorf("middle session wait stack %+v", m.Wait.Stack)
				}
				// short stacks: levels 258 and 266 print one per process, level 2 none
				if strings.HasSuffix(fixtureName(p), "_l2") {
					if ms.ShortStack != "" {
						t.Errorf("a short stack %q in a level 2 dump", ms.ShortStack)
					}
				} else if ms.ShortStack == "" || ms.ShortStackOwn != 5 || !strings.HasPrefix(ms.ShortStack, "ksedsts()+") || !strings.HasPrefix(ms.ShortStackNoOwn, "semtimedop()") {
					t.Errorf("middle process short stack %q own %d", ms.ShortStack, ms.ShortStackOwn)
				}
			} else if m.SqlID != "" {
				t.Errorf("a level-1 dump resolves a statement: %q", m.SqlID)
			}
		})
	}
}

// TestProcStateSpeed: the readings of the largest process node of a system state and of the nested process
// state. Loose floors; the numbers are logged.
func TestProcStateSpeed(t *testing.T) {
	files := append(fixtures(t), bigFixtures()...)
	var best time.Duration
	for _, fx := range files {
		r := readerOf(t, fx)
		nodes, _ := procStates(t, r)
		var big Node
		for _, n := range nodes {
			if n.Lines > big.Lines {
				big = n
			}
		}
		if big.Lines < 3000 {
			continue
		}
		d := timeReading(t, r, big)
		t.Logf("%s: process state of %d lines in %v", fixtureName(fx), big.Lines, d.Round(time.Millisecond))
		best = max(best, d)
		if d > 2*time.Second {
			t.Errorf("%s: the process state reading of %d lines took %v", fixtureName(fx), big.Lines, d)
		}
	}
	if best == 0 {
		t.Error("nothing timed")
	}
}

// TestProcStatePrefixes: a file cut anywhere reads without error or panic.
func TestProcStatePrefixes(t *testing.T) {
	for _, name := range []string{"diag_procstate.trc", "diag_sysstate_l1.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		step := max(1, len(data)/150)
		for cut := 0; cut <= len(data); cut += step {
			r := readerOfBytes(t, data[:cut])
			_, pss := procStates(t, r)
			for _, ps := range pss {
				if _, err := json.Marshal(ps); err != nil {
					t.Fatal(err)
				}
				sum := ps.Objects.TypesOther
				for _, ty := range ps.Objects.ByType {
					sum += ty.Count
				}
				if sum != ps.Objects.Total {
					t.Fatalf("%s[:%d]: counts %d, total %d", name, cut, sum, ps.Objects.Total)
				}
			}
			var b bytes.Buffer
			if err := WriteDigest(&b, r); err != nil {
				t.Fatalf("%s[:%d]: digest: %v", name, cut, err)
			}
		}
	}
}

// TestProcStateMutations: damaged lines do not panic the reading and the counts still add up.
func TestProcStateMutations(t *testing.T) {
	junk := []string{"SO: 0x1, type: session (4), map: 0x2", "    SO: 0x", "SO: 0x1, type: (", "SO: 0x1, type: x (", "SO: 0x1, type: x (7), map: 0x2", "owner: 0x1, proc: 0x2", "owner: ", "(session) sid: ", "(session) sid: 9 ser: ",
		"(process) Oracle pid:", "Current Wait Stack:", " 0: waiting for '", " 0: waiting for 'x'", "Not in wait; last wait ended", "Dumping 1 direct blocker(s):", "Dumping final blocker:", "Dumping one waiter:",
		"inst: 1, sid: 1, ser:", "There are  sessions blocked by this session.", "There are 3 sessions blocked by this session.", "Session Wait History:", " 1: waited for 'x'", "wait times: snap= total=",
		"row_wait_obj#: , block#: x", "min_blocked_time:", "Short stack dump:", "ksedsts()+1<-ksdxfstk()+1<-", "Enqueue Dump (enqueue) ", "ksqdmc(): Enqueue Dump (enqueue) TX-1-2-3-4", "mode: , lock_flag:", "req: X",
		"DML LOCK: tab=x", "LibraryObjectLock:  Address=", "LibraryHandle:  Address=0x1", "ObjectName:  Name=", "Undo blks: x recs:", "env [0x1]: (scn: xid: ", "      0      2   0x3028f75  2t77xc2qrk3fy   108609  0x73", "============", "----- X -----", ""}
	rng := newRand(5)
	for _, name := range []string{"diag_procstate.trc", "diag_sysstate_l1.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		src := strings.Split(string(data), "\n")
		for it := 0; it < 50; it++ {
			ls := append([]string(nil), src[:min(len(src), 6000)]...)
			for k := rng.Intn(40) + 1; k > 0; k-- {
				i := rng.Intn(len(ls))
				switch rng.Intn(5) {
				case 0:
					ls = append(ls[:i], ls[i+1:]...)
				case 1:
					j := rng.Intn(len(ls))
					ls[i], ls[j] = ls[j], ls[i]
				case 2, 3:
					ls[i] = junk[rng.Intn(len(junk))]
				case 4:
					ls = append(ls[:i], append([]string{junk[rng.Intn(len(junk))]}, ls[i:]...)...)
				}
			}
			r := readerOfBytes(t, []byte(strings.Join(ls, "\n")))
			_, pss := procStates(t, r)
			for _, ps := range pss {
				sum := ps.Objects.TypesOther
				for _, ty := range ps.Objects.ByType {
					sum += ty.Count
				}
				if sum != ps.Objects.Total {
					t.Fatalf("%s mutation %d: counts %d, total %d", name, it, sum, ps.Objects.Total)
				}
				if _, err := json.Marshal(ps); err != nil {
					t.Fatal(err)
				}
			}
			var b bytes.Buffer
			if err := WriteDigest(&b, r); err != nil {
				t.Fatalf("%s mutation %d: digest: %v", name, it, err)
			}
		}
	}
}
