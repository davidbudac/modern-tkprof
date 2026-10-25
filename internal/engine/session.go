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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Session states. "closed" only appears in the session event of a DELETE.
const (
	SessionOpening = "opening"
	SessionReady   = "ready"
	SessionFailed  = "failed"
	SessionClosed  = "closed"
)

// maxPaths bounds the inputs of one session.
const maxPaths = 1000

// SessionOptions are the options of POST /engine/sessions.
type SessionOptions struct {
	Follow     bool            `json:"follow"`
	Binds      string          `json:"binds"` // keep (default), redact, none
	Salt       string          `json:"salt"`  // redaction salt (implies redact)
	Thresholds json.RawMessage `json:"thresholds"`
}

// FileInfo is one input file of a session.
type FileInfo struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// SessionInfo is a session as the engine reports it.
type SessionInfo struct {
	ID       string     `json:"id"`
	Paths    []string   `json:"paths"`
	State    string     `json:"state"`
	Rev      int        `json:"rev"`
	Identity string     `json:"identity"`
	Files    []FileInfo `json:"files"`
	Opened   string     `json:"opened"` // RFC 3339
	Bytes    int64      `json:"bytes"`
	Lines    int64      `json:"lines"`
	Job      string     `json:"job,omitempty"` // the open job
	Error    string     `json:"error,omitempty"`
}

// SessionEvent is the payload of a session event.
type SessionEvent struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Rev   int    `json:"rev"`
}

// Session is one open trace set. Once ready it serves the handlers of
// `serve -spill` at /s/{id}/.
type Session struct {
	id       string
	paths    []string // absolute
	identity string
	opened   time.Time
	bindMode model.BindMode
	salt     string
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

	use sync.RWMutex // requests hold it shared, close exclusively
	op  *opened      // set when ready; nil after close
}

// opened is what a ready session serves from.
type opened struct {
	m       *model.Model
	spill   *slice.Spill
	lis     []*trace.LineIndex
	handler http.Handler
}

// close releases the line indexes and the spill (its directory is removed).
func (o *opened) close() {
	for _, li := range o.lis {
		li.Close()
	}
	if o.spill != nil {
		o.spill.Close()
	}
}

// Info is a snapshot of the session.
func (ss *Session) Info() SessionInfo {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return SessionInfo{ID: ss.id, Paths: ss.paths, State: ss.state, Rev: ss.rev, Identity: ss.identity,
		Files: ss.files, Opened: ss.opened.UTC().Format(time.RFC3339), Bytes: ss.bytes, Lines: ss.lines,
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
	if o.Follow {
		writeError(w, errorf(CodeBadRequest, "follow is not implemented yet"))
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
	inputs, err := model.ExpandInputs(paths)
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "paths: %v", err))
		return
	}
	ss := &Session{id: newID("s"), paths: paths, identity: slice.SpillKey(paths), opened: time.Now(),
		bindMode: mode, salt: o.Salt, th: th, done: make(chan struct{}), state: SessionOpening, rev: 1, files: fileInfos(inputs)}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		writeError(w, errorf(CodeConflict, "the engine is shutting down"))
		return
	}
	ss.job = s.newJobLocked("open", ss.id)
	var total int64
	for _, f := range ss.files {
		total += f.Size
	}
	ss.job.info.Phase, ss.job.info.Unit, ss.job.info.Total = "parse", "bytes", total
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
		if errors.Is(err, errCancelled) {
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
	m := op.m
	files := make([]FileInfo, len(m.File.Files))
	for i, fe := range m.File.Files {
		files[i] = FileInfo{Path: fe.Path, Name: fe.Name, Size: fe.Size}
	}
	ss.mu.Lock()
	ss.state, ss.files, ss.bytes, ss.lines = SessionReady, files, m.Diag.Bytes, int64(m.Diag.Lines)
	ss.mu.Unlock()
	job.mu.Lock()
	job.info.Phase = "ready"
	job.mu.Unlock()
	job.finish(nil) // one event: done, phase ready
	s.bc.publish("session", ss.event())
	s.logf("info", "session %s: %s ready in %s (%d lines, %.1f MB)", ss.id, describe(m), time.Since(start).Round(time.Millisecond), m.Diag.Lines, float64(m.Diag.Bytes)/1e6)
}

func describe(m *model.Model) string {
	if n := len(m.File.Files); n > 1 {
		return fmt.Sprintf("%d files (%s ...)", n, m.File.Files[0].Name)
	}
	return m.File.Files[0].Name
}

// buildSession builds a session exactly as `serve -spill` does: an
// aggregation-only model, calls, waits and binds spilled to a temporary
// directory under the cache dir, bind redaction applied to the spill and the
// model, the document with slice: true, one line index per input file.
//
// Seams: the persistent cache (E2) looks the session's content identity up
// here first and, on a hit, reopens the spill instead of building; the parse
// progress hook (E3) is model.Options.OnProgress = job.Progress.
func (s *Server) buildSession(job *Job, ss *Session) (_ *opened, err error) {
	ctx := job.Context() // phase "parse" was set when the job was created
	if ctx.Err() != nil {
		return nil, errCancelled
	}
	// The key carries the session id (no '-': RemoveStale splits on it), so a
	// second session of the same trace does not remove this one's directory.
	sp, err := slice.NewSpill(slice.SpillOptions{Dir: s.opts.CacheDir, Key: ss.identity + "." + ss.id, BindMode: ss.bindMode, Salt: ss.salt})
	if err != nil {
		return nil, fmt.Errorf("spill: %w", err)
	}
	op := &opened{spill: sp}
	defer func() {
		if err != nil {
			op.close()
		}
	}()
	th := analyze.DefaultThresholds()
	if ss.th != nil {
		th = *ss.th
	}
	opts := model.Options{NoFacts: true, Aggregate: true, SpillBinds: ss.bindMode != model.BindsNone,
		NewSink:    func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:     func(m *model.Model) model.Sink { return &cancelSink{ctx: ctx, sink: sp.Attach(m), binds: sp} },
		OnProgress: job.Progress,
	}
	m, err := buildFiles(ss.paths, opts)
	if err != nil {
		return nil, err
	}
	op.m = m
	model.RedactBindsSalt(m, ss.bindMode, ss.salt)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: false, Packed: true, Slice: true, Thresholds: ss.th})
	if err != nil {
		return nil, err
	}
	src, err := sp.Source()
	if err != nil {
		return nil, fmt.Errorf("spill: %w", err)
	}
	debug.FreeOSMemory() // the build churned through the heap; give the pages back before idling
	job.SetPhase("index", "files", 0, int64(len(m.File.Files)))
	for i, fe := range m.File.Files {
		if ctx.Err() != nil {
			return nil, errCancelled
		}
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			return nil, err
		}
		op.lis = append(op.lis, li)
		job.SetPhase("index", "files", int64(i+1), int64(len(m.File.Files)))
	}
	ssrv := slice.NewServer(m, src)
	ssrv.AllowOrigin = slice.NoCORS // the engine's middleware sets CORS
	mux := http.NewServeMux()
	mux.Handle("/api/", ssrv.Handler())
	mux.Handle("/api/lines", slice.LinesHandler(op.lis))
	mux.HandleFunc("/api/doc", func(w http.ResponseWriter, r *http.Request) {
		// ?rev= is accepted; there is one revision until ref data or follow exist
		w.Header().Set("Content-Type", "application/json")
		w.Write(doc)
	})
	op.handler = mux
	return op, nil
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
	s.mu.Lock()
	ss := s.sessions[id]
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeNotFound, "no session %q", id))
		return
	}
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
	http.StripPrefix("/s/"+id, ss.op.handler).ServeHTTP(w, r)
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
// in flight and releases its files (the spill directory is removed). 204.
func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	ss := s.sessions[r.PathValue("id")]
	delete(s.sessions, r.PathValue("id"))
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeNotFound, "no session %q", r.PathValue("id")))
		return
	}
	ss.job.cancel()
	<-ss.done
	ss.close()
	s.bc.publish("session", ss.event())
	w.WriteHeader(http.StatusNoContent)
}

// sweepSpills removes the spill directories engines left behind when they
// died (the engine's keys contain a '.'; `serve -spill` cleans its own).
func sweepSpills(base string) {
	ents, err := os.ReadDir(base)
	if err != nil {
		return
	}
	const prefix = "mtkprof-spill-"
	for _, e := range ents {
		name := e.Name()
		if !e.IsDir() || !strings.HasPrefix(name, prefix) {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(name, prefix), "-")
		if len(parts) != 3 || !strings.Contains(parts[0], ".") {
			continue
		}
		pid, err := strconv.Atoi(parts[1])
		if err != nil || pid == os.Getpid() || processAlive(pid) {
			continue
		}
		os.RemoveAll(filepath.Join(base, name))
	}
}
