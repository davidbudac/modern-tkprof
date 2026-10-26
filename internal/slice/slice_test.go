package slice

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

const fixture = "../../testdata/traces/19c/io_waits.trc"

func setup(t *testing.T) (*model.Model, http.Handler) {
	t.Helper()
	m, err := model.Build(fixture, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m, New(m).Handler()
}

// get decodes the JSON answer of a GET into v and returns the status.
func get(t *testing.T, h http.Handler, path string, v any) int {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	if rec.Code == http.StatusOK && v != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
			t.Fatalf("%s: %v\n%s", path, err, rec.Body.String())
		}
	}
	return rec.Code
}

func eventID(t *testing.T, m *model.Model, name string) model.ID {
	t.Helper()
	for i := range m.Events {
		if m.Events[i].Name == name {
			return model.ID(i)
		}
	}
	t.Fatalf("no event %q", name)
	return 0
}

// busiest statement: the one with the most waits of db file sequential read
func busiestStmt(m *model.Model, ev model.ID) model.ID {
	n := map[model.ID]int{}
	for i := range m.Waits {
		if m.Waits[i].Event == ev {
			n[m.Waits[i].Statement]++
		}
	}
	best, bn := model.ID(0), -1
	for s, c := range n {
		if c > bn || (c == bn && s < best) {
			best, bn = s, c
		}
	}
	return best
}

func TestPivotMatchesAnalyze(t *testing.T) {
	m, h := setup(t)
	ev := eventID(t, m, "db file sequential read")
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	cases := []struct {
		query string
		fact  analyze.Fact
		by    []string
		f     analyze.Filter
	}{
		{"fact=calls&by=stmt", analyze.FactCalls, []string{"stmt"}, analyze.Filter{IncludeIdle: true}},
		{"fact=waits&by=event&idle=0", analyze.FactWaits, []string{"event"}, analyze.Filter{}},
		{"fact=waits&by=stmt,obj&idle=1", analyze.FactWaits, []string{"stmt", "obj"}, analyze.Filter{IncludeIdle: true}},
		{fmt.Sprintf("fact=waits&by=p1&event=%d", ev), analyze.FactWaits, []string{"p1"}, analyze.Filter{IncludeIdle: true, Event: &ev}},
		{fmt.Sprintf("fact=calls&by=kind&from=%d", mid), analyze.FactCalls, []string{"kind"}, analyze.Filter{StartTim: mid}},
		{fmt.Sprintf("fact=calls&by=time&to=%d&contexts=0", mid), analyze.FactCalls, []string{"time"}, analyze.Filter{EndTim: mid, Contexts: []model.ID{0}}},
	}
	for _, c := range cases {
		var got PivotResponse
		if code := get(t, h, "/api/pivot?"+c.query, &got); code != 200 {
			t.Fatalf("%s: status %d", c.query, code)
		}
		want, err := analyze.Pivot(m, c.fact, c.by, c.f)
		if err != nil {
			t.Fatal(err)
		}
		if got.Groups != len(want.Rows) || got.Facts != want.Facts || got.Truncated {
			t.Errorf("%s: groups %d/%d facts %d/%d truncated %v", c.query, got.Groups, len(want.Rows), got.Facts, want.Facts, got.Truncated)
		}
		if !reflect.DeepEqual(got.Total, want.Total) || !reflect.DeepEqual(got.Rows, want.Rows) {
			t.Errorf("%s: rows differ\n got %v\nwant %v", c.query, got.Rows, want.Rows)
		}
	}
}

func TestPivotStatementFilterAndMeasures(t *testing.T) {
	m, h := setup(t)
	ev := eventID(t, m, "db file sequential read")
	sid := busiestStmt(m, ev)
	var got PivotResponse
	if code := get(t, h, fmt.Sprintf("/api/pivot?fact=waits&by=event&stmt=%d&measure=count,ela,share", sid), &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	want, _ := analyze.Pivot(m, analyze.FactWaits, []string{"event"}, analyze.Filter{IncludeIdle: true, Statement: &sid})
	if len(got.Measures) != 3 || got.Measures[0].ID != "count" || got.Measures[2].ID != "share" {
		t.Fatalf("measures %v", got.Measures)
	}
	if len(got.Rows) != len(want.Rows) {
		t.Fatalf("rows %d want %d", len(got.Rows), len(want.Rows))
	}
	count, ela, share := analyze.MeasureIndex(analyze.FactWaits, "count"), analyze.MeasureIndex(analyze.FactWaits, "ela"), analyze.MeasureIndex(analyze.FactWaits, "share")
	for i, r := range got.Rows { // sorted by the first measure: count
		w := want.Rows[0]
		for _, x := range want.Rows {
			if x.Keys[0] == r.Keys[0] {
				w = x
			}
		}
		if r.Values[0] != w.Values[count] || r.Values[1] != w.Values[ela] || r.Values[2] != w.Values[share] {
			t.Errorf("row %d values %v want %v", i, r.Values, w.Values)
		}
		if i > 0 && got.Rows[i-1].Values[0] < r.Values[0] {
			t.Errorf("rows not sorted by count")
		}
	}
	// the row cap keeps the order and counts every group
	var cap1 PivotResponse
	get(t, h, "/api/pivot?fact=calls&by=stmt&limit=2", &cap1)
	if len(cap1.Rows) != 2 || !cap1.Truncated || cap1.Groups != len(m.Statements) && cap1.Groups < 3 {
		t.Errorf("limit: rows %d truncated %v groups %d", len(cap1.Rows), cap1.Truncated, cap1.Groups)
	}
}

func TestTimelineMatchesAnalyze(t *testing.T) {
	m, h := setup(t)
	bucket := analyze.TimelineBucket(m)
	for _, q := range []string{"", "&contexts=0", "&idle=0"} {
		var got analyze.SpanSeries
		if code := get(t, h, fmt.Sprintf("/api/timeline?bucket=%d%s", bucket, q), &got); code != 200 {
			t.Fatalf("status %d", code)
		}
		f := analyze.Filter{IncludeIdle: true}
		if q == "&contexts=0" {
			f.Contexts = []model.ID{0}
		}
		if q == "&idle=0" {
			f.IncludeIdle = false
		}
		want := analyze.SpreadTimeline(m, bucket, f)
		if got.N != want.N || got.BucketUs != want.BucketUs || got.FirstTim != want.FirstTim || !reflect.DeepEqual(got.CPU, want.CPU) || len(got.Events) != len(want.Events) {
			t.Fatalf("%q: timeline differs (n %d/%d events %d/%d)", q, got.N, want.N, len(got.Events), len(want.Events))
		}
		for i := range got.Events {
			if got.Events[i].Event != want.Events[i].Event || !reflect.DeepEqual(got.Events[i].Us, want.Events[i].Us) {
				t.Errorf("%q: event series %d differs", q, i)
			}
		}
	}
	// invariants: no bucket is more than 100 % busy, waits add up to the pivot's wait time
	var tl analyze.SpanSeries
	get(t, h, fmt.Sprintf("/api/timeline?bucket=%d", bucket), &tl)
	for b := 0; b < tl.N; b++ {
		sum := tl.CPU[b]
		for _, e := range tl.Events {
			sum += e.Us[b]
		}
		if sum > float64(bucket)+1e-6 {
			t.Fatalf("bucket %d is %.0f of %d µs busy", b, sum, bucket)
		}
	}
	var perEvent float64
	for _, e := range tl.Events {
		for _, v := range e.Us {
			perEvent += v
		}
	}
	prof := analyze.ProfileOf(m, analyze.Filter{IncludeIdle: true})
	var waitUs int64
	for _, e := range prof.Events {
		waitUs += e.Us
	}
	if perEvent > float64(waitUs)+1 || perEvent < 0.5*float64(waitUs) {
		t.Errorf("timeline waits %.0f µs vs %d µs in the profile", perEvent, waitUs)
	}
	if code := get(t, h, "/api/timeline?bucket=1", nil); code != 400 {
		t.Errorf("bucket=1 gave %d, want 400 (too many buckets)", code)
	}
}

func TestProfileMatchesAnalyze(t *testing.T) {
	m, h := setup(t)
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/3
	var got analyze.ScopeProfile
	if code := get(t, h, fmt.Sprintf("/api/profile?from=%d&idle=0", mid), &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	want := analyze.ProfileOf(m, analyze.Filter{StartTim: mid})
	if got.Calls != want.Calls || got.Waits != want.Waits || got.CPUUs != want.CPUUs || !reflect.DeepEqual(got.Events, want.Events) {
		t.Errorf("profile differs:\n got %+v\nwant %+v", got, want)
	}
	// whole trace: CPU is Σ c of the top-level calls, waits are WaitsByEvent
	var all analyze.ScopeProfile
	get(t, h, "/api/profile", &all)
	var cpu int64
	for i := range m.Calls {
		if m.Calls[i].Parent == model.None {
			cpu += m.Calls[i].C
		}
	}
	if all.CPUUs != cpu || all.Calls != int64(len(m.Calls)) || all.Waits != int64(len(m.Waits)) {
		t.Errorf("whole trace: cpu %d/%d calls %d/%d waits %d/%d", all.CPUUs, cpu, all.Calls, len(m.Calls), all.Waits, len(m.Waits))
	}
}

func TestCallsAreTheLongest(t *testing.T) {
	m, h := setup(t)
	var got CallRows
	if code := get(t, h, "/api/calls?limit=50&longest=5", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	if len(got.Rows) != 50 || !got.Sampled || got.Total != int64(len(m.Calls)) && got.Total < 50 {
		t.Fatalf("rows %d sampled %v total %d", len(got.Rows), got.Sampled, got.Total)
	}
	var es []int64
	for i := range m.Calls {
		if m.Calls[i].Tim != 0 {
			es = append(es, m.Calls[i].E)
		}
	}
	sort.Slice(es, func(a, b int) bool { return es[a] > es[b] })
	var gotE []int64
	for k, r := range got.Rows {
		c := &m.Calls[r[0]]
		if r[1] != int64(c.Statement) || r[3] != c.Tim || r[4] != c.E || r[7] != int64(c.Line) || r[10] != int64(c.Context) {
			t.Fatalf("row %d does not match call %d: %v", k, r[0], r)
		}
		if k > 0 && r[0] <= got.Rows[k-1][0] {
			t.Fatal("rows not in file order")
		}
		gotE = append(gotE, r[4])
	}
	sort.Slice(gotE, func(a, b int) bool { return gotE[a] > gotE[b] })
	if !reflect.DeepEqual(gotE, es[:50]) {
		t.Errorf("the 50 rows are not the 50 longest calls")
	}
	if len(got.Longest) != 5 {
		t.Fatalf("longest %v", got.Longest)
	}
	for k, id := range got.Longest {
		if m.Calls[id].E != es[k] {
			t.Errorf("longest[%d] has e=%d want %d", k, m.Calls[id].E, es[k])
		}
	}
	// a window narrows the calls and reports the number in scope
	var win CallRows
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	get(t, h, fmt.Sprintf("/api/calls?from=%d&limit=20000", mid), &win)
	if win.Total >= got.Total || win.Total == 0 || win.Sampled {
		t.Errorf("window total %d of %d sampled %v", win.Total, got.Total, win.Sampled)
	}
}

func TestExecutionsMatchAnalyze(t *testing.T) {
	m, h := setup(t)
	stats := analyze.Statements(m)
	sid := model.ID(0)
	for _, s := range stats {
		if s.Executions > stats[sid].Executions {
			sid = s.ID
		}
	}
	want := analyze.Executions(m, sid)
	if len(want) < 2 {
		t.Skip("fixture has no statement with several executions")
	}
	var got ExecResponse
	if code := get(t, h, fmt.Sprintf("/api/executions?stmt=%d&limit=5000", sid), &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got.Total != len(want) || len(got.Rows) != len(want) {
		t.Fatalf("executions %d/%d want %d", got.Total, len(got.Rows), len(want))
	}
	var sum float64
	for i, e := range want {
		r := got.Rows[i]
		c := &m.Calls[e.Exec]
		if r.ExecNo != e.ExecNo || r.Exec != e.Exec || r.Cursor != e.Cursor || r.Line != c.Line || r.Ctx != c.Context || r.E != e.Stats.Elapsed || r.C != e.Stats.CPU ||
			r.R != e.Stats.Rows || r.WaitEla != e.Stats.Waits || r.Fetches != len(e.Fetches) || r.StartTim != e.StartTim || r.EndTim != e.EndTim {
			t.Fatalf("execution %d differs: %+v vs %+v", i, r, e)
		}
		sum += float64(e.Stats.Elapsed)
		if e.BindSet >= 0 {
			bs := m.BindSets[e.BindSet]
			if len(r.Binds) != int(bs.N) {
				t.Fatalf("execution %d: %d binds want %d", i, len(r.Binds), bs.N)
			}
			for k, b := range r.Binds {
				mb := &m.Binds[int(bs.First)+k]
				if b.Pos != mb.Pos || b.Value != mb.Value || b.Type != mb.TypeName() || b.IsNull != mb.IsNull || b.Kind != mb.Kind().String() || b.Typed != mb.Typed() {
					t.Fatalf("execution %d bind %d: %+v vs %+v", i, k, b, mb)
				}
			}
		}
	}
	if got.AvgE != sum/float64(len(want)) {
		t.Errorf("avgE %v want %v", got.AvgE, sum/float64(len(want)))
	}
	// sorted by elapsed, a page of two, offset one
	var page ExecResponse
	get(t, h, fmt.Sprintf("/api/executions?stmt=%d&sort=e&limit=2&offset=1", sid), &page)
	order := append([]analyze.Execution(nil), want...)
	sort.SliceStable(order, func(a, b int) bool { return order[a].Stats.Elapsed > order[b].Stats.Elapsed })
	if len(page.Rows) != 2 || page.Rows[0].ExecNo != order[1].ExecNo || page.Rows[1].ExecNo != order[2].ExecNo || page.Slowest.ExecNo != order[0].ExecNo {
		t.Errorf("sorted page: %+v", page.Rows)
	}
}

func TestExecutionDetailMatchesExecutions(t *testing.T) {
	m, h := setup(t)
	stats := analyze.Statements(m)
	sid := model.ID(0)
	for _, s := range stats {
		if s.Executions > stats[sid].Executions {
			sid = s.ID
		}
	}
	exs := analyze.Executions(m, sid)
	e := exs[len(exs)-1]
	var d ExecDetailResponse
	if code := get(t, h, fmt.Sprintf("/api/executions/detail?stmt=%d&cursor=%d&execNo=%d", sid, e.Cursor, e.ExecNo), &d); code != 200 {
		t.Fatalf("status %d", code)
	}
	if d.Exec != e.Exec || d.Line != m.Calls[e.Exec].Line || d.Ctx != m.Calls[e.Exec].Context {
		t.Errorf("exec %d line %d", d.Exec, d.Line)
	}
	// parse + exec + fetch of the detail cover at least the execution's own EXEC and FETCH calls
	if d.ExecPart.Calls != 1 || d.Fetch.Calls != int64(len(e.Fetches)) || d.Total.E < e.Stats.Elapsed {
		t.Errorf("parts: exec %+v fetch %+v (%d fetches) total %+v elapsed %d", d.ExecPart, d.Fetch, len(e.Fetches), d.Total, e.Stats.Elapsed)
	}
	if d.Total.Calls != d.Parse.Calls+d.ExecPart.Calls+d.Fetch.Calls {
		t.Errorf("total calls %d != %d+%d+%d", d.Total.Calls, d.Parse.Calls, d.ExecPart.Calls, d.Fetch.Calls)
	}
	var n int64
	for _, w := range d.Waits {
		n += w.Count
	}
	var want int64
	in := map[model.ID]bool{e.Exec: true}
	for _, f := range e.Fetches {
		in[f] = true
	}
	for i := range m.Waits {
		if in[m.Waits[i].Call] {
			want++
		}
	}
	if n < want {
		t.Errorf("waits %d, at least %d expected", n, want)
	}
	if code := get(t, h, fmt.Sprintf("/api/executions/detail?stmt=%d&cursor=%d&execNo=99999", sid, e.Cursor), nil); code != 400 {
		t.Errorf("unknown execution gave %d", code)
	}
}

// busiestEvent is the event with the most waits.
func busiestEvent(m *model.Model) model.ID {
	n := make([]int, len(m.Events))
	for i := range m.Waits {
		n[m.Waits[i].Event]++
	}
	best := model.ID(0)
	for e := range n {
		if n[e] > n[best] {
			best = model.ID(e)
		}
	}
	return best
}

func TestWaitsHistScatter(t *testing.T) {
	m, h := setup(t)
	ev := busiestEvent(m)
	var all []int64
	var sum int64
	for i := range m.Waits {
		if m.Waits[i].Event == ev {
			all = append(all, m.Waits[i].Ela)
			sum += m.Waits[i].Ela
		}
	}
	sort.Slice(all, func(a, b int) bool { return all[a] > all[b] })

	var hist analyze.LogHist
	if code := get(t, h, fmt.Sprintf("/api/waits/hist?event=%d", ev), &hist); code != 200 {
		t.Fatalf("status %d", code)
	}
	if hist.Count != int64(len(all)) || hist.Us != sum {
		t.Errorf("hist count %d us %d want %d, %d", hist.Count, hist.Us, len(all), sum)
	}
	var wantC [analyze.HistBins]int64
	for _, v := range all {
		b := 0
		for x := v; x > 1 && b < analyze.HistBins-1; x >>= 1 {
			b++
		}
		wantC[b]++
	}
	if hist.Counts != wantC {
		t.Errorf("hist counts %v want %v", hist.Counts, wantC)
	}

	var rows WaitsResponse
	if code := get(t, h, fmt.Sprintf("/api/waits?event=%d&limit=7", ev), &rows); code != 200 {
		t.Fatalf("status %d", code)
	}
	if rows.Total != int64(len(all)) || rows.Us != sum || len(rows.Rows) != 7 {
		t.Fatalf("waits: total %d us %d rows %d", rows.Total, rows.Us, len(rows.Rows))
	}
	for k, r := range rows.Rows {
		if r.Ela != all[k] || r.Event != ev || r.Ctx != m.Waits[findWait(m, r.Line)].Context || r.Line != m.Waits[findWait(m, r.Line)].Line {
			t.Errorf("row %d: %+v want ela %d", k, r, all[k])
		}
	}
	var early WaitsResponse
	get(t, h, fmt.Sprintf("/api/waits?event=%d&limit=3&sort=tim", ev), &early)
	for k := 1; k < len(early.Rows); k++ {
		if early.Rows[k].Tim < early.Rows[k-1].Tim {
			t.Error("sort=tim is not ascending")
		}
	}

	var sc ScatterResponse
	if code := get(t, h, fmt.Sprintf("/api/waits/scatter?event=%d&max=20000", ev), &sc); code != 200 {
		t.Fatalf("status %d", code)
	}
	if sc.Total != len(all) || sc.Sampled || len(sc.Rows) != len(all) {
		t.Fatalf("scatter total %d rows %d sampled %v", sc.Total, len(sc.Rows), sc.Sampled)
	}
	for k, r := range sc.Rows {
		if w := &m.Waits[findWait(m, int32(r[2]))]; r[4] != int64(w.Context) {
			t.Fatalf("scatter row %d ctx %d want %d", k, r[4], w.Context)
		}
	}
	// forced sampling keeps the slowest wait and the cap
	var small ScatterResponse
	get(t, h, fmt.Sprintf("/api/waits/scatter?event=%d&max=%d", ev, analyze.KeepSlowest+10), &small)
	if len(all) > analyze.KeepSlowest+10 {
		if len(small.Rows) != analyze.KeepSlowest+10 || !small.Sampled {
			t.Fatalf("sampled scatter: %d rows, sampled %v", len(small.Rows), small.Sampled)
		}
		var top int64
		for _, r := range small.Rows {
			if r[1] > top {
				top = r[1]
			}
		}
		if top != all[0] {
			t.Errorf("sample lost the slowest wait: %d vs %d", top, all[0])
		}
	}
	if code := get(t, h, "/api/waits/hist", nil); code != 400 {
		t.Errorf("hist without event or stmt gave %d", code)
	}
}

func TestWaitsByMatchesAnalyze(t *testing.T) {
	m, h := setup(t)
	ev := busiestEvent(m)
	for _, by := range []string{"stmt", "obj", "p1", "p2"} {
		var got WaitsByResponse
		if code := get(t, h, fmt.Sprintf("/api/waits/by?event=%d&by=%s&limit=3", ev, by), &got); code != 200 {
			t.Fatalf("%s: status %d", by, code)
		}
		want := analyze.WaitsBy(m, func(w *model.Wait) bool { return w.Event == ev }, func(w *model.Wait) (int64, bool) {
			switch by {
			case "stmt":
				return int64(w.Statement), true
			case "obj":
				return w.ObjID, w.ObjID > 0
			case "p1":
				return w.P1, true
			}
			return w.P2, true
		})
		if got.Groups != len(want) {
			t.Errorf("%s: %d groups want %d", by, got.Groups, len(want))
		}
		n := len(want)
		if n > 3 {
			n = 3
		}
		if !reflect.DeepEqual(got.Rows, want[:n]) && n > 0 {
			t.Errorf("%s: rows %v want %v", by, got.Rows, want[:n])
		}
	}
}

func findWait(m *model.Model, line int32) int {
	for i := range m.Waits {
		if m.Waits[i].Line == line {
			return i
		}
	}
	return 0
}

func TestStatementEndpoints(t *testing.T) {
	m, h := setup(t)
	ev := eventID(t, m, "db file sequential read")
	sid := busiestStmt(m, ev)
	other := (sid + 1) % model.ID(len(m.Statements))

	var roles struct {
		Classes []string
		Rows    [][3]int64
	}
	if code := get(t, h, "/api/stmt/roles", &roles); code != 200 {
		t.Fatalf("status %d", code)
	}
	var fromRows, fromWaits int64
	for _, r := range roles.Rows {
		if r[0] == int64(sid) {
			fromRows += r[2]
		}
	}
	for i := range m.Waits {
		if m.Waits[i].Statement == sid {
			fromWaits += m.Waits[i].Ela
		}
	}
	if fromRows != fromWaits || len(roles.Classes) == 0 {
		t.Errorf("roles: %d µs, waits %d", fromRows, fromWaits)
	}

	var tw struct {
		Waits map[string][]analyze.StmtEventWait
	}
	if code := get(t, h, fmt.Sprintf("/api/stmt/waits?stmt=%d,%d&max=3", sid, other), &tw); code != 200 {
		t.Fatalf("status %d", code)
	}
	l := tw.Waits[fmt.Sprint(sid)]
	if len(l) == 0 || len(l) > 3 {
		t.Fatalf("waits of %d: %v", sid, l)
	}
	var n, us, maxUs int64
	for i := range m.Waits {
		if w := &m.Waits[i]; w.Statement == sid && w.Event == l[0].Event {
			n++
			us += w.Ela
			if w.Ela > maxUs {
				maxUs = w.Ela
			}
		}
	}
	for i := range m.Waits {
		if w := &m.Waits[i]; w.Line == l[0].MaxLin && w.Statement == sid && w.Event == l[0].Event && w.Context != l[0].MaxCtx {
			t.Errorf("maxCtx %d want %d", l[0].MaxCtx, w.Context)
		}
	}
	if l[0].Count != n || l[0].Us != us || l[0].MaxUs != maxUs {
		t.Errorf("top wait %+v want count %d us %d max %d", l[0], n, us, maxUs)
	}
	for k := 1; k < len(l); k++ {
		if l[k].Us > l[k-1].Us {
			t.Error("waits not sorted by time")
		}
	}
	if _, ok := tw.Waits[fmt.Sprint(other)]; !ok {
		t.Error("a statement without waits must still be listed")
	}

	var sp struct {
		Spans map[string][]analyze.Interval
	}
	if code := get(t, h, fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=0", sid), &sp); code != 200 {
		t.Fatalf("status %d", code)
	}
	iv := sp.Spans[fmt.Sprint(sid)]
	if len(iv) == 0 {
		t.Fatal("no spans")
	}
	for k, x := range iv {
		if x.End < x.Start || (k > 0 && x.Start <= iv[k-1].End) {
			t.Errorf("span %d %+v overlaps the previous one", k, x)
		}
	}
	var wide struct {
		Spans map[string][]analyze.Interval
	}
	get(t, h, fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=%d", sid, m.Span.LastTim-m.Span.FirstTim), &wide)
	if got := wide.Spans[fmt.Sprint(sid)]; len(got) != 1 {
		t.Errorf("a gap as long as the trace merges everything, got %d spans", len(got))
	}

	// phases=1: same stretches' coverage, each with a kind and µs per group
	var ph struct {
		Spans map[string][]analyze.PhaseSpan
	}
	if code := get(t, h, fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=0&phases=1", sid), &ph); code != 200 {
		t.Fatalf("phases: status %d", code)
	}
	segs := ph.Spans[fmt.Sprint(sid)]
	if len(segs) < len(iv) {
		t.Errorf("phase segments (%d) cannot be fewer than merged spans (%d)", len(segs), len(iv))
	}
	var segUs, callUs int64
	for k, x := range segs {
		if x.End < x.Start || (k > 0 && x.Start < segs[k-1].Start) {
			t.Errorf("segment %d %+v out of order", k, x)
		}
		ok := false
		for _, n := range analyze.PhaseNames {
			ok = ok || x.Kind == n
		}
		if !ok {
			t.Errorf("segment %d has kind %q", k, x.Kind)
		}
		for _, v := range x.Us {
			segUs += v
		}
	}
	for i := range m.Calls {
		if c := &m.Calls[i]; c.Statement == sid && c.Tim != 0 {
			callUs += c.E
		}
	}
	if segUs != callUs {
		t.Errorf("segments hold %d µs, the statement's calls %d", segUs, callUs)
	}
	var wsp struct {
		Spans map[string][]analyze.WaitSpan
	}
	if code := get(t, h, fmt.Sprintf("/api/stmt/waitspans?stmt=%d,%d&gap=1000", sid, other), &wsp); code != 200 {
		t.Fatalf("waitspans: status %d", code)
	}
	var wUs, evUs int64
	for _, x := range wsp.Spans[fmt.Sprint(sid)] {
		if x.End < x.Start || len(x.Top) == 0 || int(x.Top[0][0]) < 0 {
			t.Errorf("wait span %+v", x)
		}
		wUs += x.RestUs
		for _, e := range x.Top {
			wUs += e[1]
		}
	}
	for i := range m.Waits {
		if w := &m.Waits[i]; w.Statement == sid && w.Tim != 0 {
			evUs += w.Ela
		}
	}
	if wUs != evUs {
		t.Errorf("wait spans hold %d µs, the statement's waits %d", wUs, evUs)
	}
	if _, ok := wsp.Spans[fmt.Sprint(other)]; !ok {
		t.Error("a statement without waits must still be listed")
	}
	var plain struct {
		Spans map[string][]map[string]any
	}
	get(t, h, fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=0", sid), &plain)
	if _, has := plain.Spans[fmt.Sprint(sid)][0]["kind"]; has {
		t.Error("without phases=1 the intervals carry no kind")
	}
}

func TestBadParametersAre400(t *testing.T) {
	_, h := setup(t)
	for _, p := range []string{
		"/api/pivot", "/api/pivot?fact=nope&by=stmt", "/api/pivot?fact=calls", "/api/pivot?fact=calls&by=nope",
		"/api/pivot?fact=calls&by=stmt&measure=nope", "/api/pivot?fact=calls&by=stmt&limit=0", "/api/pivot?fact=calls&by=stmt&limit=9999999",
		"/api/pivot?fact=calls&by=stmt&from=abc", "/api/pivot?fact=calls&by=stmt&from=10&to=5", "/api/pivot?fact=calls&by=stmt&contexts=999",
		"/api/pivot?fact=calls&by=stmt&stmt=9999", "/api/pivot?fact=calls&by=stmt&event=1", "/api/pivot?fact=waits&by=stmt&idle=2",
		"/api/pivot?fact=waits&by=stmt,event,obj,p1,p2",
		"/api/timeline?bucket=0", "/api/timeline?bucket=x",
		"/api/calls?limit=0", "/api/calls?limit=20001", "/api/calls?longest=101",
		"/api/executions", "/api/executions?stmt=-1", "/api/executions?stmt=0&sort=nope", "/api/executions?stmt=0&limit=5001", "/api/executions?stmt=0&offset=-1",
		"/api/executions/detail?stmt=0", "/api/executions/detail?stmt=0&cursor=0",
		"/api/waits", "/api/waits?event=0&sort=nope", "/api/waits?event=0&limit=1001", "/api/waits/hist", "/api/waits/scatter?event=0&max=50001", "/api/waits/by?event=0", "/api/waits/by?event=0&by=nope", "/api/waits/by?event=0&by=stmt&limit=0",
		"/api/stmt/waits", "/api/stmt/waits?stmt=9999", "/api/stmt/spans", "/api/stmt/spans?stmt=0&gap=-1", "/api/stmt/spans?stmt=0&phases=2", "/api/stmt/waitspans", "/api/stmt/waitspans?stmt=0&gap=-1", "/api/stmt/waitspans?stmt=0&idle=2",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != 400 {
			t.Errorf("%s: status %d, want 400 (%s)", p, rec.Code, strings.TrimSpace(rec.Body.String()))
		} else if strings.TrimSpace(rec.Body.String()) == "" {
			t.Errorf("%s: 400 without a reason", p)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/pivot?fact=calls&by=stmt", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST gave %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("OPTIONS", "/api/pivot", nil))
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("OPTIONS gave %d, origin %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestResponsesAreCachedAndCORS(t *testing.T) {
	_, h := setup(t)
	a := httptest.NewRecorder()
	h.ServeHTTP(a, httptest.NewRequest("GET", "/api/pivot?fact=calls&by=stmt", nil))
	b := httptest.NewRecorder()
	h.ServeHTTP(b, httptest.NewRequest("GET", "/api/pivot?fact=calls&by=stmt", nil))
	if a.Code != 200 || a.Body.String() != b.Body.String() {
		t.Fatal("repeated query differs")
	}
	if a.Header().Get("Access-Control-Allow-Origin") != "*" || a.Header().Get("Content-Type") != "application/json" {
		t.Errorf("headers %v", a.Header())
	}
}
