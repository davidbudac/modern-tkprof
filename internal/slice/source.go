package slice

import (
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// FactSource is where the endpoints read the fact rows from: calls and waits
// as analyze.Facts, and bind values by bind set. memSource reads the tables
// of a full model, diskSource the spill files of an aggregation-only build
// (spill.go). The endpoints do not know which one they have; the JSON is the
// same.
type FactSource interface {
	analyze.Facts
	// Binds are the binds of bind set id in position order (nil when there are none).
	Binds(set model.ID) []model.Bind
	// BindSetLine is the trace line of the BINDS block.
	BindSetLine(set model.ID) (line int, ok bool)
	// NumBindSets is the number of bind sets (ids 0..n-1).
	NumBindSets() int64
	// BindSetAt is the bind set with ID, Line, Cursor, Statement, N and IsRPC
	// set (a spill does not keep Call and First: the call that owns the set
	// is the one whose BindSet it is).
	BindSetAt(set model.ID) (model.BindSet, bool)
	// RowsOfContext are the rows of the calls and of the waits of a session
	// context: contexts are opened in file order, so the rows of one are
	// adjacent (hi <= lo: it has none). Together with CallAt / WaitAt this is
	// what finds "the call at line L of file F" by binary search.
	RowsOfContext(ctx model.ID) (calls, waits rowRange)
	// CallAt and WaitAt read one row (ID and Statement set, like EachCall).
	// Rows are in file and line order, so Line is non-decreasing within a file.
	CallAt(row int64) (model.Call, bool)
	WaitAt(row int64) (model.Wait, bool)
	// Close releases the source (the spill files are removed).
	Close() error
}

// MemSource is the FactSource of a model that holds its calls, waits and binds.
func MemSource(m *model.Model) FactSource { return &memSource{Facts: analyze.ModelFacts(m), m: m} }

type memSource struct {
	analyze.Facts
	m *model.Model

	once             sync.Once
	callCtx, waitCtx []rowRange // per context, built on first use
}

func (s *memSource) ranges() {
	s.once.Do(func() {
		for i := range s.m.Calls {
			extend(&s.callCtx, s.m.Calls[i].Context, int64(i))
		}
		for i := range s.m.Waits {
			extend(&s.waitCtx, s.m.Waits[i].Context, int64(i))
		}
	})
}

func (s *memSource) RowsOfContext(ctx model.ID) (calls, waits rowRange) {
	s.ranges()
	return ctxRows(s.callCtx, ctx), ctxRows(s.waitCtx, ctx)
}

// ctxRows is ranges[ctx], or the empty range.
func ctxRows(ranges []rowRange, ctx model.ID) rowRange {
	if ctx < 0 || int(ctx) >= len(ranges) || ranges[ctx].lo < 0 {
		return rowRange{}
	}
	return ranges[ctx]
}

func (s *memSource) CallAt(row int64) (model.Call, bool) {
	if row < 0 || row >= int64(len(s.m.Calls)) {
		return model.Call{}, false
	}
	return s.m.Calls[row], true
}

func (s *memSource) WaitAt(row int64) (model.Wait, bool) {
	if row < 0 || row >= int64(len(s.m.Waits)) {
		return model.Wait{}, false
	}
	return s.m.Waits[row], true
}

func (s *memSource) Binds(set model.ID) []model.Bind {
	m := s.m
	if set < 0 || int(set) >= len(m.BindSets) {
		return nil
	}
	bs := &m.BindSets[set]
	first, n := int(bs.First), int(bs.N)
	if first < 0 || first+n > len(m.Binds) {
		return nil
	}
	return m.Binds[first : first+n]
}

func (s *memSource) BindSetLine(set model.ID) (int, bool) {
	if set < 0 || int(set) >= len(s.m.BindSets) {
		return 0, false
	}
	return s.m.BindSets[set].Line, true
}

func (s *memSource) NumBindSets() int64 { return int64(len(s.m.BindSets)) }

func (s *memSource) BindSetAt(set model.ID) (model.BindSet, bool) {
	if set < 0 || int(set) >= len(s.m.BindSets) {
		return model.BindSet{}, false
	}
	return s.m.BindSets[set], true
}

func (*memSource) Close() error { return nil }
