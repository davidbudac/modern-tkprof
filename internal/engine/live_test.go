package engine

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
)

// liveEnv is an engine with a followed file.
type liveEnv struct {
	*env
	path string // the growing file
	id   string // the session
}

// startFollow writes first to a new file and follows it.
func startFollow(t *testing.T, name string, first []byte, opts map[string]any) *liveEnv {
	t.Helper()
	e := newEnv(t)
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, first, 0o644); err != nil {
		t.Fatal(err)
	}
	o := map[string]any{"follow": true, "batchMs": 50}
	for k, v := range opts {
		o[k] = v
	}
	r := e.open([]string{p}, o)
	if r.Job.Kind != "live" || r.Session.State != SessionOpening {
		t.Fatalf("follow answer %+v", r)
	}
	return &liveEnv{env: e, path: p, id: r.Session.ID}
}

func (le *liveEnv) info() SessionInfo {
	le.t.Helper()
	r := le.req("GET", "/engine/sessions/"+le.id, nil)
	if r.code != 200 {
		le.t.Fatalf("session: %d %s", r.code, r.body)
	}
	return decode[SessionInfo](le.t, r.body)
}

// waitBytes waits until the served snapshot has parsed n bytes.
func (le *liveEnv) waitBytes(n int64) SessionInfo {
	le.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		si := le.info()
		if si.State == SessionFailed {
			le.t.Fatalf("session failed: %s", si.Error)
		}
		if si.State == SessionLive && si.Bytes == n {
			return si
		}
		time.Sleep(5 * time.Millisecond)
	}
	le.t.Fatalf("session never reached %d bytes: %+v", n, le.info())
	return SessionInfo{}
}

func appendFile(t *testing.T, p string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(b); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

// lineCuts are byte offsets just after a newline, at about the fractions of
// the file given, and the end.
func lineCuts(data []byte, fracs ...float64) []int64 {
	var out []int64
	for _, f := range fracs {
		at := int(float64(len(data)) * f)
		i := bytes.IndexByte(data[at:], '\n')
		if i < 0 {
			continue
		}
		c := int64(at + i + 1)
		if len(out) == 0 || c > out[len(out)-1] {
			out = append(out, c)
		}
	}
	if len(out) == 0 || out[len(out)-1] != int64(len(data)) {
		out = append(out, int64(len(data)))
	}
	return out
}

// TestLivePrefixesMatchOpen: at every settled batch a live session answers
// what a normal open of the input so far answers: the document and every
// slice and line endpoint, byte for byte (paths apart: the prefix is a file
// of its own).
func TestLivePrefixesMatchOpen(t *testing.T) {
	names := []string{"io_waits", "basic_binds", "bind_types", "plsql_recursive", "cursor_cache", "lobs", "errors", "multisession", "parallel", "nasty_sql", "truncated", "midtrace_start"}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(traces + name + ".trc")
			if err != nil {
				t.Fatal(err)
			}
			cuts := lineCuts(data, 0.01, 0.13, 0.37, 0.5, 0.71, 0.93)
			le := startFollow(t, name+".trc", data[:cuts[0]], nil)
			var prev int64
			stmts := -1
			for k, c := range cuts {
				if k > 0 {
					appendFile(t, le.path, data[prev:c])
				}
				prev = c
				si := le.waitBytes(c)
				pre := filepath.Join(t.TempDir(), name+".trc")
				os.WriteFile(pre, data[:c], 0o644)
				ref, m := reference(t, []string{pre}, model.BindsKeep, "")
				doc := le.req("GET", "/s/"+le.id+"/api/doc", nil)
				want := bytes.ReplaceAll(get(ref, "/api/doc").body, []byte(pre), []byte(le.path))
				if !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(doc.body, nil)) {
					t.Fatalf("cut %d (%d bytes): document differs (%d vs %d bytes)", k, c, len(want), len(doc.body))
				}
				if doc.hdr.Get("X-Rev") != strconv.Itoa(si.Rev) {
					t.Errorf("X-Rev %q, session rev %d", doc.hdr.Get("X-Rev"), si.Rev)
				}
				if len(m.Statements) < stmts {
					t.Errorf("statements went down: %d after %d", len(m.Statements), stmts)
				}
				stmts = len(m.Statements)
				n := 0
				for _, q := range queries(t, m, ref) {
					r, g := get(ref, q), le.req("GET", "/s/"+le.id+q, nil)
					if r.code != g.code || !bytes.Equal(r.body, g.body) {
						t.Errorf("cut %d: %s: %d %.200s\nlive %d %.200s", k, q, r.code, r.body, g.code, g.body)
						continue
					}
					n++
				}
				if k == len(cuts)-1 {
					t.Logf("%d cuts, %d answers equal at the end, rev %d", len(cuts), n, si.Rev)
				}
			}
		})
	}
}

// TestLiveFollowGrowingFile: a file grows by 50 KB every 100 ms; the
// revision goes up, the statements only grow, every snapshot answers a
// pivot, the last one equals a normal open, DELETE removes the spill and
// stops the follow.
func TestLiveFollowGrowingFile(t *testing.T) {
	data, err := os.ReadFile(traces + "io_waits.trc")
	if err != nil {
		t.Fatal(err)
	}
	before := runtime.NumGoroutine()
	le := startFollow(t, "io_waits.trc", data[:50<<10], map[string]any{"batchMs": 200})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for off := 50 << 10; off < len(data); off += 50 << 10 {
			time.Sleep(100 * time.Millisecond)
			appendFile(t, le.path, data[off:min(off+50<<10, len(data))])
		}
	}()
	lastRev, lastStmts, revs := 0, 0, 0
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	check := func() SessionInfo {
		si := le.info()
		if si.State == SessionFailed {
			t.Fatalf("failed: %s", si.Error)
		}
		if si.State != SessionLive || si.Rev == lastRev {
			return si
		}
		if si.Rev < lastRev {
			t.Errorf("rev went down: %d after %d", si.Rev, lastRev)
		}
		lastRev = si.Rev
		revs++
		doc := le.req("GET", "/s/"+le.id+"/api/doc", nil)
		var d struct {
			Statements []any `json:"statements"`
		}
		d = decode[struct {
			Statements []any `json:"statements"`
		}](t, doc.body)
		if len(d.Statements) < lastStmts {
			t.Errorf("statements went down: %d after %d", len(d.Statements), lastStmts)
		}
		lastStmts = len(d.Statements)
		for _, q := range []string{"/api/pivot?fact=calls&by=stmt", "/api/pivot?fact=waits&by=event", "/api/timeline", "/api/lines?file=0&from=1&n=20"} {
			if r := le.req("GET", "/s/"+le.id+q, nil); r.code != 200 {
				t.Errorf("rev %d %s: %d %s", si.Rev, q, r.code, r.body)
			}
		}
		return si
	}
loop:
	for {
		select {
		case <-done:
			break loop
		case <-time.After(30 * time.Millisecond):
			check()
		}
	}
	le.waitBytes(int64(len(data)))
	check()
	if revs < 5 {
		t.Errorf("only %d revisions seen while the file grew", revs)
	}
	t.Logf("%d revisions seen, last %d, %d statements", revs, lastRev, lastStmts)

	// the last snapshot is the document of a normal open of the whole file
	live := le.req("GET", "/s/"+le.id+"/api/doc", nil).body
	other := newEnv(t)
	id := other.openReady([]string{le.path}, nil)
	want := other.req("GET", "/s/"+id+"/api/doc", nil).body
	if !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(live, nil)) {
		t.Errorf("final snapshot differs from a normal open (%d vs %d bytes)", len(live), len(want))
	}

	dirs, _ := filepath.Glob(filepath.Join(le.cache, "live", "mtkprof-spill-*"))
	if len(dirs) != 1 {
		t.Fatalf("spill dirs %v", dirs)
	}
	if r := le.req("DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if _, err := os.Stat(dirs[0]); !os.IsNotExist(err) {
		t.Errorf("spill dir left after DELETE: %v", err)
	}
	if r := le.req("GET", "/s/"+le.id+"/api/doc", nil); r.code != 404 {
		t.Errorf("doc after delete: %d", r.code)
	}
	other.srv.Close()
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > before+2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > before+2 {
		buf := make([]byte, 1<<16)
		t.Errorf("%d goroutines, %d before:\n%s", n, before, buf[:runtime.Stack(buf, true)])
	}
}

// TestLivePartialLine: a line written in two parts is counted once, when
// its newline arrives.
func TestLivePartialLine(t *testing.T) {
	data, err := os.ReadFile(traces + "io_waits.trc")
	if err != nil {
		t.Fatal(err)
	}
	cut := lineCuts(data, 0.5)[0]
	end := cut + int64(bytes.IndexByte(data[cut:], '\n')) + 1
	line := data[cut:end]
	if !bytes.HasPrefix(line, []byte("WAIT #")) && !bytes.HasPrefix(line, []byte("FETCH #")) && !bytes.HasPrefix(line, []byte("EXEC #")) {
		t.Logf("line at the cut: %q", line)
	}
	le := startFollow(t, "io_waits.trc", data[:cut], nil)
	si := le.waitBytes(cut)
	appendFile(t, le.path, line[:len(line)/2])
	time.Sleep(300 * time.Millisecond) // several batch periods
	if got := le.info(); got.Bytes != cut || got.Lines != si.Lines {
		t.Fatalf("half a line was parsed: %+v (before %+v)", got, si)
	}
	appendFile(t, le.path, line[len(line)/2:])
	got := le.waitBytes(end)
	if got.Lines != si.Lines+1 {
		t.Errorf("lines %d, want %d", got.Lines, si.Lines+1)
	}
	pre := filepath.Join(t.TempDir(), "io_waits.trc")
	os.WriteFile(pre, data[:end], 0o644)
	ref, _ := reference(t, []string{pre}, model.BindsKeep, "")
	want := bytes.ReplaceAll(get(ref, "/api/doc").body, []byte(pre), []byte(le.path))
	if doc := le.req("GET", "/s/"+le.id+"/api/doc", nil).body; !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(doc, nil)) {
		t.Errorf("document after the completed line differs")
	}
}

// TestLiveDocLongPoll: api/doc?rev=N waits for a newer snapshot.
func TestLiveDocLongPoll(t *testing.T) {
	data, err := os.ReadFile(traces + "basic_binds.trc")
	if err != nil {
		t.Fatal(err)
	}
	cut := lineCuts(data, 0.5)[0]
	le := startFollow(t, "basic_binds.trc", data[:cut], nil)
	si := le.waitBytes(cut)
	if r := le.req("GET", "/s/"+le.id+"/api/doc?rev="+strconv.Itoa(si.Rev-1), nil); r.code != 200 || r.hdr.Get("X-Rev") != strconv.Itoa(si.Rev) {
		t.Errorf("older rev: %d %s", r.code, r.hdr.Get("X-Rev"))
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		appendFile(t, le.path, data[cut:])
	}()
	start := time.Now()
	r := le.req("GET", "/s/"+le.id+"/api/doc?rev="+strconv.Itoa(si.Rev), nil)
	if r.code != 200 || r.hdr.Get("X-Rev") == strconv.Itoa(si.Rev) || time.Since(start) < 150*time.Millisecond {
		t.Errorf("long poll: %d rev %s after %s", r.code, r.hdr.Get("X-Rev"), time.Since(start))
	}
	if r := le.req("GET", "/s/"+le.id+"/api/doc?rev=x", nil); r.code != 400 {
		t.Errorf("bad rev: %d", r.code)
	}
	// DELETE ends a waiting long poll at once
	cur := le.info().Rev
	got := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		le.req("GET", "/s/"+le.id+"/api/doc?rev="+strconv.Itoa(cur+100), nil)
		got <- time.Since(start)
	}()
	time.Sleep(100 * time.Millisecond)
	start = time.Now()
	if r := le.req("DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("delete waited %s for the long poll", d)
	}
	if d := <-got; d > 3*time.Second {
		t.Errorf("long poll ended after %s", d)
	}
}

// TestLiveTruncatedFileFails: a file that shrinks fails the session; the
// last snapshot stays served.
func TestLiveTruncatedFileFails(t *testing.T) {
	data, _ := os.ReadFile(traces + "basic_binds.trc")
	le := startFollow(t, "basic_binds.trc", data, nil)
	le.waitBytes(int64(len(data)))
	os.Truncate(le.path, 100)
	deadline := time.Now().Add(5 * time.Second)
	for le.info().State != SessionFailed && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	si := le.info()
	if si.State != SessionFailed || !strings.Contains(si.Error, "shrank") {
		t.Fatalf("after truncate: %+v", si)
	}
	if r := le.req("GET", "/s/"+le.id+"/api/pivot?fact=calls&by=stmt", nil); r.code != 200 {
		t.Errorf("last snapshot not served: %d %s", r.code, r.body)
	}
	j := decode[struct{ Jobs []JobInfo }](t, le.req("GET", "/engine/jobs", nil).body).Jobs
	if len(j) != 1 || j[0].State != JobFailed || j[0].Kind != "live" {
		t.Errorf("jobs %+v", j)
	}
}

func TestLiveBadRequests(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	for _, tc := range []struct {
		body any
		want string
	}{
		{map[string]any{"paths": []string{traces + "io_waits.trc", traces + "basic_binds.trc"}, "options": map[string]any{"follow": true}}, "one file"},
		{map[string]any{"paths": []string{dir}, "options": map[string]any{"follow": true}}, "not a file"},
		{map[string]any{"paths": []string{traces + "io_waits.trc"}, "options": map[string]any{"follow": true, "batchMs": 1}}, "batchMs"},
		{map[string]any{"paths": []string{traces + "io_waits.trc"}, "options": map[string]any{"follow": true, "batchMB": -1}}, "batchMB"},
	} {
		r := e.req("POST", "/engine/sessions", tc.body)
		if env := decode[struct{ Error Error }](t, r.body); r.code != 400 || !strings.Contains(env.Error.Message, tc.want) {
			t.Errorf("%v: %d %s", tc.body, r.code, r.body)
		}
	}
	if len(e.srv.jobs) != 0 || len(e.srv.sessions) != 0 {
		t.Errorf("a rejected follow left a job or session behind")
	}
}

// TestLiveBig measures the snapshot cost on a 100 MB prefix of a large
// trace: MTKPROF_BIG=/path/to/big_loop.trc go test ./internal/engine -run LiveBig -v
func TestLiveBig(t *testing.T) {
	p := os.Getenv("MTKPROF_BIG")
	if p == "" {
		t.Skip("MTKPROF_BIG not set")
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	const prefix = 100 << 20
	data := make([]byte, prefix+1<<20)
	n, _ := f.ReadAt(data, 0)
	data = data[:n]
	cut := lineCuts(data, float64(prefix)/float64(len(data)))[0]
	start := time.Now()
	le := startFollow(t, "big.trc", data[:cut], map[string]any{"batchMs": 1000})
	le.waitBytes(cut)
	catchUp := time.Since(start)
	lv := le.srv.sessions[le.id].op.handler.(*live)
	costs := lv.snapCosts()
	// one more batch on top of the 100 MB
	tail := lineCuts(data[cut:], 0.0001)[0]
	appendFile(t, le.path, data[cut:cut+tail])
	t0 := time.Now()
	le.waitBytes(cut + tail)
	lat := time.Since(t0)
	all := lv.snapCosts()
	t.Logf("100 MB: caught up in %s with %d snapshots %v; next batch visible after %s, snapshot %s",
		catchUp.Round(time.Millisecond), len(costs), costs, lat.Round(time.Millisecond), all[len(all)-1].Round(time.Millisecond))
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	t.Logf("heap in use %d MB", ms.HeapInuse>>20)
}

// TestLiveFollowRemote: POST /engine/connections/{id}/follow over the
// in-process SSH server (lib transport): the mirror feeds a live session; a
// batch appended on the host is visible in < 2 s (PLAN-DESKTOP § 9) with
// the default batch period; DELETE of the session stops the mirror.
func TestLiveFollowRemote(t *testing.T) {
	isolate(t)
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	e, ts := newServed(t)
	autoAnswer(t, e, ts, map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"})
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "lab", "kind": "ssh", "host": srv.Host, "port": srv.Port, "user": "oracle", "transport": "lib"})
	data, _ := os.ReadFile(traces + "io_waits.trc")
	cuts := lineCuts(data, 0.3, 0.6)
	hostFile := filepath.Join(t.TempDir(), "io_waits.trc")
	os.WriteFile(hostFile, data[:cuts[0]], 0o640)

	r := call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": hostFile})
	if r.code != 202 {
		t.Fatalf("follow %d %s", r.code, r.body)
	}
	fr := decode[struct {
		Session   SessionInfo
		Job       JobInfo
		LocalPath string
	}](t, r.body)
	if fr.Job.Kind != "follow" || fr.Session.ID == "" || fr.Session.Paths[0] != fr.LocalPath {
		t.Fatalf("follow answer %+v", fr)
	}
	le := &liveEnv{env: e, path: fr.LocalPath, id: fr.Session.ID}
	le.waitBytes(cuts[0])
	time.Sleep(1200 * time.Millisecond) // the next batch is due at once
	for i, c := range cuts[1:] {
		appendFile(t, hostFile, data[cuts[i]:c])
		start := time.Now()
		si := le.waitBytes(c)
		lat := time.Since(start)
		t.Logf("append of %d bytes on the host visible after %s (rev %d)", c-cuts[i], lat.Round(time.Millisecond), si.Rev)
		if lat > 2*time.Second {
			t.Errorf("follow latency %s > 2 s", lat)
		}
	}
	other := newEnv(t)
	id := other.openReady([]string{fr.LocalPath}, nil)
	want := other.req("GET", "/s/"+id+"/api/doc", nil).body
	if got := le.req("GET", "/s/"+le.id+"/api/doc", nil).body; !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(got, nil)) {
		t.Errorf("live document differs from a normal open of the mirror")
	}
	if r := call(t, ts, "DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if j := waitJob(t, ts, fr.Job.ID); j.State != JobCancelled {
		t.Errorf("mirror job after DELETE of the session: %+v", j)
	}

	// mirrorOnly: the E7 mirror without a session; cancelling a mirror
	// that feeds a session fails the session
	r = call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": hostFile, "mirrorOnly": true})
	mo := decode[map[string]json.RawMessage](t, r.body)
	if r.code != 202 || mo["session"] != nil || mo["job"] == nil {
		t.Fatalf("mirrorOnly %d %s", r.code, r.body)
	}
	call(t, ts, "DELETE", "/engine/jobs/"+decode[JobInfo](t, mo["job"]).ID, nil)
	waitJob(t, ts, decode[JobInfo](t, mo["job"]).ID)
	r = call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": hostFile, "options": map[string]any{"batchMs": 100}})
	fr = decode[struct {
		Session   SessionInfo
		Job       JobInfo
		LocalPath string
	}](t, r.body)
	le.id = fr.Session.ID
	le.waitBytes(int64(len(data[:cuts[len(cuts)-1]])))
	call(t, ts, "DELETE", "/engine/jobs/"+fr.Job.ID, nil)
	deadline := time.Now().Add(5 * time.Second)
	for le.info().State != SessionFailed && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if si := le.info(); si.State != SessionFailed || !strings.Contains(si.Error, "cancelled") {
		t.Errorf("session after its mirror was cancelled: %+v", si)
	}
	if r := call(t, ts, "GET", "/s/"+le.id+"/api/profile", nil); r.code != 200 {
		t.Errorf("last snapshot not served: %d", r.code)
	}
	if r := call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": hostFile, "options": map[string]any{"batchMs": 1}}); r.code != 400 {
		t.Errorf("bad options: %d %s", r.code, r.body)
	}
}
