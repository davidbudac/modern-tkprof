package engine

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/db"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshcli"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
)

// TestMain: the (fake) ssh the engine spawns runs this test binary as its
// SSH_ASKPASS, like the real engine runs mtkprof.
func TestMain(m *testing.M) {
	if os.Getenv(sshcli.EnvAskpassMode) == "1" {
		os.Exit(sshcli.RunAskpass(os.Args[1:], os.Stdout, os.Stderr, nil))
	}
	os.Exit(m.Run())
}

// isolate keeps the user's ~/.ssh and agent out of the test.
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SSH_AUTH_SOCK", "")
	return home
}

// fakeSSH puts the fake ssh/sftp first on PATH; it returns their log dir.
func fakeSSH(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fakes are shell scripts")
	}
	bin, logs := t.TempDir(), t.TempDir()
	if err := sshtest.WriteFakes(bin); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_SSH_DIR", logs)
	for _, k := range []string{"FAKE_SSH_PASSWORD", "FAKE_SSH_HOSTKEY", "FAKE_SSH_IGNORE_ASKPASS", "FAKE_SSH_NO_GZIP", "FAKE_SFTP_LS"} {
		t.Setenv(k, "")
	}
	return logs
}

// answerer answers the engine's prompt events by kind (a missing kind is
// cancelled) and records them.
type answerer struct {
	mu   sync.Mutex
	seen []PromptEvent
}

func autoAnswer(t *testing.T, e *env, ts *httptest.Server, answers map[string]string) *answerer {
	t.Helper()
	return autoAnswerFn(t, ts, func(pe PromptEvent) map[string]any {
		if ans, ok := answers[pe.Kind]; ok {
			return map[string]any{"answer": ans}
		}
		return map[string]any{"cancel": true}
	})
}

// autoAnswerFn answers every open prompt with the body fn returns.
func autoAnswerFn(t *testing.T, ts *httptest.Server, fn func(PromptEvent) map[string]any) *answerer {
	t.Helper()
	ev := openSSE(t, ts)
	a := &answerer{}
	go func() {
		for {
			typ, data := "", ""
			for ev.sc.Scan() {
				line := ev.sc.Text()
				switch {
				case strings.HasPrefix(line, "event: "):
					typ = line[7:]
				case strings.HasPrefix(line, "data: "):
					data = line[6:]
				case line == "" && typ != "":
					goto got
				}
			}
			return
		got:
			if typ != "prompt" {
				continue
			}
			var pe PromptEvent
			json.Unmarshal([]byte(data), &pe)
			if pe.State != "open" {
				continue
			}
			a.mu.Lock()
			a.seen = append(a.seen, pe)
			a.mu.Unlock()
			b, _ := json.Marshal(fn(pe))
			req, _ := http.NewRequest("POST", ts.URL+"/engine/prompts/"+pe.ID, bytes.NewReader(b))
			req.Header.Set("Authorization", "Bearer "+testToken)
			if r, err := http.DefaultClient.Do(req); err == nil {
				r.Body.Close()
			}
		}
	}()
	return a
}

func (a *answerer) kinds() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, p := range a.seen {
		out = append(out, p.Kind)
	}
	return out
}

func (a *answerer) prompts() []PromptEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.seen)
}

// call does a request against the served engine.
func call(t *testing.T, ts *httptest.Server, method, path string, body any) resp {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, ts.URL+path, rd)
	req.Header.Set("Authorization", "Bearer "+testToken)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r.Body)
	return resp{r.StatusCode, r.Header, buf.Bytes()}
}

// waitJob polls a job until it leaves running.
func waitJob(t *testing.T, ts *httptest.Server, id string) JobInfo {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		for _, j := range decode[struct{ Jobs []JobInfo }](t, call(t, ts, "GET", "/engine/jobs", nil).body).Jobs {
			if j.ID == id && j.State != JobRunning {
				return j
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s still running", id)
	return JobInfo{}
}

func TestConnectionRoutes(t *testing.T) {
	isolate(t)
	e := newEnv(t)
	put := func(def map[string]any) resp { return e.req("POST", "/engine/connections", def) }
	r := put(map[string]any{"id": "lab", "kind": "ssh", "host": "dbmint", "port": 2200, "user": "oracle"})
	if r.code != 200 {
		t.Fatalf("put: %d %s", r.code, r.body)
	}
	ci := decode[struct{ Connection ConnectionInfo }](t, r.body).Connection
	if ci != (ConnectionInfo{ID: "lab", Kind: "ssh", Host: "dbmint", Port: 2200, User: "oracle", Transport: "auto"}) {
		t.Errorf("info %+v", ci)
	}
	if r := put(map[string]any{"id": "ora", "kind": "db", "host": "dbmint", "port": 1521, "user": "mtk", "service": "pdb1"}); r.code != 200 {
		t.Fatalf("db put: %d %s", r.code, r.body)
	}
	// replace
	if r := put(map[string]any{"id": "lab", "kind": "ssh", "host": "dbmint", "transport": "lib"}); r.code != 200 {
		t.Fatalf("replace: %d %s", r.code, r.body)
	}
	list := decode[struct{ Connections []ConnectionInfo }](t, e.req("GET", "/engine/connections", nil).body).Connections
	if len(list) != 2 || list[0].ID != "lab" || list[0].Transport != "lib" || list[1].ID != "ora" || list[1].Service != "pdb1" {
		t.Errorf("list %+v", list)
	}
	for _, bad := range []map[string]any{
		{"id": "", "kind": "ssh", "host": "h"},
		{"id": "../x", "kind": "ssh", "host": "h"},
		{"id": "a", "kind": "ftp", "host": "h"},
		{"id": "a", "kind": "ssh", "host": "-oProxyCommand=x"},
		{"id": "a", "kind": "ssh", "host": "h", "transport": "telnet"},
		{"id": "a", "kind": "ssh", "host": "h", "port": 70000},
		{"id": "a", "kind": "db", "host": "h", "transport": "cli"},
		{"id": "a", "kind": "ssh", "host": "h", "password": "no secrets here"},
	} {
		if r := put(bad); r.code != 400 {
			t.Errorf("%v: %d %s", bad, r.code, r.body)
		}
	}
	// ssh-only routes on a db connection, db-only routes on an ssh one
	for _, rq := range [][2]string{{"GET", "/engine/connections/ora/ls?path=/x"}, {"GET", "/engine/connections/lab/sessions"},
		{"GET", "/engine/connections/lab/tracefiles"}} {
		if r := e.req(rq[0], rq[1], nil); r.code != 400 || !strings.Contains(string(r.body), "only") {
			t.Errorf("%s %s: %d %s", rq[0], rq[1], r.code, r.body)
		}
	}
	if r := e.req("POST", "/engine/connections/ora/follow", map[string]any{"path": "/x/y.trc"}); r.code != 400 {
		t.Errorf("db follow: %d", r.code)
	}
	for _, rq := range [][2]string{{"POST", "/engine/connections/nope/test"}, {"GET", "/engine/connections/nope/ls?path=/"},
		{"DELETE", "/engine/connections/nope"}} {
		if r := e.req(rq[0], rq[1], nil); r.code != 404 {
			t.Errorf("%s %s: %d", rq[0], rq[1], r.code)
		}
	}
	if r := e.req("GET", "/engine/connections/lab/ls", nil); r.code != 400 {
		t.Errorf("ls without path: %d", r.code)
	}
	for _, body := range []map[string]any{{"paths": []string{}}, {"paths": []string{"/a/x.trc", "/b/x.trc"}}, {"paths": []string{"/"}}, {"paths": []string{"/a"}, "zip": 1}} {
		if r := e.req("POST", "/engine/connections/lab/fetch", body); r.code != 400 {
			t.Errorf("fetch %v: %d %s", body, r.code, r.body)
		}
	}
	if r := e.req("DELETE", "/engine/connections/lab", nil); r.code != 204 {
		t.Errorf("delete: %d", r.code)
	}
	if r := e.req("GET", "/engine/connections/lab/diag", nil); r.code != 404 {
		t.Errorf("after delete: %d", r.code)
	}
	if r := e.req("GET", "/engine/connections", nil, "Authorization", ""); r.code != 401 {
		t.Errorf("no token: %d", r.code)
	}
	if r := e.req("POST", "/engine/askpass", map[string]any{"text": "x"}, "Authorization", ""); r.code != 401 {
		t.Errorf("askpass without token: %d", r.code)
	}
}

// TestAskpassThroughEngine: the engine spawns (fake) ssh, which runs the
// askpass helper, which posts to POST /engine/askpass; the prompt event is
// answered like the shell would and ssh gets the password.
func TestAskpassThroughEngine(t *testing.T) {
	isolate(t)
	logs := fakeSSH(t)
	t.Setenv("FAKE_SSH_HOSTKEY", "1")
	t.Setenv("FAKE_SSH_PASSWORD", "tiger")
	e, ts := newServed(t)
	a := autoAnswer(t, e, ts, map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "tiger"})
	def := map[string]any{"id": "lab", "kind": "ssh", "host": "dbmint", "port": 2200, "user": "oracle", "transport": "cli"}
	if r := call(t, ts, "POST", "/engine/connections", def); r.code != 200 {
		t.Fatalf("put %d %s", r.code, r.body)
	}
	r := call(t, ts, "POST", "/engine/connections/lab/test", nil)
	if r.code != 200 {
		t.Fatalf("test: %d %s", r.code, r.body)
	}
	if ct := decode[ConnectionTest](t, r.body); ct.Transport != "cli" || ct.Server == "" {
		t.Errorf("test answer %+v", ct)
	}
	ps := a.prompts()
	if len(ps) != 2 || ps[0].Kind != "hostkey" || ps[0].Fingerprint != "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" ||
		ps[1].Kind != "password" || ps[1].Text != "oracle@dbmint's password: " || ps[1].Connection != "lab" || ps[1].Echo {
		t.Fatalf("prompts %+v", ps)
	}
	calls := sshtest.Calls(logs)
	env := calls[0].Env
	if env[sshcli.EnvEngine] != strings.TrimPrefix(ts.URL, "http://") || env[sshcli.EnvToken] != testToken || env[sshcli.EnvConn] != "lab" ||
		env["SSH_ASKPASS_REQUIRE"] != "force" {
		t.Errorf("ssh env: engine %q token %q conn %q", env[sshcli.EnvEngine], env[sshcli.EnvToken], env[sshcli.EnvConn])
	}
	// the password is cached for the connection
	if r := call(t, ts, "POST", "/engine/connections/lab/test", nil); r.code != 200 {
		t.Fatalf("second test: %d %s", r.code, r.body)
	}
	if k := a.kinds(); !slices.Equal(k, []string{"hostkey", "password", "hostkey"}) {
		t.Errorf("second run: %v", k)
	}
	// deleting the connection drops it
	call(t, ts, "DELETE", "/engine/connections/lab", nil)
	call(t, ts, "POST", "/engine/connections", def)
	call(t, ts, "POST", "/engine/connections/lab/test", nil)
	if k := a.kinds(); !slices.Equal(k, []string{"hostkey", "password", "hostkey", "hostkey", "password"}) {
		t.Errorf("after delete: %v", k)
	}
	// a cancelled prompt fails the request (the answerer cancels otp)
	t.Setenv("FAKE_SSH_HOSTKEY", "")
	call(t, ts, "DELETE", "/engine/connections/lab", nil)
	call(t, ts, "POST", "/engine/connections", def)
	r = call(t, ts, "POST", "/engine/askpass", sshcli.AskpassRequest{Connection: "lab", Text: "Verification code: "})
	if r.code != 409 || !strings.Contains(string(r.body), "cancelled") {
		t.Errorf("cancelled askpass: %d %s", r.code, r.body)
	}
	// ssh ignoring SSH_ASKPASS on an auto connection: the engine moves to the library
	t.Setenv("FAKE_SSH_IGNORE_ASKPASS", "1")
	srv := sshtest.Start(t, sshtest.Options{Password: "tiger"})
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "win", "kind": "ssh", "host": srv.Host, "port": srv.Port, "user": "oracle"})
	r = call(t, ts, "POST", "/engine/connections/win/test", nil)
	if ct := decode[ConnectionTest](t, r.body); r.code != 200 || ct.Transport != "lib" {
		t.Errorf("auto fallback: %d %s", r.code, r.body)
	}
	list := decode[struct{ Connections []ConnectionInfo }](t, call(t, ts, "GET", "/engine/connections", nil).body).Connections
	if list[len(list)-1].Active != "lib" {
		t.Errorf("active transport %+v", list)
	}
}

func TestFetchAndFollowLib(t *testing.T) {
	home := isolate(t)
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	e, ts := newServed(t)
	a := autoAnswer(t, e, ts, map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"})
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "lab", "kind": "ssh", "host": srv.Host, "port": srv.Port, "user": "oracle", "transport": "lib"})

	dir := t.TempDir()
	want, _ := os.ReadFile(traces + "basic_binds.trc")
	src := filepath.Join(dir, "basic_binds.trc")
	os.WriteFile(src, want, 0o640)
	r := call(t, ts, "GET", "/engine/connections/lab/ls?path="+dir, nil)
	if r.code != 200 {
		t.Fatalf("ls %d %s", r.code, r.body)
	}
	if l := decode[RemoteListing](t, r.body); len(l.Entries) != 1 || l.Entries[0].Size != int64(len(want)) || l.Path != dir {
		t.Errorf("ls %+v", l)
	}
	if k := a.kinds(); !slices.Equal(k, []string{"hostkey", "password"}) {
		t.Errorf("prompts %v", k)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".ssh", "known_hosts")); !bytes.Contains(b, []byte("ssh-ed25519")) {
		t.Errorf("known_hosts after yes: %q", b)
	}
	r = call(t, ts, "GET", "/engine/connections/lab/ls?path=/no/such/dir", nil)
	if r.code != 502 || !strings.Contains(string(r.body), `"remote"`) {
		t.Errorf("ls of a missing dir: %d %s", r.code, r.body)
	}

	fetch := func() (JobInfo, string) {
		t.Helper()
		r := call(t, ts, "POST", "/engine/connections/lab/fetch", map[string]any{"paths": []string{src}})
		if r.code != 202 {
			t.Fatalf("fetch %d %s", r.code, r.body)
		}
		fr := decode[struct {
			Job        JobInfo
			LocalPaths []string
		}](t, r.body)
		if fr.Job.Kind != "fetch" || fr.Job.Connection != "lab" || len(fr.LocalPaths) != 1 {
			t.Fatalf("fetch answer %+v", fr)
		}
		return waitJob(t, ts, fr.Job.ID), fr.LocalPaths[0]
	}
	j, local := fetch()
	if j.State != JobDone || j.Done != int64(len(want)) || j.Total != int64(len(want)) || !slices.Equal(j.LocalPaths, []string{local}) {
		t.Fatalf("fetch job %+v", j)
	}
	if local != filepath.Join(e.cache, "remote", "lab", "basic_binds.trc") {
		t.Errorf("local path %s", local)
	}
	if got, _ := os.ReadFile(local); !bytes.Equal(got, want) {
		t.Fatalf("fetched file differs")
	}
	// resume: a partial local file is completed
	os.Truncate(local, 1000)
	if j, _ := fetch(); j.State != JobDone {
		t.Fatalf("resume %+v", j)
	}
	if got, _ := os.ReadFile(local); !bytes.Equal(got, want) {
		t.Fatalf("resumed file differs")
	}
	// a longer local file (rotated on the host) is fetched again
	os.WriteFile(local, append(slices.Clone(want), "junk"...), 0o600)
	if j, _ := fetch(); j.State != JobDone {
		t.Fatalf("refetch %+v", j)
	}
	if got, _ := os.ReadFile(local); !bytes.Equal(got, want) {
		t.Fatalf("refetched file differs")
	}
	// the fetched file opens as a session
	sid := e.openReady([]string{local}, nil)
	if r := call(t, ts, "GET", "/s/"+sid+"/api/profile", nil); r.code != 200 {
		t.Errorf("profile of the fetched trace: %d", r.code)
	}

	// follow: mirror, append, cancel
	live := filepath.Join(dir, "live.trc")
	os.WriteFile(live, []byte("line 1\n"), 0o640)
	r = call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": live})
	if r.code != 202 {
		t.Fatalf("follow %d %s", r.code, r.body)
	}
	fr := decode[struct {
		Job       JobInfo
		LocalPath string
	}](t, r.body)
	if r := call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": live}); r.code != 409 {
		t.Errorf("second follow of the same file: %d", r.code)
	}
	waitFile := func(want string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if b, _ := os.ReadFile(fr.LocalPath); string(b) == want {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		b, _ := os.ReadFile(fr.LocalPath)
		t.Fatalf("mirror %q, want %q", b, want)
	}
	waitFile("line 1\n")
	f, _ := os.OpenFile(live, os.O_APPEND|os.O_WRONLY, 0)
	start := time.Now()
	f.WriteString("line 2\n")
	f.Close()
	waitFile("line 1\nline 2\n")
	t.Logf("follow latency (engine, lib, 500 ms poll): %s", time.Since(start).Round(time.Millisecond))
	if r := call(t, ts, "DELETE", "/engine/jobs/"+fr.Job.ID, nil); r.code != 202 {
		t.Fatalf("cancel follow: %d", r.code)
	}
	if j := waitJob(t, ts, fr.Job.ID); j.State != JobCancelled || j.Done != 14 || j.Connection != "lab" {
		t.Errorf("follow job %+v", j)
	}
}

func TestFetchCancelCLI(t *testing.T) {
	isolate(t)
	fakeSSH(t)
	t.Setenv("FAKE_SSH_NO_GZIP", "1")
	t.Setenv("FAKE_SSH_SLOW", "0.01")
	src := filepath.Join(t.TempDir(), "slow.trc")
	os.WriteFile(src, bytes.Repeat([]byte("WAIT #1: nam='x' ela= 1\n"), 1000), 0o644)
	ls := filepath.Join(t.TempDir(), "ls")
	os.WriteFile(ls, []byte("-rw-r-----    1 54321    54321        24000 Oct 25 09:11 "+src+"\n"), 0o644)
	t.Setenv("FAKE_SFTP_LS", ls)
	_, ts := newServed(t)
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "lab", "kind": "ssh", "host": "dbmint", "transport": "cli"})
	r := call(t, ts, "POST", "/engine/connections/lab/fetch", map[string]any{"paths": []string{src}})
	if r.code != 202 {
		t.Fatalf("fetch %d %s", r.code, r.body)
	}
	fr := decode[struct {
		Job        JobInfo
		LocalPaths []string
	}](t, r.body)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if fi, err := os.Stat(fr.LocalPaths[0]); err == nil && fi.Size() >= 240 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no progress: %s", call(t, ts, "GET", "/engine/jobs", nil).body)
		}
		time.Sleep(10 * time.Millisecond)
	}
	start := time.Now()
	if r := call(t, ts, "DELETE", "/engine/jobs/"+fr.Job.ID, nil); r.code != 202 {
		t.Fatalf("cancel %d", r.code)
	}
	j := waitJob(t, ts, fr.Job.ID)
	if j.State != JobCancelled || j.Total != 24000 || len(j.LocalPaths) != 0 || time.Since(start) > 2*time.Second {
		t.Errorf("cancelled fetch %+v after %s", j, time.Since(start))
	}
	fi, _ := os.Stat(fr.LocalPaths[0])
	if fi.Size() == 0 || fi.Size() >= 24000 || fi.Size()%24 != 0 {
		t.Errorf("partial file %d bytes", fi.Size())
	}
	// the next fetch resumes at the partial size
	t.Setenv("FAKE_SSH_SLOW", "")
	r = call(t, ts, "POST", "/engine/connections/lab/fetch", map[string]any{"paths": []string{src}, "gzip": false})
	j = waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID)
	got, _ := os.ReadFile(fr.LocalPaths[0])
	want, _ := os.ReadFile(src)
	if j.State != JobDone || !bytes.Equal(got, want) {
		t.Errorf("resumed fetch %+v, %d bytes", j, len(got))
	}
}

// TestConnectionSchemas: the connection schemas have the Go types' fields.
func TestConnectionSchemas(t *testing.T) {
	keys := readYAMLKeys(t)
	for name, v := range map[string]any{
		"ConnectionDef": ConnectionDef{}, "ConnectionInfo": ConnectionInfo{}, "ConnectionTest": ConnectionTest{},
		"RemoteListing": RemoteListing{}, "RemoteEntry": remote.Entry{}, "AskpassRequest": sshcli.AskpassRequest{},
		"DBDiag": DBDiag{}, "DBTraceFile": db.TraceFile{}, "DBSession": db.Session{},
	} {
		p := lookup(keys, "components", "schemas", name, "properties")
		if p < 0 {
			t.Errorf("schema %s: no properties", name)
			continue
		}
		var doc, have []string
		for _, c := range children(keys, p) {
			doc = append(doc, keys[c].key)
		}
		typ := reflect.TypeOf(v)
		for i := 0; i < typ.NumField(); i++ {
			tag, _, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
			if tag != "" && tag != "-" {
				have = append(have, tag)
			}
		}
		slices.Sort(doc)
		slices.Sort(have)
		if !slices.Equal(doc, have) {
			t.Errorf("schema %s has %v, the Go type %v", name, doc, have)
		}
	}
}
