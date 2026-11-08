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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/assist"
	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// Protocol is the engine protocol version; it increments on a breaking change.
const Protocol = 1

// Options configure a Server.
type Options struct {
	Token        string   // bearer token every request but GET /engine/health must carry
	AllowOrigins []string // CORS origins (exact match); none = no CORS headers
	// Cache is the persistent index cache every session is opened from; nil:
	// New opens the one at CacheDir ("" = CacheDefaultDir()) with CacheCap
	// (<= 0 = CacheDefaultCap).
	Cache    *Cache
	CacheDir string
	CacheCap int64
	Version  string // engine version, reported by health
	// PlanVizURL is the plan visualizer base URL of the JSON and HTML
	// reports ("" = report.DefaultPlanVizURL, the CLI's default).
	PlanVizURL string
	// Logf receives the engine's log lines (also sent as log events); nil = discarded.
	Logf func(format string, a ...any)
	// KeepAlive is the interval of the SSE keepalive comment (0 = 15 s).
	KeepAlive time.Duration
	// IdleEvict closes a ready session that has had no request on its /s/{id}
	// mount (a pending doc long-poll counts) and no running job for this
	// long, as DELETE does (its cache entry stays). 0 = never.
	IdleEvict time.Duration
}

// Server is the engine. It is safe for concurrent use.
type Server struct {
	opts      Options
	cache     *Cache
	token     []byte
	origins   map[string]bool
	keepAlive time.Duration
	started   time.Time

	ctx     context.Context // ends at Close; parent of every job context
	cancel  context.CancelFunc
	bc      *broadcaster
	prompts *prompts
	wg      sync.WaitGroup // open goroutines

	conns connRegistry  // connections.go
	convs conversations // assist.go
	keys  *assist.Keys  // the assistant providers' API keys, in memory

	mu       sync.Mutex
	sessions map[string]*Session
	jobs     map[string]*Job
	closed   bool

	// refMu orders the kept reference bundles (ref.go): a commit (store, apply
	// to every open session of the trace) against a session's open (read the
	// kept bundle, become ready). refGen counts the commits per trace identity.
	refMu  sync.Mutex
	refGen map[string]uint64

	inflight   atomic.Int64
	lastActive atomic.Int64 // unix ns
}

// New returns the engine server.
func New(o Options) (*Server, error) {
	c := o.Cache
	if c == nil {
		var err error
		if c, err = OpenCache(o.CacheDir, o.CacheCap); err != nil {
			return nil, fmt.Errorf("cache: %w", err)
		}
	}
	c.Protocol = Protocol
	ka := o.KeepAlive
	if ka <= 0 {
		ka = 15 * time.Second
	}
	s := &Server{opts: o, cache: c, token: []byte(o.Token), origins: map[string]bool{}, keepAlive: ka, started: time.Now(),
		bc: newBroadcaster(), sessions: map[string]*Session{}, jobs: map[string]*Job{}}
	s.prompts = newPrompts(s.bc)
	s.keys = &assist.Keys{Prompter: s.prompts}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	for _, o := range o.AllowOrigins {
		if o = strings.TrimSpace(o); o != "" {
			s.origins[o] = true
		}
	}
	s.lastActive.Store(time.Now().UnixNano())
	if o.IdleEvict > 0 {
		s.wg.Add(1)
		go s.evictLoop(o.IdleEvict)
	}
	return s, nil
}

// Cache is the server's index cache.
func (s *Server) Cache() *Cache { return s.cache }

// Prompter is the engine's prompt mechanism: Ask raises a prompt event and
// waits for POST /engine/prompts/{id}.
func (s *Server) Prompter() remote.Prompter { return s.prompts }

// routes is the control plane: the one table the mux and Routes (and so the
// contract test against api/engine.openapi.yaml) are built from.
var routes = []struct {
	pattern string
	handler func(*Server, http.ResponseWriter, *http.Request)
}{
	{"GET /engine/health", (*Server).health},
	{"GET /engine/events", (*Server).events},
	{"GET /engine/prompts/{id}", (*Server).getPrompt},
	{"POST /engine/prompts/{id}", (*Server).answerPrompt},
	{"POST /engine/sessions", (*Server).openSession},
	{"GET /engine/sessions", (*Server).listSessions},
	{"GET /engine/compare", (*Server).compareSessions},
	{"GET /engine/sessions/{id}", (*Server).getSession},
	{"DELETE /engine/sessions/{id}", (*Server).deleteSession},
	{"GET /engine/assist/tools", (*Server).assistTools},
	{"GET /engine/assist/backends", (*Server).assistBackends},
	{"POST /engine/assist/conversations", (*Server).createConversation},
	{"GET /engine/assist/conversations/{c}", (*Server).getConversation},
	{"DELETE /engine/assist/conversations/{c}", (*Server).deleteConversation},
	{"POST /engine/assist/conversations/{c}/messages", (*Server).postMessage},
	{"DELETE /engine/assist/providers/{id}/key", (*Server).forgetProviderKey},
	{"GET /engine/jobs", (*Server).listJobs},
	{"DELETE /engine/jobs/{id}", (*Server).cancelJob},
	{"GET /engine/cache", (*Server).listCache},
	{"DELETE /engine/cache", (*Server).wipeCache},
	{"DELETE /engine/cache/{identity}", (*Server).deleteCacheEntry},
}

// sessionPrefix is where a session's routes (sessionRoutes) are mounted.
const sessionPrefix = "/s/{id}"

// Routes are the patterns the engine serves ("METHOD /path"): the control
// plane and every route of a session under /s/{id}.
func (s *Server) Routes() []string {
	var out []string
	for _, r := range routes {
		out = append(out, r.pattern)
	}
	for _, p := range sessionRoutes() {
		method, path, _ := strings.Cut(p, " ")
		out = append(out, method+" "+sessionPrefix+path)
	}
	return out
}

// Handler returns the engine's HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, r := range routes {
		h := r.handler
		mux.HandleFunc(r.pattern, func(w http.ResponseWriter, r *http.Request) { h(s, w, r) })
	}
	mux.HandleFunc(sessionPrefix+"/", s.sessionAPI)
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
			w.Header().Set("Access-Control-Expose-Headers", "X-Total-Lines, X-Rev, X-Live, "+estTokensHeader)
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

// CacheHealth is the index cache's size.
type CacheHealth struct {
	Bytes   int64 `json:"bytes"`
	Entries int   `json:"entries"`
	Cap     int64 `json:"cap"`
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	n := len(s.sessions)
	s.mu.Unlock()
	bytes, entries, capBytes := s.cache.Stats()
	writeJSON(w, http.StatusOK, Health{Version: s.opts.Version, Protocol: Protocol,
		Uptime: int64(time.Since(s.started) / time.Second), Sessions: n,
		Cache: CacheHealth{Bytes: bytes, Entries: entries, Cap: capBytes}})
}

// Close stops the engine: cancels every job and prompt, ends the event
// streams, waits for the open goroutines and closes every session (their
// cache entries stay). Requests still running on a session may
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
	s.endConversations("")
	s.prompts.close()
	s.bc.close()
	s.wg.Wait()
	s.closeConnections()
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

// newID is a random id with a one-letter kind prefix (s session, j job, p prompt, c conversation).
func newID(prefix string) string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b[:])
}
