package cut

import (
	"context"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// CheckFull is Check with the cut parsed back by a full build, as Check did
// before it took an aggregation-only build: TestCheckAggregateEqualsFull
// compares the two.
func (c *Cutter) CheckFull(ctx context.Context, sel Selection, dir string) (*Check, error) {
	return c.check(ctx, sel, dir, 0, parseFull)
}

// NewCheckSink is the sink of the check's aggregation-only build (the
// benchmarks build with it themselves to measure the heap it keeps).
func NewCheckSink(m *model.Model) model.Sink { return newCheckSink(m) }

// SetCheckHook sets the hook the check sink runs after every call (nil: none).
func SetCheckHook(f func()) { checkHook = f }

// parseFull is what a check compares of a full build of the cut.
func parseFull(_ context.Context, path string) (*parsed, error) {
	m, err := model.Build(path, model.Options{})
	if err != nil {
		return nil, err
	}
	keys := stmtKeys(m)
	out := &parsed{calls: map[stmtKind]*count{}, statements: len(m.Statements), bindSets: len(m.BindSets), plans: len(m.Plans),
		unknownLines: m.Diag.UnknownLines, unknown: unknownKeys(m, keys)}
	for i := range m.Calls {
		cl := &m.Calls[i]
		k := stmtKind{stmtKeyOf(keys, cl.Statement), cl.Kind}
		g := out.calls[k]
		if g == nil {
			g = &count{}
			out.calls[k] = g
		}
		g.n++
		g.us += cl.E
		out.nCalls++
		if w := m.CallWall(cl); w != 0 && (out.first == 0 || w < out.first) {
			out.first = w
		}
	}
	for i := range m.Waits {
		out.waits.n++
		out.waits.us += m.Waits[i].Ela
	}
	return out, nil
}
