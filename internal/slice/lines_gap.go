package slice

import (
	"context"
	"fmt"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// gapRow is the part of a call or wait row the gap step needs.
type gapRow struct {
	line     int
	tim, dur int64
	ok       bool
}

// gapCursor walks the rows of one table (calls or waits) of a file in one
// direction, holding the row it stands on.
type gapCursor struct {
	s      *Server
	waits  bool
	lo, hi int64 // the file's rows
	i      int64 // current row; outside lo..hi: exhausted
	step   int64 // +1 or -1
	cur    gapRow
}

// load reads the current row (or marks the cursor exhausted).
func (g *gapCursor) load() error {
	g.cur = gapRow{}
	if g.i < g.lo || g.i >= g.hi {
		return nil
	}
	if g.waits {
		w, ok := g.s.src.WaitAt(g.i)
		if !ok {
			return fmt.Errorf("read wait row %d", g.i)
		}
		g.cur = gapRow{int(w.Line), w.Tim, w.Ela, true}
	} else {
		c, ok := g.s.src.CallAt(g.i)
		if !ok {
			return fmt.Errorf("read call row %d", g.i)
		}
		g.cur = gapRow{int(c.Line), c.Tim, c.E, true}
	}
	return nil
}

func (g *gapCursor) advance() error { g.i += g.step; return g.load() }

// nextGap is the line of the first (dir 1: line > from) or last (dir -1: line
// < from) call or wait row of the file whose idle gap before it is at least
// minGap microseconds, or -1. Calls and waits are put in line order together;
// for a row with tim T and duration D (a call's e, a wait's ela) the gap is
// (T - D) - T', and a negative gap is 0. T' is the tim of the previous call row
// of the file for a call (the WAIT lines of a call are printed before the call
// line, so the wait just above would hide the idle time) and the tim of the
// previous row of either kind, in line order, for a wait. A row with no such
// row before it has no gap. The binary searches find the rows next to `from`; from there it is a
// merge walk over the two tables, O(rows).
func (s *Server) nextGap(ctx context.Context, f *fileInfo, from, dir int, minGap int64) (int, error) {
	if dir > 0 {
		// forward: the rows with line > from; the row before is the last one at or before from
		ci, err := s.firstCall(f.calls, func(c *model.Call) bool { return int(c.Line) > from })
		if err != nil {
			return -1, err
		}
		wi, err := s.firstWait(f.waits, func(w *model.Wait) bool { return int(w.Line) > from })
		if err != nil {
			return -1, err
		}
		return s.gapWalk(ctx, f, ci, wi, +1, minGap)
	}
	// backward: the rows with line < from, the first of them being the one before the first row with line >= from
	ci, err := s.firstCall(f.calls, func(c *model.Call) bool { return int(c.Line) >= from })
	if err != nil {
		return -1, err
	}
	wi, err := s.firstWait(f.waits, func(w *model.Wait) bool { return int(w.Line) >= from })
	if err != nil {
		return -1, err
	}
	return s.gapWalk(ctx, f, ci-1, wi-1, -1, minGap)
}

// gapWalk walks the merged rows from the call row ci and the wait row wi in
// direction step; the rows on the other side of them are the earlier ones in
// line order when step is 1, the later ones when it is -1.
func (s *Server) gapWalk(ctx context.Context, f *fileInfo, ci, wi, step int64, minGap int64) (int, error) {
	cs := &gapCursor{s: s, lo: f.calls.lo, hi: f.calls.hi, i: ci, step: step}
	ws := &gapCursor{s: s, waits: true, lo: f.waits.lo, hi: f.waits.hi, i: wi, step: step}
	if err := cs.load(); err != nil {
		return -1, err
	}
	if err := ws.load(); err != nil {
		return -1, err
	}
	// the nearest row on the other side of the start, for the first row's predecessor
	var back, backCall gapRow
	if step > 0 {
		pc := &gapCursor{s: s, lo: f.calls.lo, hi: f.calls.hi, i: ci - 1}
		pw := &gapCursor{s: s, waits: true, lo: f.waits.lo, hi: f.waits.hi, i: wi - 1}
		if err := pc.load(); err != nil {
			return -1, err
		}
		if err := pw.load(); err != nil {
			return -1, err
		}
		back, backCall = pc.cur, pc.cur
		if pw.cur.ok && (!back.ok || pw.cur.line > back.line) {
			back = pw.cur
		}
	}
	// pick takes the head that comes first in the walk direction
	pick := func() *gapCursor {
		switch {
		case !cs.cur.ok && !ws.cur.ok:
			return nil
		case !ws.cur.ok:
			return cs
		case !cs.cur.ok:
			return ws
		case (cs.cur.line < ws.cur.line) == (step > 0):
			return cs
		}
		return ws
	}
	for n := 0; ; n++ {
		if n&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return -1, err
			}
		}
		h := pick()
		if h == nil {
			return -1, nil
		}
		cur := h.cur
		var prev gapRow
		if step > 0 {
			prev = back
			if !h.waits {
				prev = backCall
			}
			if err := h.advance(); err != nil {
				return -1, err
			}
		} else {
			if err := h.advance(); err != nil {
				return -1, err
			}
			if !h.waits {
				prev = h.cur // the call row before
			} else if n := pick(); n != nil {
				prev = n.cur // the row before, call or wait
			}
		}
		// tim=0 is no time (timed_statistics=false writes it on WAIT lines): a row with it, or after it, has no gap
		if prev.ok && prev.tim != 0 && cur.tim != 0 {
			if gap := cur.tim - cur.dur - prev.tim; gap >= minGap {
				return cur.line, nil
			}
		}
		if step > 0 {
			back = cur
			if !h.waits {
				backCall = cur
			}
		}
	}
}
