// Package slice answers the UI's group-by and detail queries from the fact
// tables of a model.Model, so `mtkprof serve -facts=false` keeps the browser
// free of millions of fact rows (docs/ARCHITECTURE.md § Server-side slicing).
//
// Every endpoint is a GET returning JSON, bounded (limit caps, a 400 with a
// plain-text reason on a bad parameter) and read-only. The model must not be
// modified after New.
//
//	/api/pivot           analyze.Pivot with the UI's dimensions and measures
//	/api/timeline        CPU and waits per time bucket and event
//	/api/calls           the longest calls in scope (Timeline swimlanes)
//	/api/executions      the executions of one statement, with binds
//	/api/executions/detail  one execution taken apart (A/B comparison)
//	/api/waits           wait rows (slowest or earliest)
//	/api/waits/hist      log2 histogram of wait durations
//	/api/waits/scatter   sampled waits over time
//	/api/waits/by        wait time by statement, object, p1 or p2 (real keys)
//	/api/profile         CPU and waits per event in scope
//	/api/statements      the document's statement table over the scope
//	/api/findings        the document's findings over the scope
//	/api/stmt/roles      wait time per statement and wait class
//	/api/stmt/waits      top wait events of statements
//	/api/stmt/spans      merged time intervals of statements' calls (phases=1: cut by call phase)
//	/api/stmt/waitspans  stretches of statements' waits with their dominant events
//
// Common scope parameters: from, to (tim in µs, a row is in when its
// [tim-ela, tim] interval overlaps), contexts (comma separated ids), stmt,
// event (waits only) and idle=0|1 (waits; default 1).
package slice

import (
	"container/heap"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Limits of one response.
const (
	DefaultPivotRows = 1000
	MaxPivotRows     = 100000
	MaxCalls         = 20000
	MaxLongest       = 100
	MaxExecutions    = 5000
	MaxWaitRows      = 1000
	MaxScatter       = 50000
	MaxStmtList      = 200
	maxContexts      = 10000
	maxCacheEntries  = 128
	maxCacheBytes    = 4 << 20
)

// Server serves the slicing endpoints over one model and its fact source.
type Server struct {
	m   *model.Model
	src FactSource

	// AllowOrigin is the Access-Control-Allow-Origin of every answer: "" is
	// "*" (serve, and the dev server of `pnpm dev`); NoCORS sets no CORS
	// headers and leaves OPTIONS to the caller's middleware (the engine).
	AllowOrigin string

	// Thresholds are those of /api/findings (nil: analyze.DefaultThresholds),
	// the ones the document's findings were built with.
	Thresholds *analyze.Thresholds

	mu    sync.Mutex
	cache map[string][]byte // GET query -> response body
	order []string

	lis      []*trace.LineIndex // WithLines
	fileOnce sync.Once
	fileInfo []fileInfo
}

// NoCORS is the Server.AllowOrigin that turns the server's own CORS handling off.
const NoCORS = "-"

// New returns the server for a model that holds its fact rows.
func New(m *model.Model) *Server { return NewServer(m, MemSource(m)) }

// NewServer returns the server for the dimension tables of m and the fact
// rows of src (the spilled rows of an aggregation-only model, see Spill).
func NewServer(m *model.Model, src FactSource) *Server {
	return &Server{m: m, src: src, cache: map[string][]byte{}}
}

// Close releases the fact source (the spill files are removed).
func (s *Server) Close() error { return s.src.Close() }

type badRequest string

func (e badRequest) Error() string { return string(e) }

func bad(format string, a ...any) error { return badRequest(fmt.Sprintf(format, a...)) }

// Handler returns the mux of the endpoints; CORS is open like /api/doc (the
// dev server of `pnpm dev` loads the document from this one). With WithLines
// set it also serves /api/lines (incl. annot=1 and annot=2), /api/lines/at, /api/lines/next, /api/lines/profile,
// /api/at and /api/search.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for path, fn := range s.routes() {
		mux.HandleFunc(path, s.wrap(fn))
	}
	if s.lis != nil { // the endpoints that read the trace text (WithLines)
		mux.Handle("/api/lines", s.cors(linesHandler(s.lis, s.serveAnnotated2)))
		mux.Handle("/api/search", s.cors(http.HandlerFunc(s.search)))
	}
	return mux
}

// Endpoints are the JSON query paths Handler always serves (GET), sorted;
// the line endpoints (WithLines) are listed by LineEndpoints.
func Endpoints() []string {
	var out []string
	for path := range (&Server{}).routes() {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

// LineEndpoints are the paths Handler serves in addition when WithLines is set.
func LineEndpoints() []string {
	return []string{"/api/at", "/api/lines", "/api/lines/at", "/api/lines/next", "/api/lines/profile", "/api/search"}
}

func (s *Server) routes() map[string]func(context.Context, url.Values) (any, error) {
	routes := map[string]func(context.Context, url.Values) (any, error){
		"/api/pivot":             s.pivot,
		"/api/timeline":          s.timeline,
		"/api/calls":             s.calls,
		"/api/executions":        s.executions,
		"/api/executions/detail": s.executionDetail,
		"/api/waits":             s.waits,
		"/api/waits/hist":        s.waitHist,
		"/api/waits/scatter":     s.waitScatter,
		"/api/waits/by":          s.waitsBy,
		"/api/profile":           s.profile,
		"/api/statements":        s.statements,
		"/api/findings":          s.findings,
		"/api/stmt/roles":        s.stmtRoles,
		"/api/stmt/waits":        s.stmtWaits,
		"/api/stmt/spans":        s.stmtSpans,
		"/api/stmt/waitspans":    s.stmtWaitSpans,
		"/api/plan":              s.plan,
	}
	if s.lis != nil {
		routes["/api/lines/at"] = s.linesAt
		routes["/api/lines/next"] = s.linesNext
		routes["/api/lines/profile"] = s.linesProfile
		routes["/api/at"] = s.at
	}
	return routes
}

func (s *Server) wrap(fn func(context.Context, url.Values) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.AllowOrigin != NoCORS {
			origin := s.AllowOrigin
			if origin == "" {
				origin = "*"
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "*")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "GET only", http.StatusMethodNotAllowed)
			return
		}
		key := r.URL.Path + "?" + r.URL.RawQuery
		body, ok := s.cached(key)
		if !ok {
			v, err := fn(r.Context(), r.URL.Query())
			if err != nil {
				var br badRequest
				var nf notFound
				if errors.As(err, &br) {
					http.Error(w, br.Error(), http.StatusBadRequest)
				} else if errors.As(err, &nf) {
					http.Error(w, nf.Error(), http.StatusNotFound)
				} else {
					http.Error(w, err.Error(), http.StatusInternalServerError)
				}
				return
			}
			var merr error
			body, merr = json.Marshal(v)
			if merr != nil {
				http.Error(w, merr.Error(), http.StatusInternalServerError)
				return
			}
			s.store(key, body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	}
}

// cors wraps a handler that does not go through wrap with the same CORS
// handling (AllowOrigin) and the GET-only rule.
func (s *Server) cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.AllowOrigin != NoCORS {
			origin := s.AllowOrigin
			if origin == "" {
				origin = "*"
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "*")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "GET only", http.StatusMethodNotAllowed)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (s *Server) cached(key string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.cache[key]
	return b, ok
}

func (s *Server) store(key string, body []byte) {
	if len(body) > maxCacheBytes {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.cache[key]; ok {
		return
	}
	if len(s.order) >= maxCacheEntries {
		delete(s.cache, s.order[0])
		s.order = s.order[1:]
	}
	s.cache[key] = body
	s.order = append(s.order, key)
}

// ---- parameters --------------------------------------------------------------

func intParam(q url.Values, name string, def, min, max int64) (int64, error) {
	v := q.Get(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, bad("%s: %q is not an integer", name, v)
	}
	if n < min || n > max {
		return 0, bad("%s: %d is out of range %d..%d", name, n, min, max)
	}
	return n, nil
}

func idList(q url.Values, name string, n int, max int) ([]model.ID, error) {
	v := q.Get(name)
	if v == "" {
		return nil, nil
	}
	parts := strings.Split(v, ",")
	if len(parts) > max {
		return nil, bad("%s: at most %d ids", name, max)
	}
	out := make([]model.ID, 0, len(parts))
	for _, p := range parts {
		x, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || x < 0 || x >= n {
			return nil, bad("%s: %q is not a valid id (0..%d)", name, p, n-1)
		}
		out = append(out, model.ID(x))
	}
	return out, nil
}

func (s *Server) stmtParam(q url.Values) (*model.ID, error) {
	if q.Get("stmt") == "" {
		return nil, nil
	}
	ids, err := idList(q, "stmt", len(s.m.Statements), 1)
	if err != nil {
		return nil, err
	}
	return &ids[0], nil
}

// NoContexts is the value of `contexts` that selects no session context at all
// (an empty `contexts=` means all of them): every scoped endpoint then sees no
// row.
const NoContexts = "-"

// scope reads the scope parameters from, to, contexts and idle.
func (s *Server) scope(q url.Values) (analyze.Filter, error) {
	var f analyze.Filter
	var err error
	if f.StartTim, err = intParam(q, "from", 0, 0, 1<<62); err != nil {
		return f, err
	}
	if f.EndTim, err = intParam(q, "to", 0, 0, 1<<62); err != nil {
		return f, err
	}
	if f.EndTim != 0 && f.EndTim < f.StartTim {
		return f, bad("to: %d is before from: %d", f.EndTim, f.StartTim)
	}
	if q.Get("contexts") == NoContexts {
		f.NoContexts = true
	} else if f.Contexts, err = idList(q, "contexts", len(s.m.Contexts), maxContexts); err != nil {
		return f, err
	}
	f.IncludeIdle = true
	if v := q.Get("idle"); v != "" {
		switch v {
		case "0":
			f.IncludeIdle = false
		case "1":
		default:
			return f, bad("idle: %q (want 0 or 1)", v)
		}
	}
	return f, nil
}

// filter reads the scope parameters and the row selectors: stmt (one id) and,
// when forWaits, event (calls reject an event).
func (s *Server) filter(q url.Values, forWaits bool) (analyze.Filter, error) {
	f, err := s.scope(q)
	if err != nil {
		return f, err
	}
	if f.Statement, err = s.stmtParam(q); err != nil {
		return f, err
	}
	if q.Get("event") != "" {
		if !forWaits {
			return f, bad("event: only applies to waits")
		}
		ids, err := idList(q, "event", len(s.m.Events), 1)
		if err != nil {
			return f, err
		}
		f.Event = &ids[0]
	}
	return f, nil
}

// ---- /api/pivot ----------------------------------------------------------------

// PivotResponse is the pivot with every group counted and the rows capped.
type PivotResponse struct {
	*analyze.PivotResult
	Groups    int  `json:"groups"`    // groups before the row cap
	Truncated bool `json:"truncated"` // Rows holds only the first `limit` groups
}

func (s *Server) pivot(ctx context.Context, q url.Values) (any, error) {
	fact, err := analyze.ParseFact(q.Get("fact"))
	if err != nil {
		return nil, bad("%v", err)
	}
	if q.Get("by") == "" {
		return nil, bad("by: no dimension given (have %s)", dimList(fact))
	}
	by := strings.Split(q.Get("by"), ",")
	f, err := s.filter(q, fact == analyze.FactWaits)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", DefaultPivotRows, 1, MaxPivotRows)
	if err != nil {
		return nil, err
	}
	var measures []string
	if v := q.Get("measure"); v != "" {
		measures = strings.Split(v, ",")
		for _, id := range measures {
			if analyze.MeasureIndex(fact, id) < 0 {
				return nil, bad("measure: unknown %s measure %q", fact, id)
			}
		}
	}
	r, err := analyze.PivotOn(ctx, s.m, s.src, fact, by, f)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, bad("%v", err)
	}
	if len(measures) > 0 {
		if err := r.SortBy(measures[0]); err != nil {
			return nil, bad("%v", err)
		}
		r.Project(measures)
	}
	resp := &PivotResponse{PivotResult: r, Groups: len(r.Rows)}
	if len(r.Rows) > int(limit) {
		r.Rows = r.Rows[:limit]
		resp.Truncated = true
	}
	return resp, nil
}

func dimList(f analyze.Fact) string {
	var ids []string
	for _, d := range analyze.Dims(f) {
		ids = append(ids, d.ID)
	}
	return strings.Join(ids, ",")
}

// ---- /api/timeline -------------------------------------------------------------

func (s *Server) timeline(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return nil, err
	}
	if f.Event != nil {
		return nil, bad("event: not supported by timeline")
	}
	bucket, err := intParam(q, "bucket", analyze.TimelineBucket(s.m), 1, 1<<62)
	if err != nil {
		return nil, err
	}
	out, err := analyze.SpreadTimelineOn(ctx, s.m, s.src, bucket, f)
	if err != nil {
		return nil, err
	}
	if out == nil {
		if s.m.Span.Us() <= 0 {
			return &analyze.SpanSeries{BucketUs: bucket, CPU: []float64{}, Events: []analyze.EventSeries{}}, nil
		}
		return nil, bad("bucket: %d µs gives more than %d buckets for this trace", bucket, analyze.MaxBuckets)
	}
	if out.Events == nil {
		out.Events = []analyze.EventSeries{}
	}
	return out, nil
}

// ---- /api/calls ----------------------------------------------------------------

// CallRows lists calls as arrays in the order of Cols.
type CallRows struct {
	Total   int64     `json:"total"`   // calls with a time stamp in scope
	Sampled bool      `json:"sampled"` // Rows holds only the longest `limit`
	Cols    []string  `json:"cols"`
	Rows    [][]int64 `json:"rows"`
	Longest []int32   `json:"longest"` // call ids of the longest calls, longest first (subset of Rows)
}

var callCols = []string{"id", "stmt", "kind", "tim", "e", "c", "r", "line", "dep", "execNo", "ctx"}

func (s *Server) calls(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, false)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", MaxCalls, 1, MaxCalls)
	if err != nil {
		return nil, err
	}
	nlong, err := intParam(q, "longest", 20, 0, MaxLongest)
	if err != nil {
		return nil, err
	}
	calls, total, err := analyze.TopCallsOn(ctx, s.src, f, int(limit))
	if err != nil {
		return nil, err
	}
	out := &CallRows{Total: total, Sampled: total > int64(len(calls)), Cols: callCols, Rows: make([][]int64, 0, len(calls))}
	for i := range calls {
		if i >= int(nlong) {
			break
		}
		out.Longest = append(out.Longest, int32(calls[i].ID))
	}
	sort.Slice(calls, func(a, b int) bool { return calls[a].ID < calls[b].ID })
	for i := range calls {
		c := &calls[i]
		out.Rows = append(out.Rows, []int64{int64(c.ID), int64(c.Statement), int64(c.Kind), c.Tim, c.E, c.C, c.R, int64(c.Line), int64(c.Dep), int64(c.ExecNo), int64(c.Context)})
	}
	return out, nil
}

// ---- /api/executions -----------------------------------------------------------

// BindRow is one bind value of an execution.
type BindRow struct {
	Pos    int32  `json:"pos"`
	Type   string `json:"type"`
	Value  string `json:"value"`
	IsNull bool   `json:"isNull"`
	NoDef  bool   `json:"noDef"`
	Dump   bool   `json:"dump"`
	Mal    int32  `json:"mal"`
	Kind   string `json:"kind"`
	Typed  string `json:"typed,omitempty"`
}

func (s *Server) bindsOf(set model.ID) []BindRow {
	binds := s.src.Binds(set)
	if binds == nil {
		return nil
	}
	out := make([]BindRow, 0, len(binds))
	for i := range binds {
		b := &binds[i]
		out = append(out, BindRow{Pos: b.Pos, Type: b.TypeName(), Value: b.Value, IsNull: b.IsNull, NoDef: b.NoDef, Dump: b.IsDump, Mal: b.Mal, Kind: b.Kind().String(), Typed: b.Typed()})
	}
	return out
}

// ExecRow is one execution (EXEC plus its FETCHes) of a statement.
type ExecRow struct {
	Line     int32     `json:"line"`
	Cursor   model.ID  `json:"cursor"`
	ExecNo   int32     `json:"execNo"`
	Exec     model.ID  `json:"exec"`
	Fetches  int       `json:"fetches"`
	StartTim int64     `json:"startTim"`
	EndTim   int64     `json:"endTim"`
	E        int64     `json:"e"`
	C        int64     `json:"c"`
	P        int64     `json:"p"`
	CR       int64     `json:"cr"`
	CU       int64     `json:"cu"`
	R        int64     `json:"r"`
	WaitEla  int64     `json:"waitEla"`
	IdleEla  int64     `json:"idleEla"`
	BindSet  model.ID  `json:"bindSet"`
	Ctx      model.ID  `json:"ctx"`
	Binds    []BindRow `json:"binds"`
}

// ExecResponse is a page of the executions of one statement.
type ExecResponse struct {
	Stmt    model.ID  `json:"stmt"`
	Total   int       `json:"total"`
	Offset  int       `json:"offset"`
	AvgE    float64   `json:"avgE"`
	Slowest *ExecRow  `json:"slowest"` // without binds
	Rows    []ExecRow `json:"rows"`
}

func (s *Server) execRow(e *analyze.ExecInfo, binds bool) ExecRow {
	r := ExecRow{
		Line: e.Line, Cursor: e.Cursor, ExecNo: e.ExecNo, Exec: e.Exec, Fetches: e.NumFetches,
		StartTim: e.StartTim, EndTim: e.EndTim, E: e.Stats.Elapsed, C: e.Stats.CPU, P: e.Stats.Disk, CR: e.Stats.Query,
		CU: e.Stats.Current, R: e.Stats.Rows, WaitEla: e.Stats.Waits, IdleEla: e.Stats.Idle, BindSet: e.BindSet, Ctx: e.Context,
	}
	if binds {
		r.Binds = s.bindsOf(e.BindSet)
		if r.Binds == nil {
			r.Binds = []BindRow{}
		}
	}
	return r
}

var execSorts = map[string]func(e *analyze.ExecInfo) int64{
	"e":       func(e *analyze.ExecInfo) int64 { return e.Stats.Elapsed },
	"c":       func(e *analyze.ExecInfo) int64 { return e.Stats.CPU },
	"waitEla": func(e *analyze.ExecInfo) int64 { return e.Stats.Waits },
	"r":       func(e *analyze.ExecInfo) int64 { return e.Stats.Rows },
	"p":       func(e *analyze.ExecInfo) int64 { return e.Stats.Disk },
	"cr":      func(e *analyze.ExecInfo) int64 { return e.Stats.Query },
	"fetches": func(e *analyze.ExecInfo) int64 { return int64(e.NumFetches) },
	"start":   func(e *analyze.ExecInfo) int64 { return e.StartTim },
}

// maxExecWindow bounds offset+limit of /api/executions: the page is picked
// while the executions stream by, so the server holds that many.
const maxExecWindow = 100000

// execHeap keeps the best executions by a sort key (largest first, ties in
// file order); the root is the worst of them.
type execHeap struct {
	rows []analyze.ExecInfo
	key  func(e *analyze.ExecInfo) int64
}

func (h *execHeap) worse(a, b *analyze.ExecInfo) bool {
	ka, kb := h.key(a), h.key(b)
	if ka != kb {
		return ka < kb
	}
	return a.Seq > b.Seq
}
func (h *execHeap) Len() int           { return len(h.rows) }
func (h *execHeap) Less(i, j int) bool { return h.worse(&h.rows[i], &h.rows[j]) }
func (h *execHeap) Swap(i, j int)      { h.rows[i], h.rows[j] = h.rows[j], h.rows[i] }
func (h *execHeap) Push(x any)         { h.rows = append(h.rows, x.(analyze.ExecInfo)) }
func (h *execHeap) Pop() any {
	n := len(h.rows)
	v := h.rows[n-1]
	h.rows = h.rows[:n-1]
	return v
}

func (s *Server) executions(ctx context.Context, q url.Values) (any, error) {
	if q.Get("stmt") == "" {
		return nil, bad("stmt: required")
	}
	sp, err := s.stmtParam(q)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", 1000, 1, MaxExecutions)
	if err != nil {
		return nil, err
	}
	offset, err := intParam(q, "offset", 0, 0, 1<<40)
	if err != nil {
		return nil, err
	}
	sortBy := q.Get("sort")
	var key func(e *analyze.ExecInfo) int64
	if sortBy != "" && sortBy != "file" {
		if key = execSorts[sortBy]; key == nil {
			return nil, bad("sort: unknown %q (file, e, c, waitEla, r, p, cr, fetches, start)", sortBy)
		}
	}
	if offset+limit > maxExecWindow {
		return nil, bad("offset+limit: %d is above %d", offset+limit, maxExecWindow)
	}
	// One pass over the statement's calls: count, total and slowest, and the page.
	resp := &ExecResponse{Stmt: *sp, Offset: int(offset), Rows: []ExecRow{}}
	var sum int64
	var slow analyze.ExecInfo
	h := &execHeap{key: key}
	var page []analyze.ExecInfo // key == nil: the executions with Seq in [offset, offset+limit)
	f, err := s.scope(q)
	if err != nil {
		return nil, err
	}
	err = analyze.EachExecutionIn(ctx, s.m, s.src, f, *sp, func(e *analyze.ExecInfo) {
		if resp.Total == 0 || e.Stats.Elapsed > slow.Stats.Elapsed || (e.Stats.Elapsed == slow.Stats.Elapsed && e.Seq < slow.Seq) {
			slow = *e
		}
		resp.Total++
		sum += e.Stats.Elapsed
		switch {
		case key == nil:
			if e.Seq >= int(offset) && e.Seq < int(offset+limit) {
				page = append(page, *e)
			}
		case h.Len() < int(offset+limit):
			heap.Push(h, *e)
		case h.worse(&h.rows[0], e):
			h.rows[0] = *e
			heap.Fix(h, 0)
		}
	})
	if err != nil {
		return nil, err
	}
	if resp.Total == 0 {
		return resp, nil
	}
	resp.AvgE = float64(sum) / float64(resp.Total)
	sr := s.execRow(&slow, false)
	resp.Slowest = &sr
	if key != nil { // largest first; ties in file order
		page = h.rows
		sort.Slice(page, func(a, b int) bool { return h.worse(&page[b], &page[a]) })
		if int(offset) < len(page) {
			page = page[offset:]
		} else {
			page = nil
		}
	} else {
		sort.Slice(page, func(a, b int) bool { return page[a].Seq < page[b].Seq })
	}
	for i := range page {
		resp.Rows = append(resp.Rows, s.execRow(&page[i], true))
	}
	return resp, nil
}

// ExecDetailResponse is analyze.ExecDetail with its bind values.
type ExecDetailResponse struct {
	analyze.ExecDetail
	Binds []BindRow `json:"binds"`
}

func (s *Server) executionDetail(ctx context.Context, q url.Values) (any, error) {
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
	d, ok, err := analyze.ExecutionDetailOn(ctx, s.src, *sp, model.ID(cur), int32(no))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, bad("no execution #%d of cursor %d in statement %d", no, cur, *sp)
	}
	if d.Waits == nil {
		d.Waits = []analyze.WaitPart{}
	}
	if d.BindSet >= 0 {
		d.BindLine, _ = s.src.BindSetLine(d.BindSet)
	}
	b := s.bindsOf(d.BindSet)
	if b == nil {
		b = []BindRow{}
	}
	return &ExecDetailResponse{ExecDetail: d, Binds: b}, nil
}

// ---- /api/waits ----------------------------------------------------------------

// WaitRow is one wait line.
type WaitRow struct {
	Line  int32    `json:"line"`
	Tim   int64    `json:"tim"`
	Ela   int64    `json:"ela"`
	Stmt  model.ID `json:"stmt"`
	Event model.ID `json:"event"`
	P1    int64    `json:"p1"`
	P2    int64    `json:"p2"`
	P3    int64    `json:"p3"`
	Obj   int64    `json:"obj"`
	Call  model.ID `json:"call"`
	Ctx   model.ID `json:"ctx"`
	Dep   uint8    `json:"dep"`
	Flags int      `json:"flags"` // 1 = between calls, 2 = idle
}

// WaitsResponse is the wait rows in scope, capped.
type WaitsResponse struct {
	Total int64     `json:"total"`
	Us    int64     `json:"us"`
	Rows  []WaitRow `json:"rows"`
}

func (s *Server) waitScope(q url.Values) (analyze.Filter, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return f, err
	}
	if f.Event == nil && f.Statement == nil && q.Get("scope") != "all" {
		return f, bad("event or stmt: required (scope=all for every wait)")
	}
	return f, nil
}

func (s *Server) waits(ctx context.Context, q url.Values) (any, error) {
	f, err := s.waitScope(q)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", 100, 1, MaxWaitRows)
	if err != nil {
		return nil, err
	}
	byTim := false
	switch q.Get("sort") {
	case "", "ela":
	case "tim":
		byTim = true
	default:
		return nil, bad("sort: %q (want ela or tim)", q.Get("sort"))
	}
	waits, total, us, err := analyze.TopWaitsOn(ctx, s.src, f, int(limit), byTim)
	if err != nil {
		return nil, err
	}
	out := &WaitsResponse{Total: total, Us: us, Rows: make([]WaitRow, 0, len(waits))}
	for i := range waits {
		w := &waits[i]
		fl := 0
		if w.Between {
			fl |= 1
		}
		if w.Idle {
			fl |= 2
		}
		out.Rows = append(out.Rows, WaitRow{Line: w.Line, Tim: w.Tim, Ela: w.Ela, Stmt: w.Statement, Event: w.Event, P1: w.P1, P2: w.P2, P3: w.P3,
			Obj: w.ObjID, Call: w.Call, Ctx: w.Context, Dep: w.Dep, Flags: fl})
	}
	return out, nil
}

func (s *Server) waitHist(ctx context.Context, q url.Values) (any, error) {
	f, err := s.waitScope(q)
	if err != nil {
		return nil, err
	}
	h, err := analyze.WaitHistOn(ctx, s.src, f)
	if err != nil {
		return nil, err
	}
	return h, nil
}

// ScatterResponse is a sample of waits over time: rows are [tim, ela, line, stmt, ctx].
type ScatterResponse struct {
	Total   int       `json:"total"`
	Sampled bool      `json:"sampled"`
	Cols    []string  `json:"cols"`
	Rows    [][]int64 `json:"rows"`
}

func (s *Server) waitScatter(ctx context.Context, q url.Values) (any, error) {
	f, err := s.waitScope(q)
	if err != nil {
		return nil, err
	}
	max, err := intParam(q, "max", 20000, 1, MaxScatter)
	if err != nil {
		return nil, err
	}
	pts, total, err := analyze.ScatterWaitsOn(ctx, s.src, f, int(max))
	if err != nil {
		return nil, err
	}
	out := &ScatterResponse{Total: total, Sampled: total > len(pts), Cols: []string{"tim", "ela", "line", "stmt", "ctx"}, Rows: make([][]int64, 0, len(pts))}
	for _, p := range pts {
		out.Rows = append(out.Rows, []int64{p.Tim, p.Ela, int64(p.Line), int64(p.Stmt), int64(p.Ctx)})
	}
	return out, nil
}

// WaitsByResponse is the groups of /api/waits/by, largest wait time first.
type WaitsByResponse struct {
	Groups int              `json:"groups"` // groups before the cap
	Rows   []analyze.KeyAgg `json:"rows"`
}

func (s *Server) waitsBy(ctx context.Context, q url.Values) (any, error) {
	f, err := s.waitScope(q)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", 12, 1, 1000)
	if err != nil {
		return nil, err
	}
	var key func(w *model.Wait) (int64, bool)
	switch q.Get("by") {
	case "stmt":
		key = func(w *model.Wait) (int64, bool) { return int64(w.Statement), true }
	case "obj":
		key = func(w *model.Wait) (int64, bool) { return w.ObjID, w.ObjID > 0 }
	case "p1":
		key = func(w *model.Wait) (int64, bool) { return w.P1, true }
	case "p2":
		key = func(w *model.Wait) (int64, bool) { return w.P2, true }
	default:
		return nil, bad("by: %q (want stmt, obj, p1 or p2)", q.Get("by"))
	}
	rows, err := analyze.WaitsByOn(ctx, s.src, f.Scan(), f.Matcher().Wait, key)
	if err != nil {
		return nil, err
	}
	out := &WaitsByResponse{Groups: len(rows), Rows: rows}
	if len(rows) > int(limit) {
		out.Rows = rows[:limit]
	}
	if out.Rows == nil {
		out.Rows = []analyze.KeyAgg{}
	}
	return out, nil
}

// ---- /api/profile, /api/stmt/* -------------------------------------------------

func (s *Server) profile(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)
	if err != nil {
		return nil, err
	}
	p, err := analyze.ProfileOfOn(ctx, s.m, s.src, f)
	if err != nil {
		return nil, err
	}
	if p.Events == nil {
		p.Events = []analyze.EventAgg{}
	}
	return p, nil
}

// ---- /api/statements -----------------------------------------------------------

// statements is doc.stats.statements (analyze.Statements) over the scope:
// one entry per statement in id order. idle is accepted and has no effect
// (the wait times are those attributed to the calls in scope).
func (s *Server) statements(ctx context.Context, q url.Values) (any, error) {
	if q.Get("stmt") != "" {
		return nil, bad("stmt: not supported by statements")
	}
	f, err := s.filter(q, false)
	if err != nil {
		return nil, err
	}
	st, err := analyze.StatementsOn(ctx, s.m, s.src, f)
	if err != nil {
		return nil, err
	}
	return struct {
		Statements []analyze.StmtStats `json:"statements"`
	}{st}, nil
}

// ---- /api/findings -------------------------------------------------------------

// findings is doc.stats.findings (analyze.Findings) over the scope
// (analyze.FindingsOn). idle is accepted and has no effect (the idle-time
// rules always count idle waits).
func (s *Server) findings(ctx context.Context, q url.Values) (any, error) {
	if q.Get("stmt") != "" {
		return nil, bad("stmt: not supported by findings")
	}
	f, err := s.filter(q, false)
	if err != nil {
		return nil, err
	}
	th := analyze.DefaultThresholds()
	if s.Thresholds != nil {
		th = *s.Thresholds
	}
	fs, err := analyze.FindingsOnWith(ctx, s.m, s.src, f, th)
	if err != nil {
		return nil, err
	}
	return struct {
		Findings []analyze.Finding `json:"findings"`
	}{fs}, nil
}

func (s *Server) stmtRoles(ctx context.Context, q url.Values) (any, error) {
	f, err := s.scope(q)
	if err != nil {
		return nil, err
	}
	f.IncludeIdle = true // the bars count every wait, idle included, unless idle=0 is asked
	if q.Get("idle") == "0" {
		f.IncludeIdle = false
	}
	classes, rows, err := analyze.WaitsByStmtClassOn(ctx, s.m, s.src, f)
	if err != nil {
		return nil, err
	}
	flat := make([][3]int64, len(rows))
	for i, r := range rows {
		flat[i] = [3]int64{int64(r.Statement), int64(r.Class), r.Us}
	}
	if classes == nil {
		classes = []string{}
	}
	return struct {
		Classes []string   `json:"classes"`
		Rows    [][3]int64 `json:"rows"` // [statement, class index, µs]
	}{classes, flat}, nil
}

func (s *Server) stmtWaits(ctx context.Context, q url.Values) (any, error) {
	if q.Get("stmt") == "" {
		return nil, bad("stmt: required")
	}
	ids, err := idList(q, "stmt", len(s.m.Statements), MaxStmtList)
	if err != nil {
		return nil, err
	}
	max, err := intParam(q, "max", 6, 1, 50)
	if err != nil {
		return nil, err
	}
	f, err := s.scope(q)
	if err != nil {
		return nil, err
	}
	res, err := analyze.TopStmtWaitsOn(ctx, s.src, f, ids, int(max))
	if err != nil {
		return nil, err
	}
	out := make(map[string][]analyze.StmtEventWait, len(ids))
	for _, id := range ids {
		l := res[id]
		if l == nil {
			l = []analyze.StmtEventWait{}
		}
		out[strconv.Itoa(int(id))] = l
	}
	return struct {
		Waits map[string][]analyze.StmtEventWait `json:"waits"`
	}{out}, nil
}

func (s *Server) stmtSpans(ctx context.Context, q url.Values) (any, error) {
	if q.Get("stmt") == "" {
		return nil, bad("stmt: required")
	}
	ids, err := idList(q, "stmt", len(s.m.Statements), MaxStmtList)
	if err != nil {
		return nil, err
	}
	gap, err := intParam(q, "gap", 0, 0, 1<<62)
	if err != nil {
		return nil, err
	}
	f, err := s.scope(q)
	if err != nil {
		return nil, err
	}
	phases := false
	switch v := q.Get("phases"); v {
	case "", "0":
	case "1":
		phases = true
	default:
		return nil, bad("phases: %q (want 0 or 1)", v)
	}
	if phases {
		res, err := analyze.StmtPhasesOn(ctx, s.src, f, ids, gap)
		if err != nil {
			return nil, err
		}
		out := make(map[string][]analyze.PhaseSpan, len(ids))
		for _, id := range ids {
			l := res[id]
			if l == nil {
				l = []analyze.PhaseSpan{}
			}
			out[strconv.Itoa(int(id))] = l
		}
		return struct {
			Spans map[string][]analyze.PhaseSpan `json:"spans"`
		}{out}, nil
	}
	res, err := analyze.StmtSpansOn(ctx, s.src, f, ids, gap)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]analyze.Interval, len(ids))
	for _, id := range ids {
		l := res[id]
		if l == nil {
			l = []analyze.Interval{}
		}
		out[strconv.Itoa(int(id))] = l
	}
	return struct {
		Spans map[string][]analyze.Interval `json:"spans"`
	}{out}, nil
}

func (s *Server) stmtWaitSpans(ctx context.Context, q url.Values) (any, error) {
	if q.Get("stmt") == "" {
		return nil, bad("stmt: required")
	}
	ids, err := idList(q, "stmt", len(s.m.Statements), MaxStmtList)
	if err != nil {
		return nil, err
	}
	gap, err := intParam(q, "gap", 0, 0, 1<<62)
	if err != nil {
		return nil, err
	}
	f, err := s.scope(q) // idle waits follow idle=0|1, as everywhere
	if err != nil {
		return nil, err
	}
	res, err := analyze.StmtWaitSpansOn(ctx, s.src, f, ids, gap)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]analyze.WaitSpan, len(ids))
	for _, id := range ids {
		l := res[id]
		if l == nil {
			l = []analyze.WaitSpan{}
		}
		out[strconv.Itoa(int(id))] = l
	}
	return struct {
		Spans map[string][]analyze.WaitSpan `json:"spans"`
	}{out}, nil
}
