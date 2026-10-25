package analyze

import (
	"fmt"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Accumulator is the streaming counterpart of Statements, TraceProfile,
// Contexts, Timeline, PX and the finding rules: the builder of an
// aggregation-only model (model.Options.Aggregate) feeds it every call and
// wait as they settle (it implements model.Sink) and Model.Calls / Waits stay
// empty. After Finish the analyses of this package answer from the aggregates
// (AggOf) instead of scanning the facts, with the same numbers and the same
// ordering as the full model; what cannot be answered is listed in
// docs/ARCHITECTURE.md (§ Aggregation-only mode).
//
// Layout:
//   - facts: everything the analyses filter PX slaves out of (statements,
//     edges, the trace profile). PX slave contexts are only known to be
//     attached to a coordinator once all files are read, so each PX-flagged
//     context accumulates in a shadow facts set that Finish either keeps apart
//     (attached: PXElapsed, PX totals) or merges into the main one.
//   - slots: statement accumulators are indexed by statement id; the calls of
//     a cursor that was never parsed (implicit) go to a slot of their own
//     (-2-cursor) until the cursor is adopted by the statement parsed later
//     under its number (Adopt) or the build ends.
//   - everything not PX-filtered (sessions, time buckets, call kinds, idle
//     split, events of the document) is kept globally.
type Accumulator struct {
	m  *model.Model
	th Thresholds

	seq int64 // call sequence (file order)

	main *facts
	px   map[model.ID]*facts

	ctx     []ContextStats
	events  []evAgg // every wait, by event id
	tl      timeline
	mm      mmAcc // minimap cells (minimap.go)
	kinds   [32]int64
	topRows int64 // Σ rows of top-level EXEC / FETCH calls (round-trips rule)
	think   idleAcc
	inCall  idleAcc

	open map[model.ID]*openExec // cursor -> its current execution

	fin      bool
	stats    []StmtStats
	pxTotals PXTotals
}

// NewAccumulator returns the sink for model.Options.NewSink. th are the
// thresholds the finding rules will use: the rules that need per-execution
// facts are decided while the executions stream by.
func NewAccumulator(m *model.Model, th Thresholds) *Accumulator {
	a := &Accumulator{m: m, th: th, main: newFacts(), px: map[model.ID]*facts{}, open: map[model.ID]*openExec{}}
	a.think, a.inCall = newIdleAcc(), newIdleAcc()
	return a
}

// AggOf returns the accumulator of an aggregation-only model, nil otherwise
// (or while the build is not finished).
func AggOf(m *model.Model) *Accumulator {
	if a, ok := m.Agg.(*Accumulator); ok && a.fin {
		return a
	}
	return nil
}

// ---- small aggregates -------------------------------------------------------

// evAgg is count / total / min / max of wait times.
type evAgg struct{ us, n, min, max int64 }

func (a *evAgg) add(ela int64) {
	if a.n == 0 || ela < a.min {
		a.min = ela
	}
	if ela > a.max {
		a.max = ela
	}
	a.n++
	a.us += ela
}

func (a *evAgg) merge(o *evAgg) {
	if o.n == 0 {
		return
	}
	if a.n == 0 || o.min < a.min {
		a.min = o.min
	}
	if o.max > a.max {
		a.max = o.max
	}
	a.n += o.n
	a.us += o.us
}

type objKey struct {
	ev  model.ID
	obj int64
}

func evAt(s *[]evAgg, ev model.ID) *evAgg {
	for len(*s) <= int(ev) {
		*s = append(*s, evAgg{})
	}
	return &(*s)[ev]
}

// idleAcc is the finder's idleSplit, accumulated by slot.
type idleAcc struct {
	us      int64
	n       map[model.ID]int64
	byEvent map[model.ID]int64
	byStmt  map[int32]int64
}

func newIdleAcc() idleAcc {
	return idleAcc{n: map[model.ID]int64{}, byEvent: map[model.ID]int64{}, byStmt: map[int32]int64{}}
}

// ---- statement accumulators ---------------------------------------------------

type aggStmt struct {
	StmtStats // call tables and response time, as Statements computes them

	missUs int64    // elapsed of the PARSE calls that missed
	closes [4]int64 // CLOSE calls by type

	// waits attributed to the statement (StatementProfile, waitDetail)
	byEvent            map[model.ID]*evAgg
	profWait, profIdle int64
	detEv              map[model.ID]*evAgg // non-idle, in-call waits by event
	byObj              map[objKey]*keyAgg  // ... by (event, obj#)

	ex *execAgg
}

type keyAgg struct{ n, us int64 }

func newAggStmt() *aggStmt {
	s := &aggStmt{}
	s.MinDep, s.MaxDep = 1<<30, -1
	return s
}

func (s *aggStmt) merge(o *aggStmt, k int) {
	s.Parse.addStats(o.Parse)
	s.Exec.addStats(o.Exec)
	s.Fetch.addStats(o.Fetch)
	s.Close.addStats(o.Close)
	s.Other.addStats(o.Other)
	s.AllCalls.addStats(o.AllCalls)
	s.HardParses += o.HardParses
	s.Executions += o.Executions
	s.Elapsed += o.Elapsed
	s.SelfElapsed += o.SelfElapsed
	s.CPU += o.CPU
	s.SelfCPU += o.SelfCPU
	s.WaitUs += o.WaitUs
	s.IdleUs += o.IdleUs
	s.ChildUs += o.ChildUs
	if o.MinDep < s.MinDep {
		s.MinDep = o.MinDep
	}
	if o.MaxDep > s.MaxDep {
		s.MaxDep = o.MaxDep
	}
	s.TopLevel = s.TopLevel || o.TopLevel
	if o.FirstTim != 0 && (s.FirstTim == 0 || o.FirstTim < s.FirstTim) {
		s.FirstTim, s.FirstWallUs = o.FirstTim, o.FirstWallUs
	}
	if o.LastTim > s.LastTim {
		s.LastTim, s.LastWallUs = o.LastTim, o.LastWallUs
	}
	s.missUs += o.missUs
	for i := range s.closes {
		s.closes[i] += o.closes[i]
	}
	s.profWait += o.profWait
	s.profIdle += o.profIdle
	for ev, e := range o.byEvent {
		if s.byEvent == nil {
			s.byEvent = map[model.ID]*evAgg{}
		}
		if s.byEvent[ev] == nil {
			s.byEvent[ev] = &evAgg{}
		}
		s.byEvent[ev].merge(e)
	}
	for ev, e := range o.detEv {
		if s.detEv == nil {
			s.detEv = map[model.ID]*evAgg{}
		}
		if s.detEv[ev] == nil {
			s.detEv[ev] = &evAgg{}
		}
		s.detEv[ev].merge(e)
	}
	for key, e := range o.byObj {
		if s.byObj == nil {
			s.byObj = map[objKey]*keyAgg{}
		}
		if s.byObj[key] == nil {
			s.byObj[key] = &keyAgg{}
		}
		s.byObj[key].n += e.n
		s.byObj[key].us += e.us
	}
	if o.ex != nil {
		if s.ex == nil {
			s.ex = &execAgg{}
		}
		s.ex.merge(o.ex, k)
	}
}

// facts is the part of the aggregates the analyses filter PX slaves out of.
type facts struct {
	stmts  []*aggStmt            // by statement id
	impl   map[model.ID]*aggStmt // by implicit cursor id (slot -2-id)
	edges  map[[2]int32]*Link    // (parent slot, child slot)
	events []evAgg               // waits by event (trace profile)
	waitUs int64                 // non-idle, in-call wait time
	idleUs int64                 // idle / between-call wait time
	topCPU int64                 // Σ c of top-level calls
	any    bool                  // saw a call or wait
}

func newFacts() *facts {
	return &facts{impl: map[model.ID]*aggStmt{}, edges: map[[2]int32]*Link{}}
}

func (f *facts) acc(slot int32) *aggStmt {
	if slot < 0 {
		cur := model.ID(-2 - slot)
		s := f.impl[cur]
		if s == nil {
			s = newAggStmt()
			f.impl[cur] = s
		}
		return s
	}
	for int(slot) >= len(f.stmts) {
		f.stmts = append(f.stmts, nil)
	}
	s := f.stmts[slot]
	if s == nil {
		s = newAggStmt()
		f.stmts[slot] = s
	}
	return s
}

// remap moves what was recorded under slot from to slot to.
func (f *facts) remap(from, to int32, k int) {
	if from < 0 {
		cur := model.ID(-2 - from)
		if s := f.impl[cur]; s != nil {
			delete(f.impl, cur)
			f.acc(to).merge(s, k)
		}
	}
	var keys [][2]int32
	for key := range f.edges {
		if key[0] == from || key[1] == from {
			keys = append(keys, key)
		}
	}
	for _, key := range keys {
		e := f.edges[key]
		delete(f.edges, key)
		if key[0] == from {
			key[0] = to
		}
		if key[1] == from {
			key[1] = to
		}
		f.addEdge(key, e.Calls, e.Elapsed)
	}
}

func (f *facts) addEdge(key [2]int32, calls, ela int64) {
	l := f.edges[key]
	if l == nil {
		l = &Link{}
		f.edges[key] = l
	}
	l.Calls += calls
	l.Elapsed += ela
}

// merge adds the (resolved) facts of a PX context that did not attach to a coordinator.
func (f *facts) merge(o *facts, k int) {
	for sl, s := range o.stmts {
		if s != nil {
			f.acc(int32(sl)).merge(s, k)
		}
	}
	for key, e := range o.edges {
		f.addEdge(key, e.Calls, e.Elapsed)
	}
	for ev := range o.events {
		evAt(&f.events, model.ID(ev)).merge(&o.events[ev])
	}
	f.waitUs += o.waitUs
	f.idleUs += o.idleUs
	f.topCPU += o.topCPU
	f.any = f.any || o.any
}

// resolve folds the implicit-cursor slots into their statements.
func (f *facts) resolve(a *Accumulator) {
	for cur, s := range f.impl {
		f.acc(int32(a.m.Cursors[cur].Statement)).merge(s, a.th.MaxEvidenceRows)
		delete(f.impl, cur)
	}
	var keys [][2]int32
	for key := range f.edges {
		if key[0] < 0 || key[1] < 0 {
			keys = append(keys, key)
		}
	}
	for _, key := range keys {
		e := f.edges[key]
		delete(f.edges, key)
		f.addEdge([2]int32{a.stmtOf(key[0]), a.stmtOf(key[1])}, e.Calls, e.Elapsed)
	}
}

// ---- slots --------------------------------------------------------------------

// slot is the accumulator index of a cursor's calls and waits.
func (a *Accumulator) slot(cur model.ID) int32 {
	c := &a.m.Cursors[cur]
	if c.Implicit {
		return -2 - int32(cur)
	}
	return int32(c.Statement)
}

// stmtOf resolves a slot to a statement id.
func (a *Accumulator) stmtOf(slot int32) int32 {
	if slot < 0 {
		return int32(a.m.Cursors[-2-slot].Statement)
	}
	return slot
}

func (a *Accumulator) factsFor(ctx model.ID) *facts {
	if ctx >= 0 && int(ctx) < len(a.m.Contexts) && a.m.Contexts[ctx].PX {
		f := a.px[ctx]
		if f == nil {
			f = newFacts()
			a.px[ctx] = f
		}
		return f
	}
	return a.main
}

func (a *Accumulator) ctxStat(ctx model.ID) *ContextStats {
	if ctx < 0 {
		return nil
	}
	for len(a.ctx) <= int(ctx) {
		a.ctx = append(a.ctx, ContextStats{Context: model.ID(len(a.ctx))})
	}
	return &a.ctx[ctx]
}

// ---- model.Sink -----------------------------------------------------------------

// Call folds a complete call (model.Sink).
func (a *Accumulator) Call(c *model.Call) {
	a.seq++
	f := a.factsFor(c.Context)
	f.any = true
	sl := a.slot(c.Cursor)
	s := f.acc(sl)
	switch c.Kind {
	case trace.CallParse:
		s.Parse.add(c)
		if c.Mis > 0 {
			s.HardParses += int64(c.Mis)
			s.missUs += c.E
		}
	case trace.CallExec:
		s.Exec.add(c)
		s.Executions++
	case trace.CallFetch:
		s.Fetch.add(c)
	case trace.CallClose:
		s.Close.add(c)
		if c.Type < 4 {
			s.closes[c.Type]++
		}
	default:
		s.Other.add(c)
	}
	s.AllCalls.add(c)
	if dep := int(c.Dep); dep < s.MinDep {
		s.MinDep = dep
	}
	if dep := int(c.Dep); dep > s.MaxDep {
		s.MaxDep = dep
	}
	s.SelfElapsed += c.SelfE
	s.SelfCPU += c.SelfC
	s.WaitUs += c.WaitEla
	s.IdleUs += c.IdleEla
	if c.Tim != 0 {
		if s.FirstTim == 0 || c.Tim-c.E < s.FirstTim {
			s.FirstTim = c.Tim - c.E
			s.FirstWallUs = a.m.CallWall(c) - c.E
		}
		if c.Tim > s.LastTim {
			s.LastTim = c.Tim
			s.LastWallUs = a.m.CallWall(c)
		}
	}
	if int(c.Kind) < len(a.kinds) {
		a.kinds[c.Kind]++
	}
	a.execCall(c, s)

	// sessions and time buckets: every call, PX or not
	if cs := a.ctxStat(c.Context); cs != nil {
		cs.Calls++
		cs.Rows += c.R
		if c.Tim != 0 {
			span(cs, c.Tim-c.E, c.Tim)
		}
	}
	if c.Tim != 0 {
		b := a.tl.cell(c.Tim, a.m.Span.FirstTim)
		b.Calls++
		b.Disk += c.P
		b.Query += c.CR
		b.Rows += c.R
	}
	if c.Dep == 0 {
		a.topLevel(f, s, c.Context, c.Tim, c.E, c.C, c.R, c.Kind)
	}
}

func span(s *ContextStats, from, to int64) {
	if s.FirstTim == 0 || from < s.FirstTim {
		s.FirstTim = from
	}
	if to > s.LastTim {
		s.LastTim = to
	}
}

// topLevel counts a call that has no parent (depth 0, or an orphan).
func (a *Accumulator) topLevel(f *facts, s *aggStmt, ctx model.ID, tim, e, c, r int64, kind trace.CallKind) {
	s.TopLevel = true
	a.mm.cpu(a.m, ctx, tim, c)
	s.Elapsed += e
	s.CPU += c
	f.topCPU += c
	if cs := a.ctxStat(ctx); cs != nil {
		cs.Elapsed += e
		cs.CPU += c
	}
	if tim != 0 {
		b := a.tl.cell(tim, a.m.Span.FirstTim)
		b.CPUUs += c
		b.ElaUs += e
	}
	if kind == trace.CallExec || kind == trace.CallFetch {
		a.topRows += r
	}
}

// Child resolves a recursive call whose parent is known (model.Sink).
func (a *Accumulator) Child(ch *model.ChildRec, parent *model.Call) {
	f := a.factsFor(ch.Context)
	cs := a.slot(ch.Cursor)
	s := f.acc(cs)
	if parent == nil {
		a.topLevel(f, s, ch.Context, ch.Tim, ch.E, ch.C, ch.R, ch.Kind)
		return
	}
	if a.m.Cursors[parent.Cursor].Statement == a.m.Cursors[ch.Cursor].Statement {
		return // nested in a call of the same statement: its time is in the parent's
	}
	s.Elapsed += ch.E
	s.CPU += ch.C
	ps := a.slot(parent.Cursor)
	f.addEdge([2]int32{ps, cs}, 1, ch.E)
	f.acc(ps).ChildUs += ch.E
}

// Wait folds a settled wait (model.Sink).
func (a *Accumulator) Wait(w *model.Wait, call *model.Call) {
	f := a.factsFor(w.Context)
	f.any = true
	idle := w.Idle || w.Between
	a.mm.wait(a.m, w.Context, w.Tim, w.Event, w.Ela)
	evAt(&a.events, w.Event).add(w.Ela)
	if cs := a.ctxStat(w.Context); cs != nil {
		if w.Idle {
			cs.IdleUs += w.Ela
		} else {
			cs.WaitUs += w.Ela
		}
		if w.Tim != 0 {
			span(cs, w.Tim, w.Tim)
		}
	}
	if w.Tim != 0 {
		b := a.tl.cell(w.Tim, a.m.Span.FirstTim)
		if idle {
			b.IdleUs += w.Ela
		} else {
			b.WaitUs += w.Ela
		}
	}
	var sl int32 = -1
	if w.Cursor != model.None {
		sl = a.slot(w.Cursor)
	}
	if idle {
		d := &a.think
		if inCallIdle(w, call) {
			d = &a.inCall
		}
		d.us += w.Ela
		if w.Idle { // evidence lists idle events only
			d.n[w.Event]++
			d.byEvent[w.Event] += w.Ela
		}
		if sl != -1 {
			d.byStmt[sl] += w.Ela
		}
	}

	evAt(&f.events, w.Event).add(w.Ela)
	if idle {
		f.idleUs += w.Ela
	} else {
		f.waitUs += w.Ela
	}
	if sl == -1 {
		return
	}
	s := f.acc(sl)
	if s.byEvent == nil {
		s.byEvent = map[model.ID]*evAgg{}
	}
	e := s.byEvent[w.Event]
	if e == nil {
		e = &evAgg{}
		s.byEvent[w.Event] = e
	}
	e.add(w.Ela)
	if idle {
		s.profIdle += w.Ela
		return
	}
	s.profWait += w.Ela
	if s.detEv == nil {
		s.detEv = map[model.ID]*evAgg{}
	}
	d := s.detEv[w.Event]
	if d == nil {
		d = &evAgg{}
		s.detEv[w.Event] = d
	}
	d.add(w.Ela)
	if w.ObjID > 0 {
		if s.byObj == nil {
			s.byObj = map[objKey]*keyAgg{}
		}
		k := objKey{w.Event, w.ObjID}
		o := s.byObj[k]
		if o == nil {
			o = &keyAgg{}
			s.byObj[k] = o
		}
		o.n++
		o.us += w.Ela
	}
}

// inCallIdle is inCallIdleWait for a wait attached to call (nil: none).
func inCallIdle(w *model.Wait, c *model.Call) bool {
	if !w.Idle || c == nil || w.Tim == 0 {
		return false
	}
	return !c.Synthetic && c.Tim != 0 && w.Tim > c.Tim-c.E && w.Tim <= c.Tim
}

// Adopt moves what an implicit cursor collected to the statement that took it over (model.Sink).
func (a *Accumulator) Adopt(cur, to model.ID) {
	from := -2 - int32(cur)
	for _, f := range a.allFacts() {
		f.remap(from, int32(to), a.th.MaxEvidenceRows)
	}
	for _, d := range []*idleAcc{&a.think, &a.inCall} {
		if v, ok := d.byStmt[from]; ok {
			delete(d.byStmt, from)
			d.byStmt[int32(to)] += v
		}
	}
}

func (a *Accumulator) allFacts() []*facts {
	out := []*facts{a.main}
	ids := make([]model.ID, 0, len(a.px))
	for id := range a.px {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		out = append(out, a.px[id])
	}
	return out
}

// Finish settles the aggregates (model.Sink): open executions are closed,
// implicit cursors fall back to their statement, PX slave contexts are split
// into the attached ones and the rest, and the statement stats are built.
func (a *Accumulator) Finish() {
	m := a.m
	ids := make([]model.ID, 0, len(a.open))
	for cur := range a.open {
		ids = append(ids, cur)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, cur := range ids {
		a.closeExec(cur)
	}
	for _, f := range a.allFacts() {
		f.resolve(a)
	}
	for _, d := range []*idleAcc{&a.think, &a.inCall} {
		for sl, v := range d.byStmt {
			if sl < -1 {
				delete(d.byStmt, sl)
				d.byStmt[a.stmtOf(sl)] += v
			}
		}
	}
	var kids []model.ID
	pxIDs := make([]model.ID, 0, len(a.px))
	for id := range a.px {
		pxIDs = append(pxIDs, id)
	}
	sort.Slice(pxIDs, func(i, j int) bool { return pxIDs[i] < pxIDs[j] })
	for _, id := range pxIDs {
		if m.PXChild(id) {
			kids = append(kids, id)
		} else {
			a.main.merge(a.px[id], a.th.MaxEvidenceRows)
		}
	}
	if a.tl.set && a.tl.base != m.Span.FirstTim {
		m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("aggregate mode: files start at different tim values; time buckets built from %g ms cells, events may land in the neighbouring bucket", float64(a.tl.g)/1e3))
	}
	a.stats = a.buildStats(kids)
	for len(a.ctx) < len(m.Contexts) {
		a.ctx = append(a.ctx, ContextStats{Context: model.ID(len(a.ctx))})
	}
	a.mm.finish(m)
	a.fin = true
}

func (a *Accumulator) buildStats(kids []model.ID) []StmtStats {
	m := a.m
	out := make([]StmtStats, len(m.Statements))
	for i := range out {
		if i < len(a.main.stmts) && a.main.stmts[i] != nil {
			out[i] = a.main.stmts[i].StmtStats
		} else {
			out[i].MinDep, out[i].MaxDep = 1<<30, -1
		}
		out[i].ID = model.ID(i)
		out[i].Cursors = len(m.Statements[i].Cursors)
	}
	keys := make([][2]int32, 0, len(a.main.edges))
	for e := range a.main.edges {
		keys = append(keys, e)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i][0] != keys[j][0] {
			return keys[i][0] < keys[j][0]
		}
		return keys[i][1] < keys[j][1]
	})
	for _, e := range keys {
		l := a.main.edges[e]
		out[e[0]].Children = append(out[e[0]].Children, Link{Statement: model.ID(e[1]), Calls: l.Calls, Elapsed: l.Elapsed})
		out[e[1]].Parents = append(out[e[1]].Parents, Link{Statement: model.ID(e[0]), Calls: l.Calls, Elapsed: l.Elapsed})
	}
	for i := range out {
		s := &out[i]
		s.Total.addStats(s.Parse)
		s.Total.addStats(s.Exec)
		s.Total.addStats(s.Fetch)
		if s.MinDep == 1<<30 {
			s.MinDep = m.Statements[i].MinDep
			s.MaxDep = s.MinDep
		}
		sort.Slice(s.Children, func(x, y int) bool { return s.Children[x].Elapsed > s.Children[y].Elapsed })
		sort.Slice(s.Parents, func(x, y int) bool { return s.Parents[x].Elapsed > s.Parents[y].Elapsed })
	}
	for i := range m.Errors {
		if sid := m.Errors[i].Statement; sid != model.None {
			out[sid].Errors++
		}
	}
	seen := map[model.ID]map[uint64]bool{}
	for i := range m.Plans {
		p := &m.Plans[i]
		s := &out[p.Statement]
		s.Plans = append(s.Plans, p.ID)
		if seen[p.Statement] == nil {
			seen[p.Statement] = map[uint64]bool{}
		}
		if !seen[p.Statement][p.PLH] {
			seen[p.Statement][p.PLH] = true
			s.PlanHashes = append(s.PlanHashes, p.PLH)
		}
	}
	// PX slaves attached to a coordinator: their work is kept out of the
	// statement totals above and reported next to them
	procs := map[model.ID]map[string]bool{}
	all := map[string]bool{}
	for _, id := range kids {
		f := a.px[id]
		proc := PXProcess(m, id)
		if f.any {
			all[proc] = true
		}
		for sl, s := range f.stmts {
			if s == nil || s.AllCalls.Count == 0 {
				continue
			}
			out[sl].PXElapsed += s.AllCalls.SelfElapsed
			out[sl].PXCPU += s.AllCalls.SelfCPU
			if procs[model.ID(sl)] == nil {
				procs[model.ID(sl)] = map[string]bool{}
			}
			procs[model.ID(sl)][proc] = true
		}
		a.pxTotals.CPUUs += f.topCPU
		a.pxTotals.IdleUs += f.idleUs
		a.pxTotals.WaitUs += f.waitUs
	}
	for sid, p := range procs {
		out[sid].PXSessions = len(p)
	}
	a.pxTotals.Sessions = len(all)
	return out
}

// ---- timeline cells -------------------------------------------------------------

// timeline accumulates the time buckets before the bucket size is known (it
// depends on the whole span): fine cells (1 ms) on an absolute grid from the
// first tim, coarsened by 10 whenever there are too many, so memory stays
// bounded for any span. The bucket sizes of BucketForSpan are multiples of
// every cell size the coarsening can reach below span/2000, so the buckets are
// exact whenever the first tim is the minimum tim (always for a monotonic
// trace); a build that sees an earlier tim later, or a span beyond 16 days,
// attributes a cell to the bucket of its start.
type timeline struct {
	g, base int64
	set     bool
	cells   map[int64]*Bucket
	lastIdx int64
	last    *Bucket
}

const maxCells = 20000

func (t *timeline) cell(tim, first int64) *Bucket {
	if !t.set {
		t.set = true
		t.g = 1000
		t.base = first
		if t.base == 0 || tim < t.base {
			t.base = tim
		}
		t.cells = map[int64]*Bucket{}
	}
	idx := floorDiv(tim-t.base, t.g)
	if t.last != nil && idx == t.lastIdx {
		return t.last
	}
	b := t.cells[idx]
	if b == nil {
		b = &Bucket{}
		t.cells[idx] = b
		if len(t.cells) > maxCells {
			t.coarsen()
			return t.cell(tim, first)
		}
	}
	t.lastIdx, t.last = idx, b
	return b
}

func (t *timeline) coarsen() {
	next := make(map[int64]*Bucket, len(t.cells)/4)
	for idx, b := range t.cells {
		k := floorDiv(idx, 10)
		n := next[k]
		if n == nil {
			next[k] = b
			continue
		}
		n.add(b)
	}
	t.cells, t.g, t.last = next, t.g*10, nil
}

func (b *Bucket) add(o *Bucket) {
	b.Calls += o.Calls
	b.CPUUs += o.CPUUs
	b.ElaUs += o.ElaUs
	b.WaitUs += o.WaitUs
	b.IdleUs += o.IdleUs
	b.Disk += o.Disk
	b.Query += o.Query
	b.Rows += o.Rows
}

// timeline is Timeline over the aggregates.
func (a *Accumulator) timeline(bucketUs int64) []Bucket {
	m := a.m
	if bucketUs <= 0 || m.Span.Us() == 0 {
		return nil
	}
	n := int(m.Span.Us()/bucketUs) + 1
	if n > 100000 {
		return nil
	}
	out := make([]Bucket, n)
	base := m.Span.FirstTim
	for i := range out {
		out[i].StartUs = m.WallOf(base + int64(i)*bucketUs)
		if out[i].StartUs == 0 {
			out[i].StartUs = base + int64(i)*bucketUs
		}
	}
	for idx, c := range a.tl.cells {
		j := int(floorDiv(a.tl.base+idx*a.tl.g-base, bucketUs))
		if j < 0 {
			j = 0
		}
		if j >= n {
			j = n - 1
		}
		out[j].add(c)
	}
	return out
}
