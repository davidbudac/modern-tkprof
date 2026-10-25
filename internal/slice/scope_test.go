package slice

import (
	"context"
	"fmt"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// contexts=- is the explicit empty set: every scoped endpoint sees no row,
// while an empty `contexts=` still means all of them.
func TestNoContextsSelectsNothing(t *testing.T) {
	paths := []string{traces + "multisession_a.trc", traces + "multisession_b.trc"}
	m, err := model.BuildFiles(paths, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	h := New(m).Handler()

	var st struct {
		Statements []analyze.StmtStats `json:"statements"`
	}
	if code := get(t, h, "/api/statements?contexts=-", &st); code != 200 || len(st.Statements) != len(m.Statements) {
		t.Fatalf("statements: status %d, %d entries", code, len(st.Statements))
	}
	for _, s := range st.Statements {
		if s.Executions != 0 || s.Elapsed != 0 || s.AllCalls.Count != 0 || s.Cursors != 0 {
			t.Fatalf("statement %d has rows with contexts=-: %+v", s.ID, s)
		}
	}
	var all struct {
		Statements []analyze.StmtStats `json:"statements"`
	}
	get(t, h, "/api/statements?contexts=", &all)
	sameStmts(t, "empty contexts= is all", all.Statements, analyze.Statements(m))

	for _, fact := range []string{"calls", "waits"} {
		var pv PivotResponse
		if code := get(t, h, "/api/pivot?fact="+fact+"&by=stmt&contexts=-", &pv); code != 200 || pv.Facts != 0 || len(pv.Rows) != 0 {
			t.Errorf("pivot %s: status %d, %d facts, %d rows", fact, code, pv.Facts, len(pv.Rows))
		}
	}
	var pr analyze.ScopeProfile
	if code := get(t, h, "/api/profile?contexts=-", &pr); code != 200 || pr.CPUUs != 0 || len(pr.Events) != 0 || pr.Calls != 0 {
		t.Errorf("profile: status %d, %+v", code, pr)
	}
	var ca struct {
		Total int `json:"total"`
	}
	if code := get(t, h, "/api/calls?contexts=-", &ca); code != 200 || ca.Total != 0 {
		t.Errorf("calls: status %d, total %d", code, ca.Total)
	}
	var w WaitsResponse
	if code := get(t, h, "/api/waits?scope=all&contexts=-", &w); code != 200 || w.Total != 0 || len(w.Rows) != 0 {
		t.Errorf("waits: status %d, total %d", code, w.Total)
	}
	var roles struct {
		Rows [][3]int64 `json:"rows"`
	}
	if code := get(t, h, "/api/stmt/roles?contexts=-", &roles); code != 200 || len(roles.Rows) != 0 {
		t.Errorf("stmt/roles: status %d, %d rows", code, len(roles.Rows))
	}
	for _, p := range []string{"/api/statements?contexts=-,0", "/api/statements?contexts=--"} {
		if code := get(t, h, p, nil); code != 400 {
			t.Errorf("%s: status %d, want 400", p, code)
		}
	}
}

// The per-statement lists take the scope: executions, the statement's waits and
// its call intervals of a subset are those of the rows in the subset.
func TestStatementListsFollowTheScope(t *testing.T) {
	paths := []string{traces + "multisession_a.trc", traces + "multisession_b.trc"}
	m, err := model.BuildFiles(paths, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	h := New(m).Handler()
	checked := 0
	for c := range m.Contexts {
		f := analyze.Filter{Contexts: []model.ID{model.ID(c)}, IncludeIdle: true}
		for sid := range m.Statements {
			var wantExec []analyze.ExecInfo
			if err := analyze.EachExecutionIn(context.Background(), m, MemSource(m), f, model.ID(sid), func(e *analyze.ExecInfo) { wantExec = append(wantExec, *e) }); err != nil {
				t.Fatal(err)
			}
			var got ExecResponse
			if code := get(t, h, fmt.Sprintf("/api/executions?stmt=%d&contexts=%d&limit=5000", sid, c), &got); code != 200 {
				t.Fatalf("executions: status %d", code)
			}
			if got.Total != len(wantExec) {
				t.Fatalf("stmt %d ctx %d: %d executions, want %d", sid, c, got.Total, len(wantExec))
			}
			for _, r := range got.Rows {
				if r.Ctx != model.ID(c) {
					t.Errorf("stmt %d ctx %d: execution of context %d", sid, c, r.Ctx)
				}
			}
			var whole, none ExecResponse
			get(t, h, fmt.Sprintf("/api/executions?stmt=%d&limit=5000", sid), &whole)
			get(t, h, fmt.Sprintf("/api/executions?stmt=%d&contexts=-", sid), &none)
			if none.Total != 0 || len(none.Rows) != 0 || got.Total > whole.Total {
				t.Errorf("stmt %d: %d with contexts=-, %d in ctx %d of %d", sid, none.Total, got.Total, c, whole.Total)
			}
			checked += got.Total
			var sw struct {
				Waits map[string][]analyze.StmtEventWait `json:"waits"`
			}
			get(t, h, fmt.Sprintf("/api/stmt/waits?stmt=%d&contexts=%d", sid, c), &sw)
			for _, e := range sw.Waits[fmt.Sprint(sid)] {
				if model.ID(c) != e.MaxCtx {
					t.Errorf("stmt %d ctx %d: longest wait in context %d", sid, c, e.MaxCtx)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no execution checked")
	}
}
