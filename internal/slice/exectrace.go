package slice

import (
	"context"
	"net/url"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// ---- /api/executions/trace -------------------------------------------------------
//
// The raw rows of one execution for the Execution Loom (web/src/lib/data/exectrace.ts
// builds the same shape from the document's fact columns): the own calls (the
// PARSE right before the EXEC, the EXEC, its FETCHes), their recursive calls and
// the waits of both, in trace order. No derived numbers.
//
// The reads are bounded to the execution, also over a spill: recursive calls
// complete before their parent, so the children of an own call are the deeper
// rows of its context right before it (walking back to the previous call at the
// same depth or above), and its waits are the wait rows of the context between
// that call's line and its own.

// Limits of one answer (a FETCH with millions of recursive calls); Truncated says so.
const (
	maxTraceChildren = 50_000
	maxTraceWaits    = 200_000
)

// TraceCall is one call of an execution trace (counters inclusive, as recorded).
type TraceCall struct {
	ID     model.ID `json:"id"`
	Owner  model.ID `json:"owner"` // the own call it rolls up to (itself for an own call)
	Parent model.ID `json:"parent"`
	Line   int32    `json:"line"`
	Ctx    model.ID `json:"ctx"`
	Kind   int      `json:"kind"`
	Cursor model.ID `json:"cursor"`
	Stmt   model.ID `json:"stmt"`
	Dep    uint8    `json:"dep"`
	ExecNo int32    `json:"execNo"`
	C      int64    `json:"c"`
	E      int64    `json:"e"`
	P      int64    `json:"p"`
	CR     int64    `json:"cr"`
	CU     int64    `json:"cu"`
	R      int64    `json:"r"`
	Tim    int64    `json:"tim"`
	SelfE  int64    `json:"selfE"`
	PLH    uint32   `json:"plh"`
}

// TraceWait is one WAIT line of an execution trace.
type TraceWait struct {
	ID      model.ID `json:"id"`
	Call    model.ID `json:"call"`
	Owner   model.ID `json:"owner"`
	Line    int32    `json:"line"`
	Ctx     model.ID `json:"ctx"`
	Event   model.ID `json:"event"`
	Ela     int64    `json:"ela"`
	P1      int64    `json:"p1"`
	P2      int64    `json:"p2"`
	P3      int64    `json:"p3"`
	Obj     int64    `json:"obj"`
	Tim     int64    `json:"tim"`
	Dep     uint8    `json:"dep"`
	Between bool     `json:"between"`
}

// ExecTraceResponse is the answer of /api/executions/trace.
type ExecTraceResponse struct {
	Calls     []TraceCall `json:"calls"`
	Children  []TraceCall `json:"children"`
	Waits     []TraceWait `json:"waits"`
	Truncated bool        `json:"truncated"`
}

func traceCall(c *model.Call, owner model.ID) TraceCall {
	return TraceCall{ID: c.ID, Owner: owner, Parent: c.Parent, Line: c.Line, Ctx: c.Context, Kind: int(c.Kind), Cursor: c.Cursor, Stmt: c.Statement,
		Dep: c.Dep, ExecNo: c.ExecNo, C: c.C, E: c.E, P: c.P, CR: c.CR, CU: c.CU, R: c.R, Tim: c.Tim, SelfE: c.SelfE, PLH: c.PLH}
}

func (s *Server) executionTrace(ctx context.Context, q url.Values) (any, error) {
	sp, err := s.stmtParam(q)
	if err != nil {
		return nil, err
	}
	if sp == nil {
		return nil, bad("stmt: required")
	}
	cur, err := intParam(q, "cursor", -1, 0, int64(len(s.m.Cursors))-1)
	if err != nil {
		return nil, err
	}
	if cur < 0 {
		return nil, bad("cursor: required")
	}
	no, err := intParam(q, "execNo", 0, 1, 1<<31-1)
	if err != nil {
		return nil, err
	}
	own, ok, err := analyze.ExecutionCallsOn(ctx, s.src, *sp, model.ID(cur), int32(no))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, bad("no execution #%d of cursor %d in statement %d", no, cur, *sp)
	}
	return ExecutionTrace(ctx, s.src, own)
}

// ExecutionTrace collects the recursive calls and the waits of the own calls of
// one execution (analyze.ExecutionCallsOn) from src.
func ExecutionTrace(ctx context.Context, src FactSource, own []model.Call) (*ExecTraceResponse, error) {
	r := &ExecTraceResponse{Calls: make([]TraceCall, 0, len(own)), Children: []TraceCall{}, Waits: []TraceWait{}}
	owner := make(map[model.ID]model.ID, len(own))
	for i := range own {
		owner[own[i].ID] = own[i].ID
	}
	for i := range own {
		o := &own[i]
		r.Calls = append(r.Calls, traceCall(o, o.ID))
		calls, waits := src.RowsOfContext(o.Context)
		// recursive calls: deeper rows of the context right before the call; a
		// child's own children come before it, so walking back meets the parent first
		var lowLine int32 // waits of the call come after this line
		for row := int64(o.ID) - 1; row >= calls.lo; row-- {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			c, ok := src.CallAt(row)
			if !ok {
				break
			}
			if c.Context != o.Context {
				continue
			}
			if c.Dep <= o.Dep {
				lowLine = c.Line
				break
			}
			if top, in := owner[c.Parent]; in {
				if len(r.Children) >= maxTraceChildren {
					r.Truncated = true
					break
				}
				owner[c.ID] = top
				r.Children = append(r.Children, traceCall(&c, top))
			}
		}
		// waits: rows of the context with lowLine < line <= o.Line (one file per context, lines ascending)
		n := int(waits.hi - waits.lo)
		if n <= 0 {
			continue
		}
		first := waits.lo + int64(sort.Search(n, func(k int) bool {
			w, ok := src.WaitAt(waits.lo + int64(k))
			return !ok || w.Line > lowLine
		}))
		for row := first; row < waits.hi; row++ {
			w, ok := src.WaitAt(row)
			if !ok || w.Line > o.Line {
				break
			}
			if w.Context != o.Context {
				continue
			}
			top, in := owner[w.Call]
			if !in {
				continue
			}
			if len(r.Waits) >= maxTraceWaits {
				r.Truncated = true
				break
			}
			r.Waits = append(r.Waits, TraceWait{ID: w.ID, Call: w.Call, Owner: top, Line: w.Line, Ctx: w.Context, Event: w.Event, Ela: w.Ela,
				P1: w.P1, P2: w.P2, P3: w.P3, Obj: w.ObjID, Tim: w.Tim, Dep: w.Dep, Between: w.Between})
		}
	}
	sort.Slice(r.Children, func(i, j int) bool { return r.Children[i].ID < r.Children[j].ID })
	sort.Slice(r.Waits, func(i, j int) bool { return r.Waits[i].ID < r.Waits[j].ID })
	return r, nil
}
