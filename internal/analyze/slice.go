package analyze

import (
	"container/heap"
	"context"
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
	out, _ := SpreadTimelineOn(context.Background(), m, ModelFacts(m), bucketUs, f)
	return out
}

// SpreadTimelineOn is SpreadTimeline over any Facts.
func SpreadTimelineOn(ctx context.Context, m *model.Model, src Facts, bucketUs int64, f Filter) (*SpanSeries, error) {
	span := m.Span.LastTim - m.Span.FirstTim
	if bucketUs <= 0 || span <= 0 {
		return nil, nil
	}
	n64 := span/bucketUs + 1
	if n64 > MaxBuckets {
		return nil, nil
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
	err := src.EachCall(ctx, f.Scan(), func(c *model.Call) bool {
		if c.Parent != model.None || c.Tim == 0 || !mt.Call(c) {
			return true
		}
		add(cpu, c.Tim, c.E, float64(c.C))
		return true
	})
	if err != nil {
		return nil, err
	}
	perEvent := make([][]float64, len(m.Events))
	totals := make([]float64, len(m.Events))
	err = src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if w.Tim == 0 || w.Event < 0 || int(w.Event) >= len(perEvent) || !mt.Wait(w) {
			return true
		}
		arr := perEvent[w.Event]
		if arr == nil {
			arr = make([]float64, n)
			perEvent[w.Event] = arr
		}
		add(arr, w.Tim, w.Ela, float64(w.Ela))
		totals[w.Event] += float64(w.Ela)
		return true
	})
	if err != nil {
		return nil, err
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
	return out, nil
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
	h, _ := WaitHistOn(context.Background(), ModelFacts(m), f)
	return h
}

// WaitHistOn is WaitHist over any Facts.
func WaitHistOn(ctx context.Context, src Facts, f Filter) (LogHist, error) {
	var h LogHist
	mt := f.Matcher()
	err := src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !mt.Wait(w) {
			return true
		}
		b := HistBin(w.Ela)
		h.Count++
		h.Us += w.Ela
		h.Counts[b]++
		h.Sums[b] += w.Ela
		return true
	})
	return h, err
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
	p, _ := ProfileOfOn(context.Background(), m, ModelFacts(m), f)
	return p
}

// ProfileOfOn is ProfileOf over any Facts.
func ProfileOfOn(ctx context.Context, m *model.Model, src Facts, f Filter) (ScopeProfile, error) {
	var p ScopeProfile
	mt := f.Matcher()
	err := src.EachCall(ctx, f.Scan(), func(c *model.Call) bool {
		if !mt.Call(c) {
			return true
		}
		p.Calls++
		if c.Parent == model.None {
			p.CPUUs += c.C
		}
		return true
	})
	if err != nil {
		return p, err
	}
	p.Events, err = WaitsByEventOn(ctx, m, src, f.Scan(), mt.Wait)
	if err != nil {
		return p, err
	}
	for _, e := range p.Events {
		p.Waits += e.Count
	}
	return p, nil
}

// callHeap keeps the N calls with the largest elapsed time; the root is the
// worst of them (smallest e, then largest index).
type callHeap struct{ calls []model.Call }

func (h *callHeap) worse(a, b *model.Call) bool {
	if a.E != b.E {
		return a.E < b.E
	}
	return a.ID > b.ID
}
func (h *callHeap) Len() int           { return len(h.calls) }
func (h *callHeap) Less(i, j int) bool { return h.worse(&h.calls[i], &h.calls[j]) }
func (h *callHeap) Swap(i, j int)      { h.calls[i], h.calls[j] = h.calls[j], h.calls[i] }
func (h *callHeap) Push(x any)         { h.calls = append(h.calls, x.(model.Call)) }
func (h *callHeap) Pop() any {
	n := len(h.calls)
	v := h.calls[n-1]
	h.calls = h.calls[:n-1]
	return v
}

// TopCalls returns the indexes of the (at most) limit longest calls with a
// time stamp in scope, longest first (ties: file order), and the number of
// calls in scope.
func TopCalls(m *model.Model, f Filter, limit int) (ids []int32, total int64) {
	calls, total, _ := TopCallsOn(context.Background(), ModelFacts(m), f, limit)
	ids = make([]int32, len(calls))
	for i := range calls {
		ids[i] = int32(calls[i].ID)
	}
	return ids, total
}

// TopCallsOn is TopCalls over any Facts, returning the calls themselves.
func TopCallsOn(ctx context.Context, src Facts, f Filter, limit int) (out []model.Call, total int64, err error) {
	mt := f.Matcher()
	h := &callHeap{}
	err = src.EachCall(ctx, f.Scan(), func(c *model.Call) bool {
		if c.Tim == 0 || !mt.Call(c) {
			return true
		}
		total++
		if limit <= 0 {
			return true
		}
		if len(h.calls) < limit {
			heap.Push(h, *c)
		} else if h.worse(&h.calls[0], c) {
			h.calls[0] = *c
			heap.Fix(h, 0)
		}
		return true
	})
	if err != nil {
		return nil, 0, err
	}
	out = h.calls
	sort.Slice(out, func(a, b int) bool {
		if out[a].E != out[b].E {
			return out[a].E > out[b].E
		}
		return out[a].ID < out[b].ID
	})
	return out, total, nil
}

// TopWaits returns the (at most) limit waits in scope with the largest
// elapsed time (ties: file order) or, with byTim, the earliest ones, and the
// number of waits and their total time in scope.
func TopWaits(m *model.Model, f Filter, limit int, byTim bool) (ids []int32, total, sumUs int64) {
	waits, total, sumUs, _ := TopWaitsOn(context.Background(), ModelFacts(m), f, limit, byTim)
	ids = make([]int32, len(waits))
	for i := range waits {
		ids[i] = int32(waits[i].ID)
	}
	return ids, total, sumUs
}

// TopWaitsOn is TopWaits over any Facts, returning the waits themselves.
func TopWaitsOn(ctx context.Context, src Facts, f Filter, limit int, byTim bool) (out []model.Wait, total, sumUs int64, err error) {
	mt := f.Matcher()
	less := func(a, b *model.Wait) bool { // a ranks before b
		if byTim {
			if a.Tim != b.Tim {
				return a.Tim < b.Tim
			}
		} else if a.Ela != b.Ela {
			return a.Ela > b.Ela
		}
		return a.ID < b.ID
	}
	var cand []model.Wait
	err = src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !mt.Wait(w) {
			return true
		}
		total++
		sumUs += w.Ela
		cand = append(cand, *w)
		if len(cand) >= 4*limit+1024 { // keep the buffer bounded: trim to the best `limit`
			sort.Slice(cand, func(a, b int) bool { return less(&cand[a], &cand[b]) })
			cand = cand[:limit]
		}
		return true
	})
	if err != nil {
		return nil, 0, 0, err
	}
	sort.Slice(cand, func(a, b int) bool { return less(&cand[a], &cand[b]) })
	if len(cand) > limit {
		cand = cand[:limit]
	}
	return cand, total, sumUs, nil
}

// KeepSlowest is how many of the slowest waits ScatterWaits always keeps.
const KeepSlowest = 2000

// ScatterPoint is a wait picked for the scatter plot.
type ScatterPoint struct {
	ID   model.ID
	Tim  int64
	Ela  int64
	Line int32
	Stmt model.ID
}

func pointOf(w *model.Wait) ScatterPoint {
	return ScatterPoint{ID: w.ID, Tim: w.Tim, Ela: w.Ela, Line: w.Line, Stmt: w.Statement}
}

// ScatterWaits picks at most max of the waits in scope that have a time
// stamp, for a scatter plot: the KeepSlowest slowest are kept, the rest is
// strided evenly (EventDetail.tsx sampleWaits). Result in file order; total is
// the number in scope.
func ScatterWaits(m *model.Model, f Filter, max int) (ids []int32, total int) {
	pts, total, _ := ScatterWaitsOn(context.Background(), ModelFacts(m), f, max)
	ids = make([]int32, len(pts))
	for i := range pts {
		ids[i] = int32(pts[i].ID)
	}
	return ids, total
}

// pointHeap keeps the n slowest points (the root is the worst: smallest ela,
// then largest index).
type pointHeap []ScatterPoint

func pointWorse(a, b ScatterPoint) bool {
	if a.Ela != b.Ela {
		return a.Ela < b.Ela
	}
	return a.ID > b.ID
}
func (h pointHeap) Len() int           { return len(h) }
func (h pointHeap) Less(i, j int) bool { return pointWorse(h[i], h[j]) }
func (h pointHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *pointHeap) Push(x any)        { *h = append(*h, x.(ScatterPoint)) }
func (h *pointHeap) Pop() any {
	old := *h
	v := old[len(old)-1]
	*h = old[:len(old)-1]
	return v
}

// ScatterWaitsOn is ScatterWaits over any Facts. The strided part picks the
// waits at fixed ranks of the list sorted by elapsed time (ties in file
// order), which a table of millions of waits cannot hold: the first pass
// keeps the slowest, counts the waits per elapsed time and finds the value of
// every wanted rank, the second pass collects the waits at those ranks.
func ScatterWaitsOn(ctx context.Context, src Facts, f Filter, max int) (out []ScatterPoint, total int, err error) {
	mt := f.Matcher()
	scan := func(fn func(w *model.Wait)) error {
		return src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
			if w.Tim == 0 || !mt.Wait(w) {
				return true
			}
			fn(w)
			return true
		})
	}
	keepN := KeepSlowest
	if max < keepN {
		keepN = max
	}
	var all []ScatterPoint // while total <= max: every wait in scope
	top := pointHeap{}
	byEla := map[int64]int64{}
	err = scan(func(w *model.Wait) {
		total++
		p := pointOf(w)
		if total <= max {
			all = append(all, p)
		} else {
			all = nil
		}
		byEla[p.Ela]++
		if len(top) < keepN {
			heap.Push(&top, p)
		} else if keepN > 0 && pointWorse(top[0], p) {
			top[0] = p
			heap.Fix(&top, 0)
		}
	})
	if err != nil {
		return nil, 0, err
	}
	if total <= max {
		return all, total, nil
	}
	sort.Slice(top, func(a, b int) bool { return pointWorse(top[b], top[a]) }) // slowest first
	if max < KeepSlowest {
		return []ScatterPoint(top), total, nil
	}
	// ranks (0-based, slowest first) to fetch from the rest
	nrest := total - KeepSlowest
	want := max - KeepSlowest
	stride := float64(nrest) / float64(want)
	elas := make([]int64, 0, len(byEla))
	for e := range byEla {
		elas = append(elas, e)
	}
	sort.Slice(elas, func(a, b int) bool { return elas[a] > elas[b] })
	type need struct {
		js   []int64 // occurrences (0-based, file order) of this elapsed time to take
		next int
		seen int64
	}
	needs := map[int64]*need{}
	var cum int64 // waits slower than elas[ei]
	ei := 0
	for k := 0; k < want; k++ {
		rank := int64(KeepSlowest) + int64(float64(k)*stride)
		for ei < len(elas) && cum+byEla[elas[ei]] <= rank {
			cum += byEla[elas[ei]]
			ei++
		}
		if ei >= len(elas) {
			break
		}
		n := needs[elas[ei]]
		if n == nil {
			n = &need{}
			needs[elas[ei]] = n
		}
		n.js = append(n.js, rank-cum)
	}
	byEla = nil
	out = append(out, top...)
	err = scan(func(w *model.Wait) {
		n := needs[w.Ela]
		if n == nil {
			return
		}
		if n.next < len(n.js) && n.seen == n.js[n.next] {
			out = append(out, pointOf(w))
			n.next++
		}
		n.seen++
	})
	if err != nil {
		return nil, 0, err
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out, total, nil
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
	classes, rows, _ = WaitsByStmtClassOn(context.Background(), m, ModelFacts(m))
	return classes, rows
}

// WaitsByStmtClassOn is WaitsByStmtClass over any Facts.
func WaitsByStmtClassOn(ctx context.Context, m *model.Model, src Facts) (classes []string, rows []StmtClassWait, err error) {
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
	err = src.EachWait(ctx, Scan{}, func(w *model.Wait) bool {
		if w.Statement < 0 || w.Event < 0 || int(w.Event) >= len(classOf) {
			return true
		}
		k := key{w.Statement, classOf[w.Event]}
		a := acc[k]
		if a == nil {
			a = &StmtClassWait{Statement: k.s, Class: k.c}
			acc[k] = a
			order = append(order, a)
		}
		a.Us += w.Ela
		return true
	})
	if err != nil {
		return nil, nil, err
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
	return cls.keys, rows, nil
}

// StmtEventWait is the top-waits row of a statement (derive.ts statementWaits).
type StmtEventWait struct {
	Event  model.ID `json:"event"`
	Us     int64    `json:"us"`
	Count  int64    `json:"count"`
	MaxUs  int64    `json:"maxUs"`
	Obj    int64    `json:"obj"`     // the object every wait named, else -1
	MaxLin int32    `json:"maxLine"` // trace line of the longest wait
}

// TopStmtWaits returns, for each statement in sids, its (at most) max events
// by wait time. Obj is the common obj# of all waits of the event (-1 when
// they differ or name none).
func TopStmtWaits(m *model.Model, sids []model.ID, max int) map[model.ID][]StmtEventWait {
	out, _ := TopStmtWaitsOn(context.Background(), ModelFacts(m), sids, max)
	return out
}

// TopStmtWaitsOn is TopStmtWaits over any Facts.
func TopStmtWaitsOn(ctx context.Context, src Facts, sids []model.ID, max int) (map[model.ID][]StmtEventWait, error) {
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
	err := src.EachWait(ctx, Scan{Statements: sids}, func(w *model.Wait) bool {
		if !want[w.Statement] {
			return true
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
		}
		if !a.objSet {
			a.objSet, a.obj = true, w.ObjID
		} else if a.obj != w.ObjID {
			a.mixed = true
		}
		return true
	})
	if err != nil {
		return nil, err
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
	return out, nil
}

// Interval is a [Start, End] range of tim values.
type Interval struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

// StmtSpans returns, for each statement in sids, the time intervals its calls
// covered (tim-e .. tim), merged where they are at most gapUs apart.
func StmtSpans(m *model.Model, sids []model.ID, gapUs int64) map[model.ID][]Interval {
	out, _ := StmtSpansOn(context.Background(), ModelFacts(m), sids, gapUs)
	return out
}

// StmtSpansOn is StmtSpans over any Facts.
func StmtSpansOn(ctx context.Context, src Facts, sids []model.ID, gapUs int64) (map[model.ID][]Interval, error) {
	want := make(map[model.ID]bool, len(sids))
	for _, s := range sids {
		want[s] = true
	}
	raw := map[model.ID][]Interval{}
	err := src.EachCall(ctx, Scan{Statements: sids}, func(c *model.Call) bool {
		if c.Tim == 0 || !want[c.Statement] {
			return true
		}
		raw[c.Statement] = append(raw[c.Statement], Interval{c.Tim - c.E, c.Tim})
		return true
	})
	if err != nil {
		return nil, err
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
	return out, nil
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
	d, ok, _ = ExecutionDetailOn(context.Background(), ModelFacts(m), sid, cursor, execNo)
	if ok && d.BindSet >= 0 && int(d.BindSet) < len(m.BindSets) {
		d.BindLine = m.BindSets[d.BindSet].Line
	}
	return d, ok
}

// ExecutionDetailOn is ExecutionDetail over any Facts. BindLine is left 0:
// bind sets are not part of Facts.
func ExecutionDetailOn(ctx context.Context, src Facts, sid, cursor model.ID, execNo int32) (d ExecDetail, ok bool, err error) {
	// One pass over the calls of the statement in file order. Before the EXEC
	// only the latest call of the cursor matters (a PARSE right before the
	// EXEC belongs to it, anything else to the previous execution); after it
	// the calls of the cursor up to the next EXEC, CLOSE or PARSE.
	var prev model.Call
	havePrev, found := false, false
	var ex model.Call
	var picked []model.ID // ascending
	pick := func(c *model.Call) {
		picked = append(picked, c.ID)
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
	err = src.EachCall(ctx, Scan{Statements: []model.ID{sid}}, func(c *model.Call) bool {
		if c.Statement != sid {
			return true
		}
		if !found {
			if c.Kind == trace.CallExec && c.Cursor == cursor && c.ExecNo == execNo {
				found = true
				ex = *c
				if havePrev && prev.Kind == trace.CallParse {
					pick(&prev)
				}
				pick(c)
				return true
			}
			if c.Cursor == cursor {
				prev, havePrev = *c, true
			}
			return true
		}
		if c.Cursor != cursor {
			return true
		}
		if c.Kind != trace.CallFetch || c.ExecNo != execNo {
			if c.Kind == trace.CallExec || c.Kind == trace.CallClose || c.Kind == trace.CallParse {
				return false
			}
			return true
		}
		pick(c)
		return true
	})
	if err != nil {
		return d, false, err
	}
	if !found {
		return d, false, nil
	}
	d.Cursor, d.ExecNo, d.Exec, d.Line, d.PLH, d.BindSet = cursor, execNo, ex.ID, ex.Line, ex.PLH, ex.BindSet
	in := func(id model.ID) bool {
		i := sort.Search(len(picked), func(i int) bool { return picked[i] >= id })
		return i < len(picked) && picked[i] == id
	}
	byEvent := map[model.ID]*WaitPart{}
	err = src.EachWait(ctx, Scan{Statements: []model.ID{sid}}, func(w *model.Wait) bool {
		if w.Call < 0 || !in(w.Call) {
			return true
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
		return true
	})
	if err != nil {
		return d, false, err
	}
	for _, a := range byEvent {
		d.Waits = append(d.Waits, *a)
	}
	sort.Slice(d.Waits, func(i, j int) bool { return d.Waits[i].Event < d.Waits[j].Event })
	return d, true, nil
}
