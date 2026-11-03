package slice

import (
	"context"
	"net/url"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
)

// Rows of one /api/io/map answer.
const (
	DefaultIOMapRows = 20000
	MaxIOMapRows     = 200000
)

// ioMap answers GET /api/io/map?limit=N (+ from, to, contexts, stmt, event):
// the physical I/O waits with a block address in scope (analyze.IOMapOn),
// rows [tim, ela, event, file, block, blocks, obj, stmt, call, line, ctx,
// dep] in trace order; above limit every k-th, k = ceil(total/limit), with
// total, files and events over all of them. idle is accepted and changes
// nothing: block I/O is never idle.
func (s *Server) ioMap(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", DefaultIOMapRows, 1, MaxIOMapRows)
	if err != nil {
		return nil, err
	}
	return analyze.IOMapOn(ctx, s.src, f, s.blockEvents, s.countP3, int(limit))
}
