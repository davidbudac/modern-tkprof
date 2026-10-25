package analyze

import (
	"fmt"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// execRec is what is kept of one execution (EXEC plus its FETCH calls, see
// Execution): enough for the summary line and the evidence rows of findings.
type execRec struct {
	seq     int64 // file order of the EXEC call
	cursor  model.ID
	execNo  int32
	call    model.ID
	line    int32
	nFetch  int32
	elapsed int64
	cpu     int64
	rows    int64
	disk    int64
	query   int64
}

// openExec is the execution a cursor is in the middle of: FETCH calls carry
// the number of the latest EXEC of their cursor, so one record per cursor
// suffices; it is settled at the next EXEC, the CLOSE or the end of the build.
type openExec struct {
	execRec
	ctx         model.ID
	plh         uint64
	fetchRows   int64 // Σ rows of the FETCH calls
	fetchImpact int64 // Σ (e + idle wait) of the FETCH calls
}

type planRec struct {
	plh     uint64
	line    int
	execs   int64
	elapsed int64
}

// execAgg is the aggregate of the executions of one statement. Its size is
// 8 bytes per execution (els) plus a bounded number of records.
type execAgg struct {
	n, sum, min, max int64
	slowest          execRec // earliest execution with the maximum elapsed (valid when max > 0)
	els              []int64 // elapsed of every execution, for the median of the outlier rule
	top              []execRec

	smallN, smallFetches, smallRows, smallImpact int64
	smallFirst                                   execRec

	plans   []planRec // by first appearance of the plan hash among the EXEC calls
	planIdx map[uint64]int
}

func better(a, b *execRec) bool {
	return a.elapsed > b.elapsed || a.elapsed == b.elapsed && a.seq < b.seq
}

func (e *execAgg) seePlan(plh uint64, line int) *planRec {
	if i, ok := e.planIdx[plh]; ok {
		return &e.plans[i]
	}
	if e.planIdx == nil {
		e.planIdx = map[uint64]int{}
	}
	e.planIdx[plh] = len(e.plans)
	e.plans = append(e.plans, planRec{plh: plh, line: line})
	return &e.plans[len(e.plans)-1]
}

func (e *execAgg) addTop(r execRec, k int) {
	if k <= 0 {
		return
	}
	if len(e.top) == k {
		if !better(&r, &e.top[k-1]) {
			return
		}
		e.top[k-1] = r
	} else {
		e.top = append(e.top, r)
	}
	for i := len(e.top) - 1; i > 0 && better(&e.top[i], &e.top[i-1]); i-- {
		e.top[i], e.top[i-1] = e.top[i-1], e.top[i]
	}
}

// add folds one settled execution (th: the thresholds of the accumulator).
func (e *execAgg) add(o *openExec, th *Thresholds) {
	r := o.execRec
	if e.n == 0 || r.elapsed < e.min {
		e.min = r.elapsed
	}
	if r.elapsed > e.max || r.elapsed == e.max && r.elapsed > 0 && r.seq < e.slowest.seq {
		e.max, e.slowest = r.elapsed, r
	}
	e.n++
	e.sum += r.elapsed
	e.els = append(e.els, r.elapsed)
	e.addTop(r, th.MaxEvidenceRows)
	if nf := int64(r.nFetch); nf >= th.SmallFetchMinFetchesPerExec && float64(o.fetchRows)/float64(nf) < th.SmallFetchRows {
		e.smallN++
		e.smallFetches += nf
		e.smallRows += o.fetchRows
		e.smallImpact += o.fetchImpact
		if e.smallN == 1 || r.seq < e.smallFirst.seq {
			e.smallFirst = r
		}
	}
	if o.plh != 0 {
		p := e.seePlan(o.plh, int(r.line))
		p.execs++
		p.elapsed += r.elapsed
	}
}

func (e *execAgg) merge(o *execAgg, k int) {
	if o.n == 0 && len(o.plans) == 0 {
		return
	}
	if o.n > 0 {
		if e.n == 0 || o.min < e.min {
			e.min = o.min
		}
		if o.max > e.max || o.max == e.max && o.max > 0 && o.slowest.seq < e.slowest.seq {
			e.max, e.slowest = o.max, o.slowest
		}
		e.n += o.n
		e.sum += o.sum
		e.els = append(e.els, o.els...)
		for _, r := range o.top {
			e.addTop(r, k)
		}
		if o.smallN > 0 {
			if e.smallN == 0 || o.smallFirst.seq < e.smallFirst.seq {
				e.smallFirst = o.smallFirst
			}
			e.smallN += o.smallN
			e.smallFetches += o.smallFetches
			e.smallRows += o.smallRows
			e.smallImpact += o.smallImpact
		}
	}
	for _, p := range o.plans {
		q := e.seePlan(p.plh, p.line)
		q.execs += p.execs
		q.elapsed += p.elapsed
	}
}

// execCall tracks the executions: a call of the cursor settles or extends its current one.
func (a *Accumulator) execCall(c *model.Call, s *aggStmt) {
	switch c.Kind {
	case trace.CallExec:
		a.closeExec(c.Cursor)
		o := &openExec{ctx: c.Context, plh: uint64(c.PLH)}
		o.seq, o.cursor, o.execNo, o.call, o.line = a.seq, c.Cursor, c.ExecNo, c.ID, c.Line
		o.elapsed, o.cpu, o.rows, o.disk, o.query = c.E, c.C, c.R, c.P, c.CR
		a.open[c.Cursor] = o
		if c.PLH != 0 {
			if s.ex == nil {
				s.ex = &execAgg{}
			}
			s.ex.seePlan(uint64(c.PLH), int(c.Line)) // fixes the order of the plan hashes
		}
	case trace.CallFetch:
		if o := a.open[c.Cursor]; o != nil && o.execNo == c.ExecNo {
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
		a.closeExec(c.Cursor)
	}
}

// closeExec settles the current execution of a cursor.
func (a *Accumulator) closeExec(cur model.ID) {
	o := a.open[cur]
	if o == nil {
		return
	}
	delete(a.open, cur)
	s := a.factsFor(o.ctx).acc(a.slot(cur))
	if s.ex == nil {
		s.ex = &execAgg{}
	}
	s.ex.add(o, &a.th)
}

// ---- reading the aggregates -------------------------------------------------------

// ExecSummary is the summary of the executions of one statement.
type ExecSummary struct {
	N, Min, Sum, Max int64
	HasSlowest       bool
	SlowestExecNo    int32
	SlowestCursor    model.ID
	SlowestElapsed   int64
	SlowestRows      int64
	SlowestDisk      int64
}

// ExecSummaryOf returns the executions summary of a statement of an
// aggregation-only model (ok is false for a full model: use Executions).
func ExecSummaryOf(m *model.Model, sid model.ID) (ExecSummary, bool) {
	a := AggOf(m)
	if a == nil {
		return ExecSummary{}, false
	}
	var out ExecSummary
	if e := a.execAggOf(sid); e != nil {
		out = ExecSummary{N: e.n, Min: e.min, Sum: e.sum, Max: e.max}
		if e.max > 0 {
			r := e.slowest
			out.HasSlowest, out.SlowestExecNo, out.SlowestCursor = true, r.execNo, r.cursor
			out.SlowestElapsed, out.SlowestRows, out.SlowestDisk = r.elapsed, r.rows, r.disk
		}
	}
	return out, true
}

func (a *Accumulator) execAggOf(sid model.ID) *execAgg {
	if int(sid) < len(a.main.stmts) && a.main.stmts[sid] != nil {
		return a.main.stmts[sid].ex
	}
	return nil
}

func (a *Accumulator) acc(sid model.ID) *aggStmt {
	if int(sid) < len(a.main.stmts) {
		return a.main.stmts[sid]
	}
	return nil
}

// median of the elapsed times of the executions of a statement, ties as in median().
func (e *execAgg) median() int64 { return median(e.els) }

// waitsByEvent is the sorted per-event list of WaitsByEvent over the
// aggregates: get returns the aggregate of an event (nil: none).
func (a *Accumulator) waitsByEvent(get func(model.ID) *evAgg) []EventAgg {
	m := a.m
	out := []EventAgg{}
	for i := range m.Events {
		e := get(model.ID(i))
		if e == nil || e.n == 0 {
			continue
		}
		out = append(out, EventAgg{Event: model.ID(i), Name: m.Events[i].Name, Class: m.Events[i].Class, Idle: m.Events[i].Idle,
			Count: e.n, Us: e.us, MinUs: e.min, MaxUs: e.max})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Us > out[j].Us })
	return out
}

// WaitDetailEvents lists the in-call, non-idle waits of a statement by event,
// most time first (the events of the "Wait detail by object" section).
func WaitDetailEvents(m *model.Model, sid model.ID) []EventAgg {
	if a := AggOf(m); a != nil {
		s := a.acc(sid)
		if s == nil {
			return []EventAgg{}
		}
		return a.waitsByEvent(func(ev model.ID) *evAgg { return s.detEv[ev] })
	}
	return WaitsByEvent(m, func(w *model.Wait) bool {
		return w.Statement == sid && !w.Idle && !w.Between && !m.PXChild(w.Context)
	})
}

// WaitDetailObjects groups the same waits of one event by obj#.
func WaitDetailObjects(m *model.Model, sid, ev model.ID) []KeyAgg {
	if a := AggOf(m); a != nil {
		s := a.acc(sid)
		if s == nil {
			return []KeyAgg{}
		}
		out := []KeyAgg{}
		for k, v := range s.byObj {
			if k.ev == ev {
				out = append(out, KeyAgg{Key: k.obj, Count: v.n, Us: v.us})
			}
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Us != out[j].Us {
				return out[i].Us > out[j].Us
			}
			return out[i].Key < out[j].Key
		})
		return out
	}
	return WaitsBy(m, func(w *model.Wait) bool {
		return w.Statement == sid && !w.Idle && !w.Between && !m.PXChild(w.Context) && w.Event == ev
	}, func(w *model.Wait) (int64, bool) { return w.ObjID, w.ObjID > 0 })
}

// KindCount is the number of calls of one kind.
type KindCount struct {
	Kind  trace.CallKind
	Count int64
}

// CallKinds counts the calls of the trace by kind, in kind order.
func CallKinds(m *model.Model) []KindCount {
	var out []KindCount
	if a := AggOf(m); a != nil {
		for k, n := range a.kinds {
			if n > 0 {
				out = append(out, KindCount{trace.CallKind(k), n})
			}
		}
		return out
	}
	counts := map[trace.CallKind]int64{}
	for i := range m.Calls {
		counts[m.Calls[i].Kind]++
	}
	for k := range counts {
		out = append(out, KindCount{k, counts[k]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out
}

// ---- finding rules over the aggregates ----------------------------------------------

// outliersAgg is outliers() over the execution aggregates: the median and the
// hit count come from the elapsed time of every execution, the evidence rows
// from the slowest ones kept per statement.
func (f *finder) outliersAgg() {
	for i := range f.stats {
		s := &f.stats[i]
		if s.Executions < f.th.OutlierMinExecs {
			continue
		}
		ea := f.execAgg(s.ID)
		if ea == nil || ea.n < f.th.OutlierMinExecs {
			continue
		}
		med := ea.median()
		var hits, excess int64
		for _, e := range ea.els {
			if float64(e) > f.th.OutlierFactor*float64(med) && e > f.th.OutlierMinUs {
				hits++
				excess += e - med
			}
		}
		if hits == 0 {
			continue
		}
		worst := ea.max
		x := Finding{
			Rule: RuleOutlierExecs, Title: "Outlier executions", Statement: s.ID, ImpactUs: excess,
			Severity: f.timeSeverity(excess, f.total),
			Summary: fmt.Sprintf("%s: %d of %d executions over %gx the median %s; slowest %s (%.0fx); %s over the median in total",
				f.label(s.ID), hits, ea.n, f.th.OutlierFactor, fmtUs(med), fmtUs(worst), float64(worst)/float64(max(med, 1)), fmtUs(excess)),
		}
		for k := int64(0); k < hits; k++ {
			if k == int64(f.th.MaxEvidenceRows) {
				x.Evidence = append(x.Evidence, row("...", fmt.Sprintf("%d more outlier executions", hits-k)))
				break
			}
			e := &ea.top[k]
			cur := &f.m.Cursors[e.cursor]
			v := fmt.Sprintf("%s  %d rows  %d disk  %d fetches  cursor at line %d", fmtUs(e.elapsed), e.rows, e.disk, e.nFetch, cur.Line)
			r := stmtRow(s.ID, fmt.Sprintf("exec %d", e.execNo), v)
			r.Cursor, r.ExecNo, r.Call, r.Line, r.Us = e.cursor, e.execNo, model.None, int(e.line), e.elapsed
			x.Evidence = append(x.Evidence, r)
		}
		f.add(x)
	}
}

// smallFetchesAgg is the body of smallFetches() for one statement (the
// caller checked the statement-level thresholds) over the execution aggregates.
func (f *finder) smallFetchesAgg(s *StmtStats) {
	ea := f.execAgg(s.ID)
	if ea == nil || ea.smallFetches <= f.th.SmallFetchMinFetches || ea.smallRows <= f.th.SmallFetchMinRows {
		return
	}
	nEx, fetches, rows, impact := ea.smallN, ea.smallFetches, ea.smallRows, ea.smallImpact
	first := &ea.smallFirst
	avg := float64(rows) / float64(fetches)
	x := Finding{Rule: RuleSmallFetches, Title: "Small fetches", Statement: s.ID, ImpactUs: impact, Severity: f.timeSeverity(impact, f.total),
		Summary: fmt.Sprintf("%s: %.1f rows per fetch; %d fetches, %d rows in %d of %d executions; %s in these fetches and preceding round trips",
			f.label(s.ID), avg, fetches, rows, nEx, ea.n, fmtUs(impact))}
	x.Evidence = append(x.Evidence,
		stmtRow(s.ID, "small-fetch executions", fmt.Sprintf("%d of %d (at least %d fetches, under %g rows per fetch)", nEx, ea.n, f.th.SmallFetchMinFetchesPerExec, f.th.SmallFetchRows)),
		stmtRow(s.ID, "fetches / rows", fmt.Sprintf("%d / %d (%.1f rows per fetch)", fetches, rows, avg)),
		stmtRow(s.ID, "whole statement", fmt.Sprintf("%d fetches / %d rows (%.1f rows per fetch)", s.Fetch.Count, s.Fetch.Rows, float64(s.Fetch.Rows)/float64(s.Fetch.Count))),
	)
	r := stmtRow(s.ID, fmt.Sprintf("exec %d", first.execNo), fmt.Sprintf("first: %d fetches, %d rows, %s", first.nFetch, first.rows, fmtUs(first.elapsed)))
	r.Cursor, r.ExecNo, r.Call, r.Line, r.Us = first.cursor, first.execNo, model.None, int(first.line), first.elapsed
	x.Evidence = append(x.Evidence, r)
	f.add(x)
}
