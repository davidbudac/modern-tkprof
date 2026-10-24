package analyze

import (
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

func buildFixture(t *testing.T, name string) *model.Model {
	t.Helper()
	m, err := model.Build(filepath.Join(fixtures, name), model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func findStmt(c *Comparison, key string) *StmtDelta {
	for i := range c.Statements {
		if c.Statements[i].Key == key {
			return &c.Statements[i]
		}
	}
	return nil
}

// A trace against itself has no differences anywhere.
func TestCompareSelf(t *testing.T) {
	m := buildFixture(t, "plan_change.trc")
	c := Compare(m, m)
	for _, x := range c.Totals {
		if x.A != x.B || x.Delta != 0 {
			t.Errorf("total %s: %d vs %d", x.Key, x.A, x.B)
		}
	}
	for _, x := range c.Classes {
		if x.Delta != 0 {
			t.Errorf("class %s delta %d", x.Key, x.Delta)
		}
	}
	for _, x := range c.Profile {
		if x.DeltaUs != 0 || x.AUs != x.BUs {
			t.Errorf("profile %s delta %d", x.Component, x.DeltaUs)
		}
	}
	for _, x := range c.Events {
		if x.DeltaUs != 0 || x.DCount != 0 {
			t.Errorf("event %s delta %d/%d", x.Name, x.DeltaUs, x.DCount)
		}
	}
	if len(c.Statements) == 0 {
		t.Fatal("no statements")
	}
	for _, x := range c.Statements {
		if x.Status != StmtBoth || x.A == nil || x.B == nil {
			t.Errorf("%s status %s", x.Key, x.Status)
		}
		if x.DElapsed != 0 || x.DExecutions != 0 || x.DCPU != 0 || x.DDisk != 0 || x.DQuery != 0 || x.DRows != 0 || x.DPerExecUs != 0 || x.PlanChanged {
			t.Errorf("%s: non-zero delta %+v", x.Key, x)
		}
	}
	if len(c.OnlyA()) != 0 || len(c.OnlyB()) != 0 {
		t.Error("unmatched statements against itself")
	}
	// plan_change.trc really has two plans for one statement; comparing it with itself is not a "change"
	var multi bool
	for _, x := range c.Statements {
		multi = multi || len(x.A.PlanHashes) > 1
	}
	if !multi {
		t.Error("fixture lost its two plan hashes")
	}
}

// Statements of two different traces line up by sql_id; the rest is listed as unmatched.
func TestCompareFixtures(t *testing.T) {
	a, b := buildFixture(t, "io_waits.trc"), buildFixture(t, "level_8.trc")
	c := Compare(a, b)

	ids := func(m *model.Model) map[string]bool {
		out := map[string]bool{}
		st := Statements(m)
		for i := range m.Statements {
			if m.Statements[i].SQLID != "" && (st[i].AllCalls.Count > 0 || st[i].Errors > 0) {
				out[m.Statements[i].SQLID] = true
			}
		}
		return out
	}
	ia, ib := ids(a), ids(b)
	both := 0
	for id := range ia {
		d := findStmt(&c, "sqlid:"+id)
		if d == nil {
			t.Fatalf("sql_id %s missing from the comparison", id)
		}
		if ib[id] {
			both++
			if d.Status != StmtBoth || d.A == nil || d.B == nil {
				t.Errorf("%s: want both, got %s", id, d.Status)
			}
			if d.DElapsed != d.B.Elapsed-d.A.Elapsed {
				t.Errorf("%s: delta %d != %d-%d", id, d.DElapsed, d.B.Elapsed, d.A.Elapsed)
			}
		} else if d.Status != StmtOnlyA || d.B != nil {
			t.Errorf("%s: want onlyA, got %s", id, d.Status)
		}
	}
	for id := range ib {
		if !ia[id] {
			if d := findStmt(&c, "sqlid:"+id); d == nil || d.Status != StmtOnlyB || d.A != nil {
				t.Errorf("%s: want onlyB, got %+v", id, d)
			}
		}
	}
	if both == 0 {
		t.Log("note: the two fixtures share no sql_id")
	}
	if len(c.OnlyA())+len(c.OnlyB())+len(c.Matched()) != len(c.Statements) {
		t.Error("status partition does not cover the statements")
	}
	for i := 1; i < len(c.Statements); i++ {
		if abs64(c.Statements[i-1].DElapsed) < abs64(c.Statements[i].DElapsed) {
			t.Fatalf("statements not ranked by |delta elapsed| at %d", i)
		}
	}
	// totals are the profiles' numbers
	if r := c.Totals[0]; r.Key != "response" || r.A != a.Span.Us() || r.B != b.Span.Us() {
		t.Errorf("response total %+v", r)
	}
	t.Logf("io_waits vs level_8: %d statements, %d both, %d only A, %d only B, %d events", len(c.Statements), len(c.Matched()), len(c.OnlyA()), len(c.OnlyB()), len(c.Events))
}

func cmpWait(m *model.Model, ev model.ID, sid model.ID, ela int64) {
	m.Waits = append(m.Waits, model.Wait{ID: model.ID(len(m.Waits)), Event: ev, Statement: sid, Call: model.None, Ela: ela, Tim: int64(len(m.Waits)+1) * 10})
}

// The delta math on hand-built models: matching, per-exec figures, plan hash
// changes, new and missing statements, events and classes.
func TestCompareDeltas(t *testing.T) {
	events := []model.Event{{ID: 0, Name: "db file sequential read", Class: "User I/O"}, {ID: 1, Name: "log file sync", Class: "Commit"}}

	a := newModel(3) // sqla, sqlb, sqlc
	a.m.Events = events
	a.exec(0, 1000, 11, 1)
	a.exec(0, 3000, 11, 2) // elapsed 4000, 2 execs -> 2000 / exec
	a.exec(1, 500, 0, 1)
	a.exec(2, 700, 0, 1) // only in A
	a.m.Calls[0].C, a.m.Calls[0].P, a.m.Calls[0].CR, a.m.Calls[0].SelfC, a.m.Calls[0].SelfP, a.m.Calls[0].SelfCR = 400, 5, 50, 400, 5, 50
	a.m.Calls[1].C, a.m.Calls[1].R = 600, 7
	cmpWait(a.m, 0, 0, 800)
	cmpWait(a.m, 0, 0, 200)
	a.m.Plans = append(a.m.Plans, model.Plan{ID: 0, Statement: 0, PLH: 11})

	b := newModel(3) // sqla, sqlb, sqlc -> but sqlc unused, plus a new "sqld" below
	b.m.Events = events
	b.m.Statements[2].SQLID = "sqld" // new in B
	b.exec(0, 6000, 22, 1)           // 6000 / exec: slower, other plan
	b.exec(1, 500, 0, 1)
	b.exec(2, 900, 0, 1)
	b.m.Calls[0].C, b.m.Calls[0].P, b.m.Calls[0].CR, b.m.Calls[0].SelfC, b.m.Calls[0].SelfP, b.m.Calls[0].SelfCR = 900, 30, 40, 900, 30, 40
	cmpWait(b.m, 0, 0, 2500)
	cmpWait(b.m, 1, 1, 300)
	b.m.Plans = append(b.m.Plans, model.Plan{ID: 0, Statement: 0, PLH: 22})

	c := Compare(a.m, b.m)

	sqla := findStmt(&c, "sqlid:sqla")
	if sqla == nil || sqla.Status != StmtBoth {
		t.Fatalf("sqla = %+v", sqla)
	}
	if sqla.A.Elapsed != 4000 || sqla.B.Elapsed != 6000 || sqla.DElapsed != 2000 {
		t.Errorf("sqla elapsed %d -> %d (%d)", sqla.A.Elapsed, sqla.B.Elapsed, sqla.DElapsed)
	}
	if sqla.A.PerExecUs != 2000 || sqla.B.PerExecUs != 6000 || sqla.DPerExecUs != 4000 {
		t.Errorf("sqla per exec %d -> %d (%d)", sqla.A.PerExecUs, sqla.B.PerExecUs, sqla.DPerExecUs)
	}
	if sqla.DExecutions != -1 || sqla.DCPU != -100 || sqla.DDisk != 25 || sqla.DQuery != -10 {
		t.Errorf("sqla deltas execs %d cpu %d disk %d query %d", sqla.DExecutions, sqla.DCPU, sqla.DDisk, sqla.DQuery)
	}
	if !sqla.PlanChanged || len(sqla.A.PlanHashes) != 1 || sqla.A.PlanHashes[0] != 11 || sqla.B.PlanHashes[0] != 22 {
		t.Errorf("sqla plans %v -> %v changed=%v", sqla.A.PlanHashes, sqla.B.PlanHashes, sqla.PlanChanged)
	}
	if sqlb := findStmt(&c, "sqlid:sqlb"); sqlb == nil || sqlb.DElapsed != 0 || sqlb.PlanChanged {
		t.Errorf("sqlb = %+v", sqlb)
	}
	if only := c.OnlyA(); len(only) != 1 || only[0].SQLID != "sqlc" || only[0].DElapsed != -700 || only[0].B != nil {
		t.Errorf("only A = %+v", only)
	}
	if only := c.OnlyB(); len(only) != 1 || only[0].SQLID != "sqld" || only[0].DElapsed != 900 || only[0].A != nil {
		t.Errorf("only B = %+v", only)
	}
	if c.Statements[0].Key != "sqlid:sqla" {
		t.Errorf("first ranked statement %s, want sqla (|2000| is the largest)", c.Statements[0].Key)
	}

	// events and classes
	byName := map[string]EventDelta{}
	for _, e := range c.Events {
		byName[e.Name] = e
	}
	if e := byName["db file sequential read"]; e.A.Us != 1000 || e.B.Us != 2500 || e.DeltaUs != 1500 || e.A.Count != 2 || e.B.Count != 1 || e.DCount != -1 {
		t.Errorf("sequential read %+v", e)
	}
	if e := byName["log file sync"]; e.A.Us != 0 || e.B.Us != 300 || e.DeltaUs != 300 {
		t.Errorf("log file sync %+v", e)
	}
	if c.Events[0].Name != "db file sequential read" {
		t.Errorf("events not ranked: %s first", c.Events[0].Name)
	}
	cls := map[string]Metric{}
	for _, m := range c.Classes {
		cls[m.Key] = m
	}
	if m := cls["User I/O"]; m.A != 1000 || m.B != 2500 || m.Delta != 1500 {
		t.Errorf("User I/O class %+v", m)
	}

	// totals
	tot := map[string]Metric{}
	for _, m := range c.Totals {
		tot[m.Key] = m
	}
	if m := tot["execs"]; m.A != 4 || m.B != 3 || m.Delta != -1 {
		t.Errorf("execs %+v", m)
	}
	if m := tot["disk"]; m.A != 5 || m.B != 30 {
		t.Errorf("disk %+v", m)
	}
	if m := tot["rows"]; m.A != 7 {
		t.Errorf("rows %+v", m)
	}
	// profile: CPU row is present on both sides
	var cpuRow *ProfileDelta
	for i := range c.Profile {
		if c.Profile[i].Component == "CPU" {
			cpuRow = &c.Profile[i]
		}
	}
	if cpuRow == nil || cpuRow.AUs != 1000 || cpuRow.BUs != 900 || cpuRow.DeltaUs != -100 {
		t.Errorf("CPU row %+v (Σ c of top-level calls)", cpuRow)
	}
}

func TestPctChange(t *testing.T) {
	if p, ok := PctChange(200, 300); !ok || p != 50 {
		t.Errorf("200 -> 300 = %v %v", p, ok)
	}
	if _, ok := PctChange(0, 5); ok {
		t.Error("0 base must not give a percentage")
	}
}

// statements without a sql_id match by kind and normalised text.
func TestStmtKeyNormalised(t *testing.T) {
	x := &model.Statement{Kind: model.StmtSQL, Text: "SELECT  1\n FROM dual"}
	y := &model.Statement{Kind: model.StmtSQL, Text: "select 1 from DUAL"}
	z := &model.Statement{Kind: model.StmtLob, Text: "select 1 from DUAL"}
	if StmtKey(x) != StmtKey(y) {
		t.Error("whitespace and case must not matter")
	}
	if StmtKey(x) == StmtKey(z) {
		t.Error("kind must matter")
	}
	_ = trace.CallExec
}
