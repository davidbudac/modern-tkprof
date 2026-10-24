package model

import "github.com/davidbudac/modern-tkprof/internal/trace"

// ChildRec is what the aggregation needs of a recursive call (dep > 0) until
// its parent call shows up: the parent is the next call of a lower depth, and
// a long PL/SQL block can hold millions of children back, so the pending ones
// are kept in this compact form (48 bytes) instead of as Calls.
type ChildRec struct {
	Cursor, Context ID
	Tim, E, C, R    int64
	Kind            trace.CallKind
}

// Sink receives the facts of an aggregation-only build (Options.Aggregate)
// instead of Model.Calls / Model.Waits. The builder keeps its call-stack logic
// (which waits belong to which call, which pending calls are the children of
// a call, self times) and calls the sink where it would have stored a fact:
//
//   - Call: a call is complete: waits attached, children subtracted. Parent is
//     not known (it is None); a call with Dep > 0 is announced again through
//     Child when its parent arrives. The pointer is only valid during the call.
//   - Child: the parent of a pending recursive call is known (parent != nil) or
//     will never arrive (nil: orphan, counted as top level).
//   - Wait: a wait is final: attached to call c (nil when the wait found none).
//   - Adopt: implicit cursor cur is re-pointed to statement to (called before
//     the cursor is changed); what was recorded against it moves to the statement.
//   - Finish: the build is over, Context.Parent of PX slaves is set.
//
// internal/analyze.Accumulator is the implementation.
type Sink interface {
	Call(c *Call)
	Child(ch *ChildRec, parent *Call)
	Wait(w *Wait, c *Call)
	Adopt(cur, to ID)
	Finish()
}

// CallCount is the number of calls of the trace (the fact table is empty in
// an aggregation-only build, see Options.Aggregate).
func (m *Model) CallCount() int64 {
	if m.Aggregate {
		return m.AggCalls
	}
	return int64(len(m.Calls))
}

// WaitCount is the number of wait lines of the trace.
func (m *Model) WaitCount() int64 {
	if m.Aggregate {
		return m.AggWaits
	}
	return int64(len(m.Waits))
}
