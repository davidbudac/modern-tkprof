package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/remote/db"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// Reference bundles in a session (docs/REF-BUNDLE.md, docs/REMOTE.md).
//
// POST /s/{id}/api/ref {dir} or {connection, lite} starts a job (kind ref)
// that obtains a bundle (a local directory, or the reference queries run on
// a db connection), keeps it at <cache>/ref/<trace identity>/ (SessionInfo
// .identity, the content identity of the trace files without build options,
// so every session of the same trace shares it; the cache entries are left
// alone, their manifests list every file), applies it to the session's model
// (model.ApplyRef, which replaces a bundle applied before), rebuilds the
// document, and bumps the session's rev. Opening a trace later, a cache hit
// or not, applies the stored bundle before the first document is built.
// DELETE /engine/cache drops the bundles of the traces no session has open.

// refState is a session's reference-bundle state (Session.mu).
type refState struct {
	doc []byte // the document api/doc serves
	job *Job   // the running ref job
}

// document is the document api/doc serves.
func (ss *Session) document() []byte {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.ref.doc
}

// refRoot is where stored bundles live.
func (s *Server) refRoot() string { return filepath.Join(filepath.Dir(s.cache.Dir()), "ref") }

func (s *Server) refDir(ss *Session) string { return filepath.Join(s.refRoot(), ss.identity) }

// loadStoredRef reads the stored bundle of the session's trace, nil when
// there is none (or it cannot be read: logged, the trace opens without).
func (s *Server) loadStoredRef(ss *Session) *ref.Bundle {
	dir := s.refDir(ss)
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	b, err := ref.LoadBundle(dir)
	if err != nil {
		s.logf("warn", "session %s: stored reference bundle %s: %v", ss.id, dir, err)
		return nil
	}
	if b.Empty() {
		return nil
	}
	return b
}

// pruneRefs removes the stored bundles of the traces that no session has open.
func (s *Server) pruneRefs() {
	ents, err := os.ReadDir(s.refRoot())
	if err != nil {
		return
	}
	keep := map[string]bool{}
	s.mu.Lock()
	for _, ss := range s.sessions {
		keep[ss.identity] = true
	}
	s.mu.Unlock()
	for _, e := range ents {
		if !keep[e.Name()] && !strings.HasPrefix(e.Name(), ".") { // dot: a ref job's staging directory
			os.RemoveAll(filepath.Join(s.refRoot(), e.Name()))
		}
	}
}

// cancelRefJobs cancels the ref jobs of session id (it is being closed).
func (s *Server) cancelRefJobs(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, j := range s.jobs {
		if info := j.Info(); info.Kind == "ref" && info.Session == id {
			j.cancel()
		}
	}
}

// refHandler serves POST /s/{id}/api/ref {dir} | {connection, lite}:
// 202 {job}.
func (s *Server) refHandler(ss *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Dir        string `json:"dir"`
			Connection string `json:"connection"`
			Lite       bool   `json:"lite"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			writeError(w, errorf(CodeBadRequest, "body: %v", err))
			return
		}
		if (body.Dir == "") == (body.Connection == "") {
			writeError(w, errorf(CodeBadRequest, "body: want {dir} or {connection}"))
			return
		}
		if body.Dir != "" && body.Lite {
			writeError(w, errorf(CodeBadRequest, "lite: connection only"))
			return
		}
		var c *connection
		var dir string
		if body.Dir != "" {
			abs, err := filepath.Abs(body.Dir)
			if err == nil {
				var fi os.FileInfo
				if fi, err = os.Stat(abs); err == nil && !fi.IsDir() {
					err = fmt.Errorf("%s is not a directory", abs)
				}
			}
			if err != nil {
				writeError(w, errorf(CodeBadRequest, "dir: %v", err))
				return
			}
			dir = abs
		} else {
			s.conns.mu.Lock()
			c = s.conns.m[body.Connection]
			s.conns.mu.Unlock()
			if c == nil {
				writeError(w, errorf(CodeNotFound, "no connection %q", body.Connection))
				return
			}
			if c.def.Kind != ConnDB {
				writeError(w, errorf(CodeBadRequest, "connection %s is %s: want a db connection", c.def.ID, c.def.Kind))
				return
			}
		}
		j, err := s.startRefJob(ss, c, func(j *Job) error {
			if c != nil {
				return s.runRefDB(j, ss, c, body.Lite)
			}
			return s.runRefDir(j, ss, dir)
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, struct {
			Job JobInfo `json:"job"`
		}{j.Info()})
	}
}

// startRefJob registers the session's ref job (one at a time) and runs work.
func (s *Server) startRefJob(ss *Session, c *connection, work func(*Job) error) (*Job, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errorf(CodeConflict, "the engine is shutting down")
	}
	ss.mu.Lock()
	if ss.ref.job != nil && ss.ref.job.running() {
		ss.mu.Unlock()
		s.mu.Unlock()
		return nil, errorf(CodeConflict, "session %s has a running reference job", ss.id)
	}
	j := s.newJobLocked("ref", ss.id)
	j.info.Phase, j.info.Unit = "ref", "files"
	if c != nil {
		j.info.Connection, j.info.Unit = c.def.ID, "queries"
	}
	ss.ref.job = j
	ss.mu.Unlock()
	s.wg.Add(1)
	s.mu.Unlock()
	j.publish()
	go func() {
		defer s.wg.Done()
		err := work(j)
		if err != nil && j.ctx.Err() == nil {
			s.logf("error", "session %s: reference bundle failed: %v", ss.id, err)
		}
		j.finish(err)
	}()
	return j, nil
}

// stage makes an empty staging directory next to the stored bundles.
func (s *Server) stage() (string, error) {
	if err := os.MkdirAll(s.refRoot(), 0o700); err != nil {
		return "", err
	}
	return os.MkdirTemp(s.refRoot(), ".stage-")
}

// runRefDir: copy the bundle of a local directory into the store, apply it.
func (s *Server) runRefDir(j *Job, ss *Session, dir string) error {
	j.SetPhase("ref", "files", 0, 0)
	st, err := s.stage()
	if err != nil {
		return err
	}
	defer os.RemoveAll(st)
	n, err := ref.CopyBundle(dir, st)
	if err != nil {
		return err
	}
	j.SetPhase("apply", "files", int64(n), int64(n))
	return s.commitRef(j, ss, st, "")
}

// runRefDB: run the reference queries of the session's trace on a session of
// the connection of its own, write the bundle into the store, apply it.
func (s *Server) runRefDB(j *Job, ss *Session, c *connection, lite bool) error {
	ctx := j.Context()
	st, err := s.stage()
	if err != nil {
		return err
	}
	defer os.RemoveAll(st)
	cl, err := s.dbOpen(ctx, ctx, c)
	if err != nil {
		return err
	}
	defer cl.Close()
	// The queries are made from the model, read-only; the only writer is the
	// apply step of a ref job, and a session has one ref job at a time.
	ss.use.RLock()
	m := ss.modelLocked()
	ss.use.RUnlock()
	if m == nil {
		return errors.New("the session is closed")
	}
	j.SetPhase("ref", "queries", 0, 0)
	err = cl.FetchRef(ctx, m, st, lite, func(done, total int) {
		j.mu.Lock()
		j.info.Done, j.info.Total = int64(done), int64(total)
		j.mu.Unlock()
		j.publish()
	})
	var note string
	var pe *db.PartialError
	switch {
	case errors.As(err, &pe):
		var skipped []string
		for _, f := range pe.Failed {
			skipped = append(skipped, f.Target+": "+oneLine(f.Err.Error()))
		}
		var lites []string
		for _, f := range pe.Fallback {
			lites = append(lites, f.Target)
		}
		if len(skipped) > 0 {
			note = "queries skipped: " + strings.Join(skipped, "; ")
		}
		if len(lites) > 0 {
			if note != "" {
				note += "; "
			}
			note += "lite queries (ALL_ views) used for " + strings.Join(lites, ", ")
		}
		if !lite {
			note += " (no DBA_ views: SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY, or use lite)"
		}
	case err != nil:
		return err
	}
	j.SetPhase("apply", "queries", j.Info().Done, j.Info().Total)
	return s.commitRef(j, ss, st, note)
}

func oneLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// modelLocked is the session's model (ss.use is held); nil once closed.
func (ss *Session) modelLocked() *model.Model {
	if ss.op == nil {
		return nil
	}
	return ss.op.co.Model
}

// commitRef stores the staged bundle for the session's trace, applies it,
// rebuilds the document and publishes the new revision. note is set as the
// job's message.
func (s *Server) commitRef(j *Job, ss *Session, stage, note string) error {
	b, err := ref.LoadBundle(stage)
	if err != nil {
		return err
	}
	if b.Empty() {
		return fmt.Errorf("the bundle has no usable files (want objects.csv, datafiles.csv, users.csv, plans/<sql_id>.txt)")
	}
	if err := j.ctx.Err(); err != nil {
		return err
	}
	final := s.refDir(ss)
	old := stage + ".old"
	os.RemoveAll(old)
	if err := os.Rename(final, old); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(stage, final); err != nil {
		os.Rename(old, final)
		return err
	}
	os.RemoveAll(old)

	ss.use.Lock() // no request reads the model while it changes
	defer ss.use.Unlock()
	m := ss.modelLocked()
	if m == nil {
		return errors.New("the session is closed")
	}
	model.ApplyRef(m, b)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: false, Packed: true, Slice: true, Thresholds: ss.th})
	if err != nil {
		return err
	}
	ss.mu.Lock()
	ss.ref.doc = doc
	ss.rev++
	ss.mu.Unlock()
	msg := b.Summary()
	if note != "" {
		msg += "; " + note
	}
	j.mu.Lock()
	j.info.Message = msg
	j.mu.Unlock()
	s.bc.publish("session", ss.event())
	s.logf("info", "session %s: reference bundle applied (%s), revision %d", ss.id, b.Summary(), ss.event().Rev)
	return nil
}
