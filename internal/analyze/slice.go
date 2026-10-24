package analyze

import (
	"container/heap"
	"math/bits"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Queries behind `mtkprof serve` slicing (internal/slice): what the UI used to
// compute in the browser from the fact columns (web/src/data/derive.ts,
// groupby.ts, views/EventDetail.tsx, views/Timeline.tsx). Each takes a Filter
// like Pivot does.

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// SpanSeries is the CPU and the waits of a trace per time bucket: the data of
// the UI's activity chart and lanes strips (derive.ts timeline()).
type SpanSeries struct {
	BucketUs int64         `json:"bucketUs"`
	FirstTim int64         `json:"firstTim"` // tim of bucket 0
	N        int           `json:"n"`
	CPU      []float64     `json:"cpu"`    // µs of CPU of top-level calls per bucket
	Events   []EventSeries `json:"events"` // events with at least one wait in scope
}

// EventSeries is the wait time of one event per bucket.
type EventSeries struct {
	Event model.ID  `json:"event"`
	Us    []float64 `json:"us"`
}

// MaxBuckets bounds a timeline.
const MaxBuckets = 100000

// SpreadTimeline buckets top-level call CPU and wait time. A call or wait that
// is longer than a bucket is spread evenly over the buckets it covers, then a
// bucket is clamped to 100 % busy: waits are scaled down if they alone exceed
// the bucket, CPU gets what the waits leave free (as derive.ts timeline()).
// It returns nil when the span or bucket is unknown or n exceeds MaxBuckets.
func SpreadTimeline(m *model.Model, bucketUs int64, f Filter) *SpanSeries {
	span := m.Span.LastTim - m.Span.FirstTim
	if bucketUs <= 0 || span <= 0 {
		return nil
	}
	n64 := span/bucketUs + 1
	if n64 > MaxBuckets {
		return nil
	}
	n := int(n64)
	base := m.Span.FirstTim
	mt := f.Matcher()
	add := func(arr []float64, tim, dur int64, v float64) {
		if dur <= bucketUs || v == 0 {
			b := floorDiv(tim-base, bucketUs)
			if b > int64(n-1) {
				b = int64(n - 1)
			}
			if b < 0 {
				b = 0
			}
			arr[b] += v
			return
		}
		b0 := floorDiv(tim-dur-base, bucketUs)
		if b0 < 0 {
			b0 = 0
		}
		b1 := floorDiv(tim-base, bucketUs)
		if b1 > int64(n-1) {
			b1 = int64(n - 1)
		}
		per := v / float64(b1-b0+1)
		for b := b0; b <= b1; b++ {
			arr[b] += per
		}
	}
	cpu := make([]float64, n)
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Parent != model.None || c.Tim == 0 || !mt.Call(c) {
			continue
		}
		add(cpu, c.Tim, c.E, float64(c.C))
	}
	perEvent := make([][]float64, len(m.Events))
	totals := make([]float64, len(m.Events))
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.Tim == 0 || w.Event < 0 || int(w.Event) >= len(perEvent) || !mt.Wait(w) {
			continue
		}
		arr := perEvent[w.Event]
		if arr == nil {
			arr = make([]float64, n)
			perEvent[w.Event] = arr
		}
		add(arr, w.Tim, w.Ela, float64(w.Ela))
		totals[w.Event] += float64(w.Ela)
	}
	bk := float64(bucketUs)
	for b := 0; b < n; b++ {
		waitUs := 0.0
		for _, arr := range perEvent {
			if arr != nil {
				waitUs += arr[b]
			}
		}
		if waitUs > bk {
			k := bk / waitUs
			for _, arr := range perEvent {
				if arr != nil {
					arr[b] *= k
				}
			}
			waitUs = bk
		}
		free := bk - waitUs
		if free < 0 {
			free = 0
		}
		if cpu[b] > free {
			cpu[b] = free
		}
	}
	out := &SpanSeries{BucketUs: bucketUs, FirstTim: base, N: n, CPU: cpu}
	for e, arr := range perEvent {
		if arr != nil && totals[e] > 0 {
			out.Events = append(out.Events, EventSeries{Event: model.ID(e), Us: arr})
		}
	}
	return out
}

// HistBins is the number of log2 buckets of a wait-duration histogram.
const HistBins = 24

// LogHist is a histogram of wait durations: bin i holds waits with
// floor(log2(ela)) == i (bin 0 also takes ela <= 1, the last bin the rest).
type LogHist struct {
	Count  int64           `json:"count"`
	Us     int64           `json:"us"`
	Counts [HistBins]int64 `json:"counts"`
	Sums   [HistBins]int64 `json:"sums"`
}

// HistBin returns the bin of a duration in µs.
func HistBin(ela int64) int {
	if ela <= 1 {
		return 0
	}
	b := bits.Len64(uint64(ela)) - 1
	if b > HistBins-1 {
		b = HistBins - 1
	}
	return b
}

// WaitHist histograms the waits in scope.
func WaitHist(m *model.Model, f Filter) LogHist {
	var h LogHist
	mt := f.Matcher()
	for i := range m.Waits {
		w := &m.Waits[i]
		if !mt.Wait(w) {
			continue
		}
		b := HistBin(w.Ela)
		h.Count++
		h.Us += w.Ela
		h.Counts[b]++
		h.Sums[b] += w.Ela
	}
	return h
}

// ScopeProfile is the response-time ledger of a scope: CPU of the top-level
// calls plus the waits per event (web/src/data/derive.ts componentRows).
type ScopeProfile struct {
	Calls  int64      `json:"calls"` // calls in scope
	Waits  int64      `json:"waits"` // waits in scope
	CPUUs  int64      `json:"cpuUs"`
	Events []EventAgg `json:"events"`
}

// ProfileOf aggregates the calls and waits in scope.
func ProfileOf(m *model.Model, f Filter) ScopeProfile {
	var p ScopeProfile
	mt := f.Matcher()
	for i := range m.Calls {
		c := &m.Calls[i]
		if !mt.Call(c) {
			continue
		}
		p.Calls++
		if c.Parent == model.None {
			p.CPUUs += c.C
		}
	}
	p.Events = WaitsByEvent(m, mt.Wait)
	for _, e := range p.Events {
		p.Waits += e.Count
	}
	return p
}

// callHeap keeps the N calls with the largest elapsed time; the root is the
// worst of them (smallest e, then largest index).
type callHeap struct {
	ids []int32
	m   *model.Model
}

func (h *callHeap) worse(a, b int32) bool {
	ea, eb := h.m.Calls[a].E, h.m.Calls[b].E
	if ea != eb {
		return ea < eb
	}
	return a > b
}
func (h *callHeap) Len() int           { return len(h.ids) }
func (h *callHeap) Less(i, j int) bool { return h.worse(h.ids[i], h.ids[j]) }
func (h *callHeap) Swap(i, j int)      { h.ids[i], h.ids[j] = h.ids[j], h.ids[i] }
func (h *callHeap) Push(x any)         { h.ids = append(h.ids, x.(int32)) }
func (h *callHeap) Pop() any {
	n := len(h.ids)
	v := h.ids[n-1]
	h.ids = h.ids[:n-1]
	return v
}

// TopCalls returns the indexes of the (at most) limit longest calls with a
// time stamp in scope, longest first (ties: file order), and the number of
// calls in scope.
func TopCalls(m *model.Model, f Filter, limit int) (ids []int32, total int64) {
	mt := f.Matcher()
	h := &callHeap{m: m}
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Tim == 0 || !mt.Call(c) {
			continue
		}
		total++
		if limit <= 0 {
			continue
		}
		if len(h.ids) < limit {
			heap.Push(h, int32(i))
		} else if h.worse(h.ids[0], int32(i)) {
			h.ids[0] = int32(i)
			heap.Fix(h, 0)
		}
	}
	ids = h.ids
	sort.Slice(ids, func(a, b int) bool {
		ea, eb := m.Calls[ids[a]].E, m.Calls[ids[b]].E
		if ea != eb {
			return ea > eb
		}
		return ids[a] < ids[b]
	})
	return ids, total
}

// TopWaits returns the (at most) limit waits in scope with the largest
// elapsed time (ties: file order) or, with byTim, the earliest ones, and the
// number of waits and their total time in scope.
func TopWaits(m *model.Model, f Filter, limit int, byTim bool) (ids []int32, total, sumUs int64) {
	mt := f.Matcher()
	less := func(a, b int32) bool { // a ranks before b
		wa, wb := &m.Waits[a], &m.Waits[b]
		if byTim {
			if wa.Tim != wb.Tim {
				return wa.Tim < wb.Tim
			}
		} else if wa.Ela != wb.Ela {
			return wa.Ela > wb.Ela
		}
		return a < b
	}
	var cand []int32
	for i := range m.Waits {
		w := &m.Waits[i]
		if !mt.Wait(w) {
			continue
		}
		total++
		sumUs += w.Ela
		cand = append(cand, int32(i))
		if len(cand) >= 4*limit+1024 { // keep the buffer bounded: trim to the best `limit`
			sort.Slice(cand, func(a, b int) bool { return less(cand[a], cand[b]) })
			cand = cand[:limit]
		}
	}
	sort.Slice(cand, func(a, b int) bool { return less(cand[a], cand[b]) })
	if len(cand) > limit {
		cand = cand[:limit]
	}
	return cand, total, sumUs
}

// KeepSlowest is how many of the slowest waits ScatterWaits always keeps.
const KeepSlowest = 2000

// ScatterWaits picks at most max of the waits in scope that have a time
// stamp, for a scatter plot: the KeepSlowest slowest are kept, the rest is
// strided evenly (EventDetail.tsx sampleWaits). Result in file order; total is
// the number in scope.
func ScatterWaits(m *model.Model, f Filter, max int) (ids []int32, total int) {
	mt := f.Matcher()
	var all []int32
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.Tim == 0 || !mt.Wait(w) {
			continue
		}
		all = append(all, int32(i))
	}
	total = len(all)
	if total <= max {
		return all, total
	}
	byEla := append([]int32(nil), all...)
	sort.SliceStable(byEla, func(a, b int) bool { return m.Waits[byEla[a]].Ela > m.Waits[byEla[b]].Ela })
	keep := byEla
	if max < KeepSlowest {
		return append([]int32(nil), keep[:max]...), total
	}
	rest := byEla[KeepSlowest:]
	out := append([]int32(nil), byEla[:KeepSlowest]...)
	stride := float64(len(rest)) / float64(max-KeepSlowest)
	for k := 0; k < max-KeepSlowest; k++ {
		out = append(out, rest[int(float64(k)*stride)])
	}
	sort.Slice(out, func(a, b int) bool { return out[a] < out[b] })
	return out, total
}

// StmtClassWait is the wait time of one statement in one wait class.
type StmtClassWait struct {
	Statement model.ID
	Class     int // index into the class list returned with it
	Us        int64
}

// ClassOf is the wait class name a pivot groups an event under.
func ClassOf(ev *model.Event) string {
	if ev.Idle {
		return "Idle"
	}
	if ev.Class == "" {
		return "unknown"
	}
	return ev.Class
}

// WaitsByStmtClass sums the wait time of every statement per wait class (all
// waits, idle included, as derive.ts statementRoleUs); classes lists the
// class names the Class indexes refer to.
func WaitsByStmtClass(m *model.Model) (classes []string, rows []StmtClassWait) {
	cls := newInterner[string]()
	classOf := make([]int, len(m.Events))
	for i := range m.Events {
		classOf[i] = int(cls.id(ClassOf(&m.Events[i])))
	}
	type key struct {
		s model.ID
		c int
	}
	acc := map[key]*StmtClassWait{}
	var order []*StmtClassWait
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.Statement < 0 || w.Event < 0 || int(w.Event) >= len(classOf) {
			continue
		}
		k := key{w.Statement, classOf[w.Event]}
		a := acc[k]
		if a == nil {
			a = &StmtClassWait{Statement: k.s, Class: k.c}
			acc[k] = a
			order = append(order, a)
		}
		a.Us += w.Ela
	}
	rows = make([]StmtClassWait, len(order))
	for i, a := range order {
		rows[i] = *a
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Statement != rows[j].Statement {
			return rows[i].Statement < rows[j].Statement
		}
		return rows[i].Class < rows[j].Class
	})
	return cls.keys, rows
}

// StmtEventWait is the top-waits row of a statement (derive.ts statementWaits).
type StmtEventWait struct {
	Event  model.ID `json:"event"`
	Us     int64    `json:"us"`
	Count  int64    `json:"count"`
	MaxUs  int64    `json:"maxUs"`
	Obj    int64    `json:"obj"`     // the object every wait named, else -1
	MaxLin int32    `json:"maxLine"` // trace line of the longest wait
	MaxCtx model.ID `json:"maxCtx"`  // context of that wait
}

// TopStmtWaits returns, for each statement in sids, its (at most) max events
// by wait time. Obj is the common obj# of all waits of the event (-1 when
// they differ or name none).
func TopStmtWaits(m *model.Model, sids []model.ID, max int) map[model.ID][]StmtEventWait {
	want := make(map[model.ID]bool, len(sids))
	for _, s := range sids {
		want[s] = true
	}
	type key struct{ s, e model.ID }
	type acc struct {
		StmtEventWait
		maxEla int64
		objSet bool
		obj    int64
		mixed  bool
	}
	byKey := map[key]*acc{}
	for i := range m.Waits {
		w := &m.Waits[i]
		if !want[w.Statement] {
			continue
		}
		k := key{w.Statement, w.Event}
		a := byKey[k]
		if a == nil {
			a = &acc{StmtEventWait: StmtEventWait{Event: w.Event}, maxEla: -1}
			byKey[k] = a
		}
		a.Us += w.Ela
		a.Count++
		if w.Ela > a.MaxUs {
			a.MaxUs = w.Ela
		}
		if w.Ela > a.maxEla {
			a.maxEla = w.Ela
			a.MaxLin = w.Line
			a.MaxCtx = w.Context
		}
		if !a.objSet {
			a.objSet, a.obj = true, w.ObjID
		} else if a.obj != w.ObjID {
			a.mixed = true
		}
	}
	out := make(map[model.ID][]StmtEventWait, len(sids))
	for k, a := range byKey {
		a.Obj = -1
		if !a.mixed && a.obj > 0 {
			a.Obj = a.obj
		}
		out[k.s] = append(out[k.s], a.StmtEventWait)
	}
	for s, l := range out {
		sort.Slice(l, func(i, j int) bool {
			if l[i].Us != l[j].Us {
				return l[i].Us > l[j].Us
			}
			return l[i].Event < l[j].Event
		})
		if len(l) > max {
			l = l[:max]
		}
		out[s] = l
	}
	return out
}

// Interval is a [Start, End] range of tim values.
type Interval struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

// StmtSpans returns, for each statement in sids, the time intervals its calls
// covered (tim-e .. tim), merged where they are at most gapUs apart.
func StmtSpans(m *model.Model, sids []model.ID, gapUs int64) map[model.ID][]Interval {
	want := make(map[model.ID]bool, len(sids))
	for _, s := range sids {
		want[s] = true
	}
	raw := map[model.ID][]Interval{}
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Tim == 0 || !want[c.Statement] {
			continue
		}
		raw[c.Statement] = append(raw[c.Statement], Interval{c.Tim - c.E, c.Tim})
	}
	out := make(map[model.ID][]Interval, len(raw))
	for s, iv := range raw {
		sort.Slice(iv, func(a, b int) bool { return iv[a].Start < iv[b].Start })
		var merged []Interval
		for _, x := range iv {
			if n := len(merged); n > 0 && x.Start-merged[n-1].End <= gapUs {
				if x.End > merged[n-1].End {
					merged[n-1].End = x.End
				}
			} else {
				merged = append(merged, x)
			}
		}
		out[s] = merged
	}
	return out
}

// CallPart sums the resources of the calls of one kind within an execution.
type CallPart struct {
	Calls int64 `json:"calls"`
	C     int64 `json:"c"`
	E     int64 `json:"e"`
	P     int64 `json:"p"`
	CR    int64 `json:"cr"`
	CU    int64 `json:"cu"`
	R     int64 `json:"r"`
}

func (p *CallPart) add(c *model.Call) {
	p.Calls++
	p.C += c.C
	p.E += c.E
	p.P += c.P
	p.CR += c.CR
	p.CU += c.CU
	p.R += c.R
}

// ExecDetail is one execution taken apart for the A/B comparison and the bind
// panel: call statistics per kind, waits per event and the bind set.
type ExecDetail struct {
	Cursor    model.ID   `json:"cursor"`
	ExecNo    int32      `json:"execNo"`
	Exec      model.ID   `json:"exec"` // call id of the EXEC
	Line      int32      `json:"line"`
	Ctx       model.ID   `json:"ctx"` // context of the EXEC (and of its BINDS)
	PLH       uint32     `json:"planHash"`
	Parse     CallPart   `json:"parse"`
	ExecPart  CallPart   `json:"execPart"`
	Fetch     CallPart   `json:"fetch"`
	Total     CallPart   `json:"total"`
	Waits     []WaitPart `json:"waits"`     // per event, over the parse, exec and fetch calls
	ExecWaits int64      `json:"execWaits"` // waits attached to the EXEC call itself
	BindSet   model.ID   `json:"bindSet"`
	BindLine  int        `json:"bindLine"`
}

// WaitPart is the wait time of one event within an execution.
type WaitPart struct {
	Event model.ID `json:"event"`
	Count int64    `json:"count"`
	Us    int64    `json:"us"`
}

// ExecutionDetail takes one execution apart (web/src/views/ExecCompare.tsx
// factsOf): the PARSE just before its EXEC on the same cursor, the EXEC and the
// FETCHes of the execution. ok is false when the statement has no such EXEC.
func ExecutionDetail(m *model.Model, sid, cursor model.ID, execNo int32) (d ExecDetail, ok bool) {
	var calls []int32 // calls of the statement, in file order
	at := -1
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Statement != sid {
			continue
		}
		if c.Kind == trace.CallExec && c.Cursor == cursor && c.ExecNo == execNo && at < 0 {
			at = len(calls)
		}
		calls = append(calls, int32(i))
	}
	if at < 0 {
		return d, false
	}
	ex := &m.Calls[calls[at]]
	var picked []int32
	for k := at - 1; k >= 0; k-- {
		c := &m.Calls[calls[k]]
		if c.Cursor != cursor {
			continue
		}
		if c.Kind == trace.CallParse {
			picked = append(picked, calls[k])
		}
		break // the nearest earlier call of this cursor: a parse belongs to this execution, anything else to the previous one
	}
	picked = append(picked, calls[at])
	for k := at + 1; k < len(calls); k++ {
		c := &m.Calls[calls[k]]
		if c.Cursor != cursor {
			continue
		}
		if c.Kind != trace.CallFetch || c.ExecNo != execNo {
			if c.Kind == trace.CallExec || c.Kind == trace.CallClose || c.Kind == trace.CallParse {
				break
			}
			continue
		}
		picked = append(picked, calls[k])
	}
	d = ExecDetail{Cursor: cursor, ExecNo: execNo, Exec: ex.ID, Line: ex.Line, Ctx: m.Calls[ex.ID].Context, PLH: ex.PLH, BindSet: ex.BindSet}
	if ex.BindSet >= 0 && int(ex.BindSet) < len(m.BindSets) {
		d.BindLine = m.BindSets[ex.BindSet].Line
	}
	in := make(map[int32]bool, len(picked))
	for _, i := range picked {
		in[i] = true
		c := &m.Calls[i]
		switch c.Kind {
		case trace.CallParse:
			d.Parse.add(c)
		case trace.CallExec:
			d.ExecPart.add(c)
		default:
			d.Fetch.add(c)
		}
		d.Total.add(c)
	}
	byEvent := map[model.ID]*WaitPart{}
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.Call < 0 || !in[int32(w.Call)] {
			continue
		}
		if w.Call == ex.ID {
			d.ExecWaits++
		}
		a := byEvent[w.Event]
		if a == nil {
			a = &WaitPart{Event: w.Event}
			byEvent[w.Event] = a
		}
		a.Count++
		a.Us += w.Ela
	}
	for _, a := range byEvent {
		d.Waits = append(d.Waits, *a)
	}
	sort.Slice(d.Waits, func(i, j int) bool { return d.Waits[i].Event < d.Waits[j].Event })
	return d, true
}
