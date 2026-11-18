package diag

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func deadlockOf(t testing.TB, r *Reader) (Node, *Deadlock) {
	t.Helper()
	for _, n := range r.Scan.Top {
		if n.Kind == "deadlock" {
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatal(err)
			}
			return n, rd.(*Deadlock)
		}
	}
	t.Fatal("no deadlock in the file")
	return Node{}, nil
}

func ptr(n int) *int { return &n }

// TestDeadlockFixture: diag_deadlock (scenario sc_diag_deadlock.sql: session A takes row 201 then asks for 202, session
// B takes 202 then asks for 201; the trace is session A's).
func TestDeadlockFixture(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_deadlock.trc"))
	n, d := deadlockOf(t, r)
	if d.From != n.From || d.To != n.To || n.Reading != "deadlock" || d.ORA != "ORA-00060" || d.Type != "Transaction Deadlock" || d.Line != n.From {
		t.Errorf("node %+v, reading %+v", n, d)
	}
	// the graph: two rows as printed, the empty cells absent
	g := d.Graph
	if g.Total != 2 || len(g.Rows) != 2 || len(g.Header) != 2 || !strings.HasPrefix(strings.TrimSpace(g.Header[1]), "Resource Name") || !strings.Contains(g.Header[0], "Blocker(s)") {
		t.Fatalf("graph %+v", g)
	}
	want := []DeadlockRow{
		{Line: 46, Resource: "TX-000A0009-00004D46-ED94F66A-00000000", Type: "TX",
			Blocker: DeadlockParty{Process: ptr(61), Session: ptr(255), Holds: "X", Serial: ptr(52110), Key: "255.52110"},
			Waiter:  DeadlockParty{Process: ptr(6), Session: ptr(61), Waits: "X", Serial: ptr(27430), Key: "61.27430"}},
		{Line: 47, Resource: "TX-00080010-000057D7-ED94F66A-00000000", Type: "TX",
			Blocker: DeadlockParty{Process: ptr(6), Session: ptr(61), Holds: "X", Serial: ptr(27430), Key: "61.27430"},
			Waiter:  DeadlockParty{Process: ptr(61), Session: ptr(255), Waits: "X", Serial: ptr(52110), Key: "255.52110"}},
	}
	got, _ := json.Marshal(g.Rows)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Errorf("rows\n got %s\nwant %s", got, exp)
	}
	// the cycle closes: each edge's blocker is the next edge's waiter, the last leads back to the first
	c := d.Cycle
	if !c.Closed || len(c.Sessions) != 2 || len(c.Edges) != 2 {
		t.Fatalf("cycle %+v", c)
	}
	for i, e := range c.Edges {
		if e.Waiter != c.Sessions[i] || e.Blocker != c.Edges[(i+1)%len(c.Edges)].Waiter || e.Mode != "X" || e.Resource == "" {
			t.Errorf("edge %d %+v", i, e)
		}
	}
	// it starts at the victim: the session of the trace, session A
	if v := d.Victim; v == nil || v.Session != "255.52110" || !v.InGraph || v.Line != 24 || c.Sessions[0] != "255.52110" {
		t.Errorf("victim %+v, cycle %v", v, c.Sessions)
	}
	// the sessions and their statements, which are those of the scenario
	if len(d.Sessions) != 2 || d.SessionsTotal != 2 || !d.SessionsEnded || d.SessionsLine != 49 {
		t.Fatalf("sessions %+v", d.Sessions)
	}
	a, b := d.Sessions[0], d.Sessions[1]
	if a.Key != "255.52110" || a.Number != 255 || a.Module != "mtk_diag_deadlock_a" || a.Action != "a_asks_202" || a.SqlText != "select id from mtk_cust where id = 202 for update wait 30" ||
		a.HeldResource != "TX-000A0009-00004D46-ED94F66A-00000000" || a.AcquiredSec == nil || *a.AcquiredSec != 5 || a.User != "MTK" || a.UserID == nil || *a.UserID != 165 || a.Container != "3/PDB1" ||
		a.ContainerID == nil || *a.ContainerID != 3 || a.ContainerName != "PDB1" || a.AudSid == nil || *a.AudSid != 4273372 || a.Pid == nil || *a.Pid != 61 || a.OSPid != "13878" || a.Machine != "ol9-19-dg1.localdomain" ||
		a.Program != "sqlplus@ol9-19-dg1.localdomain (TNS V1-V3)" || a.ClientOSPid != "13875" || !a.InGraph {
		t.Errorf("session A %+v", a)
	}
	if b.Key != "61.27430" || b.Module != "mtk_diag_deadlock_b" || b.Action != "b_asks_201" || b.SqlText != "select id from mtk_cust where id = 201 for update wait 30" || b.HeldResource != "TX-00080010-000057D7-ED94F66A-00000000" || !b.InGraph {
		t.Errorf("session B %+v", b)
	}
	// each session holds the resource the graph says it holds, and waits for the one the other holds
	for _, s := range d.Sessions {
		ok := false
		for _, row := range g.Rows {
			ok = ok || (row.Blocker.Key == s.Key && row.Resource == s.HeldResource && row.Blocker.Holds != "")
		}
		if !ok {
			t.Errorf("session %s holds %s, which is not a row where it is the blocker", s.Key, s.HeldResource)
		}
		inNode(t, "session block", s.From, d.From, d.To)
		inNode(t, "session block end", s.To, d.From, d.To)
		inNode(t, "statement", s.SqlLine, d.From, d.To)
	}
	// the rows the sessions wait on: the same table and object, other slots
	rw := d.RowsWaited
	if rw == nil || rw.Total != 2 || len(rw.Rows) != 2 || rw.Rows[0].Session != 255 || rw.Rows[0].Objn == nil || *rw.Rows[0].Objn != 108609 || *rw.Rows[0].File != 12 || *rw.Rows[0].Block != 169241 || *rw.Rows[0].Slot != 3 ||
		rw.Rows[0].Obj != "0001A841" || rw.Rows[0].RowID != "AAAahBAAMAAApUZAAD" || rw.Rows[1].Session != 61 || *rw.Rows[1].Slot != 2 {
		t.Errorf("rows waited on %+v", rw)
	}
	// the dump that follows: its node resolves to a call stack reading, which names the same statement
	if d.Dump == nil || d.Dump.From != 86 || d.Dump.To != n.To {
		t.Fatalf("dump %+v", d.Dump)
	}
	rd, err := r.Reading(d.Dump.Node)
	if err != nil {
		t.Fatal(err)
	}
	cs, ok := rd.(*CallStack)
	if !ok || cs.Statement == nil || !strings.Contains(cs.Statement.Text, "id = 202") {
		t.Errorf("the dump's call stack reading: %+v", rd)
	}
	if len(d.Notes) != 0 {
		t.Errorf("notes %v", d.Notes)
	}
	raw, _ := json.Marshal(d)
	if jsonNull.Match(raw) {
		i := jsonNull.FindIndex(raw)
		t.Errorf("a null in the reading: ...%s", raw[max(0, i[0]-60):i[1]])
	}
}

// TestDeadlockColumns: the fixed-column table with empty cells, a three-session cycle, a blocker that also waits.
func TestDeadlockColumns(t *testing.T) {
	// rows laid out as Oracle does: each cell right-aligned to the end of its column (the waiter's group one character
	// to the left of its header, as in the fixture)
	row := func(res string, cells ...string) string {
		ends := []int{49, 57, 63, 69, 76, 84, 92, 98, 104, 111}
		line := []byte(res)
		for i, c := range cells {
			if c == "" {
				continue
			}
			for len(line) < ends[i]-len(c) {
				line = append(line, ' ')
			}
			line = append(line, c...)
		}
		return string(line)
	}
	text := "*** SESSION ID:(30.7) 2026-11-17T21:34:33.717056+00:00\n \nDEADLOCK DETECTED ( ORA-00060 )\n\n[Transaction Deadlock]\n\nDeadlock graph:\n" +
		"                                          ------------Blocker(s)-----------  ------------Waiter(s)------------\n" +
		"Resource Name                             process session holds waits serial  process session holds waits serial\n" +
		row("TX-000A0009-00004D46-ED94F66A-00000000", "61", "10", "X", "", "1111", "6", "20", "", "X", "2222") + "\n" +
		row("TM-0001A841-00000000-00000000-00000000", "6", "20", "SX", "X", "2222", "71", "30", "SX", "", "3333") + "\n" +
		row("TX-00080010-000057D7-ED94F66A-00000000", "71", "30", "X", "", "3333", "61", "10", "", "X", "1111") + "\n" +
		" \n"
	text += `----- Information for waiting sessions -----
Session 30:
Holds resource TX-00080010-000057D7-ED94F66A-00000000 acquired 12 seconds ago.
  sid: 30 ser: 7 audsid: 99 user: 5/SCOTT
  current SQL:
  update t
  set a = 1
  where b = 2

Session 10:
Holds resource TX-000A0009-00004D46-ED94F66A-00000000 acquired 1 seconds ago.
  sid: 10 ser: 1111 audsid: 98 user: 5/SCOTT
  current SQL:
  delete from t
----- End of information for waiting sessions -----
`
	r := readerOfBytes(t, []byte(text))
	_, d := deadlockOf(t, r)
	rows := d.Graph.Rows
	if len(rows) != 3 {
		t.Fatalf("rows %+v", rows)
	}
	b1 := rows[1]
	if b1.Resource != "TM-0001A841-00000000-00000000-00000000" || b1.Type != "TM" || b1.Blocker.Holds != "SX" || b1.Blocker.Waits != "X" || *b1.Blocker.Serial != 2222 || b1.Waiter.Holds != "SX" || b1.Waiter.Waits != "" || *b1.Waiter.Session != 30 {
		t.Errorf("row 2 (the blocker holds and waits, the waiter holds): %+v", b1)
	}
	if rows[0].Blocker.Waits != "" || rows[0].Waiter.Holds != "" || rows[0].Waiter.Waits != "X" || *rows[0].Waiter.Serial != 2222 {
		t.Errorf("row 1 %+v", rows[0])
	}
	// the cycle: 10.1111 -> 61? edges are waiter -> blocker; a 3-cycle through the rows that have keys
	if d.Victim == nil || d.Victim.Session != "30.7" || d.Victim.InGraph {
		t.Errorf("victim %+v", d.Victim)
	}
	if len(d.Sessions) != 2 || d.Sessions[0].SqlText != "update t\nset a = 1\nwhere b = 2" || d.Sessions[1].SqlText != "delete from t" || !d.SessionsEnded {
		t.Errorf("sessions %+v", d.Sessions)
	}
	found := false
	for _, n := range d.Notes {
		found = found || strings.Contains(n, "is not in the graph")
	}
	if !found {
		t.Errorf("notes %v", d.Notes)
	}
	if !d.Cycle.Closed || len(d.Cycle.Sessions) != 3 {
		t.Errorf("cycle %+v", d.Cycle)
	}
}

// TestDeadlockBounds: a graph of more rows than the bound counts them.
func TestDeadlockBounds(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("DEADLOCK DETECTED ( ORA-00060 )\nDeadlock graph:\n                                          ------------Blocker(s)-----------  ------------Waiter(s)------------\nResource Name                             process session holds waits serial  process session holds waits serial\n")
	for i := 0; i < DeadlockRowCap+50; i++ {
		b.WriteString("TX-000A0009-00004D46-ED94F66A-00000000         61     255     X        52110       6      61           X  27430\n")
	}
	b.WriteString(" \n----- Information for waiting sessions -----\n")
	for i := 0; i < DeadlockSessionCap+5; i++ {
		b.WriteString("Session 1:\n  sid: 1 ser: 1 audsid: 1 user: 1/X\n  current SQL:\n")
		for k := 0; k < DeadlockSQLLines+10; k++ {
			b.WriteString("  select 1 from dual\n")
		}
		b.WriteString(" \n")
	}
	b.WriteString("----- End of information for waiting sessions -----\n")
	r := readerOfBytes(t, b.Bytes())
	_, d := deadlockOf(t, r)
	if d.Graph.Total != DeadlockRowCap+50 || len(d.Graph.Rows) != DeadlockRowCap || d.SessionsTotal != DeadlockSessionCap+5 || len(d.Sessions) != DeadlockSessionCap || !d.Sessions[0].SqlCut {
		t.Errorf("rows %d of %d, sessions %d of %d, cut %v", len(d.Graph.Rows), d.Graph.Total, len(d.Sessions), d.SessionsTotal, d.Sessions[0].SqlCut)
	}
	if strings.Count(d.Sessions[0].SqlText, "\n") != DeadlockSQLLines-1 {
		t.Errorf("%d lines of statement", strings.Count(d.Sessions[0].SqlText, "\n")+1)
	}
}

// TestDeadlockPrefixesAndMutations: every prefix of the fixture and damaged ones read without a panic.
func TestDeadlockPrefixesAndMutations(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_deadlock.trc"))
	if err != nil {
		t.Fatal(err)
	}
	head := data
	if i := bytes.Index(data, []byte("Rows waited on:")); i > 0 {
		head = append(append([]byte{}, data[:i+400]...), '\n')
	}
	for k := 0; k <= 120; k++ {
		cut := len(head) * k / 120
		r := readerOfBytes(t, head[:cut])
		for _, n := range r.Scan.Top {
			if n.Kind != "deadlock" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatalf("prefix %d: %v", cut, err)
			}
			d := rd.(*Deadlock)
			var b bytes.Buffer
			writeDeadlockText(&b, "", d)
			if d.SessionsLine > 0 && !d.SessionsEnded {
				said := false
				for _, nn := range d.Notes {
					said = said || strings.Contains(nn, "cut short")
				}
				if !said {
					t.Errorf("prefix %d: a cut block does not say so: %v", cut, d.Notes)
				}
			}
		}
	}
	all := strings.Split(string(head), "\n")
	junk := []string{"Deadlock graph:", "TX-1-2-3-4  1 2 X 3", "TX-1-2-3-4", "Session 5:", "Session x:", "current SQL:", "Rows waited on:", "  Session 3: obj - rowid = 1 - AAA", "  (dictionary objn - 1, file - 2, block - 3, slot - 4)",
		"----- Information for waiting sessions -----", "----- End of information for waiting sessions -----", "DEADLOCK DETECTED ( ORA-00060 )", "Holds resource X acquired", "  sid: 3 ser: x", "", " ", "Resource Name process session holds waits serial"}
	rng := rand.New(rand.NewSource(11))
	for it := 0; it < 300; it++ {
		m := append([]string(nil), all...)
		for k := rng.Intn(25) + 1; k > 0; k-- {
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
			if n.Kind != "deadlock" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatalf("mutation %d: %v", it, err)
			}
			d := rd.(*Deadlock)
			var b bytes.Buffer
			writeDeadlockText(&b, "", d)
			if _, err := json.Marshal(d); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// TestDeadlockDigest: the document's digest holds the reading and the text has the graph.
func TestDeadlockDigest(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_deadlock.trc"))
	n, d := deadlockOf(t, r)
	dg, err := r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if raw, ok := dg.Readings[n.ID]; !ok || !strings.HasPrefix(string(raw), `{"kind":"deadlock","node":`) {
		t.Fatalf("the digest's readings: %v", dg.Readings)
	}
	var b bytes.Buffer
	if err := WriteDigest(&b, r); err != nil {
		t.Fatal(err)
	}
	for _, row := range d.Graph.Rows {
		if !strings.Contains(b.String(), row.Resource) {
			t.Errorf("the text has no %s", row.Resource)
		}
	}
	for _, want := range []string{"255.52110", "61.27430", "id = 201", "id = 202", "(the victim)", "cycle (closes)"} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("the text has no %q", want)
		}
	}
}
