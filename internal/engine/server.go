// Package engine is the control plane of `mtkprof engine`, the desktop
// app's sidecar (docs/PLAN-DESKTOP.md § 2): sessions (open traces), jobs
// with cancellation, prompts and an SSE event stream over loopback HTTP with
// a bearer token. Each ready session mounts the handlers of `serve -spill`
// at /s/{id}/.
package engine

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// Protocol is the engine protocol version; it increments on a breaking change.
const Protocol = 1

// Options configure a Server.
type Options struct {
	Token        string   // bearer token every request but GET /engine/health must carry
	AllowOrigins []string // CORS origins (exact match); none = no CORS headers
	CacheDir     string   // parent of the session spill directories ("" = os.TempDir())
	Version      string   // engine version, reported by health
	// Logf receives the engine's log lines (also sent as log events); nil = discarded.
	Logf func(format string, a ...any)
	// KeepAlive is the interval of the SSE keepalive comment (0 = 15 s).
	KeepAlive time.Duration
}

// Server is the engine. It is safe for concurrent use.
type Server struct {
	opts      Options
	token     []byte
	origins   map[string]bool
	keepAlive time.Duration
	started   time.Time

	ctx     context.Context // ends at Close; parent of every job context
	cancel  context.CancelFunc
	bc      *broadcaster
	prompts *prompts
	wg      sync.WaitGroup // open goroutines

	mu       sync.Mutex
	sessions map[string]*Session
	jobs     map[string]*Job
	closed   bool

	inflight   atomic.Int64
	lastActive atomic.Int64 // unix ns
}

// New returns the engine server.
func New(o Options) *Server {
	if o.CacheDir == "" {
		o.CacheDir = os.TempDir()
	}
	ka := o.KeepAlive
	if ka <= 0 {
		ka = 15 * time.Second
	}
	s := &Server{opts: o, token: []byte(o.Token), origins: map[string]bool{}, keepAlive: ka, started: time.Now(),
		bc: newBroadcaster(), sessions: map[string]*Session{}, jobs: map[string]*Job{}}
	s.prompts = newPrompts(s.bc)
	s.ctx, s.cancel = context.WithCancel(context.Background())
	for _, o := range o.AllowOrigins {
		if o = strings.TrimSpace(o); o != "" {
			s.origins[o] = true
		}
	}
	s.lastActive.Store(time.Now().UnixNano())
	sweepSpills(o.CacheDir)
	return s
}

// Prompter is the engine's prompt mechanism: Ask raises a prompt event and
// waits for POST /engine/prompts/{id}.
func (s *Server) Prompter() remote.Prompter { return s.prompts }

// Handler returns the engine's HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /engine/health", s.health)
	mux.HandleFunc("GET /engine/events", s.events)
	mux.HandleFunc("POST /engine/prompts/{id}", s.answerPrompt)
	mux.HandleFunc("POST /engine/sessions", s.openSession)
	mux.HandleFunc("GET /engine/sessions", s.listSessions)
	mux.HandleFunc("GET /engine/sessions/{id}", s.getSession)
	mux.HandleFunc("DELETE /engine/sessions/{id}", s.deleteSession)
	mux.HandleFunc("GET /engine/jobs", s.listJobs)
	mux.HandleFunc("DELETE /engine/jobs/{id}", s.cancelJob)
	mux.HandleFunc("/s/{id}/", s.sessionAPI)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errorf(CodeNotFound, "no route %s %s", r.Method, r.URL.Path))
	})
	return s.cors(s.track(s.auth(mux)))
}

// cors answers preflights and sets Access-Control-Allow-Origin for the
// configured origins only (never "*"). Preflights carry no Authorization
// header, so they are answered before the token check.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := origin != "" && s.origins[origin]
		if origin != "" {
			w.Header().Add("Vary", "Origin")
		}
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "X-Total-Lines")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if allowed {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// auth requires the bearer token on every route but GET /engine/health.
func (s *Server) auth(next http.Handler) http.Handler {
	want := append([]byte("Bearer "), s.token...)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/engine/health" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			next.ServeHTTP(w, r)
			return
		}
		got := []byte(r.Header.Get("Authorization"))
		if len(s.token) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
			writeError(w, errorf(CodeUnauthorized, "missing or wrong bearer token"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// track counts requests in flight for IdleFor.
func (s *Server) track(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.inflight.Add(1)
		s.lastActive.Store(time.Now().UnixNano())
		defer func() {
			s.lastActive.Store(time.Now().UnixNano())
			s.inflight.Add(-1)
		}()
		next.ServeHTTP(w, r)
	})
}

// IdleFor is how long the engine has had no sessions and no requests (an
// open event stream counts as a request); 0 while it has either.
func (s *Server) IdleFor() time.Duration {
	if s.inflight.Load() > 0 {
		return 0
	}
	s.mu.Lock()
	n := len(s.sessions)
	s.mu.Unlock()
	if n > 0 {
		return 0
	}
	return time.Since(time.Unix(0, s.lastActive.Load()))
}

// Health is the answer of GET /engine/health.
type Health struct {
	Version  string      `json:"version"`
	Protocol int         `json:"protocol"`
	Uptime   int64       `json:"uptime"` // seconds
	Sessions int         `json:"sessions"`
	Cache    CacheHealth `json:"cache"`
}

// CacheHealth is the index cache's size (filled by the persistent cache).
type CacheHealth struct {
	Bytes   int64 `json:"bytes"`
	Entries int   `json:"entries"`
	Cap     int64 `json:"cap"`
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	n := len(s.sessions)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, Health{Version: s.opts.Version, Protocol: Protocol,
		Uptime: int64(time.Since(s.started) / time.Second), Sessions: n})
}

// Close stops the engine: cancels every job and prompt, ends the event
// streams, waits for the open goroutines and closes every session (their
// spill directories are removed). Requests still running on a session may
// fail.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	s.cancel()
	s.prompts.close()
	s.bc.close()
	s.wg.Wait()
	s.mu.Lock()
	var all []*Session
	for id, ss := range s.sessions {
		all = append(all, ss)
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	for _, ss := range all {
		ss.close()
	}
	return nil
}

func (s *Server) logf(level, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if s.opts.Logf != nil {
		s.opts.Logf("%s", msg)
	}
	s.bc.publish("log", LogEvent{Level: level, Message: msg})
}

// newID is a random id with a one-letter kind prefix (s session, j job, p prompt).
func newID(prefix string) string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b[:])
}
