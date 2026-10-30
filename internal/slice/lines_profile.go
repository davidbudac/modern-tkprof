package slice

import (
	"context"
	"net/url"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// maxProfileBuckets bounds ?buckets= of /api/lines/profile.
const maxProfileBuckets = 2000

// linesProfile is the answer of /api/lines/profile: the file cut into Buckets
// runs of Size lines (the last one may be shorter or, when Size does not
// divide Total, a few trailing buckets are empty), with per bucket the number
// of calls, waits, cursor parses, errors and commits whose line lies in it.
type linesProfile struct {
	Total    int   `json:"total"`
	Buckets  int   `json:"buckets"`
	Size     int   `json:"size"`
	Calls    []int `json:"calls"`
	Waits    []int `json:"waits"`
	Cursors  []int `json:"cursors"`
	Errors   []int `json:"errors"`
	Commits  []int `json:"commits"`
	MaxCalls int   `json:"maxCalls"`
	MaxWaits int   `json:"maxWaits"`
}

// linesProfileOf answers /api/lines/profile?file=&buckets=N (N 1..2000,
// default 200). Bucket i covers the lines [i*size+1, min(total, (i+1)*size)]
// with size = ceil(total/buckets); a file shorter than N lines gets one bucket
// per line. The counts come from B+1 binary searches per fact table at the
// bucket edges (the number of rows with Line <= edge, differenced between
// neighbouring edges) and from sort.Search on the sorted per-file lists, so
// the cost does not depend on the size of the file.
func (s *Server) linesProfile(_ context.Context, q url.Values) (any, error) {
	_, li, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	n64, err := intParam(q, "buckets", 200, 1, maxProfileBuckets)
	if err != nil {
		return nil, err
	}
	total := li.Lines()
	p := linesProfile{Total: total, Calls: []int{}, Waits: []int{}, Cursors: []int{}, Errors: []int{}, Commits: []int{}}
	if total <= 0 {
		p.Total = 0
		return p, nil
	}
	b := min(int(n64), total)
	size := (total + b - 1) / b
	p.Buckets, p.Size = b, size
	// edge k is the last line of bucket k-1 (edge 0: before the first line)
	edge := func(k int) int { return min(total, k*size) }

	// rowsUpTo[k]: how many rows of the range have Line <= edge(k)
	rowsUpTo := func(rg rowRange, calls bool) ([]int64, error) {
		out := make([]int64, b+1)
		for k := range out {
			if rg.hi <= rg.lo {
				out[k] = 0
				continue
			}
			past := edge(k)
			var i int64
			var err error
			if calls {
				i, err = s.firstCall(rg, func(c *model.Call) bool { return int(c.Line) > past })
			} else {
				i, err = s.firstWait(rg, func(w *model.Wait) bool { return int(w.Line) > past })
			}
			if err != nil {
				return nil, err
			}
			out[k] = i - rg.lo
		}
		return out, nil
	}
	diff := func(up []int64) ([]int, int) {
		out, mx := make([]int, b), 0
		for i := range out {
			out[i] = int(up[i+1] - up[i])
			mx = max(mx, out[i])
		}
		return out, mx
	}
	up, err := rowsUpTo(f.calls, true)
	if err != nil {
		return nil, err
	}
	p.Calls, p.MaxCalls = diff(up)
	if up, err = rowsUpTo(f.waits, false); err != nil {
		return nil, err
	}
	p.Waits, p.MaxWaits = diff(up)

	count := func(list []lineID) []int {
		out := make([]int, b)
		prev := sort.Search(len(list), func(i int) bool { return list[i].line > edge(0) })
		for i := range out {
			next := sort.Search(len(list), func(j int) bool { return list[j].line > edge(i+1) })
			out[i] = next - prev
			prev = next
		}
		return out
	}
	p.Cursors, p.Errors, p.Commits = count(f.cursors), count(f.errors), count(f.commits)
	return p, nil
}
