package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuf is a bytes.Buffer safe for a writer and a reader goroutine.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// TestCLIFollowServe: follow -serve parses the remote trace as it grows and
// serves the live report: the UI at /, api/doc with X-Rev and the ?rev=
// long poll, reads only; when the trace continues in another file (the
// real midtrace_start pair) it follows that one too and the line endpoints
// serve both files; Ctrl-C stops it and removes the temporary mirror.
func TestCLIFollowServe(t *testing.T) {
	srv, _ := sshFixture(t)
	spec := "oracle@" + srv.Host + ":" + strconv.Itoa(srv.Port)
	part1, _ := os.ReadFile("../../testdata/traces/19c/midtrace_start_part1.trc")
	part2, _ := os.ReadFile("../../testdata/traces/19c/midtrace_start.trc")
	next := filepath.Base(strings.TrimSuffix(strings.TrimSpace(regexp.MustCompile(`CONTINUES IN FILE (\S+)`).FindStringSubmatch(string(part1))[1]), "***"))
	host := t.TempDir()
	h1 := filepath.Join(host, "part1.trc")
	half := bytes.IndexByte(part1[len(part1)/2:], '\n') + len(part1)/2 + 1
	os.WriteFile(h1, part1[:half], 0o640)

	ctx, cancel := context.WithCancel(context.Background())
	old := cliContext
	cliContext = func() (context.Context, context.CancelFunc) { return ctx, cancel }
	t.Cleanup(func() { cliContext = old })
	var stderr syncBuf
	done := make(chan error, 1)
	go func() {
		done <- followMain([]string{spec, h1, "-transport", "lib", "-serve=127.0.0.1:0", "-batch-ms", "50"}, io.Discard, &stderr)
	}()
	re := regexp.MustCompile(`into (\S+), serving the live report at (http://\S+/)`)
	var base, mirror string
	for deadline := time.Now().Add(10 * time.Second); base == ""; time.Sleep(20 * time.Millisecond) {
		if m := re.FindStringSubmatch(stderr.String()); m != nil {
			mirror, base = m[1], m[2]
		}
		if time.Now().After(deadline) {
			t.Fatalf("no serving line: %s", stderr.String())
		}
	}
	get := func(path string) (*http.Response, []byte) {
		t.Helper()
		r, err := http.Get(base + strings.TrimPrefix(path, "/"))
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r, b
	}
	type doc struct {
		File struct {
			Files []struct{ Size int64 }
		}
	}
	waitDoc := func(ok func(d doc) bool) (int, doc) {
		t.Helper()
		for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			r, b := get("/api/doc")
			if r.StatusCode != 200 {
				continue
			}
			var d doc
			if err := json.Unmarshal(b, &d); err != nil {
				t.Fatal(err)
			}
			if ok(d) {
				rev, _ := strconv.Atoi(r.Header.Get("X-Rev"))
				return rev, d
			}
		}
		t.Fatalf("document never got there: %s", stderr.String())
		return 0, doc{}
	}
	rev, _ := waitDoc(func(d doc) bool { return len(d.File.Files) == 1 && d.File.Files[0].Size == int64(half) })
	if r, b := get("/"); r.StatusCode != 200 || !bytes.Contains(b, []byte("<html")) {
		t.Errorf("UI: %d %.100s", r.StatusCode, b)
	}
	if r, err := http.Post(base+"api/ref", "application/json", strings.NewReader("{}")); err != nil || r.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST api/ref: %v %v", r.StatusCode, err)
	}

	// the long poll answers once the host's append is parsed
	polled := make(chan int, 1)
	go func() {
		r, err := http.Get(base + "api/doc?rev=" + strconv.Itoa(rev))
		if err != nil {
			polled <- -1
			return
		}
		r.Body.Close()
		n, _ := strconv.Atoi(r.Header.Get("X-Rev"))
		polled <- n
	}()
	time.Sleep(100 * time.Millisecond)
	f, _ := os.OpenFile(h1, os.O_APPEND|os.O_WRONLY, 0)
	f.Write(part1[half:])
	f.Close()
	select {
	case n := <-polled:
		if n <= rev {
			t.Errorf("long poll: rev %d after %d", n, rev)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("long poll did not answer")
	}

	os.WriteFile(filepath.Join(host, next), part2, 0o640)
	waitDoc(func(d doc) bool {
		return len(d.File.Files) == 2 && d.File.Files[0].Size == int64(len(part1)) && d.File.Files[1].Size == int64(len(part2))
	})
	if r, b := get("/api/lines?file=1&from=1&n=3"); r.StatusCode != 200 || !bytes.HasPrefix(b, part2[:bytes.IndexByte(part2, '\n')]) {
		t.Errorf("lines of the second file: %d %.200q", r.StatusCode, b)
	}
	if r, b := get("/api/at?file=1&line=40"); r.StatusCode != 200 || !bytes.Contains(b, []byte(`"kind"`)) {
		t.Errorf("at: %d %.200s", r.StatusCode, b)
	}
	if r, b := get("/api/pivot?fact=calls&by=stmt"); r.StatusCode != 200 || r.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("pivot: %d %.200s", r.StatusCode, b)
	}
	t.Logf("stderr:\n%s", stderr.String())
	if !strings.Contains(stderr.String(), "continues in") {
		t.Errorf("no switch logged: %s", stderr.String())
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("follow -serve after Ctrl-C: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("follow -serve did not stop")
	}
	if _, err := os.Stat(filepath.Dir(filepath.Dir(mirror))); !os.IsNotExist(err) {
		t.Errorf("temporary directory left: %v", err)
	}
	if _, err := http.Get(base + "api/doc"); err == nil {
		t.Errorf("still serving after Ctrl-C")
	}
}
