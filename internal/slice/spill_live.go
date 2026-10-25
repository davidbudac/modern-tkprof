package slice

import (
	"slices"

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
// counts are final or newer, never torn into another row. The statement
// indexes are only built at Finish, so a live source scans the whole table
// for a statement (the Matcher still decides).

// LiveOverlay is the tee sink of one snapshot (Spill.Overlay).
type LiveOverlay struct {
	s                *Spill
	callCtx, waitCtx []rowRange
	rec              [callRec]byte
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
