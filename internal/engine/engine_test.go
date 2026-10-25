package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

const (
	traces    = "../../testdata/traces/19c/"
	bigTrace  = "../../testdata/big/big_loop.trc"
	testToken = "0123456789abcdef0123456789abcdef-test"
)

// env is an engine under test with its cache directory.
type env struct {
	t     *testing.T
	srv   *Server
	h     http.Handler
	cache string
}

func newEnv(t *testing.T, mod ...func(*Options)) *env {
	t.Helper()
	o := Options{Token: testToken, CacheDir: t.TempDir(), Version: "test"}
	for _, f := range mod {
		f(&o)
	}
	s, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return &env{t: t, srv: s, h: s.Handler(), cache: o.CacheDir}
}

type resp struct {
	code int
	hdr  http.Header
	body []byte
}

func (e *env) req(method, path string, body any, hdr ...string) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r := httptest.NewRequest(method, path, rd)
	r.Header.Set("Authorization", "Bearer "+testToken)
	for i := 0; i+1 < len(hdr); i += 2 {
		if hdr[i+1] == "" {
			r.Header.Del(hdr[i])
		} else {
			r.Header.Set(hdr[i], hdr[i+1])
		}
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, r)
	return resp{rec.Code, rec.Header(), rec.Body.Bytes()}
}

func decode[T any](t *testing.T, b []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, b)
	}
	return v
}

type openResp struct {
	Session SessionInfo `json:"session"`
	Job     JobInfo     `json:"job"`
}

// open posts a session and returns it without waiting.
func (e *env) open(paths []string, opts map[string]any) openResp {
	e.t.Helper()
	body := map[string]any{"paths": paths}
	if opts != nil {
		body["options"] = opts
	}
	r := e.req("POST", "/engine/sessions", body)
	if r.code != http.StatusAccepted {
		e.t.Fatalf("open %v: %d %s", paths, r.code, r.body)
	}
	return decode[openResp](e.t, r.body)
}

// wait polls the session until it leaves "opening".
func (e *env) wait(id string) SessionInfo {
	e.t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		r := e.req("GET", "/engine/sessions/"+id, nil)
		if r.code != 200 {
			e.t.Fatalf("session %s: %d %s", id, r.code, r.body)
		}
		si := decode[SessionInfo](e.t, r.body)
		if si.State != SessionOpening {
			return si
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("session %s still opening", id)
	return SessionInfo{}
}

func (e *env) openReady(paths []string, opts map[string]any) string {
	e.t.Helper()
	o := e.open(paths, opts)
	if si := e.wait(o.Session.ID); si.State != SessionReady {
		e.t.Fatalf("session %s: %s (%s)", si.ID, si.State, si.Error)
	}
	return o.Session.ID
}

// buildDirs lists the cache's build directories (entries being written).
func (e *env) buildDirs() []string {
	ents, _ := os.ReadDir(filepath.Join(e.cache, cacheIndexDir))
	var out []string
	for _, x := range ents {
		if strings.HasPrefix(x.Name(), cacheBuildPfx) {
			out = append(out, x.Name())
		}
	}
	return out
}

// entries lists the identities of the committed cache entries.
func (e *env) entries() []string {
	var out []string
	for _, x := range e.srv.Cache().Entries() {
		out = append(out, x.Identity)
	}
	return out
}

func absPaths(t *testing.T, paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		a, err := filepath.Abs(p)
		if err != nil {
			t.Fatal(err)
		}
		out[i] = a
	}
	return out
}

// reference is the handler of `serve -spill` for paths: the same build and
// mux as cmdServe with -spill (no plan viz URL), outside the engine.
func reference(t *testing.T, paths []string, mode model.BindMode, salt string) (http.Handler, *model.Model) {
	t.Helper()
	paths = absPaths(t, paths)
	sp, err := slice.NewSpill(slice.SpillOptions{Dir: t.TempDir(), Key: slice.SpillKey(paths), BindMode: mode, Salt: salt})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sp.Close() })
	th := analyze.DefaultThresholds()
	m, err := model.BuildFiles(paths, model.Options{NoFacts: true, Aggregate: true, SpillBinds: mode != model.BindsNone,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  sp.Attach})
	if err != nil {
		t.Fatal(err)
	}
	model.RedactBindsSalt(m, mode, salt)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: false, Packed: true, Slice: true})
	if err != nil {
		t.Fatal(err)
	}
	src, err := sp.Source()
	if err != nil {
		t.Fatal(err)
	}
	var lis []*trace.LineIndex
	for _, fe := range m.File.Files {
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { li.Close() })
		lis = append(lis, li)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", slice.NewServer(m, src).WithLines(lis).Handler())
	mux.HandleFunc("/api/doc", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		w.Write(doc)
	})
	return mux, m
}

func get(h http.Handler, path string) resp {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return resp{rec.Code, rec.Header(), rec.Body.Bytes()}
}

// endpoints are the 13 slice endpoints.
var endpoints = []string{"pivot", "timeline", "calls", "executions", "executions/detail", "waits", "waits/hist",
	"waits/scatter", "waits/by", "profile", "stmt/roles", "stmt/waits", "stmt/spans"}

// queries are representative requests of every slice endpoint plus lines.
func queries(t *testing.T, m *model.Model, ref http.Handler) []string {
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	q := []string{
		"/api/pivot?fact=calls&by=stmt", "/api/pivot?fact=waits&by=event", "/api/pivot?fact=calls&by=stmt,session",
		"/api/pivot?fact=calls&by=dep,kind&limit=3", fmt.Sprintf("/api/pivot?fact=waits&by=time&from=%d&to=%d", mid, m.Span.LastTim),
		"/api/timeline", "/api/timeline?idle=0&bucket=1000",
		"/api/calls", "/api/calls?limit=7&longest=3",
		"/api/waits?scope=all", "/api/waits?scope=all&sort=tim&limit=10",
		"/api/waits/hist?scope=all", "/api/waits/scatter?scope=all", "/api/waits/scatter?scope=all&max=5",
		"/api/waits/by?scope=all&by=stmt", "/api/waits/by?scope=all&by=obj", "/api/waits/by?scope=all&by=p1&limit=3",
		"/api/profile", "/api/profile?idle=0&contexts=0", "/api/stmt/roles",
		"/api/pivot?fact=nope", // a 400
		"/api/lines?file=0&from=1&n=50", "/api/lines?file=0&from=100&n=5000", "/api/lines?file=9",
		"/api/lines?file=0&from=1&n=50&annot=1", "/api/lines?file=0&from=100&n=5000&annot=1", "/api/lines?file=9&annot=1",
		"/api/lines/at?file=0", "/api/lines/at?file=0&tim=x", "/api/lines/at?file=9&tim=1", "/api/lines/at?file=0&tim=0",
		"/api/at?file=0", "/api/at?file=0&line=0", "/api/at?file=9&line=1", "/api/at?file=0&line=2147483647",
		"/api/search?file=0", "/api/search?file=9&q=x", "/api/search?file=0&q=(&regex=1",
		"/api/plan", "/api/plan?stmt=x", "/api/plan?stmt=99999", "/api/plan?sql_id=nosuch",
	}
	for fi, fe := range m.File.Files {
		last := fe.Lines
		q = append(q,
			fmt.Sprintf("/api/lines/at?file=%d&tim=%d", fi, fe.FirstTim), fmt.Sprintf("/api/lines/at?file=%d&tim=%d", fi, mid),
			fmt.Sprintf("/api/lines/at?file=%d&tim=%d", fi, m.Span.LastTim+1),
			fmt.Sprintf("/api/search?file=%d&q=WAIT+%%23", fi), fmt.Sprintf("/api/search?file=%d&q=exec+%%23&case=0&limit=3", fi),
			fmt.Sprintf("/api/search?file=%d&q=%%5E(PARSE|EXEC|FETCH)+%%23%%5B0-9%%5D%%2B&regex=1", fi),
			fmt.Sprintf("/api/search?file=%d&q=END+OF+STMT&from=%d", fi, last/2), fmt.Sprintf("/api/search?file=%d&q=nothing-like-this", fi),
			fmt.Sprintf("/api/lines?file=%d&from=%d&n=40&annot=1", fi, last/2))
		step := max(1, last/40)
		for l := 1; l <= last; l += step {
			q = append(q, fmt.Sprintf("/api/at?file=%d&line=%d", fi, l))
		}
		q = append(q, fmt.Sprintf("/api/at?file=%d&line=%d", fi, last), fmt.Sprintf("/api/at?file=%d&line=%d", fi, last+1))
	}
	var all []string
	for s := range m.Statements {
		all = append(all, fmt.Sprint(s))
		q = append(q, fmt.Sprintf("/api/executions?stmt=%d", s), fmt.Sprintf("/api/executions?stmt=%d&sort=e&limit=5&offset=1", s),
			fmt.Sprintf("/api/waits?stmt=%d", s), fmt.Sprintf("/api/stmt/waits?stmt=%d", s), fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=1000", s),
			fmt.Sprintf("/api/plan?stmt=%d", s), fmt.Sprintf("/api/plan?stmt=%d&exec=1", s), fmt.Sprintf("/api/plan?sql_id=%s", m.Statements[s].SQLID))
		for _, p := range report.LatestPlans(m, model.ID(s)) {
			q = append(q, fmt.Sprintf("/api/plan?stmt=%d&plh=%d", s, p.PLH), fmt.Sprintf("/api/plan?stmt=%d&plh=%d&exec=2", s, p.PLH))
		}
		r := get(ref, fmt.Sprintf("/api/executions?stmt=%d&limit=10", s))
		if r.code != 200 {
			continue
		}
		for _, row := range decode[slice.ExecResponse](t, r.body).Rows {
			q = append(q, fmt.Sprintf("/api/executions/detail?stmt=%d&cursor=%d&execNo=%d", s, row.Cursor, row.ExecNo))
		}
	}
	q = append(q, "/api/stmt/waits?stmt="+strings.Join(all, ","), "/api/stmt/spans?stmt="+strings.Join(all, ",")+"&gap=0")
	return q
}

// TestParityWithServeSpill: every answer under /s/{id}/ equals the one of
// `serve -spill` byte for byte (the document apart from its timestamp).
func TestParityWithServeSpill(t *testing.T) {
	cases := []struct {
		name  string
		paths []string
		binds string
		salt  string
	}{
		{"basic_binds", []string{traces + "basic_binds.trc"}, "", ""},
		{"basic_binds_redact", []string{traces + "basic_binds.trc"}, "redact", "pepper"},
		{"basic_binds_none", []string{traces + "basic_binds.trc"}, "none", ""},
		{"io_waits", []string{traces + "io_waits.trc"}, "", ""},
		{"multi_a_b", []string{traces + "multisession_a.trc", traces + "multisession_b.trc"}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mode, _ := parseBinds(tc.binds, tc.salt)
			ref, m := reference(t, tc.paths, mode, tc.salt)
			e := newEnv(t)
			id := e.openReady(tc.paths, map[string]any{"binds": tc.binds, "salt": tc.salt})
			rd, ed := get(ref, "/api/doc"), e.req("GET", "/s/"+id+"/api/doc?rev=1", nil)
			if ed.code != 200 || ed.hdr.Get("Content-Type") != "application/json" {
				t.Fatalf("doc: %d %s", ed.code, ed.hdr.Get("Content-Type"))
			}
			a, b := generatedRe.ReplaceAll(rd.body, nil), generatedRe.ReplaceAll(ed.body, nil)
			if !bytes.Equal(a, b) {
				t.Errorf("doc differs (%d vs %d bytes)", len(rd.body), len(ed.body))
			}
			ok := map[string]int{}
			redacted := false
			for _, q := range queries(t, m, ref) {
				r, g := get(ref, q), e.req("GET", "/s/"+id+q, nil)
				redacted = redacted || strings.HasPrefix(q, "/api/executions") && bytes.Contains(g.body, []byte(" h="))
				if r.code != g.code || !bytes.Equal(r.body, g.body) {
					t.Errorf("%s: %d %.200s\nengine %d %.200s", q, r.code, r.body, g.code, g.body)
					continue
				}
				for _, h := range []string{"Content-Type", "X-Total-Lines"} {
					if r.hdr.Get(h) != g.hdr.Get(h) {
						t.Errorf("%s: %s %q vs %q", q, h, r.hdr.Get(h), g.hdr.Get(h))
					}
				}
				if g.hdr.Get("Access-Control-Allow-Origin") != "" {
					t.Errorf("%s: CORS header %q without an Origin", q, g.hdr.Get("Access-Control-Allow-Origin"))
				}
				if r.code == 200 {
					p := strings.TrimPrefix(q, "/api/")
					p = p[:strings.IndexAny(p+"?", "?")]
					ok[p]++
				}
			}
			if redacted != (tc.binds == "redact") {
				t.Errorf("redacted bind values in the answers: %v", redacted)
			}
			n := 0
			for _, k := range ok {
				n += k
			}
			t.Logf("%d answers equal (200), doc %d bytes", n, len(ed.body))
			for _, ep := range append(endpoints, "lines", "lines/at", "at", "search", "plan") {
				if ok[ep] == 0 && !(ep == "executions/detail" && len(m.Statements) == 0) {
					t.Errorf("no 200 answer of %s compared", ep)
				}
			}
		})
	}
}

func TestTwoSessionsAtOnce(t *testing.T) {
	e := newEnv(t)
	// two sessions of the same trace and one of another, opened concurrently
	a := e.open([]string{traces + "basic_binds.trc"}, nil)
	b := e.open([]string{traces + "basic_binds.trc"}, nil)
	c := e.open([]string{traces + "io_waits.trc"}, nil)
	for _, o := range []openResp{a, b, c} {
		if si := e.wait(o.Session.ID); si.State != SessionReady {
			t.Fatalf("%s: %s %s", si.ID, si.State, si.Error)
		}
	}
	// the two sessions of basic_binds share one entry
	if n := len(e.entries()); n != 2 || len(e.buildDirs()) != 0 {
		t.Fatalf("%d cache entries (want 2), build dirs %v", n, e.buildDirs())
	}
	if a.Session.CacheIdentity != b.Session.CacheIdentity || a.Session.Identity != b.Session.Identity || a.Session.CacheIdentity == c.Session.CacheIdentity {
		t.Errorf("identities: %+v %+v %+v", a.Session, b.Session, c.Session)
	}
	docOf := func(id string) string {
		r := e.req("GET", "/s/"+id+"/api/doc", nil)
		if r.code != 200 {
			t.Fatalf("doc of %s: %d %s", id, r.code, r.body)
		}
		return string(r.body)
	}
	if !strings.Contains(docOf(a.Session.ID), "basic_binds.trc") || !strings.Contains(docOf(c.Session.ID), "io_waits.trc") {
		t.Fatal("a session answers with another session's document")
	}
	pivotB := e.req("GET", "/s/"+b.Session.ID+"/api/pivot?fact=calls&by=stmt", nil)
	if r := e.req("DELETE", "/engine/sessions/"+a.Session.ID, nil); r.code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", r.code, r.body)
	}
	if n := len(e.entries()); n != 2 {
		t.Errorf("%d cache entries after delete, want 2 (closing keeps the entry)", n)
	}
	if r := e.req("GET", "/s/"+a.Session.ID+"/api/doc", nil); r.code != 404 {
		t.Errorf("deleted session answers: %d", r.code)
	}
	if r := e.req("GET", "/s/"+b.Session.ID+"/api/pivot?fact=calls&by=stmt", nil); r.code != 200 || !bytes.Equal(r.body, pivotB.body) {
		t.Errorf("session of the same trace broken after delete: %d %.200s", r.code, r.body)
	}
	if r := e.req("GET", "/s/"+c.Session.ID+"/api/waits/hist?scope=all", nil); r.code != 200 {
		t.Errorf("other session broken after delete: %d %s", r.code, r.body)
	}
	l := decode[struct{ Sessions []SessionInfo }](t, e.req("GET", "/engine/sessions", nil).body)
	if len(l.Sessions) != 2 {
		t.Errorf("%d sessions listed, want 2", len(l.Sessions))
	}
	e.srv.Close()
	if n := len(e.entries()); n != 2 || len(e.buildDirs()) != 0 {
		t.Errorf("after Close: %d entries (want 2), build dirs %v", n, e.buildDirs())
	}
}

func TestCancelMidParse(t *testing.T) {
	if _, err := os.Stat(bigTrace); err != nil {
		t.Skip("no " + bigTrace)
	}
	e := newEnv(t)
	before := runtime.NumGoroutine()
	o := e.open([]string{bigTrace}, nil)
	time.Sleep(200 * time.Millisecond) // the parse takes about a second
	if n := len(e.buildDirs()); n != 1 {
		t.Fatalf("%d build dirs while parsing", n)
	}
	t0 := time.Now()
	if r := e.req("DELETE", "/engine/jobs/"+o.Job.ID, nil); r.code != http.StatusAccepted {
		t.Fatalf("cancel: %d %s", r.code, r.body)
	}
	si := e.wait(o.Session.ID)
	took := time.Since(t0)
	if si.State != SessionFailed || si.Error != "cancelled" {
		t.Errorf("session after cancel: %s %q", si.State, si.Error)
	}
	jobs := decode[struct{ Jobs []JobInfo }](t, e.req("GET", "/engine/jobs", nil).body)
	if len(jobs.Jobs) != 1 || jobs.Jobs[0].State != JobCancelled {
		t.Errorf("jobs after cancel: %+v", jobs.Jobs)
	}
	if took > 500*time.Millisecond {
		t.Errorf("cancel took %s", took)
	}
	t.Logf("cancelled after 200 ms of parsing, stopped %s later", took.Round(time.Millisecond))
	if d, n := e.buildDirs(), len(e.entries()); len(d) != 0 || n != 0 {
		t.Errorf("after cancel: build dirs %v, %d entries", d, n)
	}
	if ents, _ := os.ReadDir(filepath.Join(e.cache, cacheIndexDir)); len(ents) != 0 {
		t.Errorf("index dir after cancel: %v", ents)
	}
	if r := e.req("GET", "/s/"+o.Session.ID+"/api/doc", nil); r.code != http.StatusConflict {
		t.Errorf("doc of a failed session: %d", r.code)
	}
	if r := e.req("DELETE", "/engine/jobs/"+o.Job.ID, nil); r.code != http.StatusConflict {
		t.Errorf("cancel of a finished job: %d", r.code)
	}
	if r := e.req("DELETE", "/engine/sessions/"+o.Session.ID, nil); r.code != http.StatusNoContent {
		t.Errorf("delete of a failed session: %d", r.code)
	}
	var after int
	for i := 0; i < 100; i++ {
		if after = runtime.NumGoroutine(); after <= before+1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if after > before+1 {
		t.Errorf("goroutines: %d before, %d after", before, after)
	}
}

// TestDeleteWhileOpening: DELETE of an opening session cancels its job and
// removes everything.
func TestDeleteWhileOpening(t *testing.T) {
	if _, err := os.Stat(bigTrace); err != nil {
		t.Skip("no " + bigTrace)
	}
	e := newEnv(t)
	o := e.open([]string{bigTrace}, nil)
	time.Sleep(100 * time.Millisecond)
	if r := e.req("DELETE", "/engine/sessions/"+o.Session.ID, nil); r.code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", r.code, r.body)
	}
	if d, n := e.buildDirs(), len(e.entries()); len(d) != 0 || n != 0 {
		t.Errorf("after delete: build dirs %v, %d entries", d, n)
	}
	if r := e.req("GET", "/engine/sessions/"+o.Session.ID, nil); r.code != 404 {
		t.Errorf("deleted session still listed: %d", r.code)
	}
}

func TestAuth(t *testing.T) {
	e := newEnv(t)
	for _, tc := range []struct {
		method, path, auth string
		want               int
	}{
		{"GET", "/engine/health", "", 200},
		{"GET", "/engine/sessions", "", 401},
		{"GET", "/engine/sessions", "Bearer wrong", 401},
		{"GET", "/engine/sessions", testToken, 401}, // no "Bearer "
		{"GET", "/engine/events", "", 401},
		{"POST", "/engine/sessions", "", 401},
		{"GET", "/s/sabc/api/doc", "", 401},
		{"GET", "/engine/sessions", "Bearer " + testToken, 200},
		{"GET", "/s/sabc/api/doc", "Bearer " + testToken, 404},
		{"GET", "/nope", "Bearer " + testToken, 404},
	} {
		r := e.req(tc.method, tc.path, nil, "Authorization", tc.auth)
		if r.code != tc.want {
			t.Errorf("%s %s (%q): %d, want %d", tc.method, tc.path, tc.auth, r.code, tc.want)
		}
		if r.code == 401 {
			env := decode[struct{ Error Error }](t, r.body)
			if env.Error.Code != CodeUnauthorized {
				t.Errorf("401 envelope: %s", r.body)
			}
		}
	}
	h := decode[Health](t, e.req("GET", "/engine/health", nil, "Authorization", "").body)
	if h.Protocol != Protocol || h.Version != "test" {
		t.Errorf("health: %+v", h)
	}
}

func TestCORS(t *testing.T) {
	const ok = "tauri://localhost"
	e := newEnv(t, func(o *Options) { o.AllowOrigins = []string{ok, "http://tauri.localhost"} })
	id := e.openReady([]string{traces + "io_waits.trc"}, nil)
	for _, path := range []string{"/engine/health", "/engine/sessions", "/s/" + id + "/api/pivot?fact=calls&by=stmt", "/s/" + id + "/api/doc", "/s/" + id + "/api/lines?file=0&from=1&n=2"} {
		if r := e.req("GET", path, nil, "Origin", ok); r.hdr.Get("Access-Control-Allow-Origin") != ok || r.code != 200 {
			t.Errorf("%s from %s: %d, ACAO %q", path, ok, r.code, r.hdr.Get("Access-Control-Allow-Origin"))
		}
		if r := e.req("GET", path, nil, "Origin", "http://evil.example"); r.hdr.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("%s from another origin: ACAO %q", path, r.hdr.Get("Access-Control-Allow-Origin"))
		}
		if r := e.req("GET", path, nil); len(r.hdr.Values("Access-Control-Allow-Origin")) != 0 {
			t.Errorf("%s without Origin: ACAO %q", path, r.hdr.Values("Access-Control-Allow-Origin"))
		}
	}
	// preflight: no token, answered by the engine
	r := e.req("OPTIONS", "/engine/sessions", nil, "Authorization", "", "Origin", ok, "Access-Control-Request-Method", "POST")
	if r.code != http.StatusNoContent || r.hdr.Get("Access-Control-Allow-Origin") != ok ||
		!strings.Contains(r.hdr.Get("Access-Control-Allow-Methods"), "DELETE") || !strings.Contains(r.hdr.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Errorf("preflight: %d %v", r.code, r.hdr)
	}
	r = e.req("OPTIONS", "/s/"+id+"/api/pivot", nil, "Authorization", "", "Origin", "http://evil.example", "Access-Control-Request-Method", "GET")
	if r.hdr.Get("Access-Control-Allow-Origin") != "" || r.hdr.Get("Access-Control-Allow-Methods") != "" {
		t.Errorf("preflight from another origin: %v", r.hdr)
	}
}

func TestBadRequests(t *testing.T) {
	e := newEnv(t)
	for _, tc := range []struct {
		body any
		want string
	}{
		{map[string]any{"paths": []string{}}, "paths"},
		{map[string]any{"paths": []string{traces + "missing.trc"}}, "missing.trc"},
		{map[string]any{"paths": []string{traces + "io_waits.trc"}, "options": map[string]any{"binds": "maybe"}}, "binds"},
		{map[string]any{"paths": []string{traces + "io_waits.trc"}, "options": map[string]any{"thresholds": map[string]any{"noSuchKey": 1}}}, "thresholds"},
		{map[string]any{"paths": []string{traces + "io_waits.trc"}, "extra": 1}, "body"},
	} {
		r := e.req("POST", "/engine/sessions", tc.body)
		env := decode[struct{ Error Error }](t, r.body)
		if r.code != 400 || env.Error.Code != CodeBadRequest || !strings.Contains(env.Error.Message, tc.want) {
			t.Errorf("%v: %d %s", tc.body, r.code, r.body)
		}
	}
	if r := e.req("DELETE", "/engine/jobs/jnope", nil); r.code != 404 {
		t.Errorf("unknown job: %d", r.code)
	}
	if r := e.req("DELETE", "/engine/sessions/snope", nil); r.code != 404 {
		t.Errorf("unknown session: %d", r.code)
	}
	if r := e.req("POST", "/engine/prompts/pnope", map[string]any{"answer": "x"}); r.code != 404 {
		t.Errorf("unknown prompt: %d", r.code)
	}
	if len(e.srv.jobs) != 0 || len(e.srv.sessions) != 0 {
		t.Errorf("a rejected open left a job or session behind")
	}
}

func TestThresholdsOption(t *testing.T) {
	e := newEnv(t)
	id := e.openReady([]string{traces + "io_waits.trc"}, map[string]any{"thresholds": map[string]any{"outlier_factor": 7}})
	def := e.openReady([]string{traces + "io_waits.trc"}, nil)
	a, b := e.req("GET", "/s/"+id+"/api/doc", nil).body, e.req("GET", "/s/"+def+"/api/doc", nil).body
	if bytes.Equal(generatedRe.ReplaceAll(a, nil), generatedRe.ReplaceAll(b, nil)) {
		t.Errorf("thresholds made no difference to the document")
	}
}

// sse reads an event stream.
type sse struct {
	t    *testing.T
	body io.ReadCloser
	sc   *bufio.Scanner
}

func openSSE(t *testing.T, ts *httptest.Server) *sse {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+"/engine/events", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %d %s", r.StatusCode, r.Header.Get("Content-Type"))
	}
	t.Cleanup(func() { r.Body.Close() })
	return &sse{t: t, body: r.Body, sc: bufio.NewScanner(r.Body)}
}

// next returns the next event (type, data) or a comment ("", text).
func (s *sse) next() (string, string) {
	s.t.Helper()
	var typ, data string
	for s.sc.Scan() {
		line := s.sc.Text()
		switch {
		case line == "":
			if typ != "" {
				return typ, data
			}
		case strings.HasPrefix(line, ":"):
			return "", strings.TrimSpace(line[1:])
		case strings.HasPrefix(line, "event: "):
			typ = line[7:]
		case strings.HasPrefix(line, "data: "):
			data = line[6:]
		}
	}
	s.t.Fatalf("event stream ended: %v", s.sc.Err())
	return "", ""
}

// until returns the first event of type typ matching ok.
func (s *sse) until(typ string, ok func(data string) bool) string {
	s.t.Helper()
	for {
		if ty, d := s.next(); ty == typ && ok(d) {
			return d
		}
	}
}

func newServed(t *testing.T, mod ...func(*Options)) (*env, *httptest.Server) {
	e := newEnv(t, mod...)
	ts := httptest.NewServer(e.h)
	t.Cleanup(func() { e.srv.Close(); ts.Close() })
	return e, ts
}

func TestPromptRoundTrip(t *testing.T) {
	e, ts := newServed(t)
	ev := openSSE(t, ts)
	if ty, c := ev.next(); ty != "" || c != "mtkprof engine" {
		t.Fatalf("first: %q %q", ty, c)
	}
	type result struct {
		ans string
		err error
	}
	ask := func(ctx context.Context, p remote.Prompt) chan result {
		ch := make(chan result, 1)
		go func() {
			a, err := e.srv.Prompter().Ask(ctx, p)
			ch <- result{a, err}
		}()
		return ch
	}
	open := func(d string) bool { return decode[PromptEvent](t, []byte(d)).State == "open" }

	res := ask(context.Background(), remote.Prompt{Connection: "c1", Kind: remote.KindPassword, Text: "oracle@dbmint's password:"})
	pe := decode[PromptEvent](t, []byte(ev.until("prompt", open)))
	if pe.Connection != "c1" || pe.Kind != "password" || pe.Echo || pe.Text != "oracle@dbmint's password:" {
		t.Errorf("prompt event: %+v", pe)
	}
	select {
	case r := <-res:
		t.Fatalf("Ask returned before the answer: %+v", r)
	case <-time.After(20 * time.Millisecond):
	}
	// a client connecting now sees the open prompt
	ev2 := openSSE(t, ts)
	if d := ev2.until("prompt", open); decode[PromptEvent](t, []byte(d)).ID != pe.ID {
		t.Errorf("replayed prompt: %s", d)
	}
	if r := e.req("POST", "/engine/prompts/"+pe.ID, map[string]any{"answer": "hunter2"}); r.code != http.StatusNoContent {
		t.Fatalf("answer: %d %s", r.code, r.body)
	}
	if r := <-res; r.err != nil || r.ans != "hunter2" {
		t.Errorf("Ask: %q %v", r.ans, r.err)
	}
	closed := decode[PromptEvent](t, []byte(ev.until("prompt", func(d string) bool { return !open(d) })))
	if closed.ID != pe.ID || closed.State != "closed" {
		t.Errorf("closed event: %+v", closed)
	}
	if r := e.req("POST", "/engine/prompts/"+pe.ID, map[string]any{"answer": "again"}); r.code != 404 {
		t.Errorf("second answer: %d", r.code)
	}

	// cancel by the user
	res = ask(context.Background(), remote.Prompt{Kind: remote.KindHostKey, Text: "fingerprint SHA256:x", Echo: true})
	pe = decode[PromptEvent](t, []byte(ev.until("prompt", open)))
	if r := e.req("POST", "/engine/prompts/"+pe.ID, map[string]any{"cancel": true}); r.code != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", r.code, r.body)
	}
	if r := <-res; !errors.Is(r.err, ErrPromptCancelled) {
		t.Errorf("cancelled Ask: %q %v", r.ans, r.err)
	}

	// the asker gives up
	ctx, cancel := context.WithCancel(context.Background())
	res = ask(ctx, remote.Prompt{Kind: remote.KindOTP, Text: "code:"})
	pe = decode[PromptEvent](t, []byte(ev.until("prompt", open)))
	cancel()
	if r := <-res; !errors.Is(r.err, context.Canceled) {
		t.Errorf("Ask after ctx end: %v", r.err)
	}
	if len(e.srv.prompts.pending()) != 0 {
		t.Errorf("prompts still pending")
	}

	if _, err := e.srv.Prompter().Ask(context.Background(), remote.Prompt{Kind: "pin"}); err == nil {
		t.Errorf("unknown kind accepted")
	}
	if r := e.req("POST", "/engine/prompts/"+pe.ID, map[string]any{}); r.code != 400 {
		t.Errorf("empty answer body: %d", r.code)
	}
	// engine shutdown cancels a waiting prompt
	res = ask(context.Background(), remote.Prompt{Kind: remote.KindConfirm, Text: "ok?"})
	ev.until("prompt", open)
	e.srv.Close()
	if r := <-res; !errors.Is(r.err, ErrPromptCancelled) {
		t.Errorf("Ask at shutdown: %v", r.err)
	}
}

func TestOpenEvents(t *testing.T) {
	e, ts := newServed(t, func(o *Options) { o.KeepAlive = 30 * time.Millisecond })
	ev := openSSE(t, ts)
	o := e.open([]string{traces + "basic_binds.trc"}, nil)
	var phases, sessions []string
	var last, parse JobInfo
	for last.State == "" || last.State == JobRunning || len(sessions) < 2 {
		ty, d := ev.next()
		switch ty {
		case "job":
			j := decode[JobInfo](t, []byte(d))
			if j.ID != o.Job.ID {
				continue
			}
			if len(phases) == 0 || phases[len(phases)-1] != j.Phase {
				phases = append(phases, j.Phase)
			}
			last = j
			if j.Phase == "parse" {
				parse = j
			}
		case "session":
			se := decode[SessionEvent](t, []byte(d))
			if se.ID != o.Session.ID || se.Rev != 1 {
				t.Errorf("session event: %s", d)
			}
			sessions = append(sessions, se.State)
		}
	}
	if strings.Join(phases, ",") != "open,parse,index,ready" || last.State != JobDone || last.Kind != "open" || last.Session != o.Session.ID {
		t.Errorf("job events: phases %v, last %+v", phases, last)
	}
	if strings.Join(sessions, ",") != "opening,ready" {
		t.Errorf("session events: %v", sessions)
	}
	if o.Job.Phase != "open" || o.Session.Hit {
		t.Errorf("job at open: %+v", o.Job)
	}
	if parse.Total != 213689 || parse.Unit != "bytes" || parse.Done != 213689 || parse.Lines == 0 {
		t.Errorf("last parse event: %+v", parse)
	}
	ev.until("log", func(d string) bool { return strings.Contains(d, "ready in") })
	for {
		if ty, c := ev.next(); ty == "" && c == "keepalive" {
			break
		}
	}
	e.req("DELETE", "/engine/sessions/"+o.Session.ID, nil)
	if d := ev.until("session", func(string) bool { return true }); decode[SessionEvent](t, []byte(d)).State != SessionClosed {
		t.Errorf("event after delete: %s", d)
	}
	// Close ends the stream
	e.srv.Close()
	for ev.sc.Scan() {
	}
}

func TestSlowSubscriberDropped(t *testing.T) {
	b := newBroadcaster()
	ch, cancel := b.subscribe()
	defer cancel()
	for i := 0; i < subBuffer+1; i++ {
		b.publish("log", LogEvent{Message: "x"})
	}
	n := 0
	for range ch {
		n++
	}
	if n != subBuffer {
		t.Errorf("%d events before the drop, want %d", n, subBuffer)
	}
}

func TestIdleFor(t *testing.T) {
	e := newEnv(t)
	if e.srv.IdleFor() <= 0 {
		t.Errorf("a new engine is not idle")
	}
	id := e.openReady([]string{traces + "io_waits.trc"}, nil)
	if e.srv.IdleFor() != 0 {
		t.Errorf("idle with a session")
	}
	e.req("DELETE", "/engine/sessions/"+id, nil)
	time.Sleep(5 * time.Millisecond)
	if d := e.srv.IdleFor(); d <= 0 || d > time.Second {
		t.Errorf("idle after the last session: %s", d)
	}
}

// TestIdleEviction: a ready session with no request on its mount for
// IdleEvict is closed like a DELETE (event, cache entry stays); a request
// resets the clock; a pending request and a running job keep it.
func TestIdleEviction(t *testing.T) {
	const idle = 300 * time.Millisecond
	e := newEnv(t, func(o *Options) { o.IdleEvict = idle })
	id := e.openReady([]string{traces + "io_waits.trc"}, nil)
	keep := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	ev, cancel := e.srv.bc.subscribe()
	defer cancel()

	// requests on keep's mount postpone its eviction past several idle periods
	t0 := time.Now()
	for time.Since(t0) < 3*idle {
		if r := e.req("GET", "/s/"+keep+"/api/doc", nil); r.code != 200 {
			t.Fatalf("doc: %d %s", r.code, r.body)
		}
		time.Sleep(idle / 6)
	}
	// id was never requested: gone by now, keep is still there
	if r := e.req("GET", "/engine/sessions/"+id, nil); r.code != http.StatusNotFound {
		t.Errorf("idle session still there: %d", r.code)
	}
	closed := false
	for len(ev) > 0 {
		if x := <-ev; x.Type == "session" && strings.Contains(string(x.Data), `"id":"`+id+`","state":"closed"`) {
			closed = true
		}
	}
	if !closed {
		t.Errorf("no session event with the closed state for %s", id)
	}
	if r := e.req("GET", "/engine/sessions/"+keep, nil); r.code != 200 {
		t.Errorf("busy session evicted: %d", r.code)
	}
	if n := len(e.entries()); n != 2 {
		t.Errorf("%d cache entries after the eviction, want 2", n)
	}
	// keep goes too once it is left alone
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if e.req("GET", "/engine/sessions/"+keep, nil).code == http.StatusNotFound {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("idle session %s never evicted", keep)
}

// TestEvictIdleRules drives evictIdle with a fake clock: a request in flight,
// a running job and a session that is not ready are never evicted.
func TestEvictIdleRules(t *testing.T) {
	e := newEnv(t)
	a := e.openReady([]string{traces + "io_waits.trc"}, nil)
	b := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	c := e.openReady([]string{traces + "io_waits.trc", traces + "basic_binds.trc"}, nil)
	get := func(id string) *Session {
		e.srv.mu.Lock()
		defer e.srv.mu.Unlock()
		return e.srv.sessions[id]
	}
	later := time.Now().Add(time.Hour)
	get(a).begin() // a request in flight (a doc long poll)
	e.srv.mu.Lock()
	j := e.srv.newJobLocked("ref", c) // a running job of c
	e.srv.mu.Unlock()
	if n := e.srv.evictIdle(time.Minute, later); n != 1 {
		t.Fatalf("evicted %d, want only b", n)
	}
	if get(a) == nil || get(b) != nil || get(c) == nil {
		t.Errorf("sessions after the pass: a %v, b %v, c %v", get(a) != nil, get(b) != nil, get(c) != nil)
	}
	if n := e.srv.evictIdle(time.Minute, time.Now()); n != 0 {
		t.Errorf("evicted %d sessions that were just used", n)
	}
	get(a).end()
	j.finish(nil)
	if n := e.srv.evictIdle(time.Minute, later); n != 2 {
		t.Errorf("evicted %d, want a and c", n)
	}
}
