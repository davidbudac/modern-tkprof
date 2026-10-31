package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

// Session states. "closed" only appears in the session event of a DELETE.
const (
	SessionOpening = "opening"
	SessionReady   = "ready"
	SessionFailed  = "failed"
	SessionClosed  = "closed"
	SessionLive    = "live" // a follow session that has served a snapshot (live.go)
)

// maxPaths bounds the inputs of one session.
const maxPaths = 1000

// SessionOptions are the options of POST /engine/sessions.
type SessionOptions struct {
	Follow     bool            `json:"follow"`
	Binds      string          `json:"binds"` // keep (default), redact, none
	Salt       string          `json:"salt"`  // redaction salt (implies redact)
	Thresholds json.RawMessage `json:"thresholds"`
	// Live sessions (Follow, live.go): a snapshot every BatchMs (default
	// 1000) and, when BatchMB > 0, after every BatchMB of new input.
	BatchMs int `json:"batchMs,omitempty"`
	BatchMB int `json:"batchMB,omitempty"`
}

// FileInfo is one input file of a session.
type FileInfo struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// SessionInfo is a session as the engine reports it.
type SessionInfo struct {
	ID       string   `json:"id"`
	Paths    []string `json:"paths"`
	State    string   `json:"state"`
	Rev      int      `json:"rev"`
	Identity string   `json:"identity"` // content identity of the trace files (TraceIdentity, no options): the key of annotations
	// CacheIdentity is the identity of the cache entry (files and the build
	// options), the {identity} of /engine/cache.
	CacheIdentity string     `json:"cacheIdentity"`
	Hit           bool       `json:"hit"` // opened from the cache without a parse (false while opening)
	Files         []FileInfo `json:"files"`
	Opened        string     `json:"opened"` // RFC 3339
	Bytes         int64      `json:"bytes"`
	Lines         int64      `json:"lines"`
	Job           string     `json:"job,omitempty"` // the open job
	Error         string     `json:"error,omitempty"`
}

// SessionEvent is the payload of a session event.
type SessionEvent struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Rev   int    `json:"rev"`
}

// Session is one open trace set. Once ready it serves the handlers of
// `serve -spill` at /s/{id}/, from its entry of the index cache.
type Session struct {
	id       string
	paths    []string // absolute
	inputs   []string // the trace files of paths (directories expanded)
	identity string   // TraceIdentity
	cacheID  string   // CacheIdentity
	opened   time.Time
	bindMode model.BindMode
	salt     string
	toolSalt string // assistSalt, under mu
	th       *analyze.Thresholds
	job      *Job
	done     chan struct{} // closed when the open job's goroutine has ended

	mu    sync.Mutex
	state string
	rev   int
	files []FileInfo
	bytes int64
	lines int64
	err   string
	hit   bool
	ref   refState // ref.go

	use sync.RWMutex // requests hold it shared, close exclusively
	op  *opened      // set when ready; nil after close

	// Idle eviction (Options.IdleEvict): requests of the session's mount in
	// flight (a doc long-poll counts) and when the last one started or ended.
	// begin runs under Server.mu so the evictor never races a new request.
	reqs     atomic.Int32
	lastUsed atomic.Int64 // unix ns
}

// begin marks a request on the session's mount; the caller defers end.
func (ss *Session) begin() {
	ss.reqs.Add(1)
	ss.lastUsed.Store(time.Now().UnixNano())
}

func (ss *Session) end() {
	ss.lastUsed.Store(time.Now().UnixNano())
	ss.reqs.Add(-1)
}

// opened is what a ready session serves from.
type opened struct {
	co      *CacheOpened
	handler http.Handler
	release func() // instead of co.Close (a live session, live.go)
}

// close releases the line indexes and the spill files and unpins the cache
// entry (its files stay).
func (o *opened) close() {
	if o.release != nil {
		o.release()
		return
	}
	o.co.Close()
}

// Info is a snapshot of the session.
func (ss *Session) Info() SessionInfo {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return SessionInfo{ID: ss.id, Paths: ss.paths, State: ss.state, Rev: ss.rev, Identity: ss.identity,
		CacheIdentity: ss.cacheID, Hit: ss.hit, Files: ss.files, Opened: ss.opened.UTC().Format(time.RFC3339), Bytes: ss.bytes, Lines: ss.lines,
		Job: ss.job.info.ID, Error: ss.err}
}

func (ss *Session) event() SessionEvent {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return SessionEvent{ID: ss.id, State: ss.state, Rev: ss.rev}
}

// close waits for the requests in flight and releases what the session holds.
func (ss *Session) close() {
	ss.use.Lock()
	op := ss.op
	ss.op = nil
	ss.use.Unlock()
	if op != nil {
		op.close()
	}
	ss.mu.Lock()
	ss.state = SessionClosed
	ss.mu.Unlock()
}

// parseBinds maps the binds option to a mode; a salt implies redact.
func parseBinds(v, salt string) (model.BindMode, error) {
	var m model.BindMode
	switch v {
	case "", "keep":
		m = model.BindsKeep
	case "redact":
		m = model.BindsRedact
	case "none":
		m = model.BindsNone
	default:
		return 0, fmt.Errorf("binds: want keep, redact or none")
	}
	if salt != "" && m == model.BindsKeep {
		m = model.BindsRedact
	}
	return m, nil
}

// openSession serves POST /engine/sessions: validates the request, starts the
// open job and answers 202 {session, job} at once.
func (s *Server) openSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths   []string       `json:"paths"`
		Options SessionOptions `json:"options"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: %v", err))
		return
	}
	o := body.Options
	if len(body.Paths) == 0 || len(body.Paths) > maxPaths {
		writeError(w, errorf(CodeBadRequest, "paths: want 1 to %d paths", maxPaths))
		return
	}
	mode, err := parseBinds(o.Binds, o.Salt)
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	var th *analyze.Thresholds
	if t := strings.TrimSpace(string(o.Thresholds)); t != "" && t != "null" {
		v, err := analyze.ParseThresholds(o.Thresholds)
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "thresholds: %v", err))
			return
		}
		th = &v
	}
	paths := make([]string, len(body.Paths))
	for i, p := range body.Paths {
		abs, err := filepath.Abs(p)
		if err == nil {
			_, err = os.Stat(abs)
		}
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "paths: %v", err))
			return
		}
		paths[i] = abs
	}
	if o.Follow {
		ss, err := s.startLive(liveSpec{paths: paths, opts: o, mode: mode, th: th})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, struct {
			Session SessionInfo `json:"session"`
			Job     JobInfo     `json:"job"`
		}{ss.Info(), ss.job.Info()})
		return
	}
	inputs, err := model.ExpandInputs(paths)
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "paths: %v", err))
		return
	}
	ids, err := IdentityOfFiles(inputs)
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "paths: %v", err))
		return
	}
	ss := &Session{id: newID("s"), paths: paths, inputs: inputs, identity: TraceIdentity(ids), opened: time.Now(),
		bindMode: mode, salt: o.Salt, th: th, done: make(chan struct{}), state: SessionOpening, rev: 1, files: fileInfos(inputs)}
	if ss.cacheID, err = CacheIdentity(inputs, ss.cacheOptions(nil)); err != nil {
		writeError(w, errorf(CodeBadRequest, "paths: %v", err))
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		writeError(w, errorf(CodeConflict, "the engine is shutting down"))
		return
	}
	ss.job = s.newJobLocked("open", ss.id)
	ss.job.info.Phase = "open" // cache lookup; "parse" (bytes) only on a miss
	s.sessions[ss.id] = ss
	s.wg.Add(1)
	s.mu.Unlock()
	ss.job.publish()
	go s.runOpen(ss)
	s.bc.publish("session", ss.event())
	writeJSON(w, http.StatusAccepted, struct {
		Session SessionInfo `json:"session"`
		Job     JobInfo     `json:"job"`
	}{ss.Info(), ss.job.Info()})
}

func fileInfos(paths []string) []FileInfo {
	out := make([]FileInfo, len(paths))
	for i, p := range paths {
		out[i] = FileInfo{Path: p, Name: filepath.Base(p)}
		if fi, err := os.Stat(p); err == nil {
			out[i].Size = fi.Size()
		}
	}
	return out
}

// runOpen is the open job: build, then ready, or failed (everything released).
func (s *Server) runOpen(ss *Session) {
	defer s.wg.Done()
	defer close(ss.done)
	job := ss.job
	start := time.Now()
	op, err := s.buildSession(job, ss)
	if err == nil && job.ctx.Err() != nil {
		op.close()
		err = errCancelled
	}
	if err != nil {
		if errors.Is(err, errCancelled) || errors.Is(err, context.Canceled) {
			err = errCancelled
		}
		ss.mu.Lock()
		ss.state, ss.err = SessionFailed, err.Error()
		ss.mu.Unlock()
		job.finish(err)
		s.bc.publish("session", ss.event())
		if err != errCancelled {
			s.logf("error", "session %s: open failed: %v", ss.id, err)
		}
		return
	}
	ss.use.Lock()
	ss.op = op
	ss.use.Unlock()
	m := op.co.Model
	files := make([]FileInfo, len(m.File.Files))
	for i, fe := range m.File.Files {
		files[i] = FileInfo{Path: fe.Path, Name: fe.Name, Size: fe.Size}
	}
	ss.lastUsed.Store(time.Now().UnixNano())
	ss.mu.Lock()
	ss.state, ss.files, ss.bytes, ss.lines, ss.hit = SessionReady, files, m.Diag.Bytes, int64(m.Diag.Lines), op.co.Hit
	ss.mu.Unlock()
	job.mu.Lock()
	job.info.Phase = "ready"
	job.mu.Unlock()
	job.finish(nil) // one event: done, phase ready
	s.bc.publish("session", ss.event())
	how := "parsed"
	if op.co.Hit {
		how = "from the cache"
	}
	s.logf("info", "session %s: %s ready in %s, %s (%d lines, %.1f MB)", ss.id, describe(m), time.Since(start).Round(time.Millisecond), how, m.Diag.Lines, float64(m.Diag.Bytes)/1e6)
	s.evict()
}

// evict trims the cache to its cap, keeping the entries of every session.
func (s *Server) evict() {
	s.mu.Lock()
	pinned := make([]string, 0, len(s.sessions))
	for _, ss := range s.sessions {
		pinned = append(pinned, ss.cacheID)
	}
	s.mu.Unlock()
	if gone := s.cache.Evict(pinned...); len(gone) > 0 {
		s.logf("info", "cache: evicted %d entries", len(gone))
	}
}

// cacheOptions are the options of the session's cache entry.
func (ss *Session) cacheOptions(build CacheBuildFunc) CacheOpenOptions {
	return CacheOpenOptions{BindMode: ss.bindMode, Salt: ss.salt, Thresholds: ss.th, Build: build}
}

// sessionRoutes are the routes of a ready session, relative to /s/{id}.
func sessionRoutes() []string {
	out := []string{"GET /api/doc", "GET /api/report", "POST /api/ref", "POST /api/brief", "POST /api/assist/tools/{name}"}
	for _, ep := range append(slice.Endpoints(), slice.LineEndpoints()...) {
		out = append(out, "GET "+ep)
	}
	return out
}

func describe(m *model.Model) string {
	if n := len(m.File.Files); n > 1 {
		return fmt.Sprintf("%d files (%s ...)", n, m.File.Files[0].Name)
	}
	return m.File.Files[0].Name
}

// buildSession opens a session from the index cache: on a hit the entry is
// loaded (no parse); on a miss the trace is built exactly as `serve -spill`
// does (aggregation-only model, calls, waits and binds spilled into the new
// entry, bind redaction applied to the spill and the model, one line index
// per input file) and then loaded. The document has slice: true.
func (s *Server) buildSession(job *Job, ss *Session) (_ *opened, err error) {
	ctx := job.Context()
	if ctx.Err() != nil {
		return nil, errCancelled
	}
	var total int64
	for _, f := range ss.files {
		total += f.Size
	}
	build := func(ctx context.Context, paths []string, mo model.Options) (*model.Model, error) {
		job.SetPhase("parse", "bytes", 0, total)
		tee := mo.NewTee
		mo.NewTee = func(m *model.Model) model.Sink {
			t := tee(m)
			bs, _ := t.(model.BindSink)
			return &cancelSink{ctx: ctx, sink: t, binds: bs}
		}
		mo.OnProgress = job.Progress
		m, err := buildFiles(paths, mo)
		if err == nil {
			job.SetPhase("index", "", 0, 0) // persist the entry, line indexes
		}
		return m, err
	}
	co, err := s.cache.OpenTrace(ctx, ss.inputs, ss.cacheOptions(build))
	if err != nil {
		if ctx.Err() != nil {
			return nil, errCancelled
		}
		return nil, err
	}
	op := &opened{co: co}
	defer func() {
		if err != nil {
			op.close()
		}
	}()
	if co.Identity != ss.cacheID {
		return nil, fmt.Errorf("cache: opened %s, expected %s", co.Identity, ss.cacheID)
	}
	m := co.Model
	if b := s.loadStoredRef(ss); b != nil { // a bundle kept for this trace (ref.go)
		model.ApplyRef(m, b)
	}
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: false, Packed: true, Slice: true, Thresholds: ss.th})
	if err != nil {
		return nil, err
	}
	if !co.Hit {
		debug.FreeOSMemory() // the build churned through the heap; give the pages back before idling
	}
	ss.mu.Lock()
	ss.ref.doc = doc
	ss.mu.Unlock()
	op.handler = s.sessionMux(ss, co, doc)
	return op, nil
}

// sessionMux serves the routes of a session (sessionRoutes) from an opened
// trace and its document.
func (s *Server) sessionMux(ss *Session, co *CacheOpened, doc []byte) http.Handler {
	ssrv := slice.NewServer(co.Model, co.Source).WithLines(co.Lines) // lines, lines/at, at, search
	ssrv.AllowOrigin = slice.NoCORS                                  // the engine's middleware sets CORS
	ssrv.Thresholds = ss.th                                          // api/findings: those of the document's findings
	api := ssrv.Handler()
	handlers := map[string]http.Handler{
		"GET /api/report": http.HandlerFunc(newSessionReport(ss, co, s.opts.PlanVizURL).serve),
		"GET /api/doc": http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// ?rev= is accepted and ignored here: the current document is served
			// (its revision is the session's rev, which a reference bundle
			// bumps; a live session answers api/doc itself, live.go)
			w.Header().Set("Content-Type", "application/json")
			w.Write(ss.document())
		}),
		"POST /api/ref":                 s.refHandler(ss),
		"POST /api/brief":               briefHandler(ss, co),
		"POST /api/assist/tools/{name}": toolHandler(ss, co, api),
	}
	mux := http.NewServeMux()
	for _, p := range sessionRoutes() {
		h := handlers[p]
		if h == nil {
			h = api
		}
		mux.Handle(p, h)
	}
	return mux
}

// buildFiles is model.BuildFiles that turns a cancellation (cancelSink) or a
// panic of the parser into an error instead of taking the engine down.
func buildFiles(paths []string, opts model.Options) (m *model.Model, err error) {
	defer func() {
		if r := recover(); r != nil {
			if r == errCancelled {
				err = errCancelled
				return
			}
			err = fmt.Errorf("internal error while reading the trace: %v\n%s", r, debug.Stack())
		}
	}()
	return model.BuildFiles(paths, opts)
}

// cancelSink is the build's tee sink (the spill) with a cancellation check:
// every 4096 facts it looks at ctx and unwinds the build with a panic that
// buildFiles recovers. The builder has no context of its own.
type cancelSink struct {
	ctx   context.Context
	sink  model.Sink
	binds model.BindSink
	n     uint32
}

func (c *cancelSink) check() {
	c.n++
	if c.n&4095 == 0 && c.ctx.Err() != nil {
		panic(errCancelled)
	}
}

func (c *cancelSink) Call(x *model.Call) { c.check(); c.sink.Call(x) }
func (c *cancelSink) Child(ch *model.ChildRec, p *model.Call) {
	c.sink.Child(ch, p)
}
func (c *cancelSink) Wait(w *model.Wait, x *model.Call) { c.check(); c.sink.Wait(w, x) }
func (c *cancelSink) Adopt(cur, to model.ID)            { c.sink.Adopt(cur, to) }
func (c *cancelSink) Finish()                           { c.sink.Finish() }
func (c *cancelSink) BindSet(set *model.BindSet, b []model.Bind) {
	c.check()
	c.binds.BindSet(set, b)
}

// sessionAPI serves /s/{id}/...: the session's handlers once it is ready.
func (s *Server) sessionAPI(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.serveSession(w, r, id, "/s/"+id)
}

// serveSession serves a request of session id, its path below prefix.
func (s *Server) serveSession(w http.ResponseWriter, r *http.Request, id, prefix string) {
	s.mu.Lock()
	ss := s.sessions[id]
	if ss != nil {
		ss.begin()
	}
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeNotFound, "no session %q", id))
		return
	}
	defer ss.end()
	ss.use.RLock()
	defer ss.use.RUnlock()
	if ss.op == nil {
		info := ss.Info()
		if info.State == SessionFailed {
			writeError(w, errorf(CodeConflict, "session %s failed: %s", id, info.Error))
		} else {
			writeError(w, errorf(CodeConflict, "session %s is %s", id, info.State))
		}
		return
	}
	if prefix == "" {
		ss.op.handler.ServeHTTP(w, r)
		return
	}
	http.StripPrefix(prefix, ss.op.handler).ServeHTTP(w, r)
}

func (s *Server) lookup(w http.ResponseWriter, r *http.Request) *Session {
	s.mu.Lock()
	ss := s.sessions[r.PathValue("id")]
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeNotFound, "no session %q", r.PathValue("id")))
	}
	return ss
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	all := make([]*Session, 0, len(s.sessions))
	for _, ss := range s.sessions {
		all = append(all, ss)
	}
	s.mu.Unlock()
	sort.Slice(all, func(a, b int) bool { return all[a].opened.Before(all[b].opened) })
	out := make([]SessionInfo, len(all))
	for i, ss := range all {
		out[i] = ss.Info()
	}
	writeJSON(w, http.StatusOK, struct {
		Sessions []SessionInfo `json:"sessions"`
	}{out})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	if ss := s.lookup(w, r); ss != nil {
		writeJSON(w, http.StatusOK, ss.Info())
	}
}

// deleteSession serves DELETE /engine/sessions/{id}: cancels the open job if
// it still runs, waits for it to stop, then waits for the session's requests
// in flight and releases its files (the cache entry stays). 204.
func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	ss := s.sessions[r.PathValue("id")]
	delete(s.sessions, r.PathValue("id"))
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeNotFound, "no session %q", r.PathValue("id")))
		return
	}
	s.closeSession(ss)
	w.WriteHeader(http.StatusNoContent)
}

// closeSession stops a session already removed from s.sessions: cancels its
// jobs, waits for them, releases its files and publishes the closed state.
func (s *Server) closeSession(ss *Session) {
	ss.job.cancel()
	s.cancelRefJobs(ss.id)
	<-ss.done
	ss.close()
	s.bc.publish("session", ss.event())
}

// evictIdle closes the sessions idle for at least d at now (Options.IdleEvict):
// ready, no request on their mount in flight, no running job of their own
// (so never an opening or a live session). It returns how many it closed.
func (s *Server) evictIdle(d time.Duration, now time.Time) int {
	s.mu.Lock()
	busy := map[string]bool{}
	for _, j := range s.jobs {
		if info := j.Info(); info.Session != "" && info.State == JobRunning {
			busy[info.Session] = true
		}
	}
	var gone []*Session
	for id, ss := range s.sessions {
		if busy[id] || ss.reqs.Load() > 0 || ss.Info().State != SessionReady {
			continue
		}
		if now.Sub(time.Unix(0, ss.lastUsed.Load())) < d {
			continue
		}
		delete(s.sessions, id)
		gone = append(gone, ss)
	}
	s.mu.Unlock()
	for _, ss := range gone {
		s.closeSession(ss)
		s.logf("info", "session %s: closed after %s idle (cache entry kept)", ss.id, d)
	}
	return len(gone)
}

// evictLoop runs evictIdle until the engine closes.
func (s *Server) evictLoop(d time.Duration) {
	defer s.wg.Done()
	tick := time.NewTicker(max(min(d/4, 30*time.Second), 5*time.Millisecond))
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case now := <-tick.C:
			s.evictIdle(d, now)
		}
	}
}
