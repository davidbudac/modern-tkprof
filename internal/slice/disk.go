package slice

import (
	"context"
	"fmt"
	"os"
	"slices"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// diskSource answers from the spill files with bounded memory: a scan is a
// sequential read through a 1 MB window (plain ReadAt, no mmap: it has to
// work on every platform), a statement-scoped scan reads the rows of the
// statement's index list through a small window, and a scan of some session
// contexts reads only their row ranges.
type diskSource struct {
	sp *Spill
	m  *model.Model

	calls, waits, sets, binds, vals *os.File
	nCalls, nWaits, nSets, nBinds   int64
	cstmt, wstmt                    *stmtIndex
	callCtx, waitCtx                []rowRange

	sem   chan struct{} // scans at a time
	kinds *kindCache
}

// scanSlots bounds the scans running at once: each reads its own window and a
// second one only makes the disk seek.
const scanSlots = 2

func (d *diskSource) NumCalls() int64 { return d.nCalls }
func (d *diskSource) NumWaits() int64 { return d.nWaits }
func (d *diskSource) Close() error    { return d.sp.Close() }

func (d *diskSource) stmtOf(cur model.ID) model.ID {
	if cur < 0 || int(cur) >= len(d.m.Cursors) {
		return model.None
	}
	return d.m.Cursors[cur].Statement
}

func (d *diskSource) EachCall(ctx context.Context, sc analyze.Scan, fn func(c *model.Call) bool) error {
	var c model.Call
	return d.scan(ctx, d.calls, callRec, d.nCalls, d.cstmt, d.callCtx, sc, func(row int64, b []byte) bool {
		getCall(b, &c)
		c.ID = model.ID(row)
		c.Statement = d.stmtOf(c.Cursor)
		return fn(&c)
	})
}

func (d *diskSource) EachWait(ctx context.Context, sc analyze.Scan, fn func(w *model.Wait) bool) error {
	var w model.Wait
	return d.scan(ctx, d.waits, waitRec, d.nWaits, d.wstmt, d.waitCtx, sc, func(row int64, b []byte) bool {
		getWait(b, &w)
		w.ID = model.ID(row)
		w.Statement = d.stmtOf(w.Cursor)
		return fn(&w)
	})
}

func (d *diskSource) CallKind(id model.ID) (trace.CallKind, bool) {
	return d.kinds.kind(int64(id))
}

// scan visits the rows of f the hint can match, in row order.
func (d *diskSource) scan(ctx context.Context, f *os.File, recSize int, n int64, idx *stmtIndex, ranges []rowRange, sc analyze.Scan, visit func(row int64, rec []byte) bool) error {
	select {
	case d.sem <- struct{}{}:
		defer func() { <-d.sem }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil { // both select cases can be ready
		return err
	}
	if n == 0 {
		return nil
	}
	window := 1 << 20
	var ids *rowIDs
	var segs []rowRange
	switch {
	case len(sc.Statements) > 0:
		var err error
		if ids, err = d.postings(idx, sc.Statements, n); err != nil {
			return err
		}
		if ids != nil {
			window = 64 << 10
			break
		}
		fallthrough
	default:
		segs = ctxSegments(ranges, sc.Contexts, n)
	}
	rd := &recReader{f: f, recSize: recSize, buf: make([]byte, window/recSize*recSize)}
	var tick int
	check := func() error {
		if tick++; tick&0xfff == 0 {
			return ctx.Err()
		}
		return nil
	}
	if ids != nil {
		for {
			row, ok, err := ids.next()
			if err != nil {
				return err
			}
			if !ok {
				return nil
			}
			if err := check(); err != nil {
				return err
			}
			b, err := rd.get(row, n)
			if err != nil {
				return err
			}
			if !visit(row, b) {
				return nil
			}
		}
	}
	for _, s := range segs {
		for row := s.lo; row < s.hi; row++ {
			if err := check(); err != nil {
				return err
			}
			b, err := rd.get(row, n)
			if err != nil {
				return err
			}
			if !visit(row, b) {
				return nil
			}
		}
	}
	return nil
}

// ctxSegments are the row ranges of the contexts (all rows when none is given).
func ctxSegments(ranges []rowRange, ctxs []model.ID, n int64) []rowRange {
	if len(ctxs) == 0 {
		return []rowRange{{0, n}}
	}
	var segs []rowRange
	for _, c := range ctxs {
		if c >= 0 && int(c) < len(ranges) && ranges[c].lo >= 0 {
			segs = append(segs, ranges[c])
		}
	}
	slices.SortFunc(segs, func(a, b rowRange) int {
		switch {
		case a.lo < b.lo:
			return -1
		case a.lo > b.lo:
			return 1
		}
		return 0
	})
	var out []rowRange
	for _, s := range segs {
		if k := len(out); k > 0 && s.lo <= out[k-1].hi {
			out[k-1].hi = max(out[k-1].hi, s.hi)
		} else {
			out = append(out, s)
		}
	}
	return out
}

// ---- statement postings --------------------------------------------------------

// rowIDs iterates ascending row numbers: from memory (several statements) or
// from the index file (one statement), a chunk at a time.
type rowIDs struct {
	mem  []uint32
	f    *os.File
	off  int64 // next byte in f
	left int64 // ids left in f
	buf  []byte
	cur  []uint32 // decoded chunk; mem is the unread part of it
}

const maxMergeIDs = 8 << 20

// postings returns the rows of the statements, or nil when a full scan is
// cheaper (too many rows to merge).
func (d *diskSource) postings(x *stmtIndex, sts []model.ID, n int64) (*rowIDs, error) {
	var total int64
	for _, s := range sts {
		total += x.count(s)
	}
	if total == 0 {
		return &rowIDs{}, nil
	}
	if len(sts) == 1 {
		return &rowIDs{f: x.f, off: x.starts[sts[0]] * 4, left: total, buf: make([]byte, 256<<10)}, nil
	}
	if total > maxMergeIDs {
		return nil, nil
	}
	all := make([]uint32, 0, total)
	buf := make([]byte, 0)
	for _, s := range sts {
		k := x.count(s)
		if k == 0 {
			continue
		}
		if int64(cap(buf)) < k*4 {
			buf = make([]byte, k*4)
		}
		b := buf[:k*4]
		if _, err := x.f.ReadAt(b, x.starts[s]*4); err != nil {
			return nil, fmt.Errorf("spill: read statement index: %w", err)
		}
		for i := 0; i < len(b); i += 4 {
			all = append(all, le.Uint32(b[i:]))
		}
	}
	slices.Sort(all)
	return &rowIDs{mem: all}, nil
}

func (l *rowIDs) next() (int64, bool, error) {
	for len(l.mem) == 0 {
		if l.left == 0 {
			return 0, false, nil
		}
		k := min(l.left, int64(len(l.buf)/4))
		if _, err := l.f.ReadAt(l.buf[:k*4], l.off); err != nil {
			return 0, false, fmt.Errorf("spill: read statement index: %w", err)
		}
		l.off += k * 4
		l.left -= k
		l.cur = l.cur[:0]
		for i := int64(0); i < k; i++ {
			l.cur = append(l.cur, le.Uint32(l.buf[i*4:]))
		}
		l.mem = l.cur
	}
	v := l.mem[0]
	l.mem = l.mem[1:]
	return int64(v), true, nil
}

// ---- call kinds ---------------------------------------------------------------

// kindCache answers "what kind of call is id" for the waits of a pivot, which
// ask for calls near the previous one: a few small windows of the call file.
type kindCache struct {
	mu   sync.Mutex
	f    *os.File
	n    int64
	win  [4]kindWindow
	next int
}

type kindWindow struct {
	lo, hi int64
	kinds  []byte
}

const kindWindowRows = 4096

func newKindCache(f *os.File, n int64) *kindCache { return &kindCache{f: f, n: n} }

func (k *kindCache) kind(id int64) (trace.CallKind, bool) {
	if id < 0 || id >= k.n {
		return 0, false
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	for i := range k.win {
		if w := &k.win[i]; id >= w.lo && id < w.hi {
			return trace.CallKind(w.kinds[id-w.lo]), true
		}
	}
	lo := id / kindWindowRows * kindWindowRows
	hi := min(lo+kindWindowRows, k.n)
	buf := make([]byte, (hi-lo)*callRec)
	if _, err := k.f.ReadAt(buf, lo*callRec); err != nil {
		return 0, false
	}
	w := &k.win[k.next]
	k.next = (k.next + 1) % len(k.win)
	w.lo, w.hi = lo, hi
	if cap(w.kinds) < int(hi-lo) {
		w.kinds = make([]byte, hi-lo)
	}
	w.kinds = w.kinds[:hi-lo]
	for i := range w.kinds {
		w.kinds[i] = buf[i*callRec+cOffKind]
	}
	return trace.CallKind(w.kinds[id-lo]), true
}

// ---- binds ----------------------------------------------------------------------

func (d *diskSource) BindSetLine(set model.ID) (int, bool) {
	var b [setRec]byte
	if set < 0 || int64(set) >= d.nSets {
		return 0, false
	}
	if _, err := d.sets.ReadAt(b[:], int64(set)*setRec); err != nil {
		return 0, false
	}
	return int(int32(le.Uint32(b[0:]))), true
}

func (d *diskSource) Binds(set model.ID) []model.Bind {
	var sb [setRec]byte
	if set < 0 || int64(set) >= d.nSets {
		return nil
	}
	if _, err := d.sets.ReadAt(sb[:], int64(set)*setRec); err != nil {
		return nil
	}
	first, n := int64(le.Uint64(sb[8:])), int64(le.Uint32(sb[16:]))
	if n == 0 || first+n > d.nBinds {
		return nil
	}
	recs := make([]byte, n*bindRec)
	if _, err := d.binds.ReadAt(recs, first*bindRec); err != nil {
		return nil
	}
	lo := int64(le.Uint64(recs[33:]))
	last := recs[(n-1)*bindRec:]
	hi := int64(le.Uint64(last[33:])) + int64(le.Uint32(last[41:]))
	vals := make([]byte, hi-lo)
	if len(vals) > 0 {
		if _, err := d.vals.ReadAt(vals, lo); err != nil {
			return nil
		}
	}
	out := make([]model.Bind, n)
	for i := range out {
		r := recs[int64(i)*bindRec:]
		b := &out[i]
		b.Set = set
		b.Pos, b.Dty, b.Mal = int32(le.Uint32(r[0:])), int32(le.Uint32(r[4:])), int32(le.Uint32(r[8:]))
		b.Mxl, b.Avl, b.Scl = int32(le.Uint32(r[12:])), int32(le.Uint32(r[16:])), int32(le.Uint32(r[20:]))
		b.Pre, b.Csi = int32(le.Uint32(r[24:])), int32(le.Uint32(r[28:]))
		fl := r[32]
		b.IsNull, b.NoDef, b.IsDump = fl&1 != 0, fl&2 != 0, fl&4 != 0
		off, ln := int64(le.Uint64(r[33:]))-lo, int64(le.Uint32(r[41:]))
		b.Value = string(vals[off : off+ln])
	}
	return out
}
