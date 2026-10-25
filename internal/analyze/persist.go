package analyze

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"

	"github.com/davidbudac/modern-tkprof/internal/binfmt"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Persistence of a finished Accumulator for the index cache (the counterpart
// of model.Encode, which cannot reach this package). Same explicit binary
// style: one codec function per struct, used by both directions; adding a
// field means bumping AccumPersistVersion (TestAccumPersistCoversEveryField
// counts the fields).

// AccumPersistVersion is the format version of (*Accumulator).Encode.
const AccumPersistVersion = 1

const accumMagic = "MTKPAGG1"

// Encode writes the aggregates of a finished accumulator.
func (a *Accumulator) Encode(w io.Writer) error {
	if !a.fin {
		return fmt.Errorf("analyze: encode of an unfinished accumulator")
	}
	if len(a.open) != 0 {
		return fmt.Errorf("analyze: %d executions still open after Finish", len(a.open))
	}
	bw := binfmt.NewWriter(w)
	bw.Header(accumMagic, AccumPersistVersion)
	th, err := json.Marshal(a.th)
	if err != nil {
		return err
	}
	bw.Bytes(th)
	codeAccum(binfmt.Encoder(bw), a)
	return bw.Flush()
}

// DecodeAccumulator reads what Encode wrote, for model m (the decoded
// dimensions of the same build). The caller sets m.Agg to the result.
func DecodeAccumulator(r io.Reader, m *model.Model) (*Accumulator, error) {
	br := binfmt.NewReader(r)
	br.Header(accumMagic, AccumPersistVersion)
	a := &Accumulator{m: m, open: map[model.ID]*openExec{}}
	if th := br.Bytes(); br.Err() == nil {
		if err := json.Unmarshal(th, &a.th); err != nil {
			br.Failf("thresholds: %v", err)
		}
	}
	codeAccum(binfmt.Decoder(br), a)
	if err := br.End(); err != nil {
		return nil, err
	}
	if !a.fin {
		return nil, fmt.Errorf("%w: accumulator not finished", binfmt.ErrFormat)
	}
	return a, nil
}

// accumFields is the number of fields of every struct the format covers.
var accumFields = map[string]int{
	"Accumulator": 16, "facts": 8, "aggStmt": 9, "StmtStats": 33, "CallStats": 15, "Link": 3,
	"ContextStats": 9, "evAgg": 4, "idleAcc": 4, "timeline": 6, "Bucket": 9, "PXTotals": 4,
	"execAgg": 14, "execRec": 11, "planRec": 4, "keyAgg": 2, "objKey": 2,
}

func mid(c *binfmt.Codec, p *model.ID) { c.I32((*int32)(p)) }

func codeAccum(c *binfmt.Codec, a *Accumulator) {
	// m: the caller's model; th: JSON before this
	c.I64(&a.seq)
	binfmt.Ptr(c, &a.main, func(f *facts) { codeFacts(c, f) })
	binfmt.Map(c, &a.px, func(k *model.ID) { mid(c, k) }, func(f **facts) {
		binfmt.Ptr(c, f, func(f *facts) { codeFacts(c, f) })
	})
	binfmt.Slice(c, &a.ctx, func(s *ContextStats) { codeContextStats(c, s) })
	binfmt.Slice(c, &a.events, func(e *evAgg) { codeEvAgg(c, e) })
	codeTimeline(c, &a.tl)
	for i := range a.kinds {
		c.I64(&a.kinds[i])
	}
	c.I64(&a.topRows)
	codeIdle(c, &a.think)
	codeIdle(c, &a.inCall)
	// open: empty after Finish (checked by Encode)
	c.Bool(&a.fin)
	binfmt.Slice(c, &a.stats, func(s *StmtStats) { codeStmtStats(c, s) })
	c.Int(&a.pxTotals.Sessions)
	c.I64(&a.pxTotals.CPUUs)
	c.I64(&a.pxTotals.WaitUs)
	c.I64(&a.pxTotals.IdleUs)
}

func codeFacts(c *binfmt.Codec, f *facts) {
	binfmt.Slice(c, &f.stmts, func(s **aggStmt) { binfmt.Ptr(c, s, func(s *aggStmt) { codeAggStmt(c, s) }) })
	binfmt.Map(c, &f.impl, func(k *model.ID) { mid(c, k) }, func(s **aggStmt) {
		binfmt.Ptr(c, s, func(s *aggStmt) { codeAggStmt(c, s) })
	})
	binfmt.MapFunc(c, &f.edges, cmpPair, func(k *[2]int32) { c.I32(&k[0]); c.I32(&k[1]) }, func(l **Link) {
		binfmt.Ptr(c, l, func(l *Link) { codeLink(c, l) })
	})
	binfmt.Slice(c, &f.events, func(e *evAgg) { codeEvAgg(c, e) })
	c.I64(&f.waitUs)
	c.I64(&f.idleUs)
	c.I64(&f.topCPU)
	c.Bool(&f.any)
}

func cmpPair(a, b [2]int32) int {
	if a[0] != b[0] {
		return cmp.Compare(a[0], b[0])
	}
	return cmp.Compare(a[1], b[1])
}

func cmpObjKey(a, b objKey) int {
	if a.ev != b.ev {
		return cmp.Compare(a.ev, b.ev)
	}
	return cmp.Compare(a.obj, b.obj)
}

func codeAggStmt(c *binfmt.Codec, s *aggStmt) {
	codeStmtStats(c, &s.StmtStats)
	c.I64(&s.missUs)
	for i := range s.closes {
		c.I64(&s.closes[i])
	}
	evMap := func(p *map[model.ID]*evAgg) {
		binfmt.Map(c, p, func(k *model.ID) { mid(c, k) }, func(e **evAgg) {
			binfmt.Ptr(c, e, func(e *evAgg) { codeEvAgg(c, e) })
		})
	}
	evMap(&s.byEvent)
	c.I64(&s.profWait)
	c.I64(&s.profIdle)
	evMap(&s.detEv)
	binfmt.MapFunc(c, &s.byObj, cmpObjKey, func(k *objKey) { mid(c, &k.ev); c.I64(&k.obj) }, func(v **keyAgg) {
		binfmt.Ptr(c, v, func(v *keyAgg) { c.I64(&v.n); c.I64(&v.us) })
	})
	binfmt.Ptr(c, &s.ex, func(e *execAgg) { codeExecAgg(c, e) })
}

func codeCallStats(c *binfmt.Codec, s *CallStats) {
	for _, p := range []*int64{&s.Count, &s.Misses, &s.CPU, &s.Elapsed, &s.Disk, &s.Query, &s.Current, &s.Rows,
		&s.Waits, &s.Idle, &s.SelfCPU, &s.SelfElapsed, &s.SelfDisk, &s.SelfQuery, &s.SelfCurrent} {
		c.I64(p)
	}
}

func codeLink(c *binfmt.Codec, l *Link) {
	mid(c, &l.Statement)
	c.I64(&l.Calls)
	c.I64(&l.Elapsed)
}

func codeStmtStats(c *binfmt.Codec, s *StmtStats) {
	mid(c, &s.ID)
	for _, cs := range []*CallStats{&s.Parse, &s.Exec, &s.Fetch, &s.Close, &s.Other, &s.Total, &s.AllCalls} {
		codeCallStats(c, cs)
	}
	for _, p := range []*int64{&s.Elapsed, &s.SelfElapsed, &s.CPU, &s.SelfCPU, &s.WaitUs, &s.IdleUs, &s.ChildUs,
		&s.Executions, &s.HardParses} {
		c.I64(p)
	}
	c.Int(&s.Cursors)
	c.Int(&s.Errors)
	c.Int(&s.MinDep)
	c.Int(&s.MaxDep)
	c.Bool(&s.TopLevel)
	for _, p := range []*int64{&s.FirstWallUs, &s.LastWallUs, &s.FirstTim, &s.LastTim, &s.PXElapsed, &s.PXCPU} {
		c.I64(p)
	}
	c.Int(&s.PXSessions)
	binfmt.Slice(c, &s.Parents, func(l *Link) { codeLink(c, l) })
	binfmt.Slice(c, &s.Children, func(l *Link) { codeLink(c, l) })
	binfmt.Slice(c, &s.Plans, func(p *model.ID) { mid(c, p) })
	binfmt.Slice(c, &s.PlanHashes, c.U64)
}

func codeContextStats(c *binfmt.Codec, s *ContextStats) {
	mid(c, &s.Context)
	for _, p := range []*int64{&s.Calls, &s.Rows, &s.Elapsed, &s.CPU, &s.WaitUs, &s.IdleUs, &s.FirstTim, &s.LastTim} {
		c.I64(p)
	}
}

func codeEvAgg(c *binfmt.Codec, e *evAgg) {
	c.I64(&e.us)
	c.I64(&e.n)
	c.I64(&e.min)
	c.I64(&e.max)
}

func codeIdle(c *binfmt.Codec, d *idleAcc) {
	c.I64(&d.us)
	binfmt.Map(c, &d.n, func(k *model.ID) { mid(c, k) }, c.I64)
	binfmt.Map(c, &d.byEvent, func(k *model.ID) { mid(c, k) }, c.I64)
	binfmt.Map(c, &d.byStmt, c.I32, c.I64)
}

func codeTimeline(c *binfmt.Codec, t *timeline) {
	c.I64(&t.g)
	c.I64(&t.base)
	c.Bool(&t.set)
	binfmt.Map(c, &t.cells, c.I64, func(b **Bucket) {
		binfmt.Ptr(c, b, func(b *Bucket) {
			for _, p := range []*int64{&b.StartUs, &b.Calls, &b.CPUUs, &b.ElaUs, &b.WaitUs, &b.IdleUs, &b.Disk, &b.Query, &b.Rows} {
				c.I64(p)
			}
		})
	})
	// lastIdx, last: a lookup cache, empty after decoding
	if c.Reading() {
		t.lastIdx, t.last = 0, nil
	}
}

func codeExecRec(c *binfmt.Codec, r *execRec) {
	c.I64(&r.seq)
	mid(c, &r.cursor)
	c.I32(&r.execNo)
	mid(c, &r.call)
	c.I32(&r.line)
	c.I32(&r.nFetch)
	for _, p := range []*int64{&r.elapsed, &r.cpu, &r.rows, &r.disk, &r.query} {
		c.I64(p)
	}
}

func codeExecAgg(c *binfmt.Codec, e *execAgg) {
	c.I64(&e.n)
	c.I64(&e.sum)
	c.I64(&e.min)
	c.I64(&e.max)
	codeExecRec(c, &e.slowest)
	binfmt.Slice(c, &e.els, c.I64)
	binfmt.Slice(c, &e.top, func(r *execRec) { codeExecRec(c, r) })
	c.I64(&e.smallN)
	c.I64(&e.smallFetches)
	c.I64(&e.smallRows)
	c.I64(&e.smallImpact)
	codeExecRec(c, &e.smallFirst)
	binfmt.Slice(c, &e.plans, func(p *planRec) { c.U64(&p.plh); c.Int(&p.line); c.I64(&p.execs); c.I64(&p.elapsed) })
	// planIdx: rebuilt from plans
	if c.Reading() && len(e.plans) > 0 {
		e.planIdx = make(map[uint64]int, len(e.plans))
		for i, p := range e.plans {
			e.planIdx[p.plh] = i
		}
	}
}
