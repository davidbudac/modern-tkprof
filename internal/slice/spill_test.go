package slice

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

const traces = "../../testdata/traces/19c/"

// buildSpilled builds the trace set as `serve -spill` does: aggregation-only
// model, facts and binds spilled to dir.
func buildSpilled(t *testing.T, paths []string, dir string) (*model.Model, *Spill) {
	t.Helper()
	sp, err := NewSpill(SpillOptions{Dir: dir, Key: SpillKey(paths)})
	if err != nil {
		t.Fatal(err)
	}
	th := analyze.DefaultThresholds()
	m, err := model.BuildFiles(paths, model.Options{
		Aggregate: true, SpillBinds: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  func(m *model.Model) model.Sink { return sp.Attach(m) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return m, sp
}

func canon(t *testing.T, body []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, body)
	}
	b, _ := json.Marshal(v) // maps marshal with sorted keys
	return string(b)
}

func fetch(h http.Handler, url string) (int, []byte) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	return rec.Code, rec.Body.Bytes()
}

// queries lists requests that exercise every endpoint of the model.
func queries(t *testing.T, m *model.Model, h http.Handler) []string {
	t.Helper()
	var q []string
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	for _, fact := range []analyze.Fact{analyze.FactCalls, analyze.FactWaits} {
		for _, d := range analyze.Dims(fact) {
			q = append(q, fmt.Sprintf("/api/pivot?fact=%s&by=%s", fact, d.ID))
		}
		q = append(q,
			fmt.Sprintf("/api/pivot?fact=%s&by=stmt,session", fact),
			fmt.Sprintf("/api/pivot?fact=%s&by=time&from=%d&to=%d", fact, mid, m.Span.LastTim),
			fmt.Sprintf("/api/pivot?fact=%s&by=stmt&contexts=0", fact),
			fmt.Sprintf("/api/pivot?fact=%s&by=stmt&contexts=%d,0&idle=0", fact, len(m.Contexts)-1),
		)
	}
	q = append(q, "/api/pivot?fact=waits&by=callKind,class", "/api/pivot?fact=calls&by=dep,kind&limit=3")
	q = append(q, "/api/timeline", "/api/timeline?contexts=0", "/api/timeline?idle=0&bucket=1000",
		"/api/calls", "/api/calls?limit=7&longest=3", fmt.Sprintf("/api/calls?from=%d", mid),
		"/api/waits?scope=all", "/api/waits?scope=all&sort=tim&limit=10", "/api/waits/hist?scope=all",
		"/api/waits/scatter?scope=all", "/api/waits/scatter?scope=all&max=5", "/api/waits/by?scope=all&by=stmt",
		"/api/waits/by?scope=all&by=obj", "/api/waits/by?scope=all&by=p1&limit=3", "/api/waits/by?scope=all&by=p2",
		"/api/profile", "/api/profile?idle=0&contexts=0", fmt.Sprintf("/api/profile?from=%d", mid), "/api/stmt/roles")
	for e := range m.Events {
		q = append(q, fmt.Sprintf("/api/waits?event=%d", e), fmt.Sprintf("/api/waits/hist?event=%d", e),
			fmt.Sprintf("/api/waits/scatter?event=%d&max=3", e), fmt.Sprintf("/api/waits/by?event=%d&by=p1", e),
			fmt.Sprintf("/api/profile?event=%d", e))
	}
	var all []string
	for s := range m.Statements {
		all = append(all, fmt.Sprint(s))
		q = append(q, fmt.Sprintf("/api/pivot?fact=calls&by=kind&stmt=%d", s), fmt.Sprintf("/api/pivot?fact=waits&by=event&stmt=%d", s),
			fmt.Sprintf("/api/calls?stmt=%d", s), fmt.Sprintf("/api/waits?stmt=%d", s), fmt.Sprintf("/api/waits?stmt=%d&sort=tim", s),
			fmt.Sprintf("/api/waits/hist?stmt=%d", s), fmt.Sprintf("/api/waits/by?stmt=%d&by=obj", s),
			fmt.Sprintf("/api/timeline?stmt=%d", s), fmt.Sprintf("/api/profile?stmt=%d", s),
			fmt.Sprintf("/api/stmt/waits?stmt=%d", s), fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=1000", s),
			fmt.Sprintf("/api/executions?stmt=%d", s), fmt.Sprintf("/api/executions?stmt=%d&sort=e&limit=5&offset=1", s),
			fmt.Sprintf("/api/executions?stmt=%d&sort=fetches", s))
	}
	if len(all) > 0 {
		q = append(q, "/api/stmt/waits?stmt="+strings.Join(all, ","), "/api/stmt/spans?stmt="+strings.Join(all, ",")+"&gap=0")
	}
	// every execution in detail, from the executions the server itself lists
	for s := range m.Statements {
		code, body := fetch(h, fmt.Sprintf("/api/executions?stmt=%d&limit=40", s))
		if code != 200 {
			continue
		}
		var er ExecResponse
		if err := json.Unmarshal(body, &er); err != nil {
			t.Fatal(err)
		}
		for _, r := range er.Rows {
			q = append(q, fmt.Sprintf("/api/executions/detail?stmt=%d&cursor=%d&execNo=%d", s, r.Cursor, r.ExecNo))
		}
	}
	return q
}

// compareSources serves the same trace set from the model's own tables and
// from the spill files and requires identical JSON for every query.
func compareSources(t *testing.T, paths []string) {
	t.Helper()
	full, err := model.BuildFiles(paths, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	agg, sp := buildSpilled(t, paths, dir)
	defer sp.Close()
	src, err := sp.Source()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := src.NumCalls(), int64(len(full.Calls)); got != want {
		t.Fatalf("calls: %d spilled, %d in the model", got, want)
	}
	if got, want := src.NumWaits(), int64(len(full.Waits)); got != want {
		t.Fatalf("waits: %d spilled, %d in the model", got, want)
	}
	hm := New(full).Handler()
	hd := NewServer(agg, src).Handler()
	n, withBinds := 0, 0
	for _, q := range queries(t, full, hm) {
		cm, bm := fetch(hm, q)
		cd, bd := fetch(hd, q)
		if cm != cd {
			t.Errorf("%s: status %d (model) vs %d (spill): %s", q, cm, cd, bd)
			continue
		}
		if cm != 200 {
			continue
		}
		if a, b := canon(t, bm), canon(t, bd); a != b {
			t.Errorf("%s differs\n model %.600s\n spill %.600s", q, a, b)
		}
		n++
		if strings.Contains(q, "/api/executions") && bytes.Contains(bm, []byte(`"binds":[{`)) {
			withBinds++
		}
	}
	t.Logf("%d queries equal, %d executions answers with bind values", n, withBinds)
}

func TestSpillMatchesModel(t *testing.T) {
	sets := map[string][]string{
		"io_waits":     {traces + "io_waits.trc"},
		"multisession": {traces + "multisession.trc"},
		"multi_a_b":    {traces + "multisession_a.trc", traces + "multisession_b.trc"},
		"basic_binds":  {traces + "basic_binds.trc"},
		"bind_types":   {traces + "bind_types.trc"},
		"plsql":        {traces + "plsql_recursive.trc"},
		"parallel":     {traces + "parallel.trc", traces + "parallel_slave.trc"},
		"cursor_cache": {traces + "cursor_cache.trc"},
		"midtrace":     {traces + "midtrace_start.trc"},
		"errors":       {traces + "errors.trc"},
		"lobs":         {traces + "lobs.trc"},
	}
	for name, paths := range sets {
		t.Run(name, func(t *testing.T) { compareSources(t, paths) })
	}
}

func TestSpillAllFixtures(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	files, _ := filepath.Glob(traces + "*.trc")
	for _, f := range files {
		name := filepath.Base(f)
		if strings.HasPrefix(name, "parallel") || strings.HasPrefix(name, "multisession_") {
			continue // PX slaves and trace-set halves belong to the sets above
		}
		t.Run(name, func(t *testing.T) { compareSources(t, []string{f}) })
	}
}

func TestSpillFilesRemovedAfterClose(t *testing.T) {
	dir := t.TempDir()
	_, sp := buildSpilled(t, []string{traces + "io_waits.trc"}, dir)
	files := sp.Sizes()
	for _, name := range []string{"calls.bin", "waits.bin", "calls.stmt", "waits.stmt", "bindsets.bin", "binds.bin", "bindvals.bin"} {
		if _, ok := files[name]; !ok {
			t.Errorf("no %s in the spill dir (have %v)", name, files)
		}
	}
	if files["calls.bin"]%callRec != 0 || files["waits.bin"]%waitRec != 0 {
		t.Errorf("sizes are not whole records: %v", files)
	}
	src, err := sp.Source()
	if err != nil {
		t.Fatal(err)
	}
	if err := src.Close(); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Errorf("spill dir not empty after Close: %v", ents)
	}
	if err := sp.Close(); err != nil { // idempotent
		t.Fatal(err)
	}
}

func TestSpillRemovesStaleDirOfSameTrace(t *testing.T) {
	dir := t.TempDir()
	key := SpillKey([]string{traces + "io_waits.trc"})
	dead := filepath.Join(dir, spillPrefix+key+"-2000000000-123")
	other := filepath.Join(dir, spillPrefix+"otherkey-2000000000-123")
	live := filepath.Join(dir, fmt.Sprintf("%s%s-%d-456", spillPrefix, key, os.Getppid()))
	for _, d := range []string{dead, other, live} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(d, "calls.bin"), []byte("x"), 0o600)
	}
	_, sp := buildSpilled(t, []string{traces + "io_waits.trc"}, dir)
	defer sp.Close()
	if _, err := os.Stat(dead); err == nil {
		t.Errorf("stale dir of a dead process was kept")
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("dir of another trace was removed")
	}
	if _, err := os.Stat(live); err != nil {
		t.Errorf("dir of a live process was removed")
	}
}

func TestSpillKeyChangesWithFile(t *testing.T) {
	f := filepath.Join(t.TempDir(), "a.trc")
	os.WriteFile(f, []byte("x"), 0o600)
	k1 := SpillKey([]string{f})
	os.WriteFile(f, []byte("xy"), 0o600)
	if k2 := SpillKey([]string{f}); k1 == k2 {
		t.Errorf("key did not change with the size")
	}
}

func TestSpillRedactsBinds(t *testing.T) {
	paths := []string{traces + "basic_binds.trc"}
	dir := t.TempDir()
	th := analyze.DefaultThresholds()
	sp, err := NewSpill(SpillOptions{Dir: dir, BindMode: model.BindsRedact, Salt: "s"})
	if err != nil {
		t.Fatal(err)
	}
	m, err := model.BuildFiles(paths, model.Options{Aggregate: true, SpillBinds: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  func(m *model.Model) model.Sink { return sp.Attach(m) }})
	if err != nil {
		t.Fatal(err)
	}
	defer sp.Close()
	src, err := sp.Source()
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for set := model.ID(0); ; set++ {
		bs := src.Binds(set)
		if bs == nil {
			break
		}
		for _, b := range bs {
			if !b.IsNull && !b.NoDef {
				seen++
				if !strings.HasPrefix(b.Value, "<") {
					t.Fatalf("bind value %q is not redacted", b.Value)
				}
			}
		}
	}
	if seen == 0 {
		t.Fatal("no bind values in basic_binds")
	}
	_ = m
}

// TestPagedFile checks the writer against a plain byte slice under random
// puts, patches and out-of-order rows.
func TestPagedFile(t *testing.T) {
	for _, seed := range []int64{1, 2, 3} {
		f, err := os.Create(filepath.Join(t.TempDir(), "p.bin"))
		if err != nil {
			t.Fatal(err)
		}
		const rec = 37
		p := newPagedFile(f, rec, 4)
		p.pageRecs, p.pageSize = 8, 8*rec // many small pages
		rng := rand.New(rand.NewSource(seed))
		var want []byte
		next := 0
		for i := 0; i < 20000; i++ {
			switch {
			case rng.Intn(4) > 0 || next == 0: // a row, sometimes a little ahead, sometimes far behind the newest
				idx := next
				if rng.Intn(5) == 0 && next > 0 {
					idx = rng.Intn(next)
				} else {
					next++
				}
				r := make([]byte, rec)
				rng.Read(r)
				p.put(int64(idx), r)
				for len(want) < (idx+1)*rec {
					want = append(want, 0)
				}
				copy(want[idx*rec:], r)
			default: // patch an old row
				idx := rng.Intn(next)
				off := rng.Intn(rec - 4)
				b := []byte{byte(i), byte(i >> 8), 7, 9}
				p.patch(int64(idx), off, b)
				for len(want) < (idx+1)*rec {
					want = append(want, 0)
				}
				copy(want[idx*rec+off:], b)
			}
		}
		if err := p.flush(); err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(f.Name())
		if !bytes.Equal(got, want[:len(got)]) || len(got) != int(p.n)*rec {
			t.Fatalf("seed %d: file differs from the reference (got %d bytes, want %d)", seed, len(got), p.n*rec)
		}
		f.Close()
	}
}

func TestRecordCodecs(t *testing.T) {
	c := model.Call{Tim: 1, C: 2, E: 3, P: 4, CR: 5, CU: 6, R: 7, SelfE: 8, SelfC: 9, SelfP: 10, SelfCR: 11, SelfCU: 12, WaitEla: 13, IdleEla: 14,
		Cursor: 15, Parent: -1, Context: 17, BindSet: 18, Line: 19, ExecNo: 20, NWaits: 21, Mis: 22, PLH: 4000000000, Kind: 3, Dep: 5, OG: 2, Type: 1, Orphan: true, Synthetic: true}
	b := make([]byte, callRec)
	putCall(b, &c)
	var got model.Call
	getCall(b, &got)
	if !reflect.DeepEqual(c, got) {
		t.Errorf("call round trip\n got %+v\nwant %+v", got, c)
	}
	w := model.Wait{Tim: 1, Ela: 2, P1: 3, P2: -4, P3: 5, ObjID: -1, Cursor: 7, Call: -1, Event: 9, Context: 10, Line: 11, Dep: 2, Between: true, Idle: true}
	wb := make([]byte, waitRec)
	putWait(wb, &w)
	var wg model.Wait
	getWait(wb, &wg)
	if !reflect.DeepEqual(w, wg) {
		t.Errorf("wait round trip\n got %+v\nwant %+v", wg, w)
	}
}
