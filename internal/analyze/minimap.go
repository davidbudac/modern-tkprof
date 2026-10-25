package analyze

import (
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// MinimapBuckets is the bucket count of a Minimap (fewer when the span is
// shorter than that many µs).
const MinimapBuckets = 1024

// Minimap is the zoom-out context of the Timeline view: CPU and wait time of
// the whole trace in MinimapBuckets equal buckets over [Span.FirstTim,
// Span.LastTim]. Bucket i covers tim [FirstTim+i·BucketUs, FirstTim+(i+1)·BucketUs).
//
// Semantics (the same convention as Timeline): a top-level call's whole CPU
// (Σ c of calls without a parent) goes to the bucket of its completion tim, a
// wait's whole elapsed time goes to the bucket of its tim; nothing is spread.
// Waits are grouped by Event.Class (idle events carry their own class, "Idle";
// a class-less event is "Other"); between-call waits stay in their event's
// class. PX slaves attached to a coordinator are left out, exactly as in
// TraceProfile, so Σ CPU equals Profile.CPUUs and Σ Waits[class] equals the
// profile rows of that class. Events without a tim are counted in bucket 0.
// Only classes with time appear.
//
// Full-model builds compute it exactly from the facts. Aggregate builds keep
// a private grid of cells (100 µs on an absolute grid, coarsened by 10
// whenever there are more than maxCells, like the timeline cells) and put a
// cell into the bucket of its start: while the cell is not wider than the
// bucket an event lands in its own bucket or the one before it (never after).
type Minimap struct {
	BucketUs int64              `json:"bucketUs"`
	CPU      []int64            `json:"cpu"`
	Waits    map[string][]int64 `json:"waits"`
}

type mmLayout struct {
	first, bucketUs int64
	n               int
}

func newMmLayout(sp model.Span) mmLayout {
	span := sp.LastTim - sp.FirstTim
	if sp.FirstTim == 0 || span < 0 {
		span = 0
	}
	l := mmLayout{first: sp.FirstTim, n: MinimapBuckets}
	l.bucketUs = (span + MinimapBuckets) / MinimapBuckets // ceil((span+1)/1024)
	if span+1 < MinimapBuckets {
		l.n = int(span + 1)
	}
	return l
}

func (l mmLayout) at(tim int64) int {
	if tim == 0 {
		return 0
	}
	i := floorDiv(tim-l.first, l.bucketUs)
	if i < 0 {
		return 0
	}
	if i >= int64(l.n) {
		return l.n - 1
	}
	return int(i)
}

func (l mmLayout) out() *Minimap {
	return &Minimap{BucketUs: l.bucketUs, CPU: make([]int64, l.n), Waits: map[string][]int64{}}
}

func (mm *Minimap) wait(l mmLayout, class string, i int, us int64) {
	v := mm.Waits[class]
	if v == nil {
		v = make([]int64, l.n)
		mm.Waits[class] = v
	}
	v[i] += us
}

// prune drops the classes without time.
func (mm *Minimap) prune() *Minimap {
	for c, v := range mm.Waits {
		var s int64
		for _, x := range v {
			s += x
		}
		if s == 0 {
			delete(mm.Waits, c)
		}
	}
	return mm
}

func eventClass(m *model.Model, ev model.ID) string {
	if c := m.Events[ev].Class; c != "" {
		return c
	}
	return "Other"
}

// TraceMinimap is the minimap of the whole trace (see Minimap).
func TraceMinimap(m *model.Model) *Minimap {
	if a := AggOf(m); a != nil {
		return a.mm.out
	}
	l := newMmLayout(m.Span)
	out := l.out()
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Parent == model.None && !m.PXChild(c.Context) {
			out.CPU[l.at(c.Tim)] += c.C
		}
	}
	for i := range m.Waits {
		w := &m.Waits[i]
		if !m.PXChild(w.Context) {
			out.wait(l, eventClass(m, w.Event), l.at(w.Tim), w.Ela)
		}
	}
	return out.prune()
}

// ---- aggregate mode ---------------------------------------------------------

// mmCell is the CPU and the waits (by class index) of one grid cell.
type mmCell struct {
	cpu int64
	w   []int64
}

func (c *mmCell) addWait(class int, us int64) {
	for len(c.w) <= class {
		c.w = append(c.w, 0)
	}
	c.w[class] += us
}

func (c *mmCell) add(o *mmCell) {
	c.cpu += o.cpu
	for i, v := range o.w {
		if v != 0 {
			c.addWait(i, v)
		}
	}
}

// mmGrid is a bounded-memory time grid like timeline: fine cells on an
// absolute grid from the first tim seen, coarsened by 10 when there are too
// many.
type mmGrid struct {
	g, base int64
	cells   map[int64]*mmCell
	notim   mmCell // events without a tim
	lastIdx int64
	last    *mmCell
}

const mmCell0 = 100 // µs

func (g *mmGrid) cell(tim int64) *mmCell {
	if tim == 0 {
		return &g.notim
	}
	if g.cells == nil {
		g.g, g.base, g.cells = mmCell0, tim, map[int64]*mmCell{}
	}
	idx := floorDiv(tim-g.base, g.g)
	if g.last != nil && idx == g.lastIdx {
		return g.last
	}
	c := g.cells[idx]
	if c == nil {
		c = &mmCell{}
		g.cells[idx] = c
		if len(g.cells) > maxCells {
			g.coarsen()
			return g.cell(tim)
		}
	}
	g.lastIdx, g.last = idx, c
	return c
}

func (g *mmGrid) coarsen() {
	next := make(map[int64]*mmCell, len(g.cells)/4)
	for idx, c := range g.cells {
		k := floorDiv(idx, 10)
		if n := next[k]; n != nil {
			n.add(c)
		} else {
			next[k] = c
		}
	}
	g.cells, g.g, g.last = next, g.g*10, nil
}

// mmAcc collects the minimap while the facts stream by. The grids of PX
// contexts are kept apart because whether a slave is attached to a
// coordinator (and so left out) is only known when the build is finished.
type mmAcc struct {
	main    mmGrid
	px      map[model.ID]*mmGrid
	classes []string
	byClass map[string]int
	out     *Minimap
}

func (a *mmAcc) grid(m *model.Model, ctx model.ID) *mmGrid {
	if ctx >= 0 && int(ctx) < len(m.Contexts) && m.Contexts[ctx].PX {
		g := a.px[ctx]
		if g == nil {
			if a.px == nil {
				a.px = map[model.ID]*mmGrid{}
			}
			g = &mmGrid{}
			a.px[ctx] = g
		}
		return g
	}
	return &a.main
}

// cpu counts the CPU of a top-level call (Accumulator.topLevel).
func (a *mmAcc) cpu(m *model.Model, ctx model.ID, tim, c int64) {
	a.grid(m, ctx).cell(tim).cpu += c
}

// wait counts a settled wait (Accumulator.Wait).
func (a *mmAcc) wait(m *model.Model, ctx model.ID, tim int64, ev model.ID, us int64) {
	class := eventClass(m, ev)
	ci, ok := a.byClass[class]
	if !ok {
		if a.byClass == nil {
			a.byClass = map[string]int{}
		}
		ci = len(a.classes)
		a.byClass[class] = ci
		a.classes = append(a.classes, class)
	}
	a.grid(m, ctx).cell(tim).addWait(ci, us)
}

// finish reduces the grids of the contexts that count to the 1024 buckets
// (Accumulator.Finish, after PX slaves have been attached).
func (a *mmAcc) finish(m *model.Model) {
	l := newMmLayout(m.Span)
	out := l.out()
	reduce := func(g *mmGrid) {
		put := func(i int, c *mmCell) {
			out.CPU[i] += c.cpu
			for ci, v := range c.w {
				if v != 0 {
					out.wait(l, a.classes[ci], i, v)
				}
			}
		}
		put(0, &g.notim)
		for idx, c := range g.cells {
			put(l.at(g.base+idx*g.g), c)
		}
	}
	reduce(&a.main)
	ids := make([]model.ID, 0, len(a.px))
	for id := range a.px {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if !m.PXChild(id) {
			reduce(a.px[id])
		}
	}
	a.out = out.prune()
	a.main, a.px = mmGrid{}, nil
}
