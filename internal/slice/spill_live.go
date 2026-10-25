package slice

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Live spills (internal/engine live sessions): the spill of a build that is
// still parsing a growing file serves a snapshot of the model
// (model.(*Builder).Snapshot) at every settled batch. The snapshot's
// finish settles what the live builder still holds open (the open XCTEND,
// the waits still looking for a call, the orphans so far); Overlay writes
// those rows into the files at their ids, without counting them, so the
// snapshot's source has every row of its model. The live builder writes the
// same ids again when it settles them for real (the later write wins), and
// the parent of a child an overlay marked orphan clears the mark.
//
// Readers of a snapshot read the files with ReadAt while the build goes on
// writing (pread/pwrite, no shared Go state): rows below the snapshot's
// counts are final or newer, never torn into another row.
//
// The statement indexes of a finished spill are built at Finish, which a
// live build never reaches. A live spill (SpillOptions.Live) indexes its
// rows by cursor instead, as the build settles them (curIndex): the cursor
// of a settled row never changes, its statement can (an implicit cursor is
// adopted later), so a snapshot's source maps the asked statements to their
// cursors in its own model. The rows a snapshot's overlay wrote (not settled
// yet, their cursor may still change) are listed with the snapshot.

// LiveOverlay is the tee sink of one snapshot (Spill.Overlay).
type LiveOverlay struct {
	s                  *Spill
	callCtx, waitCtx   []rowRange
	callRows, waitRows []curRow // the rows this overlay wrote, for the snapshot's postings
	rec                [callRec]byte
}

// Overlay starts the overlay of a snapshot; call it, the snapshot and
// Source in the goroutine of the build, between two facts.
func (s *Spill) Overlay() *LiveOverlay {
	s.live = true
	return &LiveOverlay{s: s, callCtx: slices.Clone(s.callCtx), waitCtx: slices.Clone(s.waitCtx)}
}

func (o *LiveOverlay) Call(c *model.Call) {
	if o.s.err != nil || c.ID < 0 {
		return
	}
	rec := o.rec[:callRec]
	putCall(rec, c)
	o.s.calls.put(int64(c.ID), rec)
	extend(&o.callCtx, c.Context, int64(c.ID))
	if c.Cursor >= 0 {
		o.callRows = append(o.callRows, curRow{c.Cursor, uint32(c.ID)})
	}
}

func (o *LiveOverlay) Child(ch *model.ChildRec, parent *model.Call) { o.s.Child(ch, parent) }

func (o *LiveOverlay) Wait(w *model.Wait, _ *model.Call) {
	if o.s.err != nil || w.ID < 0 {
		return
	}
	rec := o.rec[:waitRec]
	putWait(rec, w)
	o.s.waits.put(int64(w.ID), rec)
	extend(&o.waitCtx, w.Context, int64(w.ID))
	if w.Cursor >= 0 {
		o.waitRows = append(o.waitRows, curRow{w.Cursor, uint32(w.ID)})
	}
}

func (o *LiveOverlay) Adopt(cur, to model.ID) {}
func (o *LiveOverlay) Finish()                {}

// Source writes the cached rows out and returns the source over every row
// written so far for m, the snapshot's model. Its Close does nothing: the
// spill stays the build's (Spill.Close removes it).
func (o *LiveOverlay) Source(m *model.Model) (FactSource, error) {
	s := o.s
	if s.err != nil {
		return nil, s.err
	}
	s.fail(s.calls.sync())
	s.fail(s.waits.sync())
	s.fail(s.sets.flush())
	s.fail(s.binds.flush())
	s.fail(s.val.flush())
	if s.err != nil {
		return nil, s.err
	}
	d := &diskSource{sp: s, m: m, calls: s.calls.f, waits: s.waits.f, nCalls: s.calls.n, nWaits: s.waits.n,
		sets: s.sets.f, binds: s.binds.f, vals: s.val.f, nSets: s.nSets, nBinds: s.nBinds,
		callCtx: o.callCtx, waitCtx: o.waitCtx, sem: make(chan struct{}, scanSlots), kinds: newKindCache(s.calls.f, s.calls.n)}
	if s.lcalls != nil {
		d.lcalls = &liveRows{x: s.lcalls, extra: o.callRows}
		d.lwaits = &liveRows{x: s.lwaits, extra: o.waitRows}
	}
	return liveSource{d}, nil
}

type liveSource struct{ *diskSource }

func (liveSource) Close() error { return nil }

// sync writes the queued and the cached rows to the file and keeps the
// cache (flush without dropping it or cutting the file).
func (p *pagedFile) sync() error {
	if len(p.late) > 0 {
		p.flushLate()
	}
	for _, pg := range p.pages {
		if p.err != nil {
			break
		}
		if err := p.flushPage(pg); err != nil {
			p.err = err
		}
	}
	return p.err
}

// ---- cursor index of a live spill ----------------------------------------------

// curRow is a row of a fact table and its cursor.
type curRow struct {
	cur model.ID
	row uint32
}

// curIndex lists the settled rows of a fact table by cursor, append only:
// each cursor buffers its row numbers in memory and writes them to the
// index file as a block once it has curTailMax, or every cursor writes its
// buffer once all of them hold curBufMax. Memory is the buffers (at most
// curBufMax ids) and a block entry per write; a block is never rewritten.
type curIndex struct {
	mu       sync.Mutex
	f        *os.File
	end      int64 // ids in f
	lists    []curList
	buffered int
	scratch  []byte
	err      error
}

type curList struct {
	blocks []curBlock
	tail   []uint32
}

// curBlock is n ids at id offset off of the index file.
type curBlock struct {
	off int64
	n   int64
}

// Buffer limits of a curIndex (variables for the tests).
var (
	curTailMax = 64 << 10
	curBufMax  = 1 << 20
)

func newCurIndex(dir, name string) (*curIndex, error) {
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	return &curIndex{f: f}, nil
}

// add lists row under cursor cur (called by the build for every settled row).
func (x *curIndex) add(cur model.ID, row int64) {
	if cur < 0 {
		return
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.err != nil {
		return
	}
	if int(cur) >= len(x.lists) {
		x.lists = slices.Grow(x.lists, int(cur)+1-len(x.lists))[:int(cur)+1]
	}
	l := &x.lists[cur]
	l.tail = append(l.tail, uint32(row))
	x.buffered++
	if len(l.tail) >= curTailMax {
		x.write(l)
	}
	if x.buffered >= curBufMax {
		for i := range x.lists {
			if len(x.lists[i].tail) > 0 {
				x.write(&x.lists[i])
			}
		}
	}
}

// write appends a cursor's buffer to the file as a block; x.mu is held.
func (x *curIndex) write(l *curList) {
	if x.err != nil {
		return
	}
	b := x.scratch[:0]
	for _, v := range l.tail {
		b = le.AppendUint32(b, v)
	}
	x.scratch = b
	if _, err := x.f.WriteAt(b, x.end*4); err != nil {
		x.err = fmt.Errorf("spill: write cursor index: %w", err)
		return
	}
	n := int64(len(l.tail))
	l.blocks = append(l.blocks, curBlock{x.end, n})
	x.end += n
	x.buffered -= len(l.tail)
	l.tail = nil
}

// rows appends the rows of the cursors to out; false when there are more
// than limit in all (a full scan is cheaper).
func (x *curIndex) rows(curs []model.ID, out []uint32, limit int) ([]uint32, bool, error) {
	var blocks []curBlock
	x.mu.Lock()
	if x.err != nil {
		x.mu.Unlock()
		return nil, false, x.err
	}
	total := len(out)
	for _, c := range curs {
		if int(c) >= len(x.lists) {
			continue
		}
		l := &x.lists[c]
		for _, b := range l.blocks {
			total += int(b.n)
		}
		total += len(l.tail)
		if total > limit {
			x.mu.Unlock()
			return nil, false, nil
		}
		blocks = append(blocks, l.blocks...)
		out = append(out, l.tail...)
	}
	x.mu.Unlock()
	// the blocks are written once and never change: read them unlocked
	var buf []byte
	for _, b := range blocks {
		if int64(cap(buf)) < b.n*4 {
			buf = make([]byte, b.n*4)
		}
		if _, err := x.f.ReadAt(buf[:b.n*4], b.off*4); err != nil {
			return nil, false, fmt.Errorf("spill: read cursor index: %w", err)
		}
		for i := int64(0); i < b.n; i++ {
			out = append(out, le.Uint32(buf[i*4:]))
		}
	}
	return out, true, nil
}

// liveRows are the postings of one table of a snapshot: the cursor index
// and the rows the snapshot's overlay wrote.
type liveRows struct {
	x     *curIndex
	extra []curRow
}

// livePostings returns the rows below n whose cursor belongs to one of the
// statements in d's model, ascending; nil when a full scan is cheaper.
func (d *diskSource) livePostings(lr *liveRows, sts []model.ID, n int64) (*rowIDs, error) {
	want := make(map[model.ID]bool, len(sts))
	for _, s := range sts {
		want[s] = true
	}
	var curs []model.ID
	isCur := map[model.ID]bool{}
	for i := range d.m.Cursors {
		if want[d.m.Cursors[i].Statement] {
			curs = append(curs, model.ID(i))
			isCur[model.ID(i)] = true
		}
	}
	var out []uint32
	for _, r := range lr.extra {
		if isCur[r.cur] {
			out = append(out, r.row)
		}
	}
	out, ok, err := lr.x.rows(curs, out, maxMergeIDs)
	if err != nil || !ok {
		return nil, err
	}
	slices.Sort(out)
	out = slices.Compact(out) // an overlay row the build has settled since is listed twice
	if n < 1<<32 {
		i, _ := slices.BinarySearch(out, uint32(n))
		out = out[:i]
	}
	return &rowIDs{mem: out}, nil
}
