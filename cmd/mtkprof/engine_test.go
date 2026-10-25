package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestMain lets the tests run this binary as mtkprof: MTKPROF_TEST_MAIN=1
// with the arguments in MTKPROF_TEST_ARGS (separated by \x1f).
func TestMain(m *testing.M) {
	if os.Getenv("MTKPROF_TEST_MAIN") == "1" {
		os.Args = append([]string{"mtkprof"}, strings.Split(os.Getenv("MTKPROF_TEST_ARGS"), "\x1f")...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func mtkprof(t *testing.T, env []string, args ...string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "MTKPROF_TEST_MAIN=1", "MTKPROF_TEST_ARGS="+strings.Join(args, "\x1f"))
	cmd.Env = append(cmd.Env, env...)
	return cmd
}

const engineToken = "test-token-0123456789abcdef0123456789"

func TestEngineTokenRequired(t *testing.T) {
	cmd := mtkprof(t, []string{"MTKPROF_TOKEN=short"}, "engine", "-cache", t.TempDir())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 2 || !strings.Contains(stderr.String(), "MTKPROF_TOKEN") {
		t.Errorf("short token: %v, %q", err, stderr.String())
	}
}

// TestEngineProcess starts `mtkprof engine`, reads the ready line, opens a
// trace, compares answers with a `mtkprof serve -spill` process on the same
// trace, and closes stdin: the engine exits and removes its spill directory.
func TestEngineProcess(t *testing.T) {
	trc, _ := filepath.Abs("../../testdata/traces/19c/basic_binds.trc")
	cache := t.TempDir()
	cmd := mtkprof(t, []string{"MTKPROF_TOKEN=" + engineToken}, "engine", "-cache", cache)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Ready    bool
		Addr     string
		Version  string
		Protocol int
	}
	if err := json.Unmarshal([]byte(line), &ready); err != nil || !ready.Ready || ready.Protocol != 1 || ready.Version != version ||
		!regexp.MustCompile(`^\{"ready":true,"addr":"127\.0\.0\.1:\d+","version":"[^"]*","protocol":1\}\n$`).MatchString(line) {
		t.Fatalf("ready line %q: %v", line, err)
	}
	base := "http://" + ready.Addr
	call := func(method, path, body string) (int, []byte) {
		req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+engineToken)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, b
	}
	code, body := call("POST", "/engine/sessions", `{"paths":["`+trc+`"]}`)
	if code != 202 {
		t.Fatalf("open: %d %s", code, body)
	}
	var o struct{ Session struct{ ID string } }
	json.Unmarshal(body, &o)
	for i := 0; ; i++ {
		_, b := call("GET", "/engine/sessions/"+o.Session.ID, "")
		if bytes.Contains(b, []byte(`"state":"ready"`)) {
			break
		}
		if i > 500 || bytes.Contains(b, []byte(`"state":"failed"`)) {
			t.Fatalf("session: %s", b)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// serve -spill on the same trace
	srv := mtkprof(t, nil, "serve", trc, "-addr", "127.0.0.1:0", "-spill="+t.TempDir(), "-plan-viz-url", "")
	se, _ := srv.StderrPipe()
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { srv.Process.Kill(); srv.Wait() }()
	sc := bufio.NewScanner(se)
	var serveAddr string
	for sc.Scan() {
		if m := regexp.MustCompile(`at http://([^/]+)/`).FindStringSubmatch(sc.Text()); m != nil {
			serveAddr = m[1]
			break
		}
	}
	go io.Copy(io.Discard, se)
	if serveAddr == "" {
		t.Fatal("serve did not start")
	}
	gen := regexp.MustCompile(`"generated":"[^"]*"`)
	for _, q := range []string{"/api/doc", "/api/pivot?fact=calls&by=stmt", "/api/pivot?fact=waits&by=event,stmt", "/api/timeline",
		"/api/executions?stmt=1", "/api/waits?scope=all", "/api/profile", "/api/stmt/roles", "/api/lines?file=0&from=1&n=50"} {
		r, err := http.Get("http://" + serveAddr + q)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := io.ReadAll(r.Body)
		r.Body.Close()
		code, got := call("GET", "/s/"+o.Session.ID+q, "")
		if code != r.StatusCode || !bytes.Equal(gen.ReplaceAll(got, nil), gen.ReplaceAll(want, nil)) {
			t.Errorf("%s: serve %d %d bytes, engine %d %d bytes", q, r.StatusCode, len(want), code, len(got))
		}
	}

	if ents, _ := os.ReadDir(cache); len(ents) != 1 {
		t.Errorf("cache dir while open: %v", ents)
	}
	stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("engine exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("engine did not exit after stdin EOF")
	}
	if ents, _ := os.ReadDir(cache); len(ents) != 0 {
		t.Errorf("cache dir after exit: %v", ents)
	}
}
