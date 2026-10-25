package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshcli"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshconn"
)

// Remote connections (docs/PLAN-DESKTOP.md § 2 "Remote", docs/REMOTE.md).
// The shell keeps the definitions; the engine holds them in memory with the
// credentials asked through its prompts, until DELETE or exit. Nothing is
// written to disk but the fetched traces, under <cache>/remote/<id>/.
//
// The routes live in this file and are appended to the route table at init,
// so the remote work stays out of server.go's table.
func init() {
	for _, r := range []struct {
		pattern string
		handler func(*Server, http.ResponseWriter, *http.Request)
	}{
		{"POST /engine/askpass", (*Server).askpass},
		{"GET /engine/connections", (*Server).listConnections},
		{"POST /engine/connections", (*Server).putConnection},
		{"DELETE /engine/connections/{id}", (*Server).deleteConnection},
		{"POST /engine/connections/{id}/test", (*Server).testConnection},
		{"GET /engine/connections/{id}/ls", (*Server).lsConnection},
		{"GET /engine/connections/{id}/diag", (*Server).diagConnection},
		{"POST /engine/connections/{id}/fetch", (*Server).fetchConnection},
		{"POST /engine/connections/{id}/follow", (*Server).followConnection},
	} {
		routes = append(routes, struct {
			pattern string
			handler func(*Server, http.ResponseWriter, *http.Request)
		}{r.pattern, r.handler})
	}
}

// Connection kinds.
const (
	ConnSSH = "ssh"
	ConnDB  = "db"
)

// ConnectionDef is the body of POST /engine/connections: a definition
// without secrets.
type ConnectionDef struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"` // ssh or db
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	Service   string `json:"service,omitempty"`   // db
	AdrHome   string `json:"adrHome,omitempty"`   // db
	Transport string `json:"transport,omitempty"` // ssh: auto (default), cli or lib
}

// ConnectionInfo is a connection as the engine reports it.
type ConnectionInfo struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	Service   string `json:"service,omitempty"`
	AdrHome   string `json:"adrHome,omitempty"`
	Transport string `json:"transport"`
	// Active is the SSH transport in use ("cli" or "lib"; "" before the
	// first operation). auto starts with cli and moves to lib for good when
	// ssh ignores SSH_ASKPASS.
	Active string `json:"active"`
}

// ConnectionTest is the answer of POST /engine/connections/{id}/test.
type ConnectionTest struct {
	Server    string `json:"server"`    // the host's uname -sr (and the SSH server version on lib)
	Transport string `json:"transport"` // cli or lib
}

// RemoteListing is the answer of GET /engine/connections/{id}/ls.
type RemoteListing struct {
	Path    string         `json:"path"`
	Entries []remote.Entry `json:"entries"`
}

// connection is one registered connection.
type connection struct {
	def ConnectionDef
	ans sshcli.Answerer // askpass answers of its ssh runs

	mu  sync.Mutex
	ssh remote.SSH // dialled on first use
}

// connRegistry is the engine's connections; the zero value is ready.
type connRegistry struct {
	mu    sync.Mutex
	m     map[string]*connection
	addr  string          // the engine's address, from the first request (for MTKPROF_ENGINE)
	files map[string]bool // local files a fetch or follow job is writing
}

var connIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// noteAddr remembers the address the engine is reached at.
func (s *Server) noteAddr(r *http.Request) {
	a, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok {
		return
	}
	host, port, err := net.SplitHostPort(a.String())
	if err != nil {
		return
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	s.conns.mu.Lock()
	s.conns.addr = net.JoinHostPort(host, port)
	s.conns.mu.Unlock()
}

func (c *connection) info() ConnectionInfo {
	d := c.def
	ci := ConnectionInfo{ID: d.ID, Kind: d.Kind, Host: d.Host, Port: d.Port, User: d.User, Service: d.Service, AdrHome: d.AdrHome, Transport: d.Transport}
	c.mu.Lock()
	if c.ssh != nil {
		ci.Active = c.ssh.Transport()
	}
	c.mu.Unlock()
	return ci
}

// close drops the connection and every credential held for it.
func (c *connection) close() {
	c.mu.Lock()
	s := c.ssh
	c.ssh = nil
	c.mu.Unlock()
	if s != nil {
		s.Close()
	}
	c.ans.Forget()
}

// closeConnections closes every connection (engine shutdown).
func (s *Server) closeConnections() {
	s.conns.mu.Lock()
	all := s.conns.m
	s.conns.m = nil
	s.conns.mu.Unlock()
	for _, c := range all {
		c.close()
	}
}

func (s *Server) connection(w http.ResponseWriter, r *http.Request) *connection {
	s.noteAddr(r)
	s.conns.mu.Lock()
	c := s.conns.m[r.PathValue("id")]
	s.conns.mu.Unlock()
	if c == nil {
		writeError(w, errorf(CodeNotFound, "no connection %q", r.PathValue("id")))
	}
	return c
}

// sshOf returns the connection's SSH client (created on first use); a db
// connection is a bad request until internal/remote/db is wired (E8).
func (s *Server) sshOf(c *connection) (remote.SSH, error) {
	if c.def.Kind != ConnSSH {
		return nil, errorf(CodeBadRequest, "%s connections: not implemented yet", c.def.Kind)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ssh != nil {
		return c.ssh, nil
	}
	s.conns.mu.Lock()
	addr := s.conns.addr
	s.conns.mu.Unlock()
	o := sshconn.Options{Transport: c.def.Transport, Conn: c.def.ID, Prompter: s.prompts,
		OnSwitch: func(err error) {
			s.logf("info", "connection %s: ssh did not use SSH_ASKPASS (%v); using the Go SSH library from now on", c.def.ID, err)
		}}
	if addr != "" {
		o.Askpass = sshcli.AskpassEnv{Engine: addr, Token: s.opts.Token, Conn: c.def.ID}
	} // else (no listener seen): sshconn answers ssh through an in-process bridge to the same prompts
	conn, err := sshconn.New(remote.Target{Host: c.def.Host, Port: c.def.Port, User: c.def.User}, o)
	if err != nil {
		return nil, errorf(CodeBadRequest, "%v", err)
	}
	c.ssh = conn
	return conn, nil
}

// remoteError maps a remote failure to the envelope: a cancelled prompt or
// request is cancelled, a rejected host key too, the rest is remote (502).
func remoteError(err error) error {
	var e *Error
	switch {
	case errors.As(err, &e):
		return e
	case errors.Is(err, ErrPromptCancelled), errors.Is(err, context.Canceled), errors.Is(err, remote.ErrNoTerminal):
		return errorf(CodeCancelled, "%v", err)
	}
	return errorf(CodeRemote, "%v", err)
}

// listConnections serves GET /engine/connections.
func (s *Server) listConnections(w http.ResponseWriter, r *http.Request) {
	s.noteAddr(r)
	s.conns.mu.Lock()
	out := make([]ConnectionInfo, 0, len(s.conns.m))
	for _, c := range s.conns.m {
		out = append(out, c.info())
	}
	s.conns.mu.Unlock()
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	writeJSON(w, http.StatusOK, struct {
		Connections []ConnectionInfo `json:"connections"`
	}{out})
}

// putConnection serves POST /engine/connections: adds or replaces a
// definition (a replaced one is closed and its credentials dropped; 409
// while a job of it runs).
func (s *Server) putConnection(w http.ResponseWriter, r *http.Request) {
	s.noteAddr(r)
	var d ConnectionDef
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: %v", err))
		return
	}
	if err := checkDef(&d); err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	if s.connectionBusy(d.ID) {
		writeError(w, errorf(CodeConflict, "connection %s has a running job", d.ID))
		return
	}
	c := &connection{def: d}
	c.ans.Prompter = s.prompts
	s.conns.mu.Lock()
	if s.conns.m == nil {
		s.conns.m = map[string]*connection{}
	}
	old := s.conns.m[d.ID]
	s.conns.m[d.ID] = c
	s.conns.mu.Unlock()
	if old != nil {
		old.close()
	}
	writeJSON(w, http.StatusOK, struct {
		Connection ConnectionInfo `json:"connection"`
	}{c.info()})
}

func checkDef(d *ConnectionDef) error {
	if !connIDRe.MatchString(d.ID) {
		return fmt.Errorf("id: want 1 to 64 of A-Z a-z 0-9 . _ - (not starting with . _ -)")
	}
	switch d.Kind {
	case ConnSSH:
		if d.Transport == "" {
			d.Transport = sshconn.Auto
		}
		if !sshconn.ValidTransport(d.Transport) {
			return fmt.Errorf("transport: want auto, cli or lib")
		}
		if err := (remote.Target{Host: d.Host, Port: d.Port, User: d.User}).Check(); err != nil {
			return fmt.Errorf("ssh: %v", err)
		}
	case ConnDB:
		if d.Host == "" || d.Port < 0 || d.Port > 65535 {
			return fmt.Errorf("db: want host and port")
		}
		if d.Transport != "" {
			return fmt.Errorf("transport: ssh connections only")
		}
	default:
		return fmt.Errorf("kind: want ssh or db")
	}
	return nil
}

// connectionBusy reports whether a job of connection id is running.
func (s *Server) connectionBusy(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, j := range s.jobs {
		if j.running() && j.Info().Connection == id {
			return true
		}
	}
	return false
}

// deleteConnection serves DELETE /engine/connections/{id}: cancels its jobs,
// drops the connection and its credentials. 204.
func (s *Server) deleteConnection(w http.ResponseWriter, r *http.Request) {
	s.noteAddr(r)
	id := r.PathValue("id")
	s.conns.mu.Lock()
	c := s.conns.m[id]
	delete(s.conns.m, id)
	s.conns.mu.Unlock()
	if c == nil {
		writeError(w, errorf(CodeNotFound, "no connection %q", id))
		return
	}
	s.mu.Lock()
	for _, j := range s.jobs {
		if j.running() && j.Info().Connection == id {
			j.cancel()
		}
	}
	s.mu.Unlock()
	c.close()
	w.WriteHeader(http.StatusNoContent)
}

// askpass serves POST /engine/askpass: the `mtkprof askpass` helper that a
// spawned ssh runs posts its prompt; the engine raises a prompt event and
// answers once the user has (from the connection's cache for a password or
// passphrase it already has).
func (s *Server) askpass(w http.ResponseWriter, r *http.Request) {
	var req sshcli.AskpassRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || req.Text == "" {
		writeError(w, errorf(CodeBadRequest, "body: want {connection, kind, text}"))
		return
	}
	if req.Kind != "" && !remote.ValidKind(req.Kind) {
		writeError(w, errorf(CodeBadRequest, "kind %q", req.Kind))
		return
	}
	s.conns.mu.Lock()
	c := s.conns.m[req.Connection]
	s.conns.mu.Unlock()
	ans := &sshcli.Answerer{Prompter: s.prompts} // no connection: nothing cached
	if c != nil {
		ans = &c.ans
	}
	a, err := ans.Answer(r.Context(), req)
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	writeJSON(w, http.StatusOK, sshcli.AskpassResponse{Answer: a})
}

// testConnection serves POST /engine/connections/{id}/test.
func (s *Server) testConnection(w http.ResponseWriter, r *http.Request) {
	c := s.connection(w, r)
	if c == nil {
		return
	}
	cl, err := s.sshOf(c)
	if err != nil {
		writeError(w, err)
		return
	}
	out, err := cl.Test(r.Context())
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	writeJSON(w, http.StatusOK, ConnectionTest{Server: out, Transport: cl.Transport()})
}

// lsConnection serves GET /engine/connections/{id}/ls?path=.
func (s *Server) lsConnection(w http.ResponseWriter, r *http.Request) {
	c := s.connection(w, r)
	if c == nil {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" || strings.ContainsAny(p, "\x00\r\n") {
		writeError(w, errorf(CodeBadRequest, "path: want a remote path"))
		return
	}
	cl, err := s.sshOf(c)
	if err != nil {
		writeError(w, err)
		return
	}
	ents, err := cl.Ls(r.Context(), p)
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	writeJSON(w, http.StatusOK, RemoteListing{Path: p, Entries: ents})
}

// diagConnection serves GET /engine/connections/{id}/diag.
func (s *Server) diagConnection(w http.ResponseWriter, r *http.Request) {
	c := s.connection(w, r)
	if c == nil {
		return
	}
	cl, err := s.sshOf(c)
	if err != nil {
		writeError(w, err)
		return
	}
	dirs, err := cl.Diag(r.Context())
	if err != nil {
		writeError(w, remoteError(err))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Dirs []string `json:"dirs"`
	}{dirs})
}

// maxFetchPaths bounds one fetch.
const maxFetchPaths = 100

// remoteDir is where connection id's files are fetched to.
func (s *Server) remoteDir(id string) string {
	return filepath.Join(filepath.Dir(s.cache.Dir()), "remote", id)
}

// localFor maps remote paths to <cache>/remote/<id>/<basename>; the base
// names must differ.
func (s *Server) localFor(id string, paths []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, len(paths))
	for i, p := range paths {
		base := path.Base(p)
		if p == "" || strings.ContainsAny(p, "\x00\r\n") || base == "/" || base == "." || base == ".." || strings.ContainsAny(base, `\:`) {
			return nil, fmt.Errorf("path %q: want a remote file", p)
		}
		if seen[base] {
			return nil, fmt.Errorf("two paths named %s", base)
		}
		seen[base] = true
		out[i] = filepath.Join(s.remoteDir(id), base)
	}
	return out, nil
}

// claim marks local files as written by a job; false when one already is.
func (s *Server) claim(files []string) bool {
	s.conns.mu.Lock()
	defer s.conns.mu.Unlock()
	if s.conns.files == nil {
		s.conns.files = map[string]bool{}
	}
	for _, f := range files {
		if s.conns.files[f] {
			return false
		}
	}
	for _, f := range files {
		s.conns.files[f] = true
	}
	return true
}

func (s *Server) release(files []string) {
	s.conns.mu.Lock()
	defer s.conns.mu.Unlock()
	for _, f := range files {
		delete(s.conns.files, f)
	}
}

// startRemoteJob registers a job of kind for connection c writing files,
// and runs work in the background (the job finishes with its error).
func (s *Server) startRemoteJob(w http.ResponseWriter, kind string, c *connection, files []string, work func(*Job) error) *Job {
	if !s.claim(files) {
		writeError(w, errorf(CodeConflict, "a job is writing %s already", strings.Join(files, ", ")))
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.release(files)
		writeError(w, errorf(CodeConflict, "the engine is shutting down"))
		return nil
	}
	j := s.newJobLocked(kind, "")
	j.info.Connection, j.info.Phase, j.info.Unit = c.def.ID, kind, "bytes"
	s.wg.Add(1)
	s.mu.Unlock()
	j.publish()
	go func() {
		defer s.wg.Done()
		defer s.release(files)
		err := work(j)
		if err != nil && j.ctx.Err() == nil && !errors.Is(err, context.Canceled) {
			s.logf("error", "connection %s: %s failed: %v", c.def.ID, kind, err)
		}
		j.finish(err)
	}()
	return j
}

// progress sets the job's byte counter; events at most every 200 ms (and
// always when force).
func (j *Job) progress(done int64, force bool, last *time.Time) {
	j.mu.Lock()
	j.info.Done = done
	if j.info.Total > 0 && done > j.info.Total {
		j.info.Total = done // the file grew while it was fetched
	}
	j.mu.Unlock()
	if force || time.Since(*last) >= 200*time.Millisecond {
		*last = time.Now()
		j.publish()
	}
}

// fetchConnection serves POST /engine/connections/{id}/fetch {paths, gzip}:
// 202 {job, localPaths}. The job (kind fetch) lists the remote sizes, then
// copies each file to <cache>/remote/<id>/<basename>, resuming a partial
// local file at its size (restarting it when it is longer than the remote
// one); progress in bytes over all files. Done: the job carries localPaths.
func (s *Server) fetchConnection(w http.ResponseWriter, r *http.Request) {
	c := s.connection(w, r)
	if c == nil {
		return
	}
	var body struct {
		Paths []string `json:"paths"`
		Gzip  *bool    `json:"gzip"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: %v", err))
		return
	}
	if len(body.Paths) == 0 || len(body.Paths) > maxFetchPaths {
		writeError(w, errorf(CodeBadRequest, "paths: want 1 to %d remote files", maxFetchPaths))
		return
	}
	locals, err := s.localFor(c.def.ID, body.Paths)
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "paths: %v", err))
		return
	}
	cl, err := s.sshOf(c)
	if err != nil {
		writeError(w, err)
		return
	}
	noGzip := body.Gzip != nil && !*body.Gzip
	paths := body.Paths
	j := s.startRemoteJob(w, "fetch", c, locals, func(j *Job) error {
		return s.runFetch(j, cl, paths, locals, noGzip)
	})
	if j == nil {
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		Job        JobInfo  `json:"job"`
		LocalPaths []string `json:"localPaths"`
	}{j.Info(), locals})
}

func (s *Server) runFetch(j *Job, cl remote.SSH, paths, locals []string, noGzip bool) error {
	ctx := j.Context()
	if err := os.MkdirAll(filepath.Dir(locals[0]), 0o700); err != nil {
		return err
	}
	sizes := make([]int64, len(paths))
	var total, done int64
	for i, p := range paths {
		e, err := remote.Stat(ctx, cl, p)
		if err != nil {
			return err
		}
		sizes[i] = e.Size
		total += e.Size
		if fi, err := os.Stat(locals[i]); err == nil && fi.Size() <= e.Size {
			done += fi.Size()
		}
	}
	j.mu.Lock()
	j.info.Total = total
	j.mu.Unlock()
	var last time.Time
	j.progress(done, true, &last)
	for i, p := range paths {
		base := done
		if fi, err := os.Stat(locals[i]); err == nil && fi.Size() <= sizes[i] {
			base -= fi.Size()
		}
		end, err := remote.FetchFile(ctx, cl, p, locals[i], sizes[i], noGzip, func(pos int64) { j.progress(base+pos, false, &last) })
		done = base + end
		j.progress(done, true, &last)
		if err != nil {
			return err
		}
	}
	j.mu.Lock()
	j.info.LocalPaths = locals
	j.mu.Unlock()
	return nil
}

// followConnection serves POST /engine/connections/{id}/follow {path,
// options, mirrorOnly}: 202 {session, job, localPath}. The job (kind follow)
// mirrors the remote file into <cache>/remote/<id>/<basename> (resuming at
// the local size) and keeps appending what the host writes, reconnecting
// after a drop, until it is cancelled (DELETE /engine/jobs/{id}); progress
// is the local size. The session is a live session over the local mirror
// (live.go, options as for POST /engine/sessions): DELETE of the session
// cancels the mirror, the end of the mirror fails the session (its last
// snapshot stays served). mirrorOnly: just the mirror, no session.
func (s *Server) followConnection(w http.ResponseWriter, r *http.Request) {
	c := s.connection(w, r)
	if c == nil {
		return
	}
	var body struct {
		Path       string         `json:"path"`
		Options    SessionOptions `json:"options"`
		MirrorOnly bool           `json:"mirrorOnly"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: %v", err))
		return
	}
	locals, err := s.localFor(c.def.ID, []string{body.Path})
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "path: %v", err))
		return
	}
	var spec liveSpec
	if !body.MirrorOnly {
		if spec, err = liveSpecOf([]string{locals[0]}, body.Options); err != nil {
			writeError(w, err)
			return
		}
	}
	cl, err := s.sshOf(c)
	if err != nil {
		writeError(w, err)
		return
	}
	p := body.Path
	started := make(chan struct{})
	j := s.startRemoteJob(w, "follow", c, locals, func(j *Job) error { return s.runFollow(j, cl, p, locals[0], started) })
	if j == nil {
		return
	}
	if body.MirrorOnly {
		writeJSON(w, http.StatusAccepted, struct {
			Job       JobInfo `json:"job"`
			LocalPath string  `json:"localPath"`
		}{j.Info(), locals[0]})
		return
	}
	spec.mirror, spec.started = j, started
	ss, err := s.startLive(spec)
	if err != nil {
		j.cancel()
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		Session   SessionInfo `json:"session"`
		Job       JobInfo     `json:"job"`
		LocalPath string      `json:"localPath"`
	}{ss.Info(), j.Info(), locals[0]})
}

// runFollow is the follow job; started (if not nil) is closed once the
// local file is open at the offset the mirror appends at.
func (s *Server) runFollow(j *Job, cl remote.SSH, p, local string, started chan<- struct{}) error {
	ctx := j.Context()
	if err := os.MkdirAll(filepath.Dir(local), 0o700); err != nil {
		return err
	}
	e, err := remote.Stat(ctx, cl, p)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(local, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	off, err := f.Seek(0, io.SeekEnd)
	if err == nil && off > e.Size {
		if err = f.Truncate(0); err == nil {
			off, err = f.Seek(0, io.SeekStart)
		}
	}
	if err != nil {
		return err
	}
	j.mu.Lock()
	j.info.LocalPaths = []string{local}
	j.mu.Unlock()
	if started != nil {
		close(started)
	}
	var last time.Time
	j.progress(off, true, &last)
	err = remote.FollowTo(ctx, cl, p, f, off, func(pos int64) { j.progress(pos, false, &last) },
		func(format string, a ...any) { s.logf("info", format, a...) })
	end, _ := f.Seek(0, io.SeekCurrent)
	j.progress(end, true, &last)
	return err
}
