package model

import "github.com/davidbudac/modern-tkprof/internal/trace"

// The aggregation-only build (Options.Aggregate). The builder runs the same
// call-stack logic as for the full model; what changes is where a settled
// fact goes: to the Sink instead of Model.Calls / Model.Waits. Only what is
// still open stays in memory: the call being completed, the XCTEND that
// cursor-#0 waits can still join, the recursive calls waiting for a parent
// (compact, ChildRec) and the waits waiting for a call.

// aggCall completes a call of an aggregate build (Call after observeTim).
func (b *Builder) aggCall(call *Call, c trace.Call, curID ID, cur *Cursor) {
	switch c.Kind {
	case trace.CallExec:
		cur.Execs++
		call.ExecNo = cur.Execs
		if bs, ok := b.pendingBinds[c.Cursor]; ok {
			delete(b.pendingBinds, c.Cursor)
			call.BindSet = bs
		}
	case trace.CallFetch:
		call.ExecNo = cur.Execs
	case trace.CallClose:
		cur.Closed = true
	}
	call.ID = ID(b.nCalls)
	b.nCalls++
	b.closeX()
	b.cur = *call
	cp := &b.cur
	b.attachWaits(c.Cursor, cp, curID)
	b.attachChildrenAgg(cp, c.Dep)
	b.completeCall(cp, c.Dep)
}

// completeCall hands a call whose waits and children are settled to the sink
// and, for a recursive call, queues it until its parent arrives.
func (b *Builder) completeCall(call *Call, dep int) {
	b.see(call.Context, call.Tim-call.E, call.Tim)
	b.sink.Call(call)
	if dep <= 0 {
		return // depth-0 calls never get a parent
	}
	for len(b.pendA) <= dep {
		b.pendA = append(b.pendA, nil)
		b.pendSum = append(b.pendSum, [5]int64{})
	}
	b.pendA[dep] = append(b.pendA[dep], ChildRec{ID: call.ID, Cursor: call.Cursor, Context: call.Context, Tim: call.Tim, E: call.E, C: call.C, R: call.R, Kind: call.Kind})
	s := &b.pendSum[dep]
	s[0] += call.E
	s[1] += call.C
	s[2] += call.P
	s[3] += call.CR
	s[4] += call.CU
}

// attachChildrenAgg makes every pending deeper call a child of call: it takes
// their time off the call's self values and tells the sink.
func (b *Builder) attachChildrenAgg(call *Call, dep int) {
	for d := dep + 1; d < len(b.pendA); d++ {
		for i := range b.pendA[d] {
			b.sink.Child(&b.pendA[d][i], call)
		}
		s := &b.pendSum[d]
		call.SelfE -= s[0]
		call.SelfC -= s[1]
		call.SelfP -= s[2]
		call.SelfCR -= s[3]
		call.SelfCU -= s[4]
		b.pendA[d] = b.pendA[d][:0]
		*s = [5]int64{}
	}
	for _, v := range []*int64{&call.SelfE, &call.SelfC, &call.SelfP, &call.SelfCR, &call.SelfCU} {
		if *v < 0 {
			*v = 0
		}
	}
}

// aggXctend is Xctend of an aggregate build. The XCTEND stays open until the
// next call (closeX): the log file sync waits after it still add to its time.
func (b *Builder) aggXctend(x trace.Xctend, curID ID) {
	b.closeX()
	cur := &b.m.Cursors[curID]
	call := Call{ID: ID(b.nCalls), Line: int32(x.Line), Kind: trace.CallXctend, Cursor: curID, Statement: cur.Statement,
		Dep: 1, Tim: x.Tim, Parent: None, Context: b.context(), BindSet: None, Synthetic: true}
	b.nCalls++
	wall := b.observeTim(x.Tim, x.Line)
	b.xbuf = call
	cp := &b.xbuf
	b.attachWaits(0, cp, curID) // waits logged on #0 before the XCTEND
	b.openX = cp                // ... and the ones after it (log file sync)
	b.attachChildrenAgg(cp, 1)
	t := Transaction{ID: ID(len(b.m.Transactions)), Line: x.Line, Rlbk: x.Rlbk, RdOnly: x.RdOnly, Tim: x.Tim, WallUs: wall, Call: None, Context: cp.Context}
	b.m.Transactions = append(b.m.Transactions, t)
}

// closeX completes the open XCTEND (no more waits can join it).
func (b *Builder) closeX() {
	x := b.openX
	if x == nil {
		return
	}
	b.openX = nil
	b.completeCall(x, 1)
}

// aggWait takes a wait of an aggregate build: attached to the open XCTEND, or
// queued until the next call of its cursor.
func (b *Builder) aggWait(w Wait, num uint64) {
	w.ID = ID(b.nWaits)
	b.nWaits++
	if num == 0 && b.openX != nil {
		b.attachWait(&w, b.openX)
		b.foldWait(&w, b.openX)
		return
	}
	if b.pendWait == 0 {
		b.waitBuf = b.waitBuf[:0]
	}
	b.waitBuf = append(b.waitBuf, w)
	b.pendingWaits[num] = append(b.pendingWaits[num], ID(len(b.waitBuf)-1))
	b.pendWait++
}

// foldWait hands a settled wait to the sink (call: the call it was attached
// to, nil if none).
func (b *Builder) foldWait(w *Wait, call *Call) {
	b.see(w.Context, w.Tim-w.Ela, w.Tim)
	b.sink.Wait(w, call)
}

// flushAgg settles what is still open at the end of a file (or chain): the
// pending recursive calls are orphans, the pending waits found no call.
func (b *Builder) flushAgg() {
	b.closeX()
	for d := 1; d < len(b.pendA); d++ {
		for i := range b.pendA[d] {
			b.sink.Child(&b.pendA[d][i], nil)
			b.m.Diag.OrphanCalls++
		}
		b.pendA[d] = b.pendA[d][:0]
		b.pendSum[d] = [5]int64{}
	}
	for num, ids := range b.pendingWaits {
		for _, wid := range ids {
			b.foldWait(&b.waitBuf[wid], nil)
		}
		b.m.Diag.UnattributedWaits += len(ids)
		b.pendingWaits[num] = nil
	}
	b.pendWait = 0
	b.waitBuf = b.waitBuf[:0]
}

// see widens the tim extent of a context (what attachPX needs of the facts).
func (b *Builder) see(ctx ID, from, to int64) {
	if ctx < 0 || to == 0 {
		return
	}
	for len(b.ext) <= int(ctx) {
		b.ext = append(b.ext, ctxExtent{})
	}
	e := &b.ext[ctx]
	if !e.ok || from < e.from {
		e.from = from
	}
	if !e.ok || to > e.to {
		e.to = to
	}
	e.ok = true
}
