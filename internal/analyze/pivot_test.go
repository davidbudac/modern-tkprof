package analyze

import (
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

func loadModel(t *testing.T, name string) *model.Model {
	t.Helper()
	m, err := model.Build(filepath.Join(fixtures, name), model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func all() Filter { return Filter{IncludeIdle: true} }

func TestPivotCallsByStmtSumsAllCalls(t *testing.T) {
	m := loadModel(t, "plsql_recursive.trc")
	r, err := Pivot(m, FactCalls, []string{"stmt"}, all())
	if err != nil {
		t.Fatal(err)
	}
	var want, wantSelf int64
	for i := range m.Calls {
		want += m.Calls[i].E
		wantSelf += m.Calls[i].SelfE
	}
	e, se := MeasureIndex(FactCalls, "e"), MeasureIndex(FactCalls, "selfE")
	var got, gotSelf float64
	for _, row := range r.Rows {
		got += row.Values[e]
		gotSelf += row.Values[se]
	}
	if int64(got) != want || int64(gotSelf) != wantSelf || int64(r.Total[e]) != want {
		t.Fatalf("Σe got %v (total %v) want %d; Σself got %v want %d", got, r.Total[e], want, gotSelf, wantSelf)
	}
	if r.Facts != len(m.Calls) {
		t.Fatalf("facts %d want %d", r.Facts, len(m.Calls))
	}
	for i := 1; i < len(r.Rows); i++ {
		if r.Rows[i-1].Values[e] < r.Rows[i].Values[e] {
			t.Fatal("rows not sorted by e desc")
		}
	}
	if r.Rows[0].Extra[0] == "" {
		t.Fatal("statement dimension has no text preview")
	}
}

func TestPivotWaitsByEventMatchesWaitsByEvent(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	r, err := Pivot(m, FactWaits, []string{"event"}, all())
	if err != nil {
		t.Fatal(err)
	}
	ref := WaitsByEvent(m, nil)
	if len(r.Rows) != len(ref) {
		t.Fatalf("%d groups, WaitsByEvent has %d", len(r.Rows), len(ref))
	}
	cnt, ela, min, max := MeasureIndex(FactWaits, "count"), MeasureIndex(FactWaits, "ela"), MeasureIndex(FactWaits, "min"), MeasureIndex(FactWaits, "max")
	byName := map[string]PivotRow{}
	for _, row := range r.Rows {
		byName[row.Labels[0]] = row
	}
	for _, ev := range ref {
		row, ok := byName[ev.Name]
		if !ok {
			t.Fatalf("event %q missing", ev.Name)
		}
		if int64(row.Values[cnt]) != ev.Count || int64(row.Values[ela]) != ev.Us || int64(row.Values[min]) != ev.MinUs || int64(row.Values[max]) != ev.MaxUs {
			t.Fatalf("%s: pivot %v, WaitsByEvent %+v", ev.Name, row.Values, ev)
		}
	}
}

func TestPivotFilters(t *testing.T) {
	m := loadModel(t, "multisession.trc")
	full, _ := Pivot(m, FactWaits, []string{"session", "idle"}, all())
	noIdle, _ := Pivot(m, FactWaits, []string{"session"}, Filter{})
	var idleN int
	for i := range m.Waits {
		if m.Waits[i].Idle {
			idleN++
		}
	}
	if noIdle.Facts != full.Facts-idleN {
		t.Fatalf("idle filter: %d of %d rows, %d idle", noIdle.Facts, full.Facts, idleN)
	}
	if len(m.Contexts) > 1 {
		c, _ := Pivot(m, FactCalls, []string{"kind"}, Filter{Contexts: []model.ID{1}})
		n := 0
		for i := range m.Calls {
			if m.Calls[i].Context == 1 {
				n++
			}
		}
		if c.Facts != n {
			t.Fatalf("context filter: %d rows want %d", c.Facts, n)
		}
	}
	// a window over the first half keeps calls that end in it or overlap it
	mid := m.Span.FirstTim + m.Span.Us()/2
	w, _ := Pivot(m, FactCalls, []string{"time"}, Filter{EndTim: mid})
	n := 0
	for i := range m.Calls {
		if m.Calls[i].Tim-m.Calls[i].E <= mid {
			n++
		}
	}
	if w.Facts != n || n == 0 {
		t.Fatalf("window: %d rows want %d", w.Facts, n)
	}
}

func TestPivotEveryDimension(t *testing.T) {
	m := loadModel(t, "basic_binds.trc")
	for _, f := range []Fact{FactCalls, FactWaits} {
		for _, d := range Dims(f) {
			r, err := Pivot(m, f, []string{d.ID}, all())
			if err != nil {
				t.Fatal(err)
			}
			var n float64
			for _, row := range r.Rows {
				if row.Labels[0] == "" {
					t.Fatalf("%s/%s: empty label", f, d.ID)
				}
				n += row.Values[0]
			}
			if int(n) != r.Facts {
				t.Fatalf("%s/%s: counts %v != %d rows", f, d.ID, n, r.Facts)
			}
		}
		if _, err := Pivot(m, f, []string{"nope"}, all()); err == nil {
			t.Fatal("unknown dimension accepted")
		}
	}
}

func TestContextsMatchProfile(t *testing.T) {
	m := loadModel(t, "multisession.trc")
	cs := Contexts(m)
	var calls, ela int64
	for _, c := range cs {
		calls += c.Calls
		ela += c.Elapsed
	}
	var want int64
	for i := range m.Calls {
		if m.Calls[i].Parent == model.None {
			want += m.Calls[i].E
		}
	}
	if calls != int64(len(m.Calls)) || ela != want {
		t.Fatalf("contexts: calls %d/%d, elapsed %d/%d", calls, len(m.Calls), ela, want)
	}
}

// The UI's pickBucket (web/src/data/derive.ts) implements the same rule; keep
// the cases in sync when changing either.
func TestBucketForSpan(t *testing.T) {
	for _, c := range []struct{ span, want int64 }{
		{-5, 0}, {0, 0},
		{1, 1000}, {400_999, 1000}, {401_000, 10_000},
		{4_009_999, 10_000}, {4_010_000, 100_000},
		{40_100_000, 1_000_000},
		{24_000_000_000, 60_000_000},
		{24_060_000_000, 600_000_000},
		{240_600_000_000, 3_600_000_000},
		{1_443_599_999_999, 3_600_000_000},           // floor(span/1h) = 400
		{1_443_600_000_000, 1_443_600_000_000 / 400}, // 401 h: span/400
	} {
		if got := BucketForSpan(c.span); got != c.want {
			t.Errorf("BucketForSpan(%d) = %d, want %d", c.span, got, c.want)
		}
	}
}
