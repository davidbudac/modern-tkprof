package analyze

import (
	"context"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Scan narrows a scan of a fact table: a source may skip rows that cannot
// match (it must visit every row that does, in index order); the caller still
// applies its Matcher, so a source is free to ignore the hint.
type Scan struct {
	Statements []model.ID // only rows of these statements (nil = all)
	Contexts   []model.ID // only rows of these session contexts (nil = all)
}

// Scan returns the hint that goes with the filter.
func (f Filter) Scan() Scan {
	var s Scan
	if f.Statement != nil {
		s.Statements = []model.ID{*f.Statement}
	}
	s.Contexts = f.Contexts
	return s
}

// Facts is where the queries behind `mtkprof serve` slicing read calls and
// waits from: the model's own tables (ModelFacts) or the spill files of an
// aggregation-only build (internal/slice). Rows are visited in index order,
// c.ID / w.ID is the index and Statement is the statement of the row's
// cursor. The row passed to fn is only valid during the call.
type Facts interface {
	NumCalls() int64
	NumWaits() int64
	// EachCall calls fn for the calls of sc until fn returns false. The error
	// is the scan's own (I/O, ctx), never fn's.
	EachCall(ctx context.Context, sc Scan, fn func(c *model.Call) bool) error
	EachWait(ctx context.Context, sc Scan, fn func(w *model.Wait) bool) error
	// CallKind is the kind of call id (ok false when there is no such call).
	CallKind(id model.ID) (trace.CallKind, bool)
}

// ModelFacts is the Facts of a model that holds its calls and waits.
func ModelFacts(m *model.Model) Facts { return modelFacts{m} }

type modelFacts struct{ m *model.Model }

func (f modelFacts) NumCalls() int64 { return int64(len(f.m.Calls)) }
func (f modelFacts) NumWaits() int64 { return int64(len(f.m.Waits)) }

func (f modelFacts) EachCall(ctx context.Context, _ Scan, fn func(c *model.Call) bool) error {
	calls := f.m.Calls
	for i := range calls {
		if i&0xffff == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if !fn(&calls[i]) {
			break
		}
	}
	return nil
}

func (f modelFacts) EachWait(ctx context.Context, _ Scan, fn func(w *model.Wait) bool) error {
	waits := f.m.Waits
	for i := range waits {
		if i&0xffff == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if !fn(&waits[i]) {
			break
		}
	}
	return nil
}

func (f modelFacts) CallKind(id model.ID) (trace.CallKind, bool) {
	if id < 0 || int(id) >= len(f.m.Calls) {
		return 0, false
	}
	return f.m.Calls[id].Kind, true
}
