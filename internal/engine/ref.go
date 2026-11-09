package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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
// alone, their manifests list every file), applies it to the model of every
// open session of that trace (model.ApplyRef, which replaces a bundle applied
// before), rebuilds their documents, and bumps their revs. Opening a trace
// later, a cache hit or not, applies the stored bundle before the first
// document is built; a commit during that build is caught up once the session
// is ready (Server.refGen, catchUpRef).
// DELETE /engine/cache drops the bundles of the traces no session has open.

// refState is a session's reference-bundle state (Session.mu).
type refState struct {
	doc []byte // the document api/doc serves
	job *Job   // the running ref job
	gen uint64 // the commit of the kept bundle the model has (Server.refGen)
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

// pruneRefs removes the stored bundles of the traces that no session has open:
// directories named by a trace identity only, nothing else a user put there.
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
		if validIdentity(e.Name()) && !keep[e.Name()] { // a dot name is a ref job's staging directory
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
		if ss.identity == "" { // a live session has no content identity (no stable file) and no bundle dir
			writeError(w, errorf(CodeBadRequest, "reference data cannot be applied to a live session; open the file normally when the follow ends"))
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

// commitRef stores the staged bundle for the session's trace and applies it
// to every open session of that trace: this one, and the others (another tab
// of the same files, opened with other options), each with its document
// rebuilt and its rev bumped (a session event; the desktop reloads those
// tabs). note is set as the job's message.
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
	s.refMu.Lock() // one commit at a time; a session that opens meanwhile sees the new generation (runOpen)
	defer s.refMu.Unlock()
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
	if s.refGen == nil {
		s.refGen = map[string]uint64{}
	}
	s.refGen[ss.identity]++
	gen := s.refGen[ss.identity]

	applied, err := s.applyRefTo(ss, b, gen)
	if err != nil {
		return err
	}
	if !applied {
		return errors.New("the session is closed")
	}
	others := 0
	for _, o := range s.sameTrace(ss) {
		ok, err := s.applyRefTo(o, b, gen)
		if err != nil {
			s.logf("warn", "session %s: reference bundle of %s: %v", o.id, ss.id, err)
		} else if ok {
			others++
		}
	}
	msg := b.Summary()
	if note != "" {
		msg += "; " + note
	}
	if others > 0 {
		msg += fmt.Sprintf("; also applied to %d other open session%s of the trace", others, map[bool]string{true: "s"}[others > 1])
	}
	j.mu.Lock()
	j.info.Message = msg
	j.mu.Unlock()
	return nil
}

// sameTrace lists the other sessions of ss's trace (the same identity; a live
// session has none).
func (s *Server) sameTrace(ss *Session) []*Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*Session
	for _, o := range s.sessions {
		if o != ss && o.identity != "" && o.identity == ss.identity {
			out = append(out, o)
		}
	}
	return out
}

// applyRefTo applies b to the session's model (model.ApplyRef replaces a
// bundle applied before), rebuilds its document and publishes the new
// revision; gen is the commit b comes from. false: the session has no model
// (still opening: runOpen applies what is kept once it is ready; or closed).
func (s *Server) applyRefTo(ss *Session, b *ref.Bundle, gen uint64) (bool, error) {
	ss.use.Lock() // no request reads the model while it changes
	m := ss.modelLocked()
	if m == nil {
		ss.use.Unlock()
		return false, nil
	}
	model.ApplyRef(m, b)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: false, Packed: true, Slice: true, Thresholds: ss.th})
	if err != nil {
		ss.use.Unlock()
		return false, err
	}
	ss.mu.Lock()
	ss.ref.doc, ss.ref.gen = doc, gen
	ss.rev++
	ss.mu.Unlock()
	ss.use.Unlock()
	s.bc.publish("session", ss.event())
	s.logf("info", "session %s: reference bundle applied (%s), revision %d", ss.id, b.Summary(), ss.event().Rev)
	return true, nil
}

// storedRefGen reads the kept bundle of the session's trace with the commit
// it belongs to (buildSession).
func (s *Server) storedRefGen(ss *Session) (*ref.Bundle, uint64) {
	s.refMu.Lock()
	defer s.refMu.Unlock()
	return s.loadStoredRef(ss), s.refGen[ss.identity]
}

// catchUpRef: a session that has just become ready applies the kept bundle
// when a commit came after its build read it (that commit skipped it: no
// model yet).
func (s *Server) catchUpRef(ss *Session) {
	if ss.identity == "" {
		return
	}
	s.refMu.Lock()
	defer s.refMu.Unlock()
	ss.mu.Lock()
	have := ss.ref.gen
	ss.mu.Unlock()
	gen := s.refGen[ss.identity]
	if gen == have {
		return
	}
	if b := s.loadStoredRef(ss); b != nil {
		if _, err := s.applyRefTo(ss, b, gen); err != nil {
			s.logf("warn", "session %s: reference bundle: %v", ss.id, err)
		}
	}
}

// The names script and its pasted output (docs/REF-BUNDLE.md § Paste):
//
// GET /s/{id}/api/ref: what the trace refers to by number and how much of it
// the session's bundle names, and the session's latest ref job.
// GET /s/{id}/api/ref/script?plans=true: the names script for the trace
// (report.RefPasteScript).
// POST /s/{id}/api/ref/paste {text}: the script's output, read at once (202
// with what it holds); a ref job merges it into the kept bundle (an entry of
// the paste replaces the kept one, the rest stays) and applies that.

// refPasteMax bounds a pasted text (the plans of a big trace are long).
const refPasteMax = 64 << 20

// RefStatus is the answer of GET /s/{id}/api/ref.
type RefStatus struct {
	Wanted report.RefCounts `json:"wanted"` // ids the trace refers to (obj#, file#, user ids, sql_ids with text)
	Named  report.RefCounts `json:"named"`  // of those, the ones the applied bundle names
	Stored bool             `json:"stored"` // a bundle is kept for the trace
	Rev    int              `json:"rev"`
	Job    *JobInfo         `json:"job,omitempty"` // the session's latest ref job
}

// RefScript is the answer of GET /s/{id}/api/ref/script.
type RefScript struct {
	Script string           `json:"script"`
	Name   string           `json:"name"` // a file name for it
	Plans  bool             `json:"plans"`
	Wanted report.RefCounts `json:"wanted"`
}

// RefPasteRequest is the body of POST /s/{id}/api/ref/paste.
type RefPasteRequest struct {
	Text string `json:"text"`
}

// RefPasted is the answer of POST /s/{id}/api/ref/paste.
type RefPasted struct {
	Job JobInfo `json:"job"` // the ref job that applies it
	// Read is what the text holds; Notes the script's notes (a view it could
	// not read and the one it read instead, plans not found); Complete: the
	// text has the first and the last line of the script's output (else it
	// was cut off), or it was read as tables.
	Read     report.RefCounts `json:"read"`
	Notes    []string         `json:"notes"`
	Complete bool             `json:"complete"`
}

// shownModelLocked is the model the session shows (a live session's latest
// snapshot); nil once closed. The caller holds ss.use.
func (ss *Session) shownModelLocked() *model.Model {
	if ss.op == nil {
		return nil
	}
	co, _ := ss.op.trace()
	return co.Model
}

// refStatusHandler serves GET /s/{id}/api/ref.
func (s *Server) refStatusHandler(ss *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m := ss.shownModelLocked() // the request holds ss.use
		if m == nil {
			writeError(w, errorf(CodeConflict, "session %s is closed", ss.id))
			return
		}
		st := RefStatus{Wanted: report.RefCountsOf(m), Named: report.RefNamed(m)}
		if ss.identity != "" {
			_, err := os.Stat(s.refDir(ss))
			st.Stored = err == nil
		}
		ss.mu.Lock()
		st.Rev = ss.rev
		if ss.ref.job != nil {
			info := ss.ref.job.Info()
			st.Job = &info
		}
		ss.mu.Unlock()
		writeJSON(w, http.StatusOK, st)
	}
}

// refScriptHandler serves GET /s/{id}/api/ref/script?plans=.
func (s *Server) refScriptHandler(ss *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		plans := false
		if v := r.URL.Query().Get("plans"); v != "" {
			var err error
			if plans, err = strconv.ParseBool(v); err != nil {
				writeError(w, errorf(CodeBadRequest, "plans: %v", err))
				return
			}
		}
		m := ss.shownModelLocked()
		if m == nil {
			writeError(w, errorf(CodeConflict, "session %s is closed", ss.id))
			return
		}
		writeJSON(w, http.StatusOK, RefScript{
			Script: report.RefPasteScript(m, report.RefPasteOptions{Plans: plans}),
			Name:   report.RefPasteScriptName(m),
			Plans:  plans,
			Wanted: report.RefCountsOf(m),
		})
	}
}

// refPasteHandler serves POST /s/{id}/api/ref/paste {text}: 202.
func (s *Server) refPasteHandler(ss *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body RefPasteRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, refPasteMax))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			writeError(w, errorf(CodeBadRequest, "body: %v", err))
			return
		}
		if ss.identity == "" {
			writeError(w, errorf(CodeBadRequest, "reference data cannot be applied to a live session; open the file normally when the follow ends"))
			return
		}
		p := ref.ParsePaste(body.Text)
		if p.Bundle.Empty() {
			msg := fmt.Sprintf("no names in the pasted text: paste the whole output of the names script, from %q to %q", ref.PasteHeader, ref.PasteEnd)
			if len(p.Notes) > 0 {
				msg += "; the script said: " + strings.Join(p.Notes, "; ")
			}
			writeError(w, errorf(CodeBadRequest, "%s", msg))
			return
		}
		pasted := p.Bundle
		j, err := s.startRefJob(ss, nil, func(j *Job) error { return s.runRefPaste(j, ss, pasted) })
		if err != nil {
			writeError(w, err)
			return
		}
		notes := p.Notes
		if notes == nil {
			notes = []string{}
		}
		writeJSON(w, http.StatusAccepted, RefPasted{Job: j.Info(), Read: report.RefCountsOfBundle(pasted), Notes: notes, Complete: p.Tables || p.Header && p.End})
	}
}

// runRefPaste: merge the pasted names into the kept bundle, store and apply it.
func (s *Server) runRefPaste(j *Job, ss *Session, pasted *ref.Bundle) error {
	j.SetPhase("apply", "", 0, 0)
	st, err := s.stage()
	if err != nil {
		return err
	}
	defer os.RemoveAll(st)
	b := ref.NewBundle()
	b.Merge(s.loadStoredRef(ss)) // nil: nothing kept yet
	b.Merge(pasted)
	if err := ref.WriteBundle(b, st); err != nil {
		return err
	}
	return s.commitRef(j, ss, st, "pasted "+pasted.Summary())
}
