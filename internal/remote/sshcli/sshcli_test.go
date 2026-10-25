package sshcli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
)

// TestMain: the fakes (and real ssh) run this test binary as SSH_ASKPASS.
func TestMain(m *testing.M) {
	if os.Getenv(EnvAskpassMode) == "1" {
		os.Exit(RunAskpass(os.Args[1:], os.Stdout, os.Stderr, nil))
	}
	os.Exit(m.Run())
}

const fixture = "../../../testdata/traces/19c/basic_binds.trc"

// fakeEnv puts the fake ssh/sftp first on PATH and returns the log directory.
func fakeEnv(t *testing.T) string {
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

// bridged is a client of target dbmint through a bridge answering with p.
func bridged(t *testing.T, p remote.Prompter) *Client {
	t.Helper()
	b, err := StartBridge(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	return &Client{Target: remote.Target{Host: "dbmint", Port: 2200, User: "oracle"}, Askpass: b.Env("c1"), ControlDir: shortDir(t)}
}

func TestArgvAndEnv(t *testing.T) {
	logs := fakeEnv(t)
	c := bridged(t, &remote.FakePrompter{})
	out, err := c.Test(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := exec.Command("uname", "-sr").Output(); out != strings.TrimSpace(string(want)) {
		t.Errorf("Test: %q, want %q", out, want)
	}
	calls := sshtest.Calls(logs)
	if len(calls) != 1 {
		t.Fatalf("%d calls", len(calls))
	}
	args := strings.Join(calls[0].Args, " ")
	for _, want := range []string{"-o BatchMode=no", "-o StrictHostKeyChecking=ask", "-o User=oracle", "-o Port=2200",
		"-o ControlMaster=auto", "-o ControlPersist=60", "-x -T -- dbmint sh -c 'uname -sr'"} {
		if !strings.Contains(args, want) {
			t.Errorf("argv %q lacks %q", args, want)
		}
	}
	exe, _ := os.Executable()
	env := calls[0].Env
	for k, want := range map[string]string{"SSH_ASKPASS": exe, "SSH_ASKPASS_REQUIRE": "force", EnvAskpassMode: "1",
		EnvEngine: c.Askpass.Engine, EnvToken: c.Askpass.Token, EnvConn: "c1"} {
		if env[k] != want {
			t.Errorf("env %s=%q, want %q", k, env[k], want)
		}
	}
	if len(env[EnvSpawn]) != 12 || env[EnvMark] == "" {
		t.Errorf("spawn %q mark %q", env[EnvSpawn], env[EnvMark])
	}
	if _, err := os.Stat(env[EnvMark]); !os.IsNotExist(err) {
		t.Errorf("askpass mark file left behind")
	}
	c.NoMultiplex = true
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if args := strings.Join(sshtest.Calls(logs)[1].Args, " "); strings.Contains(args, "ControlMaster") {
		t.Errorf("NoMultiplex: %s", args)
	}
}

func TestAskpassRoundTrip(t *testing.T) {
	fakeEnv(t)
	t.Setenv("FAKE_SSH_HOSTKEY", "1")
	t.Setenv("FAKE_SSH_PASSWORD", "hunter2")
	fp := &remote.FakePrompter{Answers: []string{"yes", "hunter2"}, ByKind: map[string]string{remote.KindHostKey: "yes"}}
	c := bridged(t, fp)
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	ps := fp.Prompts()
	if len(ps) != 2 || ps[0].Kind != remote.KindHostKey || ps[1].Kind != remote.KindPassword {
		t.Fatalf("prompts %+v", ps)
	}
	if ps[0].Fingerprint != "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" || !ps[0].Echo || ps[0].Connection != "c1" {
		t.Errorf("hostkey prompt %+v", ps[0])
	}
	if ps[1].Text != "oracle@dbmint's password: " || ps[1].Echo {
		t.Errorf("password prompt %+v", ps[1])
	}
	// the next run: the password comes from the cache, the host key is asked again (the fake never stores it)
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password", "hostkey"}) {
		t.Errorf("second run asked %v", k)
	}
	// a rejected host key fails the run
	fp.ByKind[remote.KindHostKey] = "no"
	if _, err := c.Test(context.Background()); err == nil || !strings.Contains(err.Error(), "Host key verification failed") {
		t.Errorf("rejected host key: %v", err)
	}
}

func TestAskpassWrongCachedPassword(t *testing.T) {
	fakeEnv(t)
	t.Setenv("FAKE_SSH_PASSWORD", "one")
	fp := &remote.FakePrompter{Answers: []string{"one"}}
	c := bridged(t, fp)
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_SSH_PASSWORD", "two") // changed on the host
	fp.Answers = []string{"two"}
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp.Kinds(); len(k) != 2 {
		t.Errorf("asked %v: want the cached answer once, then a prompt", k)
	}
	// cancel at the prompt: ssh fails, no hang
	fp.Answers, fp.Err = nil, errors.New("user cancelled")
	t.Setenv("FAKE_SSH_PASSWORD", "three")
	if _, err := c.Test(context.Background()); err == nil || !strings.Contains(err.Error(), "Permission denied") {
		t.Errorf("cancelled prompt: %v", err)
	}
}

func TestAskpassIgnored(t *testing.T) {
	fakeEnv(t)
	t.Setenv("FAKE_SSH_IGNORE_ASKPASS", "1")
	c := bridged(t, &remote.FakePrompter{})
	_, err := c.Test(context.Background())
	if !errors.Is(err, ErrAskpassIgnored) {
		t.Fatalf("want ErrAskpassIgnored, got %v", err)
	}
	// askpass called and still denied: an ordinary failure
	t.Setenv("FAKE_SSH_IGNORE_ASKPASS", "")
	t.Setenv("FAKE_SSH_PASSWORD", "pw")
	c = bridged(t, &remote.FakePrompter{ByKind: map[string]string{remote.KindPassword: "nope"}})
	_, err = c.Test(context.Background())
	var e *Error
	if errors.Is(err, ErrAskpassIgnored) || !errors.As(err, &e) || e.Code != 255 {
		t.Errorf("wrong password: %v", err)
	}
}

func TestFetch(t *testing.T) {
	want, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	abs, _ := filepath.Abs(fixture)
	for _, tc := range []struct {
		name   string
		noGzip bool // host without gzip
		off    bool // FetchOptions.NoGzip
		from   int64
		gz     bool
	}{
		{"gzip", false, false, 0, true},
		{"no gzip on host", true, false, 0, false},
		{"gzip off", false, true, 0, false},
		{"resume", false, false, 12345, true},
		{"resume at end", false, false, int64(len(want)), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := fakeEnv(t)
			if tc.noGzip {
				t.Setenv("FAKE_SSH_NO_GZIP", "1")
			}
			c := bridged(t, &remote.FakePrompter{})
			var buf bytes.Buffer
			var last int64
			err := c.Fetch(context.Background(), abs, &buf, remote.FetchOptions{From: tc.from, NoGzip: tc.off, Progress: func(p int64) { last = p }})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(buf.Bytes(), want[tc.from:]) {
				t.Fatalf("fetched %d bytes, want %d", buf.Len(), len(want)-int(tc.from))
			}
			if tc.from < int64(len(want)) && last != int64(len(want)) {
				t.Errorf("progress ended at %d", last)
			}
			calls := sshtest.Calls(logs)
			cmd := calls[len(calls)-1].Args[len(calls[len(calls)-1].Args)-1]
			cmd = strings.ReplaceAll(cmd, `'\''`, "'")
			if strings.Contains(cmd, "gzip -1 -c") != tc.gz || !strings.Contains(cmd, "tail -c +"+itoa(tc.from+1)+" -- '"+abs+"'") {
				t.Errorf("command %q", cmd)
			}
			probes := 0
			for _, c := range calls {
				if strings.Contains(c.Args[len(c.Args)-1], "command -v gzip") {
					probes++
				}
			}
			if want := map[bool]int{true: 0, false: 1}[tc.off]; probes != want {
				t.Errorf("%d gzip probes", probes)
			}
		})
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestFetchErrors(t *testing.T) {
	fakeEnv(t)
	c := bridged(t, &remote.FakePrompter{})
	var buf bytes.Buffer
	err := c.Fetch(context.Background(), "/no/such/file.trc", &buf, remote.FetchOptions{})
	if err == nil || !strings.Contains(err.Error(), "/no/such/file.trc: cannot read") {
		t.Errorf("missing file: %v", err)
	}
	// a quote in the path is passed through intact
	dir := t.TempDir()
	p := filepath.Join(dir, "it's here.trc")
	os.WriteFile(p, []byte("hello"), 0o644)
	buf.Reset()
	if err := c.Fetch(context.Background(), p, &buf, remote.FetchOptions{}); err != nil || buf.String() != "hello" {
		t.Errorf("quoted path: %q %v", buf.String(), err)
	}
}

func TestFetchCancel(t *testing.T) {
	fakeEnv(t)
	t.Setenv("FAKE_SSH_NO_GZIP", "1")
	p := filepath.Join(t.TempDir(), "big.trc")
	if err := os.WriteFile(p, bytes.Repeat([]byte("WAIT #1: nam='x' ela= 1\n"), 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	c := bridged(t, &remote.FakePrompter{})
	ctx, cancel := context.WithCancel(context.Background())
	var got int64
	start := time.Now()
	err := c.Fetch(ctx, p, io.Discard, remote.FetchOptions{Progress: func(pos int64) {
		got = pos
		cancel()
	}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	if fi, _ := os.Stat(p); got >= fi.Size() || time.Since(start) > 5*time.Second {
		t.Errorf("cancel took %s, read %d of %d", time.Since(start), got, fi.Size())
	}
}

func TestFollow(t *testing.T) {
	fakeEnv(t)
	p := filepath.Join(t.TempDir(), "live.trc")
	os.WriteFile(p, []byte("0123456789"), 0o644)
	c := bridged(t, &remote.FakePrompter{})
	r, err := c.Follow(context.Background(), p, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	got := make(chan string, 16)
	go func() {
		b := make([]byte, 64)
		for {
			n, err := r.Read(b)
			if n > 0 {
				got <- string(b[:n])
			}
			if err != nil {
				close(got)
				return
			}
		}
	}()
	expect := func(want string) {
		t.Helper()
		var s string
		deadline := time.After(5 * time.Second)
		for s != want {
			select {
			case x, ok := <-got:
				if !ok {
					t.Fatalf("stream ended at %q", s)
				}
				s += x
			case <-deadline:
				t.Fatalf("got %q, want %q", s, want)
			}
		}
	}
	expect("456789")
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	start := time.Now()
	f.WriteString("abc\n")
	f.Close()
	expect("abc\n")
	t.Logf("follow latency (fake ssh, local tail -f): %s", time.Since(start))
	r.Close()
	if _, ok := <-got; ok {
		for range got {
		}
	}
	if _, err := c.Follow(context.Background(), "/no/such.trc", 0); err != nil {
		t.Fatal(err) // the failure shows on Read
	}
	r2, _ := c.Follow(context.Background(), "/no/such.trc", 0)
	if _, err := io.ReadAll(r2); err == nil || !strings.Contains(err.Error(), "cannot read") {
		t.Errorf("follow of a missing file: %v", err)
	}
}

func TestLsFake(t *testing.T) {
	logs := fakeEnv(t)
	canned := filepath.Join(t.TempDir(), "ls.txt")
	os.WriteFile(canned, []byte(realSample), 0o644)
	t.Setenv("FAKE_SFTP_LS", canned)
	c := bridged(t, &remote.FakePrompter{})
	ents, err := c.Ls(context.Background(), `/tmp/TestZZSample268708101/001`)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 6 || ents[0].Name != "a.trc" || ents[0].Size != 123456 {
		t.Errorf("entries %+v", ents)
	}
	calls := sshtest.Calls(logs)
	args := strings.Join(calls[0].Args, " ")
	if !strings.Contains(args, "-o BatchMode=no") || !strings.HasSuffix(args, "-b - dbmint") ||
		strings.Index(args, "BatchMode=no") > strings.Index(args, "-b -") {
		t.Errorf("sftp argv %q (BatchMode=no must precede -b, which implies BatchMode=yes)", args)
	}
	if !slices.Equal(calls[0].Batch, []string{`ls -ln "/tmp/TestZZSample268708101/001"`}) {
		t.Errorf("batch %q", calls[0].Batch)
	}
	t.Setenv("FAKE_SFTP_LS", "")
	if _, err := c.Ls(context.Background(), "/nope"); err == nil || !strings.Contains(err.Error(), "Can't ls") {
		t.Errorf("ls of a missing dir: %v", err)
	}
}

func TestDiagScript(t *testing.T) {
	fakeEnv(t)
	base := t.TempDir()
	for _, d := range []string{"cdb1/cdb1/trace", "orcl/orcl/trace", "orcl/orcl/alert"} {
		os.MkdirAll(filepath.Join(base, "diag/rdbms", d), 0o755)
	}
	t.Setenv("ORACLE_BASE", base)
	c := bridged(t, &remote.FakePrompter{})
	dirs, err := c.Diag(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{base + "/diag/rdbms/cdb1/cdb1/trace", base + "/diag/rdbms/orcl/orcl/trace"}
	if !slices.Equal(dirs[:min(2, len(dirs))], want) {
		t.Errorf("diag %v, want %v first", dirs, want)
	}
}
