package slice

import (
	"container/heap"
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The readable Lines view asks two questions of a file: which lines are worth a
// time bar (hot) and which stretches of repeated rows can be folded to one
// summary (repeats). Both are one pass over the file's call and wait rows.

const (
	defHotMin = 1000  // ?min= of /api/lines/hot: 1 ms
	defHot    = 2000  // ?limit= of /api/lines/hot
	maxHot    = 20000 // upper bound of ?limit=
	maxFolds  = 20000 // folds of one /api/lines/repeats answer

	maxMicros = 1 << 62 // upper bound of the µs parameters (no overflow when summed)

	foldRunMin    = 3  // waits of one event in a row that fold to a "run"
	foldBlockKeep = 10 // items a wait block may show before it folds whole
	foldFetchMin  = 6  // fetches of a loop that fold to "fetches"
)

// hotRow is one call or wait row of /api/lines/hot.
type hotRow struct {
	Line int   `json:"line"`
	Us   int64 `json:"us"`
	Wait bool  `json:"wait"`
}

// hotWorse: a goes before b when the rows are cut to a limit (smaller time
// first, the later line on a tie).
func hotWorse(a, b hotRow) bool { return a.Us < b.Us || (a.Us == b.Us && a.Line > b.Line) }

// hotHeap is a min-heap by hotWorse: the root is the row to drop first.
type hotHeap []hotRow

func (h hotHeap) Len() int           { return len(h) }
func (h hotHeap) Less(i, j int) bool { return hotWorse(h[i], h[j]) }
func (h hotHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *hotHeap) Push(x any)        { *h = append(*h, x.(hotRow)) }
func (h *hotHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// linesHot answers /api/lines/hot?file=&min=US&limit=N:
// {"hot":[{"line","us","wait"}],"max":US,"truncated":bool}. The call rows (us =
// the line's e=) and wait rows (us = ela, idle ones included) of the file whose
// time is at least `min` µs (default 1000), at most `limit` of them (default
// 2000, 1..20000): when more qualify the largest are kept (earlier line on a
// tie) and listed in line order. `max` is the largest time of any call or wait
// row of the file, whatever `min` says: the scale of the UI's time bars. One
// pass over the rows, a heap of `limit` rows.
func (s *Server) linesHot(ctx context.Context, q url.Values) (any, error) {
	_, _, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	minUs, err := intParam(q, "min", defHotMin, 0, maxMicros)
	if err != nil {
		return nil, err
	}
	lim, err := intParam(q, "limit", defHot, 1, maxHot)
	if err != nil {
		return nil, err
	}
	out := struct {
		Hot       []hotRow `json:"hot"`
		Max       int64    `json:"max"`
		Truncated bool     `json:"truncated"`
	}{Hot: []hotRow{}}
	var h hotHeap
	take := func(r hotRow) {
		out.Max = max(out.Max, r.Us)
		if r.Us < minUs {
			return
		}
		switch {
		case len(h) < int(lim):
			heap.Push(&h, r)
		case hotWorse(h[0], r):
			h[0] = r
			heap.Fix(&h, 0)
			out.Truncated = true
		default:
			out.Truncated = true
		}
	}
	for row := f.calls.lo; row < f.calls.hi; row++ {
		if row&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		c, ok := s.src.CallAt(row)
		if !ok {
			return nil, fmt.Errorf("read call row %d", row)
		}
		take(hotRow{Line: int(c.Line), Us: c.E})
	}
	for row := f.waits.lo; row < f.waits.hi; row++ {
		if row&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		w, ok := s.src.WaitAt(row)
		if !ok {
			return nil, fmt.Errorf("read wait row %d", row)
		}
		take(hotRow{Line: int(w.Line), Us: w.Ela, Wait: true})
	}
	out.Hot = append(out.Hot, h...)
	sort.Slice(out.Hot, func(i, j int) bool { return out.Hot[i].Line < out.Hot[j].Line })
	return out, nil
}

// repeatBy is one event of a "block" fold.
type repeatBy struct {
	Event string `json:"event"`
	N     int    `json:"n"`
	Us    int64  `json:"us"`
}

// repeatFold is one fold of /api/lines/repeats. The fields after Max belong to
// one kind each (event: run; by: block; rows, cr, p, idle: fetches); the sums
// of a fetches fold are pointers so that a 0 is still answered.
type repeatFold struct {
	From  int        `json:"from"`
	To    int        `json:"to"`
	Kind  string     `json:"kind"`
	N     int        `json:"n"`
	Us    int64      `json:"us"`
	Max   int64      `json:"max"`
	Event *string    `json:"event,omitempty"`
	By    []repeatBy `json:"by,omitempty"`
	Rows  *int64     `json:"rows,omitempty"`
	CR    *int64     `json:"cr,omitempty"`
	P     *int64     `json:"p,omitempty"`
	Idle  *int64     `json:"idle,omitempty"`
}

// linesRepeats answers /api/lines/repeats?file=&small=US:
// {"folds":[...],"truncated":bool}, the candidates of the UI's "Fold repeats".
// The call and wait rows of the file are walked in line order (see repeatWalk
// for the rules). `small` (µs) is what counts as a cheap fetch or wait of a
// fetch loop; default, and 0: 1% of the span between the first and the last row
// of the file (their tim), at least 1. The folds are sorted by `from` and do
// not overlap; at most 20000 are answered.
func (s *Server) linesRepeats(ctx context.Context, q url.Values) (any, error) {
	_, _, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	small, err := intParam(q, "small", 0, 0, maxMicros)
	if err != nil {
		return nil, err
	}
	if small == 0 {
		t0, t1, _, err := s.fileSpan(f) // no rows: no folds, whatever small is
		if err != nil {
			return nil, err
		}
		small = max(1, (t1-t0)/100)
	}
	folds, truncated, err := s.repeatsOf(ctx, f, small, maxFolds)
	if err != nil {
		return nil, err
	}
	return struct {
		Folds     []repeatFold `json:"folds"`
		Truncated bool         `json:"truncated"`
	}{folds, truncated}, nil
}

// fileSpan is the tim of the first and of the last row of the file in line
// order (calls and waits together), ok=false when it has no rows. The row tables
// of a file are in line order, so it reads the two ends of each.
func (s *Server) fileSpan(f *fileInfo) (t0, t1 int64, ok bool, err error) {
	l0, l1 := math.MaxInt, -1 // lines of the first and the last row so far
	// tim=0 is no time (timed_statistics=false writes it on WAIT lines): such an end is left out
	see := func(line0 int, tim0 int64, line1 int, tim1 int64) {
		if line0 < l0 && tim0 != 0 {
			l0, t0 = line0, tim0
		}
		if line1 > l1 && tim1 != 0 {
			l1, t1 = line1, tim1
		}
		ok = true
	}
	if f.calls.hi > f.calls.lo {
		a, ok1 := s.src.CallAt(f.calls.lo)
		b, ok2 := s.src.CallAt(f.calls.hi - 1)
		if !ok1 || !ok2 {
			return 0, 0, false, fmt.Errorf("read call rows %d..%d", f.calls.lo, f.calls.hi-1)
		}
		see(int(a.Line), a.Tim, int(b.Line), b.Tim)
	}
	if f.waits.hi > f.waits.lo {
		a, ok1 := s.src.WaitAt(f.waits.lo)
		b, ok2 := s.src.WaitAt(f.waits.hi - 1)
		if !ok1 || !ok2 {
			return 0, 0, false, fmt.Errorf("read wait rows %d..%d", f.waits.lo, f.waits.hi-1)
		}
		see(int(a.Line), a.Tim, int(b.Line), b.Tim)
	}
	return t0, t1, ok, nil
}

// repeatsOf walks the call and wait rows of the file in line order and answers
// its folds: at most limit of them, then truncated is set.
func (s *Server) repeatsOf(ctx context.Context, f *fileInfo, small int64, limit int) ([]repeatFold, bool, error) {
	r := &repeatWalk{m: s.m, small: small, limit: limit}
	r.evN = make([]int, len(s.m.Events)+1)
	r.evUs = make([]int64, len(s.m.Events)+1)
	ci, wi := f.calls.lo, f.waits.lo
	var c model.Call
	var w model.Wait
	var cok, wok bool
	loadC := func() error {
		cok = ci < f.calls.hi
		if !cok {
			return nil
		}
		var ok bool
		if c, ok = s.src.CallAt(ci); !ok {
			return fmt.Errorf("read call row %d", ci)
		}
		return nil
	}
	loadW := func() error {
		wok = wi < f.waits.hi
		if !wok {
			return nil
		}
		var ok bool
		if w, ok = s.src.WaitAt(wi); !ok {
			return fmt.Errorf("read wait row %d", wi)
		}
		return nil
	}
	if err := loadC(); err != nil {
		return nil, false, err
	}
	if err := loadW(); err != nil {
		return nil, false, err
	}
	for n := 0; (cok || wok) && !r.full(); n++ {
		if n&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, false, err
			}
		}
		if cok && (!wok || c.Line < w.Line) {
			r.call(&c)
			ci++
			if err := loadC(); err != nil {
				return nil, false, err
			}
		} else {
			r.wait(&w)
			wi++
			if err := loadW(); err != nil {
				return nil, false, err
			}
		}
	}
	if !r.full() {
		r.finish()
	}
	out := r.out
	if out == nil {
		out = []repeatFold{}
	}
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}

// fetchLoop is the FETCH calls seen so far that may become a "fetches" fold.
type fetchLoop struct {
	on                        bool
	cursor                    model.ID
	from, to, n               int
	us, mx, rows, cr, p, idle int64
	waitIdle                  int64 // idle ela since the last fetch of the loop
	waitBad                   bool  // a wait since then that ends the loop
}

// repeatWalk folds the call and wait rows of a file, fed in line order.
//
// Wait folds. A wait block is a maximal run of non-idle waits of one cursor with
// no call row between them (an idle wait, a wait of another cursor or a call
// ends it). Inside a block, 3 or more waits of one event in a row are a "run"
// fold. When the block, with each run counted as one item and every other wait
// as one, still has more than 10 items, the block is one "block" fold instead
// (and has no run folds).
//
// Fetch loops. FETCH calls of one cursor, each cheaper than `small`, with only
// waits of that cursor cheaper than `small` between them (idle ones too) and no
// other call: 6 or more of them are a "fetches" fold from the first fetch's line
// to the last one's; the wait folds between them are dropped.
//
// Memory does not grow with the length of a block or a loop: a block keeps
// sums, a dense per-event table and at most 10 run folds; a loop keeps sums. The
// wait folds found since the last call row wait in `pending`, because the next
// call row decides whether they are inside a loop (and until a loop has 6
// fetches, in `held`, because a shorter loop does not fold and its waits stay).
type repeatWalk struct {
	m     *model.Model
	small int64
	limit int // folds to find; one more says there are others

	out     []repeatFold // final folds, in order of `from`
	pending []repeatFold // wait folds since the last call row
	held    []repeatFold // wait folds inside the loop that is not yet a fold

	// the wait block
	blk struct {
		n           int
		cursor      model.ID
		first, last int
		us, mx      int64
		touched     []int // events with a nonzero total
		items       int   // items of the closed runs
		runs        []repeatFold
		// the current run of one event
		runEv          model.ID
		runN           int
		runFrom, runTo int // lines of its first and last wait
		runUs, runMx   int64
	}
	evN  []int   // per event id (the last slot: any other id): waits of the block
	evUs []int64 // and their ela

	fl fetchLoop
}

func (r *repeatWalk) full() bool { return len(r.out) > r.limit }

// evIndex is the slot of an event id in the per-event tables; an id outside the
// dimension table (should not happen) shares the last slot.
func (r *repeatWalk) evIndex(id model.ID) int {
	if id < 0 || int(id) >= len(r.m.Events) {
		return len(r.m.Events)
	}
	return int(id)
}

func (r *repeatWalk) eventName(ev int) string {
	if ev < len(r.m.Events) {
		return r.m.Events[ev].Name
	}
	return ""
}

// wait takes the next wait row.
func (r *repeatWalk) wait(w *model.Wait) {
	if r.fl.on {
		if w.Cursor != r.fl.cursor || w.Ela >= r.small {
			r.fl.waitBad = true
		} else if w.Idle {
			r.fl.waitIdle += w.Ela
		}
	}
	if w.Idle {
		r.flushBlock()
		return
	}
	b := &r.blk
	if b.n > 0 && w.Cursor != b.cursor {
		r.flushBlock()
	}
	if b.n == 0 {
		b.cursor, b.first, b.us, b.mx = w.Cursor, int(w.Line), 0, 0
	}
	b.n++
	b.last = int(w.Line)
	b.us += w.Ela
	b.mx = max(b.mx, w.Ela)
	ev := r.evIndex(w.Event)
	if r.evN[ev] == 0 {
		b.touched = append(b.touched, ev)
	}
	r.evN[ev]++
	r.evUs[ev] += w.Ela
	if b.runN > 0 && w.Event == b.runEv {
		b.runN++
		b.runTo = int(w.Line)
		b.runUs += w.Ela
		b.runMx = max(b.runMx, w.Ela)
		return
	}
	r.closeRun()
	b.runEv, b.runN, b.runFrom, b.runTo, b.runUs, b.runMx = w.Event, 1, int(w.Line), int(w.Line), w.Ela, w.Ela
}

// closeRun counts the current run of the block as items; a run of 3 or more is
// one item and, while the block may still show its items, a run fold.
func (r *repeatWalk) closeRun() {
	b := &r.blk
	switch {
	case b.runN >= foldRunMin:
		b.items++
		if b.items <= foldBlockKeep {
			name := r.eventName(r.evIndex(b.runEv))
			b.runs = append(b.runs, repeatFold{From: b.runFrom, To: b.runTo, Kind: "run", N: b.runN, Us: b.runUs, Max: b.runMx, Event: &name})
		}
	case b.runN > 0:
		b.items += b.runN
	}
	if b.items > foldBlockKeep {
		b.runs = b.runs[:0]
	}
	b.runN = 0
}

// flushBlock ends the wait block and turns it into its folds, if any.
func (r *repeatWalk) flushBlock() {
	b := &r.blk
	if b.n == 0 {
		return
	}
	r.closeRun()
	if b.items > foldBlockKeep {
		by := make([]repeatBy, 0, len(b.touched))
		for _, ev := range b.touched {
			by = append(by, repeatBy{Event: r.eventName(ev), N: r.evN[ev], Us: r.evUs[ev]})
		}
		sort.SliceStable(by, func(i, j int) bool {
			if by[i].Us != by[j].Us {
				return by[i].Us > by[j].Us
			}
			return by[i].Event < by[j].Event
		})
		r.pending = append(r.pending, repeatFold{From: b.first, To: b.last, Kind: "block", N: b.n, Us: b.us, Max: b.mx, By: by})
	} else {
		r.pending = append(r.pending, b.runs...)
	}
	for _, ev := range b.touched {
		r.evN[ev], r.evUs[ev] = 0, 0
	}
	b.touched, b.runs, b.n, b.items = b.touched[:0], b.runs[:0], 0, 0
}

// call takes the next call row.
func (r *repeatWalk) call(c *model.Call) {
	r.flushBlock()
	fl := &r.fl
	cheap := c.Kind == trace.CallFetch && c.E < r.small
	if cheap && fl.on && !fl.waitBad && c.Cursor == fl.cursor {
		fl.n++
		fl.to = int(c.Line)
		fl.us += c.E
		fl.mx = max(fl.mx, c.E)
		fl.rows += c.R
		fl.cr += c.CR
		fl.p += c.P
		fl.idle += fl.waitIdle
		fl.waitIdle, fl.waitBad = 0, false
		// the wait folds between the fetches are inside the loop: dropped once it folds
		if fl.n >= foldFetchMin {
			r.held = r.held[:0]
		} else {
			r.held = append(r.held, r.pending...)
		}
		r.pending = r.pending[:0]
		return
	}
	r.closeLoop()
	r.out = append(r.out, r.pending...)
	r.pending = r.pending[:0]
	if cheap {
		*fl = fetchLoop{on: true, cursor: c.Cursor, from: int(c.Line), to: int(c.Line), n: 1, us: c.E, mx: c.E, rows: c.R, cr: c.CR, p: c.P}
	}
}

// closeLoop ends the fetch loop: a fold when it has enough fetches, else the
// wait folds inside it stay.
func (r *repeatWalk) closeLoop() {
	fl := &r.fl
	if fl.on && fl.n >= foldFetchMin {
		rows, cr, p, idle := fl.rows, fl.cr, fl.p, fl.idle
		r.out = append(r.out, repeatFold{From: fl.from, To: fl.to, Kind: "fetches", N: fl.n, Us: fl.us, Max: fl.mx, Rows: &rows, CR: &cr, P: &p, Idle: &idle})
	} else {
		r.out = append(r.out, r.held...)
	}
	r.held = r.held[:0]
	fl.on = false
}

// finish ends the walk at the end of the file.
func (r *repeatWalk) finish() {
	r.flushBlock()
	r.closeLoop()
	r.out = append(r.out, r.pending...)
	r.pending = r.pending[:0]
}
