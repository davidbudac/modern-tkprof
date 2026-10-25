package analyze

import (
	"context"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// CallRows is random access to the call rows of a Facts (ModelFacts and the
// sources of internal/slice have it). FindingsOn uses it to tell an idle wait
// inside its call from one before it.
type CallRows interface {
	CallAt(row int64) (model.Call, bool)
}

func (f modelFacts) CallAt(row int64) (model.Call, bool) {
	if row < 0 || row >= int64(len(f.m.Calls)) {
		return model.Call{}, false
	}
	return f.m.Calls[row], true
}

// scopeIn is what the finding rules read besides the statement table, over
// the rows of a scope (FindingsOn).
type scopeIn struct {
	mt      *Matcher
	total   int64
	missUs  []int64 // per statement: elapsed of the PARSE calls with a library cache miss
	closes  [][4]int64
	think   idleSplit
	inCall  idleSplit
	events  []evCount // per event: the waits outside attached PX slaves
	topRows int64     // Σ rows of the top-level EXEC / FETCH calls
	ex      []*execAgg
	byStmt  [][]Execution
}

type evCount struct{ us, n int64 }

// txIn reports whether a transaction end is in scope (its context, its tim
// in the window).
func (sc *scopeIn) txIn(t *model.Transaction) bool {
	if sc.mt.ctxs != nil && !sc.mt.ctxs[t.Context] {
		return false
	}
	return sc.mt.inWindow(t.Tim, 0)
}

// FindingsOn is FindingsOnWith with the default thresholds.
func FindingsOn(ctx context.Context, m *model.Model, src Facts, f Filter) ([]Finding, error) {
	return FindingsOnWith(ctx, m, src, f, DefaultThresholds())
}

// FindingsOnWith is FindingsWith over the rows of src that f accepts (the window and
// the contexts; f.Statement, f.Event and f.IncludeIdle must be unset / are
// ignored): the statement table is StatementsOn, the executions are those
// whose EXEC call is in scope (with their FETCH calls in scope), the waits,
// the commits and the round trips are those in scope, and the response time
// the severities are measured against is that of the scope: the window, else
// the span of the files of the selected contexts, else the trace span, or
// the summed session time when larger (as Findings). With an empty filter it
// returns what Findings / FindingsWith returns for the model with the same
// thresholds (the thresholds an aggregation-only model was built with for
// the per-execution rules, as there). Every rule is narrowed; Finding.Scope
// stays "" (none is about the trace set as such).
//
// Memory: the statement table, per statement the elapsed time of each
// execution in scope (8 bytes, as the aggregation-only build keeps), and for
// a model that holds its facts the executions themselves (that model has
// the calls in memory anyway). Idle waits are placed by reading their call
// through CallRows when src has it, else m.Calls.
func FindingsOnWith(ctx context.Context, m *model.Model, src Facts, f Filter, th Thresholds) ([]Finding, error) {
	f.Statement, f.Event, f.IncludeIdle = nil, nil, true
	stats, err := StatementsOn(ctx, m, src, f)
	if err != nil {
		return nil, err
	}
	fd := &finder{m: m, stats: stats, th: th, acc: AggOf(m)}
	if fd.acc != nil {
		b := fd.acc.th
		fd.th.MaxEvidenceRows, fd.th.SmallFetchRows, fd.th.SmallFetchMinFetchesPerExec = b.MaxEvidenceRows, b.SmallFetchRows, b.SmallFetchMinFetchesPerExec
	}
	sc, err := scanScope(ctx, m, src, f, &fd.th, fd.acc != nil)
	if err != nil {
		return nil, err
	}
	fd.sc, fd.total, fd.byStmt = sc, sc.total, sc.byStmt
	if fd.byStmt == nil {
		fd.byStmt = make([][]Execution, len(m.Statements))
	}
	return fd.run(), nil
}

// scanScope reads the calls and the waits in scope once each. agg: keep the
// executions as aggregates (execAgg, as the aggregation-only build does)
// rather than as Execution rows.
func scanScope(ctx context.Context, m *model.Model, src Facts, f Filter, th *Thresholds, agg bool) (*scopeIn, error) {
	mt := f.Matcher()
	n := len(m.Statements)
	sc := &scopeIn{mt: mt, missUs: make([]int64, n), closes: make([][4]int64, n), events: make([]evCount, len(m.Events))}
	mk := func() idleSplit {
		return idleSplit{n: map[model.ID]int64{}, byEvent: map[model.ID]int64{}, byStmt: map[model.ID]int64{}}
	}
	sc.think, sc.inCall = mk(), mk()
	var cpu, waitUs, idleUs int64

	// executions: as AllExecutions (rows) or as Accumulator.execCall (aggregates)
	type key struct {
		cursor model.ID
		execNo int32
	}
	idx := map[key]int{}
	if !agg {
		sc.byStmt = make([][]Execution, n)
	} else {
		sc.ex = make([]*execAgg, n)
	}
	open := map[model.ID]*openExec{}
	stmtOf := map[model.ID]model.ID{} // cursor -> statement of its open execution
	settle := func(cur model.ID) {
		o := open[cur]
		if o == nil {
			return
		}
		delete(open, cur)
		sid := stmtOf[cur]
		if sc.ex[sid] == nil {
			sc.ex[sid] = &execAgg{}
		}
		sc.ex[sid].add(o, th)
	}

	err := src.EachCall(ctx, f.Scan(), func(c *model.Call) bool {
		if !mt.Call(c) {
			return true
		}
		if c.Parent == model.None && (c.Kind == trace.CallExec || c.Kind == trace.CallFetch) {
			sc.topRows += c.R
		}
		if m.PXChild(c.Context) {
			return true
		}
		if c.Parent == model.None {
			cpu += c.C
		}
		sid := c.Statement
		switch c.Kind {
		case trace.CallParse:
			if c.Mis > 0 {
				sc.missUs[sid] += c.E
			}
		case trace.CallClose:
			if c.Type < 4 {
				sc.closes[sid][c.Type]++
			}
		}
		if !agg {
			switch c.Kind {
			case trace.CallExec:
				k := key{c.Cursor, c.ExecNo}
				e := Execution{Cursor: c.Cursor, Statement: sid, ExecNo: c.ExecNo, Exec: c.ID, BindSet: c.BindSet, StartTim: c.Tim - c.E, EndTim: c.Tim, WallUs: m.CallWall(c) - c.E, Context: c.Context, Line: c.Line}
				e.Stats.add(c)
				idx[k] = len(sc.byStmt[sid])
				sc.byStmt[sid] = append(sc.byStmt[sid], e)
			case trace.CallFetch:
				if j, ok := idx[key{c.Cursor, c.ExecNo}]; ok && j < len(sc.byStmt[sid]) && sc.byStmt[sid][j].Cursor == c.Cursor {
					e := &sc.byStmt[sid][j]
					e.Fetches = append(e.Fetches, c.ID)
					e.Stats.add(c)
					if c.Tim > e.EndTim {
						e.EndTim = c.Tim
					}
				}
			}
			return true
		}
		switch c.Kind {
		case trace.CallExec:
			settle(c.Cursor)
			o := &openExec{ctx: c.Context, plh: uint64(c.PLH)}
			o.seq, o.cursor, o.execNo, o.call, o.line = int64(c.ID), c.Cursor, c.ExecNo, c.ID, c.Line
			o.elapsed, o.cpu, o.rows, o.disk, o.query = c.E, c.C, c.R, c.P, c.CR
			open[c.Cursor] = o
			stmtOf[c.Cursor] = sid
			if c.PLH != 0 {
				if sc.ex[sid] == nil {
					sc.ex[sid] = &execAgg{}
				}
				sc.ex[sid].seePlan(uint64(c.PLH), int(c.Line))
			}
		case trace.CallFetch:
			if o := open[c.Cursor]; o != nil && o.execNo == c.ExecNo {
				o.nFetch++
				o.elapsed += c.E
				o.cpu += c.C
				o.rows += c.R
				o.disk += c.P
				o.query += c.CR
				o.fetchRows += c.R
				o.fetchImpact += c.E + c.IdleEla
			}
		case trace.CallClose:
			settle(c.Cursor)
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	curs := make([]model.ID, 0, len(open))
	for cur := range open {
		curs = append(curs, cur)
	}
	sort.Slice(curs, func(i, j int) bool { return curs[i] < curs[j] })
	for _, cur := range curs {
		settle(cur)
	}

	rows, _ := src.(CallRows)
	var last model.Call
	lastID := model.None
	callOf := func(id model.ID) (*model.Call, bool) {
		if id == lastID {
			return &last, true
		}
		var ok bool
		if rows != nil {
			last, ok = rows.CallAt(int64(id))
		} else if id >= 0 && int(id) < len(m.Calls) {
			last, ok = m.Calls[id], true
		}
		if !ok {
			lastID = model.None
			return nil, false
		}
		lastID = id
		return &last, true
	}
	err = src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !mt.Wait(w) {
			return true
		}
		idle := w.Idle || w.Between
		if !m.PXChild(w.Context) {
			if idle {
				idleUs += w.Ela
			} else {
				waitUs += w.Ela
			}
			if w.Event >= 0 && int(w.Event) < len(sc.events) {
				sc.events[w.Event].us += w.Ela
				sc.events[w.Event].n++
			}
		}
		if !idle {
			return true
		}
		a := &sc.think
		if w.Idle && w.Call != model.None && w.Tim != 0 {
			if c, ok := callOf(w.Call); ok && inCallIdle(w, c) {
				a = &sc.inCall
			}
		}
		a.us += w.Ela
		if m.Events[w.Event].Idle {
			a.n[w.Event]++
			a.byEvent[w.Event] += w.Ela
		}
		if w.Statement != model.None {
			a.byStmt[w.Statement] += w.Ela
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	sc.total = scopeSpan(m, f)
	if s := cpu + waitUs + idleUs; s > sc.total {
		sc.total = s
	}
	return sc, nil
}

// scopeSpan is the wall time of a scope: the window (open ends at the trace
// span), else the span of the files the contexts belong to, else the trace span.
func scopeSpan(m *model.Model, f Filter) int64 {
	if f.StartTim != 0 || f.EndTim != 0 {
		lo, hi := f.StartTim, f.EndTim
		if lo == 0 {
			lo = m.Span.FirstTim
		}
		if hi == 0 {
			hi = m.Span.LastTim
		}
		return max(hi-lo, 0)
	}
	if f.NoContexts {
		return 0
	}
	if len(f.Contexts) == 0 {
		return m.Span.Us()
	}
	files := m.File.Files
	var lo, hi int64
	seen := false
	for _, id := range f.Contexts {
		if id < 0 || int(id) >= len(m.Contexts) {
			continue
		}
		i := m.Contexts[id].FileIdx
		if i < 0 || i >= len(files) || files[i].FirstTim <= 0 || files[i].LastTim < files[i].FirstTim {
			continue
		}
		if !seen || files[i].FirstTim < lo {
			lo = files[i].FirstTim
		}
		if !seen || files[i].LastTim > hi {
			hi = files[i].LastTim
		}
		seen = true
	}
	if !seen || hi <= lo {
		return m.Span.Us()
	}
	return hi - lo
}
