package slice

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// stmtSets are the trace sets StatementsOn is checked on: every single
// fixture plus the multi-file sets (a TRACE CONTINUES chain, two sessions,
// a PX coordinator with its slave).
func stmtSets(t *testing.T) map[string][]string {
	sets := map[string][]string{
		"multi_a_b":     {traces + "multisession_a.trc", traces + "multisession_b.trc"},
		"parallel":      {traces + "parallel.trc", traces + "parallel_slave.trc"},
		"midtrace_pair": {traces + "midtrace_start_part1.trc", traces + "midtrace_start.trc"},
		"binds_and_px":  {traces + "basic_binds.trc", traces + "parallel_slave.trc"},
	}
	files, _ := filepath.Glob(traces + "*.trc")
	if len(files) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range files {
		sets[filepath.Base(f)] = []string{f}
	}
	return sets
}

// sameStmts compares two statement tables. Statements leaves Parents,
// Children, Plans and PlanHashes nil when there are none; StatementsOn does
// the same, so nothing is normalised: a nil/empty mismatch would change the
// JSON (null vs []) and is an error.
func sameStmts(t *testing.T, what string, got, want []analyze.StmtStats) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d statements, want %d", what, len(got), len(want))
	}
	n := 0
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			if n++; n <= 3 {
				t.Errorf("%s: statement %d differs\n got %+v\nwant %+v", what, i, got[i], want[i])
			}
		}
	}
	if n > 3 {
		t.Errorf("%s: %d statements differ", what, n)
	}
}

func TestStatementsOnWholeSetEqualsStatements(t *testing.T) {
	for name, paths := range stmtSets(t) {
		t.Run(name, func(t *testing.T) {
			full, err := model.BuildFiles(paths, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			want := analyze.Statements(full)
			got, err := analyze.StatementsOn(context.Background(), full, MemSource(full), analyze.Filter{})
			if err != nil {
				t.Fatal(err)
			}
			sameStmts(t, "memory", got, want)

			agg, sp := buildSpilled(t, paths, t.TempDir())
			defer sp.Close()
			src, err := sp.Source()
			if err != nil {
				t.Fatal(err)
			}
			got, err = analyze.StatementsOn(context.Background(), agg, src, analyze.Filter{})
			if err != nil {
				t.Fatal(err)
			}
			sameStmts(t, "spill", got, want)
			// the aggregation-only model's own table (what doc.stats.statements holds there)
			sameStmts(t, "spill vs accumulator", got, analyze.Statements(agg))
		})
	}
}

// Disjoint context subsets (here: the contexts of each file, what the UI's
// file selection sends) add up to the whole set, and the spill answers each
// subset like the model (the spill skips the rows of other contexts, so the
// parents of a continued file's children are found by the second scan).
func TestStatementsOnContextSubsetsAddUp(t *testing.T) {
	for name, paths := range stmtSets(t) {
		t.Run(name, func(t *testing.T) {
			m, err := model.BuildFiles(paths, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			whole := analyze.Statements(m)
			byFile := map[int][]model.ID{}
			for i := range m.Contexts {
				byFile[m.Contexts[i].FileIdx] = append(byFile[m.Contexts[i].FileIdx], model.ID(i))
			}
			var subsets [][]model.ID
			for _, ids := range byFile {
				subsets = append(subsets, ids)
			}
			if len(m.Contexts) > 1 && len(subsets) == 1 { // one file: split its sessions
				subsets = nil
				for i := range m.Contexts {
					subsets = append(subsets, []model.ID{model.ID(i)})
				}
			}
			agg, sp := buildSpilled(t, paths, t.TempDir())
			defer sp.Close()
			disk, err := sp.Source()
			if err != nil {
				t.Fatal(err)
			}
			execs := make([]int64, len(whole))
			calls := make([]int64, len(whole))
			ela := make([]int64, len(whole))
			for _, sub := range subsets {
				part, err := analyze.StatementsOn(context.Background(), m, MemSource(m), analyze.Filter{Contexts: sub})
				if err != nil {
					t.Fatal(err)
				}
				fromDisk, err := analyze.StatementsOn(context.Background(), agg, disk, analyze.Filter{Contexts: sub})
				if err != nil {
					t.Fatal(err)
				}
				sameStmts(t, fmt.Sprintf("spill, contexts %v", sub), fromDisk, part)
				for i := range part {
					if part[i].ID != model.ID(i) {
						t.Fatalf("statement %d has id %d", i, part[i].ID)
					}
					execs[i] += part[i].Executions
					calls[i] += part[i].AllCalls.Count
					ela[i] += part[i].SelfElapsed
				}
			}
			for i := range whole {
				if execs[i] != whole[i].Executions || calls[i] != whole[i].AllCalls.Count || ela[i] != whole[i].SelfElapsed {
					t.Errorf("statement %d: subsets execs %d calls %d self ela %d, whole %d %d %d", i,
						execs[i], calls[i], ela[i], whole[i].Executions, whole[i].AllCalls.Count, whole[i].SelfElapsed)
				}
			}
		})
	}
}

// One file of a multi-file set gets the numbers of that file alone.
func TestStatementsOnFileSubsetMatchesFileAlone(t *testing.T) {
	a, b := traces+"multisession_a.trc", traces+"multisession_b.trc"
	m, err := model.BuildFiles([]string{a, b}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	alone, err := model.BuildFiles([]string{b}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var ctxs []model.ID
	for i := range m.Contexts {
		if m.Contexts[i].FileIdx == 1 {
			ctxs = append(ctxs, model.ID(i))
		}
	}
	part, err := analyze.StatementsOn(context.Background(), m, MemSource(m), analyze.Filter{Contexts: ctxs})
	if err != nil {
		t.Fatal(err)
	}
	bySQL := map[string]analyze.StmtStats{}
	for _, s := range part {
		if s.AllCalls.Count > 0 {
			bySQL[m.Statements[s.ID].SQLID+"|"+m.Statements[s.ID].Text] = s
		}
	}
	n := 0
	for _, w := range analyze.Statements(alone) {
		if w.AllCalls.Count == 0 {
			continue
		}
		key := alone.Statements[w.ID].SQLID + "|" + alone.Statements[w.ID].Text
		g, ok := bySQL[key]
		if !ok {
			t.Errorf("%s: missing in the file subset", key)
			continue
		}
		n++
		if g.Executions != w.Executions || g.AllCalls != w.AllCalls || g.Elapsed != w.Elapsed || g.Cursors != w.Cursors {
			t.Errorf("%.40s: subset execs %d ela %d cursors %d calls %+v\n alone execs %d ela %d cursors %d calls %+v", key,
				g.Executions, g.Elapsed, g.Cursors, g.AllCalls, w.Executions, w.Elapsed, w.Cursors, w.AllCalls)
		}
	}
	if n == 0 || n != len(bySQL) {
		t.Errorf("%d statements of the file alone, %d with calls in the subset", n, len(bySQL))
	}
}

func TestStatementsEndpoint(t *testing.T) {
	m, h := setup(t)
	var got struct {
		Statements []analyze.StmtStats `json:"statements"`
	}
	if code := get(t, h, "/api/statements", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	sameStmts(t, "endpoint", got.Statements, analyze.Statements(m))
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	q := fmt.Sprintf("/api/statements?from=%d&contexts=0&idle=0", mid)
	if code := get(t, h, q, &got); code != 200 {
		t.Fatalf("%s: status %d", q, code)
	}
	want, _ := analyze.StatementsOn(context.Background(), m, MemSource(m), analyze.Filter{StartTim: mid, Contexts: []model.ID{0}})
	sameStmts(t, q, got.Statements, want)
	for _, p := range []string{"/api/statements?from=x", "/api/statements?contexts=999", "/api/statements?idle=2", "/api/statements?from=10&to=5"} {
		if code := get(t, h, p, nil); code != 400 {
			t.Errorf("%s: status %d, want 400", p, code)
		}
	}
	// the exact JSON of the document's statements
	_, body := fetch(h, "/api/statements")
	if !strings.HasPrefix(string(body), `{"statements":[{"id":0,"parse":{`) {
		t.Errorf("shape: %.80s", body)
	}
}
