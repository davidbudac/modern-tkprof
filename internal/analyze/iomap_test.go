package analyze

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

func ioMap(t *testing.T, m *model.Model, f Filter, limit int) *IOMap {
	t.Helper()
	isBlock, countP3 := BlockEvents(m.Events)
	r, err := IOMapOn(context.Background(), ModelFacts(m), f, isBlock, countP3, limit)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func stmtOfSQLID(t *testing.T, m *model.Model, sqlID string) model.ID {
	t.Helper()
	for i := range m.Statements {
		if m.Statements[i].SQLID == sqlID {
			return model.ID(i)
		}
	}
	t.Fatalf("no statement %s", sqlID)
	return model.None
}

// perEvent counts the rows of a map by event name.
func perEvent(m *model.Model, r *IOMap) map[string]int {
	n := map[string]int{}
	for _, row := range r.Rows {
		n[m.Events[row[2]].Name]++
	}
	return n
}

func TestIOMapIOWaits(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	r := ioMap(t, m, Filter{IncludeIdle: true}, 20000)
	if r.Total != 8747 || r.Sampled || len(r.Rows) != 8747 {
		t.Fatalf("total %d sampled %v rows %d, want 8747 rows unsampled", r.Total, r.Sampled, len(r.Rows))
	}
	wantFiles := []IOMapFile{{File: 10, Lo: 66397, Hi: 80392, N: 3}, {File: 12, Lo: 167795, Hi: 172288, N: 194}, {File: 203, Lo: 756103, Hi: 756743, N: 8550}}
	if !reflect.DeepEqual(r.Files, wantFiles) {
		t.Errorf("files %+v\nwant %+v", r.Files, wantFiles)
	}
	if !reflect.DeepEqual(r.Cols, IOMapCols) {
		t.Errorf("cols %v", r.Cols)
	}
	if got, want := perEvent(m, r), map[string]int{"db file sequential read": 3, "direct path read": 194, "direct path write temp": 1607, "direct path read temp": 6943}; !reflect.DeepEqual(got, want) {
		t.Errorf("per event %v, want %v", got, want)
	}
	// the rows are the block I/O waits of m.Waits in order, column by column
	seen := map[model.ID]bool{}
	k := 0
	for i := range m.Waits {
		w := &m.Waits[i]
		ev := &m.Events[w.Event]
		if !ev.IsBlockIO() {
			continue
		}
		blocks := int64(1)
		if ev.BlocksParam() && w.P3 > 0 {
			blocks = w.P3
		}
		want := []int64{w.Tim, w.Ela, int64(w.Event), w.P1, w.P2, blocks, w.ObjID, int64(w.Statement), int64(w.Call), int64(w.Line), int64(w.Context), int64(w.Dep)}
		if k >= len(r.Rows) || !reflect.DeepEqual(r.Rows[k], want) {
			t.Fatalf("row %d (wait %d): %v, want %v", k, i, r.Rows[min(k, len(r.Rows)-1)], want)
		}
		seen[w.Event] = true
		k++
	}
	if len(r.Events) != len(seen) {
		t.Errorf("events %v, want the ids of %v", r.Events, seen)
	}
	for i, e := range r.Events {
		if !seen[e] || (i > 0 && r.Events[i-1] >= e) {
			t.Errorf("events %v: not the sorted ids that occurred", r.Events)
		}
	}
	// idle waits never match: idle on or off is the same answer
	if r0 := ioMap(t, m, Filter{}, 20000); !reflect.DeepEqual(r0, r) {
		t.Error("IncludeIdle changed the map")
	}
}

func TestIOMapSampling(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	all := ioMap(t, m, Filter{IncludeIdle: true}, 20000)
	r := ioMap(t, m, Filter{IncludeIdle: true}, 100)
	k := (8747 + 99) / 100 // 88
	if !r.Sampled || r.Total != 8747 || len(r.Rows) != (8747+k-1)/k {
		t.Fatalf("limit 100: sampled %v total %d rows %d, want %d", r.Sampled, r.Total, len(r.Rows), (8747+k-1)/k)
	}
	for i, row := range r.Rows {
		if !reflect.DeepEqual(row, all.Rows[i*k]) {
			t.Fatalf("row %d is not match %d", i, i*k)
		}
	}
	if !reflect.DeepEqual(r.Files, all.Files) || !reflect.DeepEqual(r.Events, all.Events) {
		t.Error("Files and Events must be over all matches")
	}
	for _, tc := range []struct{ limit, rows int }{{8747, 8747}, {8746, 4374}, {5000, 4374}, {1, 1}} {
		r := ioMap(t, m, Filter{IncludeIdle: true}, tc.limit)
		if len(r.Rows) != tc.rows || r.Sampled != (tc.rows < 8747) {
			t.Errorf("limit %d: %d rows sampled %v, want %d", tc.limit, len(r.Rows), r.Sampled, tc.rows)
		}
	}
}

func TestIOMapScopes(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	// stmt 22 (hash join): the scans, the build's spill and its 20 passes of re-reads
	s22 := stmtOfSQLID(t, m, "7r10y07tqpg98")
	r := ioMap(t, m, Filter{Statement: &s22}, 20000)
	if got, want := perEvent(m, r), map[string]int{"direct path read": 71, "direct path write temp": 276, "direct path read temp": 5612}; !reflect.DeepEqual(got, want) || s22 != 22 {
		t.Errorf("stmt %d: %v, want 22: %v", s22, got, want)
	}
	// stmt 21 (order by): sort runs written, then merged
	s21 := stmtOfSQLID(t, m, "52nzchs09dgn1")
	r = ioMap(t, m, Filter{Statement: &s21}, 20000)
	if got, want := perEvent(m, r), map[string]int{"direct path read": 26, "direct path write temp": 1331, "direct path read temp": 1331}; !reflect.DeepEqual(got, want) || s21 != 21 {
		t.Errorf("stmt %d: %v, want 21: %v", s21, got, want)
	}
	written := map[int64]bool{}
	for _, row := range r.Rows {
		if m.Events[row[2]].Name == "direct path write temp" {
			for b := row[4]; b < row[4]+row[5]; b++ {
				written[b] = true
			}
		}
	}
	if len(written) != 639 {
		t.Errorf("stmt 21 wrote %d distinct temp blocks, want 639", len(written))
	}
	for _, f := range r.Files {
		if f.File != 12 && f.File != 203 {
			t.Errorf("stmt 21 in file %d", f.File)
		}
	}
	// one event
	ev := model.ID(r.Rows[0][2])
	if re := ioMap(t, m, Filter{Event: &ev}, 20000); len(re.Events) != 1 || re.Events[0] != ev || re.Total != perEvent(m, ioMap(t, m, Filter{}, 20000))[m.Events[ev].Name] {
		t.Errorf("event %d: %+v", ev, re.Events)
	}
	// a window that holds nothing, no contexts at all
	for _, f := range []Filter{{StartTim: 1, EndTim: 2}, {NoContexts: true}} {
		r := ioMap(t, m, f, 20000)
		if r.Total != 0 || r.Sampled || r.Rows == nil || len(r.Rows) != 0 || r.Files == nil || len(r.Files) != 0 || r.Events == nil || len(r.Events) != 0 {
			t.Errorf("%+v: %+v, want an empty map (empty arrays, not null)", f, r)
		}
	}
	// a window keeps the waits whose [tim-ela, tim] overlaps it
	all := ioMap(t, m, Filter{}, 20000)
	from, to := all.Rows[100][0], all.Rows[200][0]-all.Rows[200][1]
	r = ioMap(t, m, Filter{StartTim: from, EndTim: to}, 20000)
	if r.Total != 101 || !reflect.DeepEqual(r.Rows[0], all.Rows[100]) {
		t.Errorf("window: total %d, want 101", r.Total)
	}
}

// ---- the shared case of the TS twin (web/src/lib/data/iomap.ts ioMapOf) ----

var updateIOMapCase = flag.Bool("update-iomap-case", false, "rewrite web/src/lib/data/testdata/iomap-case.json from io_waits.trc")

const ioMapCasePath = "../../web/src/lib/data/testdata/iomap-case.json"

// ioMapCase is web/src/lib/data/testdata/iomap-case.json: an excerpt of
// io_waits.trc in the document's shapes (events = doc.events, waits =
// doc.facts.waits columns) and the IOMapOn answers for some queries.
type ioMapCase struct {
	Comment string         `json:"_comment"`
	Events  []model.Event  `json:"events"`
	Waits   ioMapCaseWaits `json:"waits"`
	Cases   []ioMapQuery   `json:"cases"`
}

type ioMapCaseWaits struct {
	N      int     `json:"n"`
	Line   []int64 `json:"line"`
	Cursor []int64 `json:"cursor"`
	Stmt   []int64 `json:"stmt"`
	Call   []int64 `json:"call"`
	Event  []int64 `json:"event"`
	Ela    []int64 `json:"ela"`
	P1     []int64 `json:"p1"`
	P2     []int64 `json:"p2"`
	P3     []int64 `json:"p3"`
	Obj    []int64 `json:"obj"`
	Tim    []int64 `json:"tim"`
	Ctx    []int64 `json:"ctx"`
	Dep    []int64 `json:"dep"`
	Flags  []int64 `json:"flags"` // bit0 between calls, bit1 idle event
}

func (w *ioMapCaseWaits) cols() []struct {
	name string
	v    *[]int64
} {
	return []struct {
		name string
		v    *[]int64
	}{{"line", &w.Line}, {"cursor", &w.Cursor}, {"stmt", &w.Stmt}, {"call", &w.Call}, {"event", &w.Event}, {"ela", &w.Ela},
		{"p1", &w.P1}, {"p2", &w.P2}, {"p3", &w.P3}, {"obj", &w.Obj}, {"tim", &w.Tim}, {"ctx", &w.Ctx}, {"dep", &w.Dep}, {"flags", &w.Flags}}
}

// ioMapQuery is one question: limit, optional statement and window [from, to] (0 = open).
type ioMapQuery struct {
	Limit  int       `json:"limit"`
	Stmt   *model.ID `json:"stmt,omitempty"`
	From   int64     `json:"from,omitempty"`
	To     int64     `json:"to,omitempty"`
	Expect *IOMap    `json:"expect"`
}

func (q ioMapQuery) filter() Filter {
	return Filter{StartTim: q.From, EndTim: q.To, Statement: q.Stmt, IncludeIdle: true}
}

func (c *ioMapCase) model() *model.Model {
	m := &model.Model{Events: c.Events}
	w := &c.Waits
	for i := 0; i < w.N; i++ {
		m.Waits = append(m.Waits, model.Wait{ID: model.ID(i), Line: int32(w.Line[i]), Cursor: model.ID(w.Cursor[i]), Statement: model.ID(w.Stmt[i]),
			Call: model.ID(w.Call[i]), Event: model.ID(w.Event[i]), Ela: w.Ela[i], P1: w.P1[i], P2: w.P2[i], P3: w.P3[i], ObjID: w.Obj[i],
			Tim: w.Tim[i], Context: model.ID(w.Ctx[i]), Dep: uint8(w.Dep[i]), Between: w.Flags[i]&1 != 0, Idle: w.Flags[i]&2 != 0})
	}
	return m
}

// ioMapCaseOf cuts the case out of io_waits.trc: every wait up to the 60th
// block I/O wait (so the classification and the idle waits are part of it),
// the whole events table, and three queries: limit 20 (sampled, 1 in 3), a
// window that cuts the waits at both ends with limit 10, and one statement.
func ioMapCaseOf(t *testing.T) *ioMapCase {
	full := loadModel(t, "io_waits.trc")
	isBlock, _ := BlockEvents(full.Events)
	c := &ioMapCase{
		Comment: "Shared by internal/analyze/iomap_test.go (IOMapOn) and web/src/lib/data/iomap.test.ts (ioMapOf). Generated from " +
			"testdata/traces/19c/io_waits.trc by `go test ./internal/analyze -run IOMapSharedCase -update-iomap-case`, do not edit: " +
			"events = the trace's doc.events, waits = the doc.facts.waits columns of its first waits up to the 60th block I/O wait " +
			"(flags bit0 between, bit1 idle); each case is a query (limit, optional stmt, window from/to with 0 = open, idle ignored) " +
			"and the /api/io/map answer expected for it.",
		Events: full.Events,
	}
	var blockAt []int // wait index of each block I/O wait
	for i := range full.Waits {
		if w := &full.Waits[i]; isBlock[w.Event] {
			blockAt = append(blockAt, i)
			if len(blockAt) == 60 {
				break
			}
		}
	}
	if len(blockAt) < 60 {
		t.Fatalf("io_waits.trc has %d block I/O waits", len(blockAt))
	}
	wc := &c.Waits
	for i := 0; i <= blockAt[59]; i++ {
		w := &full.Waits[i]
		var flags int64
		if w.Between {
			flags |= 1
		}
		if w.Idle {
			flags |= 2
		}
		for j, v := range []int64{int64(w.Line), int64(w.Cursor), int64(w.Statement), int64(w.Call), int64(w.Event), w.Ela,
			w.P1, w.P2, w.P3, w.ObjID, w.Tim, int64(w.Context), int64(w.Dep), flags} {
			col := wc.cols()[j].v
			*col = append(*col, v)
		}
		wc.N++
	}
	stmt := full.Waits[blockAt[59]].Statement
	c.Cases = []ioMapQuery{
		{Limit: 20},
		{Limit: 10, From: full.Waits[blockAt[20]].Tim, To: full.Waits[blockAt[45]].Tim},
		{Limit: 20000, Stmt: &stmt},
	}
	m := c.model()
	for i := range c.Cases {
		c.Cases[i].Expect = ioMap(t, m, c.Cases[i].filter(), c.Cases[i].Limit)
	}
	return c
}

// encode writes the case with one table column, event or row per line.
func (c *ioMapCase) encode() []byte {
	js := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			panic(err)
		}
		return string(b)
	}
	sep := func(i, n int) string {
		if i < n-1 {
			return ","
		}
		return ""
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "{\n  \"_comment\": %s,\n  \"events\": [\n", js(c.Comment))
	for i, e := range c.Events {
		fmt.Fprintf(&b, "    %s%s\n", js(e), sep(i, len(c.Events)))
	}
	fmt.Fprintf(&b, "  ],\n  \"waits\": {\n    \"n\": %d,\n", c.Waits.N)
	cols := c.Waits.cols()
	for i, col := range cols {
		fmt.Fprintf(&b, "    %q: %s%s\n", col.name, js(*col.v), sep(i, len(cols)))
	}
	b.WriteString("  },\n  \"cases\": [\n")
	for i, q := range c.Cases {
		b.WriteString("    {\n")
		fmt.Fprintf(&b, "      \"limit\": %d,\n", q.Limit)
		if q.Stmt != nil {
			fmt.Fprintf(&b, "      \"stmt\": %d,\n", *q.Stmt)
		}
		if q.From != 0 {
			fmt.Fprintf(&b, "      \"from\": %d,\n", q.From)
		}
		if q.To != 0 {
			fmt.Fprintf(&b, "      \"to\": %d,\n", q.To)
		}
		e := q.Expect
		fmt.Fprintf(&b, "      \"expect\": {\n        \"total\": %d,\n        \"sampled\": %v,\n        \"cols\": %s,\n        \"rows\": [\n", e.Total, e.Sampled, js(e.Cols))
		for j, r := range e.Rows {
			fmt.Fprintf(&b, "          %s%s\n", js(r), sep(j, len(e.Rows)))
		}
		fmt.Fprintf(&b, "        ],\n        \"files\": %s,\n        \"events\": %s\n      }\n    }%s\n", js(e.Files), js(e.Events), sep(i, len(c.Cases)))
	}
	b.WriteString("  ]\n}\n")
	return b.Bytes()
}

func readIOMapCase(t *testing.T) *ioMapCase {
	t.Helper()
	raw, err := os.ReadFile(ioMapCasePath)
	if err != nil {
		t.Fatalf("%v (go test ./internal/analyze -run IOMapSharedCase -update-iomap-case)", err)
	}
	var c ioMapCase
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return &c
}

// TestIOMapSharedCase: IOMapOn over the case's waits gives its answers, and
// the case is still the excerpt io_waits.trc gives today.
func TestIOMapSharedCase(t *testing.T) {
	if *updateIOMapCase {
		if err := os.WriteFile(filepath.FromSlash(ioMapCasePath), ioMapCaseOf(t).encode(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	c := readIOMapCase(t)
	m := c.model()
	for _, col := range c.Waits.cols() {
		if len(*col.v) != c.Waits.N {
			t.Fatalf("waits.%s has %d values, n is %d", col.name, len(*col.v), c.Waits.N)
		}
	}
	if len(c.Cases) < 3 || c.Cases[0].Limit != 20 || c.Cases[0].Expect.Total != 60 || !c.Cases[0].Expect.Sampled || len(c.Cases[0].Expect.Rows) != 20 {
		t.Fatalf("the first case is not the 60 block I/O waits at limit 20 (1 in 3)")
	}
	for i, q := range c.Cases {
		if got := ioMap(t, m, q.filter(), q.Limit); !reflect.DeepEqual(got, q.Expect) {
			t.Errorf("case %d (%+v)\n got %+v\nwant %+v", i, q.filter(), got, q.Expect)
		}
	}
	if !reflect.DeepEqual(ioMapCaseOf(t), c) {
		t.Errorf("%s is stale: go test ./internal/analyze -run IOMapSharedCase -update-iomap-case", ioMapCasePath)
	}
}
