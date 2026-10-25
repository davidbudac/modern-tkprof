package engine

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
)

// jobPhases reads the event stream until job id has finished and returns
// the phases its events went through.
func jobPhases(t *testing.T, ev *sse, id string) []string {
	t.Helper()
	var phases []string
	for {
		ty, d := ev.next()
		if ty != "job" {
			continue
		}
		j := decode[JobInfo](t, []byte(d))
		if j.ID != id {
			continue
		}
		if len(phases) == 0 || phases[len(phases)-1] != j.Phase {
			phases = append(phases, j.Phase)
		}
		if j.State != JobRunning {
			if j.State != JobDone {
				t.Fatalf("job %s: %+v", id, j)
			}
			return phases
		}
	}
}

// sessionAnswers are the document (timestamp masked) and a few slice answers.
func (e *env) sessionAnswers(id string) [][]byte {
	e.t.Helper()
	var out [][]byte
	for _, q := range []string{"/api/doc", "/api/pivot?fact=calls&by=stmt", "/api/pivot?fact=waits&by=event,stmt",
		"/api/timeline", "/api/waits?scope=all", "/api/lines?file=0&from=1&n=50"} {
		r := e.req("GET", "/s/"+id+q, nil)
		if r.code != 200 {
			e.t.Fatalf("%s: %d %s", q, r.code, r.body)
		}
		out = append(out, generatedRe.ReplaceAll(r.body, nil))
	}
	return out
}

func sameAnswers(t *testing.T, a, b [][]byte) {
	t.Helper()
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			t.Errorf("answer %d differs between the parsed and the cached session (%d vs %d bytes)", i, len(a[i]), len(b[i]))
		}
	}
}

// TestSessionCacheHit: the second open of a trace is a hit (no parse phase)
// and answers byte for byte like the first.
func TestSessionCacheHit(t *testing.T) {
	e, ts := newServed(t)
	ev := openSSE(t, ts)
	paths := []string{traces + "basic_binds.trc"}
	first := e.open(paths, nil)
	if p := strings.Join(jobPhases(t, ev, first.Job.ID), ","); p != "open,parse,index,ready" {
		t.Errorf("first open: phases %s", p)
	}
	fi := e.wait(first.Session.ID)
	if fi.State != SessionReady || fi.Hit {
		t.Fatalf("first open: %+v", fi)
	}
	want := e.sessionAnswers(first.Session.ID)

	// while the first session is open, and after it is closed
	for _, closeFirst := range []bool{false, true} {
		if closeFirst {
			e.req("DELETE", "/engine/sessions/"+first.Session.ID, nil)
		}
		o := e.open(paths, nil)
		if p := strings.Join(jobPhases(t, ev, o.Job.ID), ","); p != "open,ready" {
			t.Errorf("second open (first closed %v): phases %s", closeFirst, p)
		}
		si := e.wait(o.Session.ID)
		if si.State != SessionReady || !si.Hit || si.CacheIdentity != first.Session.CacheIdentity || si.Identity != first.Session.Identity {
			t.Errorf("second open: %+v", si)
		}
		if si.Lines != fi.Lines || si.Bytes != fi.Bytes || len(si.Files) != 1 || si.Files[0] != fi.Files[0] {
			t.Errorf("second open: %+v, first %+v", si, fi)
		}
		sameAnswers(t, want, e.sessionAnswers(o.Session.ID))
	}
	// other options are another entry
	o := e.open(paths, map[string]any{"binds": "redact", "salt": "x"})
	si := e.wait(o.Session.ID)
	if si.Hit || si.CacheIdentity == first.Session.CacheIdentity || si.Identity != first.Session.Identity {
		t.Errorf("redacted open: %+v", si)
	}
	if n := len(e.entries()); n != 2 {
		t.Errorf("%d entries, want 2", n)
	}
}

// TestCacheRestart: a new engine on the same cache directory opens from the
// entries the previous one left.
func TestCacheRestart(t *testing.T) {
	dir := t.TempDir()
	paths := []string{traces + "multisession_a.trc", traces + "multisession_b.trc"}
	a := newEnv(t, func(o *Options) { o.CacheDir = dir })
	ida := a.openReady(paths, nil)
	want := a.sessionAnswers(ida)
	a.srv.Close()

	b := newEnv(t, func(o *Options) { o.CacheDir = dir })
	// the other order of the same files is the same trace
	o := b.open([]string{paths[1], paths[0]}, nil)
	si := b.wait(o.Session.ID)
	if si.State != SessionReady || !si.Hit {
		t.Fatalf("after restart: %+v", si)
	}
	sameAnswers(t, want, b.sessionAnswers(o.Session.ID))
}

func TestCacheRoutes(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.CacheCap = 1 << 40 })
	id := e.openReady([]string{traces + "io_waits.trc"}, nil)
	si := e.wait(id)
	list := func() CacheList {
		r := e.req("GET", "/engine/cache", nil)
		if r.code != 200 {
			t.Fatalf("cache list: %d %s", r.code, r.body)
		}
		return decode[CacheList](t, r.body)
	}
	l := list()
	if l.Entries != 1 || len(l.Items) != 1 || l.Cap != 1<<40 || l.Bytes <= 0 || l.Items[0].Bytes != l.Bytes {
		t.Fatalf("cache list: %+v", l)
	}
	it := l.Items[0]
	if it.Identity != si.CacheIdentity || !it.Open || len(it.Paths) != 1 || !strings.HasSuffix(it.Paths[0], "io_waits.trc") ||
		it.Created.IsZero() || it.LastUsed.IsZero() {
		t.Errorf("cache item: %+v", it)
	}
	h := decode[Health](t, e.req("GET", "/engine/health", nil).body)
	if h.Cache.Entries != 1 || h.Cache.Bytes != l.Bytes || h.Cache.Cap != 1<<40 || h.Sessions != 1 {
		t.Errorf("health: %+v", h)
	}

	errCode := func(r resp) Code { return decode[struct{ Error Error }](t, r.body).Error.Code }
	if r := e.req("DELETE", "/engine/cache/"+it.Identity, nil); r.code != http.StatusConflict || errCode(r) != CodeConflict {
		t.Errorf("delete of an open entry: %d %s", r.code, r.body)
	}
	w := decode[CacheWipe](t, e.req("DELETE", "/engine/cache", nil).body)
	if len(w.Removed) != 0 || len(w.Skipped) != 1 || w.Skipped[0] != it.Identity || w.Bytes != 0 {
		t.Errorf("wipe with the entry open: %+v", w)
	}
	if r := e.req("DELETE", "/engine/cache/xyz", nil); r.code != 400 || errCode(r) != CodeBadRequest {
		t.Errorf("bad identity: %d %s", r.code, r.body)
	}
	if r := e.req("DELETE", "/engine/cache/"+strings.Repeat("0", 64), nil); r.code != 404 || errCode(r) != CodeNotFound {
		t.Errorf("unknown identity: %d %s", r.code, r.body)
	}

	e.req("DELETE", "/engine/sessions/"+id, nil)
	if l := list(); len(l.Items) != 1 || l.Items[0].Open {
		t.Errorf("after closing the session: %+v", l)
	}
	if r := e.req("DELETE", "/engine/cache/"+it.Identity, nil); r.code != http.StatusNoContent {
		t.Errorf("delete: %d %s", r.code, r.body)
	}
	if r := e.req("DELETE", "/engine/cache/"+it.Identity, nil); r.code != 404 {
		t.Errorf("second delete: %d %s", r.code, r.body)
	}
	if l := list(); l.Entries != 0 || len(l.Items) != 0 || l.Bytes != 0 {
		t.Errorf("after delete: %+v", l)
	}

	// wipe: two closed entries go, an open one stays
	for _, p := range []string{"io_waits.trc", "basic_binds.trc"} {
		e.req("DELETE", "/engine/sessions/"+e.openReady([]string{traces + p}, nil), nil)
	}
	open := e.wait(e.openReady([]string{traces + "multisession_a.trc"}, nil))
	w = decode[CacheWipe](t, e.req("DELETE", "/engine/cache", nil).body)
	if len(w.Removed) != 2 || len(w.Skipped) != 1 || w.Skipped[0] != open.CacheIdentity || w.Bytes <= 0 {
		t.Errorf("wipe: %+v", w)
	}
	if l := list(); len(l.Items) != 1 || l.Items[0].Identity != open.CacheIdentity {
		t.Errorf("after wipe: %+v", l)
	}
	if r := e.req("GET", "/s/"+open.ID+"/api/profile", nil); r.code != 200 {
		t.Errorf("the open session after wipe: %d", r.code)
	}
}

// TestEvictKeepsOpenSessions: with a cap below one entry, opening a second
// trace evicts the closed first one but never an open session's entry.
func TestEvictKeepsOpenSessions(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.CacheCap = 1 })
	a := e.openReady([]string{traces + "io_waits.trc"}, nil)
	e.req("DELETE", "/engine/sessions/"+a, nil)
	b := e.wait(e.openReady([]string{traces + "basic_binds.trc"}, nil))
	c := e.wait(e.openReady([]string{traces + "multisession_a.trc"}, nil))
	got := strings.Join(e.entries(), ",")
	if len(e.entries()) != 2 || !strings.Contains(got, b.CacheIdentity) || !strings.Contains(got, c.CacheIdentity) {
		t.Errorf("entries %s, want the open sessions' %s and %s", got, b.CacheIdentity, c.CacheIdentity)
	}
}
