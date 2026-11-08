package slice

import (
	"context"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
)

// Rows of one /api/io/map answer.
const (
	DefaultIOMapRows = 20000
	MaxIOMapRows     = 200000
)

// ioMap answers GET /api/io/map?limit=N&reads=0|1 (+ from, to, contexts,
// stmt, event): the physical I/O waits with a block address in scope
// (analyze.IOMapWith), rows [tim, ela, event, file, block, blocks, obj, stmt,
// call, line, ctx, dep] in trace order; above limit every k-th, k =
// ceil(total/limit), with total, files and events over all of them. reads=1
// adds reads (per row, the reads of its most read block over every match)
// and readsExact. idle is accepted and changes nothing: block I/O is never
// idle.
func (s *Server) ioMap(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", DefaultIOMapRows, 1, MaxIOMapRows)
	if err != nil {
		return nil, err
	}
	reads, err := boolParam(q, "reads")
	if err != nil {
		return nil, err
	}
	return analyze.IOMapWith(ctx, s.src, f, s.ioEvents, int(limit), analyze.IOMapOpts{Reads: reads})
}

// ioHot answers GET /api/io/hot?limit=N&sort=rereads|max|us (+ from, to,
// contexts, stmt, event): the block reads of every block I/O wait in scope
// counted per block, the hottest blocks as runs of adjacent blocks, and the
// exact numbers per object and per statement and file (analyze.IOHotOn).
func (s *Server) ioHot(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", analyze.DefaultHotRuns, 1, analyze.MaxHotRuns)
	if err != nil {
		return nil, err
	}
	sort := q.Get("sort")
	if sort != "" && !slices.Contains(analyze.HotSorts, sort) {
		return nil, bad("sort: %q (want %s)", sort, strings.Join(analyze.HotSorts, ", "))
	}
	return analyze.IOHotOn(ctx, s.src, f, s.ioEvents, analyze.IOHotOpts{Limit: int(limit), Sort: sort})
}

// ioDensity answers GET /api/io/density (+ from, to, contexts, stmt, event):
// every block I/O wait in scope counted into the cells of the I/O map's
// panels (analyze.IODensityOn). x=order|time; xs=a.b.n,a.b.n… the x bins
// (order: match indices [a, b), time: tim µs [a, b); absent: xbins bins over
// the scope); p=key:file.lo.hi.n,file.lo.hi.n… one panel per p (keys f<file>,
// o<obj>, t<file>, n<file>, rest; absent: one per file with ybins bins).
func (s *Server) ioDensity(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return nil, err
	}
	var r analyze.IODensityReq
	r.X = q.Get("x")
	xbins, err := intParam(q, "xbins", 0, 1, analyze.MaxDensityXBins)
	if err != nil {
		return nil, err
	}
	ybins, err := intParam(q, "ybins", 0, 1, analyze.MaxDensityYBins)
	if err != nil {
		return nil, err
	}
	r.XBins, r.YBins = int(xbins), int(ybins)
	if v := q.Get("xs"); v != "" {
		for _, part := range strings.Split(v, ",") {
			n, err := numbers(part, 3)
			if err != nil {
				return nil, bad("xs: %q: %v", part, err)
			}
			r.XSegs = append(r.XSegs, [3]int64{n[0], n[1], n[2]})
		}
	}
	for _, v := range q["p"] {
		key, segs, ok := strings.Cut(v, ":")
		if !ok || segs == "" {
			return nil, bad("p: %q (want key:file.lo.hi.bins,…)", v)
		}
		p := analyze.IODensityPanelReq{Key: key}
		for _, part := range strings.Split(segs, ",") {
			n, err := numbers(part, 4)
			if err != nil {
				return nil, bad("p %s: %q: %v", key, part, err)
			}
			p.Segs = append(p.Segs, [4]int64{n[0], n[1], n[2], n[3]})
		}
		r.Panels = append(r.Panels, p)
	}
	if err := analyze.CheckDensityReq(r); err != nil {
		return nil, bad("%v", err)
	}
	return analyze.IODensityOn(ctx, s.src, f, s.ioEvents, r)
}

// numbers reads n integers separated by dots.
func numbers(s string, n int) ([]int64, error) {
	parts := strings.Split(s, ".")
	if len(parts) != n {
		return nil, badRequest("want " + strconv.Itoa(n) + " integers separated by dots")
	}
	out := make([]int64, n)
	for i, p := range parts {
		v, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return nil, badRequest(strconv.Quote(p) + " is not an integer")
		}
		out[i] = v
	}
	return out, nil
}
