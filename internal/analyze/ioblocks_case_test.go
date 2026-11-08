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

// ---- the shared case of the TS twins of IOHotOn, IODensityOn and IOMapWith's reads
// (web/src/lib/data/iohot.ts, iodensity.ts, iomap.ts) ----

var updateIOBlocksCase = flag.Bool("update-ioblocks-case", false, "rewrite web/src/lib/data/testdata/ioblocks-case.json from 19c/io_waits.trc")

const ioBlocksCasePath = "../../web/src/lib/data/testdata/ioblocks-case.json"

// ioBlocksCase is web/src/lib/data/testdata/ioblocks-case.json: an excerpt of
// io_waits.trc in the document's shapes and the answers of the routes for some queries.
type ioBlocksCase struct {
	Comment string         `json:"_comment"`
	Events  []model.Event  `json:"events"`
	Waits   ioMapCaseWaits `json:"waits"`
	Hot     []hotQuery     `json:"hot"`
	Density []densQuery    `json:"density"`
	Reads   []readsQuery   `json:"reads"`
}

// ioScope is a query's scope: optional statement and window [from, to] (0 = open).
type ioScope struct {
	Stmt *model.ID `json:"stmt,omitempty"`
	From int64     `json:"from,omitempty"`
	To   int64     `json:"to,omitempty"`
}

func (q ioScope) filter() Filter {
	return Filter{StartTim: q.From, EndTim: q.To, Statement: q.Stmt, IncludeIdle: true}
}

type hotQuery struct {
	ioScope
	Opts   IOHotOpts `json:"opts"`
	Expect *IOHot    `json:"expect"`
}

type densQuery struct {
	ioScope
	Req    IODensityReq `json:"req"`
	Expect *IODensity   `json:"expect"`
}

type readsQuery struct {
	ioScope
	Limit  int       `json:"limit"`
	Opts   IOMapOpts `json:"opts"`
	Expect *IOMap    `json:"expect"`
}

func (c *ioBlocksCase) model() *model.Model {
	return (&ioMapCase{Events: c.Events, Waits: c.Waits}).model()
}

// ioBlocksCaseOf cuts the case out of 19c/io_waits.trc: every wait up to the
// 60th block I/O wait (the scans of MTK_ORDERS and MTK_CUST), then the waits
// from 300 block I/O waits before statement 22's first one to 800 after it
// (stmt 21's sort reads its temp blocks, stmt 22's hash join writes the same
// blocks and reads them back: 148 of them twice), and the queries.
func ioBlocksCaseOf(t *testing.T) *ioBlocksCase {
	full, err := model.Build(filepath.Join(fixtures, "io_waits.trc"), model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ev := IOEventsOf(full.Events)
	var blockAt []int
	for i := range full.Waits {
		if ev.Block[full.Waits[i].Event] {
			blockAt = append(blockAt, i)
		}
	}
	first22 := -1
	for k, i := range blockAt {
		if full.Waits[i].Statement == 22 {
			first22 = k
			break
		}
	}
	if first22 < 360 || first22+800 > len(blockAt) {
		t.Fatalf("stmt 22's first block I/O wait is the %d-th of %d", first22, len(blockAt))
	}
	c := &ioBlocksCase{
		Comment: "Shared by internal/analyze/ioblocks_case_test.go (IOHotOn, IODensityOn, IOMapWith reads) and web/src/lib/data/ioblocks.test.ts " +
			"(ioHotOf, ioDensityOf, ioMapOf reads). Generated from testdata/traces/19c/io_waits.trc by `go test ./internal/analyze -run IOBlocksSharedCase " +
			"-update-ioblocks-case`, do not edit: events = the trace's doc.events, waits = the doc.facts.waits columns of its waits up to the 60th block I/O " +
			"wait, then from 300 block I/O waits before statement 22's first one to 800 after it (flags bit0 between, bit1 idle); hot, density and reads are " +
			"queries (options, optional stmt, window from/to with 0 = open) and the answers of /api/io/hot, /api/io/density and /api/io/map?reads=1 for them, " +
			"some with caps small enough that the counting prunes.",
		Events: full.Events,
	}
	var keep []int
	for i := 0; i <= blockAt[59]; i++ {
		keep = append(keep, i)
	}
	for i := blockAt[first22-300]; i <= blockAt[first22+799]; i++ {
		keep = append(keep, i)
	}
	wc := &c.Waits
	for _, i := range keep {
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
	s22 := model.ID(22)
	w22 := full.Waits[blockAt[first22]]
	mid := full.Waits[blockAt[first22+400]].Tim
	all := ioScope{}
	c.Hot = []hotQuery{
		{ioScope: all, Opts: IOHotOpts{}},
		{ioScope: all, Opts: IOHotOpts{Limit: 5, Sort: "max"}},
		{ioScope: ioScope{From: w22.Tim, To: mid}, Opts: IOHotOpts{Sort: "us"}},
		{ioScope: ioScope{Stmt: &s22}, Opts: IOHotOpts{Limit: 25}},
		{ioScope: all, Opts: IOHotOpts{CountCap: 40}},
		{ioScope: all, Opts: IOHotOpts{Candidates: 30, Limit: 7}},
		{ioScope: all, Opts: IOHotOpts{SeenBytes: 5000, Limit: 10}},
		{ioScope: all, Opts: IOHotOpts{OwnerBytes: 8000, Limit: 10}},
	}
	f12, f203 := int64(12), int64(203)
	c.Density = []densQuery{
		{ioScope: all, Req: IODensityReq{}},
		{ioScope: all, Req: IODensityReq{X: "time", XBins: 37, YBins: 11}},
		{ioScope: all, Req: IODensityReq{X: "order", XSegs: [][3]int64{{0, 40, 13}, {40, 700, 60}, {700, 1160, 25}}, Panels: []IODensityPanelReq{
			{Key: fmt.Sprintf("f%d", f12), Segs: [][4]int64{{f12, 167795, 172288, 33}}},
			{Key: fmt.Sprintf("t%d", f203), Segs: [][4]int64{{f203, 756103, 756400, 17}, {f203, 756400, 756743, 5}}},
			{Key: fmt.Sprintf("o%d", full.Waits[blockAt[0]].ObjID), Segs: [][4]int64{{f12, 167795, 172288, 9}}},
			{Key: "rest", Segs: [][4]int64{{f12, 0, 1 << 20, 8}}},
			{Key: "n10", Segs: [][4]int64{{10, 0, 1 << 20, 4}}},
		}}},
		{ioScope: ioScope{From: w22.Tim, To: mid}, Req: IODensityReq{X: "time", XSegs: [][3]int64{{w22.Tim - 5000, mid, 50}}, Panels: []IODensityPanelReq{
			{Key: fmt.Sprintf("f%d", f203), Segs: [][4]int64{{f203, 756103, 756743, 40}}}}}},
		{ioScope: ioScope{Stmt: &s22}, Req: IODensityReq{YBins: 3}},
	}
	c.Reads = []readsQuery{
		{ioScope: all, Limit: 200, Opts: IOMapOpts{Reads: true}},
		{ioScope: all, Limit: 50, Opts: IOMapOpts{Reads: true}},
		{ioScope: all, Limit: 200, Opts: IOMapOpts{Reads: true, CountCap: 30}},
		{ioScope: ioScope{Stmt: &s22}, Limit: 200, Opts: IOMapOpts{Reads: true, SeenBytes: 5000}},
	}
	c.answer(t)
	return c
}

// answer fills the expected answers from the Go implementations.
func (c *ioBlocksCase) answer(t *testing.T) {
	m := c.model()
	ev := IOEventsOf(m.Events)
	src := ModelFacts(m)
	ctx := context.Background()
	var err error
	for i := range c.Hot {
		q := &c.Hot[i]
		if q.Expect, err = IOHotOn(ctx, src, q.filter(), ev, q.Opts); err != nil {
			t.Fatal(err)
		}
	}
	for i := range c.Density {
		q := &c.Density[i]
		if q.Expect, err = IODensityOn(ctx, src, q.filter(), ev, q.Req); err != nil {
			t.Fatal(err)
		}
	}
	for i := range c.Reads {
		q := &c.Reads[i]
		if q.Expect, err = IOMapWith(ctx, src, q.filter(), ev, q.Limit, q.Opts); err != nil {
			t.Fatal(err)
		}
	}
}

// encode writes the case with one table column, event or query per line.
func (c *ioBlocksCase) encode() []byte {
	js := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			panic(err)
		}
		return string(b)
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "{\n  \"_comment\": %s,\n  \"events\": [\n", js(c.Comment))
	for i, e := range c.Events {
		fmt.Fprintf(&b, "    %s%s\n", js(e), map[bool]string{true: ",", false: ""}[i < len(c.Events)-1])
	}
	fmt.Fprintf(&b, "  ],\n  \"waits\": {\n    \"n\": %d,\n", c.Waits.N)
	cols := c.Waits.cols()
	for i, col := range cols {
		fmt.Fprintf(&b, "    %q: %s%s\n", col.name, js(*col.v), map[bool]string{true: ",", false: ""}[i < len(cols)-1])
	}
	b.WriteString("  },\n")
	list := func(name string, n int, at func(i int) any, last bool) {
		fmt.Fprintf(&b, "  %q: [\n", name)
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "    %s%s\n", js(at(i)), map[bool]string{true: ",", false: ""}[i < n-1])
		}
		fmt.Fprintf(&b, "  ]%s\n", map[bool]string{true: "", false: ","}[last])
	}
	list("hot", len(c.Hot), func(i int) any { return c.Hot[i] }, false)
	list("density", len(c.Density), func(i int) any { return c.Density[i] }, false)
	list("reads", len(c.Reads), func(i int) any { return c.Reads[i] }, true)
	b.WriteString("}\n")
	return b.Bytes()
}

// TestIOBlocksSharedCase: the Go answers over the case's waits are its
// answers, the case is still the excerpt io_waits.trc gives today, and it
// exercises what it is for (re-reads, a prune, a capped seen set).
func TestIOBlocksSharedCase(t *testing.T) {
	if *updateIOBlocksCase {
		if err := os.WriteFile(filepath.FromSlash(ioBlocksCasePath), ioBlocksCaseOf(t).encode(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(ioBlocksCasePath)
	if err != nil {
		t.Fatalf("%v (go test ./internal/analyze -run IOBlocksSharedCase -update-ioblocks-case)", err)
	}
	var c ioBlocksCase
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	want := c
	want.Hot, want.Density, want.Reads = append([]hotQuery(nil), c.Hot...), append([]densQuery(nil), c.Density...), append([]readsQuery(nil), c.Reads...)
	want.answer(t)
	for i := range c.Hot {
		if !reflect.DeepEqual(c.Hot[i].Expect, want.Hot[i].Expect) {
			t.Errorf("hot %d (%+v): the answer changed", i, c.Hot[i].Opts)
		}
	}
	for i := range c.Density {
		if !reflect.DeepEqual(c.Density[i].Expect, want.Density[i].Expect) {
			t.Errorf("density %d (%+v): the answer changed", i, c.Density[i].Req)
		}
	}
	for i := range c.Reads {
		if !reflect.DeepEqual(c.Reads[i].Expect, want.Reads[i].Expect) {
			t.Errorf("reads %d (%+v): the answer changed", i, c.Reads[i].Opts)
		}
	}
	h := c.Hot[0].Expect
	if !h.Exact || h.Reread < 100 || len(h.Runs) == 0 || c.Hot[4].Expect.Exact || !c.Hot[6].Expect.Exact || c.Hot[6].Expect.DistinctExact ||
		c.Hot[7].Expect.DistinctExact || c.Reads[2].Expect.ReadsExact {
		t.Errorf("the case does not exercise re-reads, a prune and the caps: %d re-read, exact %v %v %v, distinct %v %v, reads exact %v",
			h.Reread, h.Exact, c.Hot[4].Expect.Exact, c.Hot[6].Expect.Exact, c.Hot[6].Expect.DistinctExact, c.Hot[7].Expect.DistinctExact, c.Reads[2].Expect.ReadsExact)
	}
	if !reflect.DeepEqual(ioBlocksCaseOf(t).encode(), raw) {
		t.Errorf("%s is stale: go test ./internal/analyze -run IOBlocksSharedCase -update-ioblocks-case", ioBlocksCasePath)
	}
}
