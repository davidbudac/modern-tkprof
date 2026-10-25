package engine

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/db"
)

// Oracle connections (kind "db", docs/REMOTE.md part 2): the routes below
// are the db side of /engine/connections; test, diag and fetch share their
// route with ssh (connections.go dispatches on the kind).
func init() {
	for _, r := range []struct {
		pattern string
		handler func(*Server, http.ResponseWriter, *http.Request)
	}{
		{"GET /engine/connections/{id}/tracefiles", (*Server).tracefilesConnection},
		{"GET /engine/connections/{id}/sessions", (*Server).sessionsConnection},
		{"POST /engine/connections/{id}/trace", (*Server).traceConnection},
	} {
		routes = append(routes, struct {
			pattern string
			handler func(*Server, http.ResponseWriter, *http.Request)
		}{r.pattern, r.handler})
	}
}

// dbDriver is the Oracle driver; tests replace it with a fake.
var dbDriver db.Driver = db.GoOra{}

// DBDiag is the part of V$DIAG_INFO the engine reports.
type DBDiag struct {
	ADRHome  string `json:"adrHome"`  // ADR Home
	TraceDir string `json:"traceDir"` // Diag Trace
}

// dbState is what a db connection holds: the password (in memory, like the
// SSH answerer's cache) and one open session, pinned until the connection is
// deleted. Long jobs (fetch, ref) use sessions of their own so they do not
// block the quick calls.
type dbState struct {
	use sync.Mutex // one statement at a time on cl; held while it is opened (and the password asked)

	mu     sync.Mutex // guards the rest
	cl     *db.Client
	pw     string
	gone   context.Context // ends when the connection is closed
	cancel context.CancelFunc
}

// ctx is the context that ends with the connection.
func (d *dbState) ctx() context.Context {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.gone == nil {
		d.gone, d.cancel = context.WithCancel(context.Background())
	}
	return d.gone
}

// close ends the connection's operations, closes its session and forgets the
// password.
func (d *dbState) close() {
	d.ctx()
	d.mu.Lock()
	d.cancel()
	cl := d.cl
	d.cl, d.pw = nil, ""
	d.mu.Unlock()
	if cl != nil {
		cl.Close()
	}
}

// opCtx is ctx that also ends when the connection is closed.
func (d *dbState) opCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(d.ctx(), cancel)
	return ctx, func() { stop(); cancel() }
}

// pwPrompter hands db.OpenWith the connection's password: the cached one for
// the first question of an open, the user (through the engine prompts) for
// the rest, which only come after a rejected password (ORA-01017).
type pwPrompter struct {
	c       *connection
	p       remote.Prompter
	offered bool
}

func (w *pwPrompter) Ask(ctx context.Context, q remote.Prompt) (string, error) {
	d := &w.c.dbs
	if q.Kind == remote.KindPassword {
		d.mu.Lock()
		pw := d.pw
		d.mu.Unlock()
		if pw != "" && !w.offered {
			w.offered = true
			return pw, nil
		}
		w.offered = true
	}
	a, err := w.p.Ask(ctx, q)
	if err == nil && q.Kind == remote.KindPassword && a != "" {
		d.mu.Lock()
		d.pw = a
		d.mu.Unlock()
	}
	return a, err
}

// ctxDriver connects with a context of its own: the session lives on after
// the request (or the prompt) that opened it.
type ctxDriver struct {
	d   db.Driver
	ctx context.Context
}

func (c ctxDriver) Connect(_ context.Context, s db.Spec, pw string, tls bool) (db.Conn, error) {
	return c.d.Connect(c.ctx, s, pw, tls)
}

// dbOpen opens a session of c: the password from the cache, else asked
// through the engine's prompts (promptCtx); the session lives until connCtx
// ends or it is closed.
func (s *Server) dbOpen(promptCtx, connCtx context.Context, c *connection) (*db.Client, error) {
	d := c.def
	sp := db.Spec{ID: d.ID, User: d.User, Host: d.Host, Port: d.Port, Service: d.Service, TLSSkipVerify: d.TLSSkipVerify}
	cl, err := db.OpenWith(promptCtx, ctxDriver{dbDriver, connCtx}, sp, &pwPrompter{c: c, p: s.prompts}, d.TCPS)
	if err != nil {
		c.dbs.mu.Lock()
		c.dbs.pw = "" // not accepted (or never asked)
		c.dbs.mu.Unlock()
		return nil, err
	}
	return cl, nil
}

// dbDo runs fn on the connection's pinned session (opened on first use, one
// call at a time). A session the network dropped is closed, so the next call
// reconnects with the cached password.
func (s *Server) dbDo(ctx context.Context, c *connection, fn func(context.Context, *db.Client) error) error {
	d := &c.dbs
	ctx, done := d.opCtx(ctx)
	defer done()
	d.use.Lock()
	defer d.use.Unlock()
	d.mu.Lock()
	cl := d.cl
	d.mu.Unlock()
	if cl == nil {
		var err error
		if cl, err = s.dbOpen(ctx, d.ctx(), c); err != nil {
			return err
		}
		d.mu.Lock()
		if d.gone.Err() != nil { // closed while it connected
			d.mu.Unlock()
			cl.Close()
			return context.Canceled
		}
		d.cl = cl
		d.mu.Unlock()
	}
	err := fn(ctx, cl)
	if lostConn(err) {
		d.mu.Lock()
		if d.cl == cl {
			d.cl = nil
		}
		d.mu.Unlock()
		cl.Close()
	}
	return err
}

// lostConn reports whether err says the session is gone.
func lostConn(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	for _, code := range []int{3113, 3114, 3135, 12170, 12537, 28} { // end-of-file on channel, not connected, lost contact, timeout, closed, session killed
		if db.IsORA(err, code) {
			return true
		}
	}
	m := err.Error()
	return strings.Contains(m, "connection reset") || strings.Contains(m, "broken pipe") || strings.Contains(m, "use of closed network connection")
}

// dbHandler is the head of every db route: the connection (404), whether it
// is a db one (400).
func (s *Server) dbHandler(w http.ResponseWriter, r *http.Request) *connection {
	c := s.connection(w, r)
	if c == nil {
		return nil
	}
	if c.def.Kind != ConnDB {
		writeError(w, errorf(CodeBadRequest, "%s connections do not do this (db connections only)", c.def.Kind))
		return nil
	}
	return c
}

func checkDBDef(d *ConnectionDef) error {
	if d.Host == "" || d.Port < 0 || d.Port > 65535 {
		return fmt.Errorf("db: want host and port")
	}
	for _, f := range []struct{ name, v string }{{"host", d.Host}, {"user", d.User}, {"service", d.Service}} {
		if f.v == "" || strings.ContainsAny(f.v, " \t\r\n\x00/@\\?") {
			return fmt.Errorf("db: %s: want a name (no spaces or / @ \\ ?)", f.name)
		}
	}
	if d.Transport != "" {
		return fmt.Errorf("transport: ssh connections only")
	}
	if d.TLSSkipVerify && !d.TCPS {
		return fmt.Errorf("tlsSkipVerify: needs tcps")
	}
	return nil
}

func (c *connection) dbTransport() string {
	if c.def.TCPS {
		return "tcps"
	}
	return "tcp"
}

// testDB serves POST /engine/connections/{id}/test for a db connection:
// connects (asking for the password once), reports the server version and
// V$DIAG_INFO.
func (s *Server) testDB(w http.ResponseWriter, r *http.Request, c *connection) {
	out := ConnectionTest{Transport: c.dbTransport()}
	err := s.dbDo(r.Context(), c, func(ctx context.Context, cl *db.Client) error {
		v, err := cl.Version(ctx)
		if err != nil {
			return err
		}
		out.Server = v
		if di, err := cl.DiagInfo(ctx); err == nil {
			out.Diag = &DBDiag{ADRHome: di.ADRHome, TraceDir: di.DiagTrace}
		} else if ctx.Err() != nil {
			return ctx.Err()
		}
		return nil
	})
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// diagDB serves GET /engine/connections/{id}/diag for a db connection: the
// trace directory of V$DIAG_INFO (a list, as for ssh) and the ADR home.
func (s *Server) diagDB(w http.ResponseWriter, r *http.Request, c *connection) {
	var di db.DiagInfo
	err := s.dbDo(r.Context(), c, func(ctx context.Context, cl *db.Client) (err error) {
		di, err = cl.DiagInfo(ctx)
		return err
	})
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	dirs := []string{}
	if di.DiagTrace != "" {
		dirs = append(dirs, di.DiagTrace)
	}
	writeJSON(w, http.StatusOK, struct {
		Dirs    []string `json:"dirs"`
		ADRHome string   `json:"adrHome"`
	}{dirs, di.ADRHome})
}

// parseSince reads the since parameter: a duration back from now (Go
// syntax, or Nd for days) or an RFC 3339 time.
func parseSince(v string, now time.Time) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	if n, ok := strings.CutSuffix(v, "d"); ok {
		if days, err := strconv.ParseFloat(n, 64); err == nil && days > 0 {
			return now.Add(-time.Duration(days * 24 * float64(time.Hour))), nil
		}
	}
	if d, err := time.ParseDuration(v); err == nil {
		if d <= 0 {
			return time.Time{}, fmt.Errorf("since %q: want a positive duration", v)
		}
		return now.Add(-d), nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, fmt.Errorf("since %q: want a duration (2h, 30m, 1d) or an RFC 3339 time", v)
	}
	return t, nil
}

func queryInt(q map[string][]string, name string) (int, error) {
	v := ""
	if vs := q[name]; len(vs) > 0 {
		v = vs[0]
	}
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s %q: want a number", name, v)
	}
	return n, nil
}

// tracefilesConnection serves GET /engine/connections/{id}/tracefiles?sid&serial&since.
func (s *Server) tracefilesConnection(w http.ResponseWriter, r *http.Request) {
	c := s.dbHandler(w, r)
	if c == nil {
		return
	}
	q := r.URL.Query()
	var f db.Filter
	var err error
	if f.SID, err = queryInt(q, "sid"); err == nil {
		f.Serial, err = queryInt(q, "serial")
	}
	if err == nil {
		f.Since, err = parseSince(q.Get("since"), time.Now())
	}
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	var files []db.TraceFile
	err = s.dbDo(r.Context(), c, func(ctx context.Context, cl *db.Client) (err error) {
		files, err = cl.TraceFiles(ctx, f)
		return err
	})
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	if files == nil {
		files = []db.TraceFile{}
	}
	writeJSON(w, http.StatusOK, struct {
		Files []db.TraceFile `json:"files"`
	}{files})
}

// sessionsConnection serves GET /engine/connections/{id}/sessions: the
// user sessions of V$SESSION, newest logon first.
func (s *Server) sessionsConnection(w http.ResponseWriter, r *http.Request) {
	c := s.dbHandler(w, r)
	if c == nil {
		return
	}
	var ss []db.Session
	err := s.dbDo(r.Context(), c, func(ctx context.Context, cl *db.Client) (err error) {
		ss, err = cl.Sessions(ctx)
		return err
	})
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	if ss == nil {
		ss = []db.Session{}
	}
	writeJSON(w, http.StatusOK, struct {
		Sessions []db.Session `json:"sessions"`
	}{ss})
}

// traceConnection serves POST /engine/connections/{id}/trace: SQL trace of a
// session on or off (DBMS_MONITOR), or of the connection's own session
// (self, DBMS_SESSION).
func (s *Server) traceConnection(w http.ResponseWriter, r *http.Request) {
	c := s.dbHandler(w, r)
	if c == nil {
		return
	}
	var body struct {
		SID      int    `json:"sid"`
		Serial   int    `json:"serial"`
		Enable   *bool  `json:"enable"`
		Waits    *bool  `json:"waits"`
		Binds    *bool  `json:"binds"`
		PlanStat string `json:"planStat"`
		Self     bool   `json:"self"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: %v", err))
		return
	}
	switch {
	case body.Enable == nil:
		writeError(w, errorf(CodeBadRequest, "enable: want true or false"))
		return
	case !body.Self && (body.SID <= 0 || body.Serial <= 0):
		writeError(w, errorf(CodeBadRequest, "sid, serial: want the session's SID and SERIAL# (or self: true)"))
		return
	case body.Self && (body.SID != 0 || body.Serial != 0):
		writeError(w, errorf(CodeBadRequest, "self: true takes no sid or serial"))
		return
	case !db.ValidPlanStat(body.PlanStat):
		writeError(w, errorf(CodeBadRequest, "planStat: want never, first_execution or all_executions"))
		return
	}
	enable := *body.Enable
	o := db.TraceOptions{Waits: body.Waits == nil || *body.Waits, Binds: body.Binds == nil || *body.Binds, PlanStat: body.PlanStat}
	if o.PlanStat == "" {
		o.PlanStat = "all_executions"
	}
	var traceFile string
	err := s.dbDo(r.Context(), c, func(ctx context.Context, cl *db.Client) error {
		if body.Self {
			if err := cl.MyTrace(ctx, enable); err != nil {
				return err
			}
			if di, err := cl.DiagInfo(ctx); enable && err == nil {
				traceFile = di.DefaultTraceFile
			}
			return nil
		}
		if err := cl.Trace(ctx, body.SID, body.Serial, enable, o); err != nil {
			return err
		}
		if ss, err := cl.Sessions(ctx); enable && err == nil { // the file the session writes
			for _, x := range ss {
				if x.SID == body.SID && x.Serial == body.Serial {
					traceFile = x.TraceFile
				}
			}
		}
		return nil
	})
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Enabled   bool   `json:"enabled"`
		TraceFile string `json:"traceFile,omitempty"`
	}{enable, traceFile})
}

// fetchDB serves POST /engine/connections/{id}/fetch {adrHome, name} for a
// db connection: 202 {job, localPaths}. The job (kind fetch, unit lines)
// copies the trace file out of V$DIAG_TRACE_FILE_CONTENTS, on a session of
// its own, to <cache>/remote/<id>/<name>, continuing a partial local file
// after its last complete line.
func (s *Server) fetchDB(w http.ResponseWriter, r *http.Request, c *connection) {
	var body struct {
		AdrHome string `json:"adrHome"`
		Name    string `json:"name"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: %v", err))
		return
	}
	if body.Name == "" || strings.ContainsAny(body.Name, "/\\:\x00\r\n") || body.Name == "." || body.Name == ".." || strings.ContainsAny(body.AdrHome, "\x00\r\n") {
		writeError(w, errorf(CodeBadRequest, "name: want a trace file name (TRACE_FILENAME), not a path"))
		return
	}
	adr := body.AdrHome
	if adr == "" {
		adr = c.def.AdrHome
	}
	locals, err := s.localFor(c.def.ID, []string{body.Name})
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "name: %v", err))
		return
	}
	name := body.Name
	j := s.startRemoteJobUnit(w, "fetch", "lines", c, locals, func(j *Job) error {
		return s.runDBFetch(j, c, adr, name, locals[0])
	})
	if j == nil {
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		Job        JobInfo  `json:"job"`
		LocalPaths []string `json:"localPaths"`
	}{j.Info(), locals})
}

// countW counts the bytes written through it.
type countW struct {
	w io.Writer
	n int64
}

func (c *countW) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func (s *Server) runDBFetch(j *Job, c *connection, adrHome, name, local string) error {
	ctx := j.Context()
	if err := os.MkdirAll(filepath.Dir(local), 0o700); err != nil {
		return err
	}
	f, from, err := db.OpenResume(local, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	cl, err := s.dbOpen(ctx, ctx, c)
	if err != nil {
		return err
	}
	defer cl.Close()
	if adrHome == "" {
		di, err := cl.DiagInfo(ctx)
		if err != nil {
			return err
		}
		adrHome = di.ADRHome
	}
	have, _ := f.Seek(0, io.SeekCurrent)
	cw := &countW{w: f, n: have}
	j.SetPhase("fetch", "lines", from.Lines, 0)
	var last time.Time
	warned := false
	n, err := cl.Fetch(ctx, adrHome, name, cw, from, func(lines int64) {
		if cw.n > db.BigFetch && !warned {
			warned = true
			j.mu.Lock()
			j.info.Message = "past 200 MB: V$DIAG_TRACE_FILE_CONTENTS is slow, fetching over SSH is faster for big files"
			j.mu.Unlock()
		}
		j.progress(from.Lines+lines, true, &last)
	})
	j.progress(from.Lines+n, true, &last)
	if err != nil {
		return err
	}
	if from.Lines+n == 0 {
		return fmt.Errorf("fetch %s/%s: no lines (wrong adrHome or name, or the file is not visible from this container)", adrHome, name)
	}
	j.mu.Lock()
	j.info.LocalPaths = []string{local}
	j.mu.Unlock()
	return nil
}
