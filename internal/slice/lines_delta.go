package slice

import (
	"container/heap"
	"context"
	"fmt"
	"net/url"
	"sort"
)

// The Lines view's Δ filter asks which lines of a file come long after the
// line with a time before them: the time that passed between two timed lines,
// whatever it went into (the line's own call or wait, or idle time before it).

const (
	defDeltaMin = 1000   // ?min= of /api/lines/delta: 1 ms
	defDelta    = 20000  // ?limit= of /api/lines/delta
	maxDelta    = 100000 // upper bound of ?limit=
)

// deltaStream is one source of timed lines of a file, in line order.
type deltaStream struct {
	n    int64
	at   func(i int64) (line int, tim int64, err error)
	i    int64
	line int
	tim  int64
	ok   bool
}

func (d *deltaStream) load() error {
	d.ok = d.i < d.n
	if !d.ok {
		return nil
	}
	var err error
	d.line, d.tim, err = d.at(d.i)
	return err
}

// linesDelta answers /api/lines/delta?file=&min=US&limit=N:
// {"lines":[[line,us]],"truncated":bool}. The timed lines of the file (calls,
// waits, PARSING IN CURSOR lines and XCTENDs: the lines with a tim=) are put
// in line order; a line's Δ is its tim minus the tim of the timed line before
// it, the first timed line has none, and tim=0 is no time (neither a Δ nor a
// reference). The lines whose Δ is at least `min` µs (default 1000) are
// listed in line order, at most `limit` of them (default 20000, 1..100000):
// when more qualify the largest Δ are kept (the earlier line on a tie) and
// `truncated` is set. One merge walk over the rows.
func (s *Server) linesDelta(ctx context.Context, q url.Values) (any, error) {
	_, _, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	minUs, err := intParam(q, "min", defDeltaMin, 0, maxMicros)
	if err != nil {
		return nil, err
	}
	lim, err := intParam(q, "limit", defDelta, 1, maxDelta)
	if err != nil {
		return nil, err
	}
	streams := []*deltaStream{
		{n: f.calls.hi - f.calls.lo, at: func(i int64) (int, int64, error) {
			c, ok := s.src.CallAt(f.calls.lo + i)
			if !ok {
				return 0, 0, fmt.Errorf("read call row %d", f.calls.lo+i)
			}
			return int(c.Line), c.Tim, nil
		}},
		{n: f.waits.hi - f.waits.lo, at: func(i int64) (int, int64, error) {
			w, ok := s.src.WaitAt(f.waits.lo + i)
			if !ok {
				return 0, 0, fmt.Errorf("read wait row %d", f.waits.lo+i)
			}
			return int(w.Line), w.Tim, nil
		}},
		{n: int64(len(f.cursors)), at: func(i int64) (int, int64, error) {
			id := f.cursors[i].id
			if id < 0 || int(id) >= len(s.m.Cursors) {
				return f.cursors[i].line, 0, nil
			}
			return f.cursors[i].line, s.m.Cursors[id].Tim, nil
		}},
		{n: int64(len(f.commits)), at: func(i int64) (int, int64, error) {
			id := f.commits[i].id
			if id < 0 || int(id) >= len(s.m.Transactions) {
				return f.commits[i].line, 0, nil
			}
			return f.commits[i].line, s.m.Transactions[id].Tim, nil
		}},
	}
	for _, d := range streams {
		if err := d.load(); err != nil {
			return nil, err
		}
	}
	out := struct {
		Lines     [][2]int64 `json:"lines"`
		Truncated bool       `json:"truncated"`
	}{Lines: [][2]int64{}}
	var h hotHeap
	lastLine := -1
	var prevTim int64 // 0: no timed line yet
	for n := 0; ; n++ {
		if n&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		var next *deltaStream
		for _, d := range streams {
			if d.ok && (next == nil || d.line < next.line) {
				next = d
			}
		}
		if next == nil {
			break
		}
		line, tim := next.line, next.tim
		next.i++
		if err := next.load(); err != nil {
			return nil, err
		}
		// one line can be in two tables (an XCTEND is also a call row): it counts once
		if line == lastLine || tim == 0 {
			continue
		}
		lastLine = line
		if prevTim != 0 {
			if us := tim - prevTim; us >= minUs {
				r := hotRow{Line: line, Us: us}
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
		}
		prevTim = tim
	}
	sort.Slice(h, func(i, j int) bool { return h[i].Line < h[j].Line })
	for _, r := range h {
		out.Lines = append(out.Lines, [2]int64{int64(r.Line), r.Us})
	}
	return out, nil
}
