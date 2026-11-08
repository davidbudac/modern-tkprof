package slice

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/cut"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// The cut endpoints (internal/cut; the desktop's Cut view), served with
// WithLines (they read the trace files):
//
//	/api/cut        the plan of the new file: its pieces and where every source line goes
//	/api/cut/check  the new file written to a temporary file, parsed back and compared with the selection
//	                (at most MaxCheckBytes unless force=1; one check at a time, see runCheck)
//	/api/cut/file   the new file (text/plain, an attachment)
//
// Parameters: the scope (from, to, contexts, stmt: the units are the
// statement's calls instead of whole top-level calls), edges=calls|executions,
// binds=keep|mask|none (default: keep, or what the session's bind mode
// allows), plans=0 (do not borrow plans from outside the cut) and prov=0 (no
// provenance lines).

func (s *Server) cutter() *cut.Cutter {
	s.cutOnce.Do(func() { s.cut = cut.New(s.m, s.src, s.lis) })
	return s.cut
}

// cutBinds are the bind modes a cut of this model may use: a model whose
// bind values were redacted or dropped must not get them back from the trace
// text.
func (s *Server) cutBinds() []cut.Binds {
	switch s.m.Diag.BindMode {
	case model.BindsRedact.String():
		return []cut.Binds{cut.BindsMask, cut.BindsNone}
	case model.BindsNone.String():
		return []cut.Binds{cut.BindsNone}
	}
	return []cut.Binds{cut.BindsKeep, cut.BindsMask, cut.BindsNone}
}

func (s *Server) cutSelection(q url.Values) (cut.Selection, error) {
	f, err := s.filter(q, false)
	if err != nil {
		return cut.Selection{}, err
	}
	sel := cut.Selection{From: f.StartTim, To: f.EndTim, Contexts: f.Contexts, NoContexts: f.NoContexts, Statement: f.Statement, Salt: s.CutSalt}
	switch q.Get("edges") {
	case "", "calls":
	case "executions":
		sel.Executions = true
	default:
		return sel, bad("edges %q: calls|executions", q.Get("edges"))
	}
	allowed := s.cutBinds()
	sel.Binds = allowed[0]
	if v := q.Get("binds"); v != "" {
		b, err := cut.ParseBinds(v)
		if err != nil {
			return sel, bad("%v", err)
		}
		ok := false
		for _, a := range allowed {
			ok = ok || a == b
		}
		if !ok {
			return sel, bad("binds=%s: the session's bind values are %s", v, s.m.Diag.BindMode)
		}
		sel.Binds = b
	}
	sel.NoPlans = q.Get("plans") == "0"
	sel.NoProvenance = q.Get("prov") == "0"
	return sel, nil
}

func (s *Server) cutPlan(ctx context.Context, q url.Values) (any, error) {
	sel, err := s.cutSelection(q)
	if err != nil {
		return nil, err
	}
	p, err := s.cutter().Plan(ctx, sel)
	if err != nil {
		return nil, err
	}
	for _, b := range s.cutBinds() {
		p.BindsAllowed = append(p.BindsAllowed, b.String())
	}
	return p, nil
}

func (s *Server) cutCheck(ctx context.Context, q url.Values) (any, error) {
	force := false
	switch q.Get("force") {
	case "", "0":
	case "1":
		force = true
	default:
		return nil, bad("force %q: 0|1", q.Get("force"))
	}
	sel, err := s.cutSelection(q)
	if err != nil {
		return nil, err
	}
	max := s.MaxCheckBytes
	if max <= 0 {
		max = DefaultMaxCheckBytes
	}
	if force {
		max = 0
	}
	q.Del("force")
	ck, err := s.runCheck(ctx, q.Encode(), func(ctx context.Context) (*cut.Check, error) {
		return s.cutter().CheckMax(ctx, sel, s.CutDir, max)
	})
	var tb *cut.TooBigError
	if errors.As(err, &tb) {
		return nil, bad("%v: ask with force=1 to check it anyway", err)
	}
	return ck, err
}

// checkRun is a /api/cut/check in flight: its selection (the query without
// force) and the requests waiting for its answer.
type checkRun struct {
	key     string
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{} // closed when run returned
	waiters int
	res     *cut.Check
	err     error
}

// errSuperseded is the answer of a check that a check of another selection
// replaced.
var errSuperseded = errors.New("cut check: replaced by the check of another selection")

// runCheck runs one check at a time per server: the UI only ever wants the
// answer for its current selection, and a check writes and parses the whole
// new file. A request for the selection being checked waits for that check;
// a request for another selection cancels it (its waiters get
// errSuperseded) and starts once it has stopped. A check whose waiters all
// went away (the client aborted) is cancelled too. The check runs on its own
// context, so one waiter leaving does not cancel it for the others.
func (s *Server) runCheck(ctx context.Context, key string, run func(context.Context) (*cut.Check, error)) (*cut.Check, error) {
	s.checkMu.Lock()
	c := s.check
	if c == nil || c.key != key || c.cancelled() {
		prev := c
		if prev != nil {
			prev.cancel()
		}
		cctx, cancel := context.WithCancel(context.Background())
		c = &checkRun{key: key, ctx: cctx, cancel: cancel, done: make(chan struct{})}
		s.check = c
		go func() {
			defer func() {
				cancel()
				s.checkMu.Lock()
				if s.check == c {
					s.check = nil
				}
				s.checkMu.Unlock()
				close(c.done)
			}()
			if prev != nil {
				<-prev.done // one parse at a time: the cancelled one stops within a read buffer
			}
			if cctx.Err() != nil {
				c.err = errSuperseded
				return
			}
			c.res, c.err = run(cctx)
			if c.err != nil && cctx.Err() != nil {
				c.err = errSuperseded
			}
		}()
	}
	c.waiters++
	s.checkMu.Unlock()
	select {
	case <-c.done:
	case <-ctx.Done():
	}
	s.checkMu.Lock()
	c.waiters--
	finished := false
	select {
	case <-c.done:
		finished = true
	default:
		if c.waiters == 0 {
			c.cancel() // nobody wants it any more
		}
	}
	s.checkMu.Unlock()
	if !finished {
		return nil, ctx.Err()
	}
	return c.res, c.err
}

// cancelled reports whether the run was cancelled (it is on its way out: a
// new request for its selection starts a new run after it).
func (c *checkRun) cancelled() bool { return c.ctx.Err() != nil }

// cutFileName is the new file's name: the first input's, with -cut before .trc.
func (s *Server) cutFileName() string {
	n := s.m.File.Files[0].Name
	ext := filepath.Ext(n)
	if ext == "" {
		ext = ".trc"
	}
	return strings.TrimSuffix(n, filepath.Ext(n)) + "-cut" + ext
}

func (s *Server) cutFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	sel, err := s.cutSelection(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, s.cutFileName()))
	if r.Method == http.MethodHead {
		return
	}
	cw := &countWriter{w: w}
	if _, err := s.cutter().Write(r.Context(), sel, cw); err != nil {
		if cw.n == 0 {
			w.Header().Del("Content-Disposition")
			http.Error(w, "cut: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// the status line is gone: end the stream short so the client sees a broken file
		fmt.Fprintf(os.Stderr, "mtkprof: cut: %v\n", err)
		panic(http.ErrAbortHandler)
	}
}

type countWriter struct {
	w http.ResponseWriter
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
