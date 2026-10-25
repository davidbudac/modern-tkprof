package sshlib

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const fixture = "../../../testdata/traces/19c/basic_binds.trc"

func client(t *testing.T, srv *sshtest.Server, home string, fp remote.Prompter) *Client {
	t.Helper()
	t.Setenv("SSH_AUTH_SOCK", "")
	c := New(Options{Target: remote.Target{Host: srv.Host, Port: srv.Port, User: "oracle"}, Prompter: fp, Conn: "c9", Home: home,
		PollInterval: 50 * time.Millisecond})
	t.Cleanup(func() { c.Close() })
	return c
}

func TestPasswordAndHostKey(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "oracle", Password: "pw"})
	home := t.TempDir()
	fp := &remote.FakePrompter{Answers: []string{"yes", "pw"}}
	c := client(t, srv, home, fp)
	ctx := context.Background()
	out, err := c.Test(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "SSH-2.0-Go") {
		t.Errorf("Test: %q", out)
	}
	ps := fp.Prompts()
	if len(ps) != 2 || ps[0].Kind != remote.KindHostKey || ps[1].Kind != remote.KindPassword {
		t.Fatalf("prompts %+v", ps)
	}
	fpr := ssh.FingerprintSHA256(srv.HostKey)
	if ps[0].Fingerprint != fpr || !strings.Contains(ps[0].Text, fpr) || ps[0].Connection != "c9" || !ps[0].Echo {
		t.Errorf("hostkey prompt %+v", ps[0])
	}
	if ps[1].Text != "oracle@127.0.0.1's password: " || ps[1].Echo {
		t.Errorf("password prompt %+v", ps[1])
	}
	kh, err := os.ReadFile(filepath.Join(home, ".ssh", "known_hosts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "[127.0.0.1]:"; !strings.HasPrefix(string(kh), want) || !strings.Contains(string(kh), "ssh-ed25519 ") {
		t.Errorf("known_hosts %q", kh)
	}
	// a dropped connection is redialled with the cached password
	srv.DropConnections()
	time.Sleep(50 * time.Millisecond)
	if _, err := c.Test(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(fp.Prompts()); n != 2 || srv.Logins() != 2 {
		t.Errorf("redial: %d prompts, %d logins", n, srv.Logins())
	}
	// a new client: the host is known now; Close forgot the password
	c.Close()
	fp2 := &remote.FakePrompter{Answers: []string{"wrong", "pw"}}
	c2 := client(t, srv, home, fp2)
	if _, err := c2.Test(ctx); err != nil {
		t.Fatal(err)
	}
	if k := fp2.Kinds(); !slices.Equal(k, []string{"password", "password"}) {
		t.Errorf("known host, wrong then right password: %v", k)
	}
}

func TestHostKeyRejectedAndChanged(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	home := t.TempDir()
	c := client(t, srv, home, &remote.FakePrompter{Answers: []string{"no"}})
	if _, err := c.Test(context.Background()); !errors.Is(err, ErrHostKeyRejected) {
		t.Fatalf("rejected: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".ssh", "known_hosts")); !os.IsNotExist(err) {
		t.Errorf("known_hosts written after no: %v", err)
	}
	// known_hosts holds another key for this host
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	ok, _ := ssh.NewPublicKey(other)
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	if err := appendKnownHost(filepath.Join(home, ".ssh", "known_hosts"), "[127.0.0.1]:"+itoa(srv.Port), ok); err != nil {
		t.Fatal(err)
	}
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"}}
	c = client(t, srv, home, fp)
	_, err := c.Test(context.Background())
	if err == nil || !strings.Contains(err.Error(), "has changed") || len(fp.Prompts()) != 0 {
		t.Errorf("changed key: %v, prompts %v", err, fp.Kinds())
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// writeKey writes an ed25519 key (with a passphrase when pass != "") as
// <home>/.ssh/id_ed25519.
func writeKey(t *testing.T, home, pass string) ssh.PublicKey {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	var blk *pem.Block
	var err error
	if pass == "" {
		blk, err = ssh.MarshalPrivateKey(priv, "test")
	} else {
		blk, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "test", []byte(pass))
	}
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	if err := os.WriteFile(filepath.Join(home, ".ssh", "id_ed25519"), pem.EncodeToMemory(blk), 0o600); err != nil {
		t.Fatal(err)
	}
	pub, _ := ssh.NewPublicKey(priv.Public())
	return pub
}

func TestKeyWithPassphrase(t *testing.T) {
	home := t.TempDir()
	pub := writeKey(t, home, "open sesame")
	srv := sshtest.Start(t, sshtest.Options{Keys: []ssh.PublicKey{pub}})
	fp := &remote.FakePrompter{Answers: []string{"yes", "wrong", "open sesame"}}
	c := client(t, srv, home, fp)
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "passphrase", "passphrase"}) {
		t.Errorf("prompts %v", k)
	}
	if p := fp.Prompts()[1]; !strings.Contains(p.Text, "Enter passphrase for key '"+filepath.Join(home, ".ssh", "id_ed25519")+"'") {
		t.Errorf("passphrase prompt %q", p.Text)
	}
	// the key is not asked for when the server does not take it
	srv2 := sshtest.Start(t, sshtest.Options{Password: "pw"})
	fp2 := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"}}
	c2 := client(t, srv2, home, fp2)
	if _, err := c2.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp2.Kinds(); !slices.Equal(k, []string{"hostkey", "password"}) {
		t.Errorf("unaccepted key: prompts %v", k)
	}
}

func TestPlainKeyAndAgent(t *testing.T) {
	home := t.TempDir()
	pub := writeKey(t, home, "")
	srv := sshtest.Start(t, sshtest.Options{Keys: []ssh.PublicKey{pub}})
	fp := &remote.FakePrompter{Answers: []string{"yes"}}
	c := client(t, srv, home, fp)
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey"}) {
		t.Errorf("plain key: prompts %v", k)
	}
	if runtime.GOOS == "windows" {
		return
	}
	// an agent holding a key the files do not have
	_, apriv, _ := ed25519.GenerateKey(rand.Reader)
	apub, _ := ssh.NewPublicKey(apriv.Public())
	kr := agent.NewKeyring()
	kr.Add(agent.AddedKey{PrivateKey: apriv})
	sock := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Skip("no unix sockets:", err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go agent.ServeAgent(kr, conn)
		}
	}()
	srv2 := sshtest.Start(t, sshtest.Options{Keys: []ssh.PublicKey{apub}})
	fp2 := &remote.FakePrompter{Answers: []string{"yes"}}
	c2 := client(t, srv2, home, fp2)
	t.Setenv("SSH_AUTH_SOCK", sock)
	if _, err := c2.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp2.Kinds(); !slices.Equal(k, []string{"hostkey"}) {
		t.Errorf("agent: prompts %v", k)
	}
}

func TestKeyboardInteractive(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{KeyboardInteractive: []sshtest.KIQuestion{
		{Q: "Password: ", Answer: "pw"}, {Q: "Verification code: ", Echo: true, Answer: "123456"}}})
	fp := &remote.FakePrompter{Answers: []string{"yes", "pw", "123456"}}
	c := client(t, srv, t.TempDir(), fp)
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	ps := fp.Prompts()
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password", "otp"}) {
		t.Fatalf("prompts %v", k)
	}
	if ps[2].Text != "Verification code: " || !ps[2].Echo || ps[1].Echo {
		t.Errorf("KI prompts %+v", ps)
	}
	// redial: the password is cached, the code is not
	srv.DropConnections()
	time.Sleep(50 * time.Millisecond)
	fp.Answers = []string{"123456"}
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password", "otp", "otp"}) {
		t.Errorf("redial prompts %v", k)
	}
}

func TestPromptCancelled(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	c := client(t, srv, t.TempDir(), &remote.FakePrompter{Answers: []string{"yes"}, Err: nil})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Test(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}

func TestOps(t *testing.T) {
	base := t.TempDir()
	os.MkdirAll(filepath.Join(base, "diag/rdbms/cdb1/cdb1/trace"), 0o755)
	srv := sshtest.Start(t, sshtest.Options{Env: []string{"ORACLE_BASE=" + base}})
	c := client(t, srv, t.TempDir(), &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes"}})
	ctx := context.Background()

	dirs, err := c.Diag(ctx)
	if err != nil || len(dirs) == 0 || dirs[0] != base+"/diag/rdbms/cdb1/cdb1/trace" {
		t.Errorf("diag %v %v", dirs, err)
	}

	dir := t.TempDir()
	want, _ := os.ReadFile(fixture)
	p := filepath.Join(dir, "basic binds.trc")
	os.WriteFile(p, want, 0o640)
	os.Mkdir(filepath.Join(dir, "sub"), 0o750)
	os.Symlink("basic binds.trc", filepath.Join(dir, "link.trc"))
	os.WriteFile(filepath.Join(dir, ".hidden"), nil, 0o600)
	ents, err := c.Ls(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 3 {
		t.Fatalf("ls %+v", ents)
	}
	byName := map[string]remote.Entry{}
	for _, e := range ents {
		byName[e.Name] = e
	}
	if e := byName["basic binds.trc"]; e.Size != int64(len(want)) || e.Mode != "-rw-r-----" || e.Path != p || e.Dir || e.Link {
		t.Errorf("file %+v", e)
	}
	if e := byName["sub"]; !e.Dir || e.Mode != "drwxr-x---" {
		t.Errorf("dir %+v", e)
	}
	if e := byName["link.trc"]; !e.Link || e.Mode[0] != 'l' {
		t.Errorf("link %+v", e)
	}
	if one, err := c.Ls(ctx, p); err != nil || len(one) != 1 || one[0].Path != p {
		t.Errorf("ls of a file: %+v %v", one, err)
	}
	if _, err := c.Ls(ctx, "/no/such"); err == nil {
		t.Errorf("ls of a missing dir")
	}

	for _, from := range []int64{0, 777, int64(len(want))} {
		var buf bytes.Buffer
		var last int64 = -1
		if err := c.Fetch(ctx, p, &buf, remote.FetchOptions{From: from, Progress: func(x int64) { last = x }}); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(buf.Bytes(), want[from:]) {
			t.Errorf("fetch from %d: %d bytes", from, buf.Len())
		}
		if from < int64(len(want)) && last != int64(len(want)) {
			t.Errorf("progress %d", last)
		}
	}
	cctx, cancel := context.WithCancel(ctx)
	err = c.Fetch(cctx, p, io.Discard, remote.FetchOptions{Progress: func(int64) { cancel() }})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled fetch: %v", err)
	}
	if err := c.Fetch(ctx, "/no/such.trc", io.Discard, remote.FetchOptions{}); err == nil {
		t.Errorf("fetch of a missing file")
	}

	// follow
	live := filepath.Join(dir, "live.trc")
	os.WriteFile(live, []byte("0123456789"), 0o644)
	r, err := c.Follow(ctx, live, 3)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 7)
	if _, err := io.ReadFull(r, got); err != nil || string(got) != "3456789" {
		t.Fatalf("follow %q %v", got, err)
	}
	f, _ := os.OpenFile(live, os.O_APPEND|os.O_WRONLY, 0)
	start := time.Now()
	f.WriteString("abc")
	f.Close()
	got = make([]byte, 3)
	if _, err := io.ReadFull(r, got); err != nil || string(got) != "abc" {
		t.Fatalf("follow append %q %v", got, err)
	}
	t.Logf("follow latency (sftp poll 50 ms): %s", time.Since(start).Round(time.Millisecond))
	r.Close()
	if _, err := r.Read(got); err == nil {
		t.Errorf("read after close")
	}
	// a truncated file ends the stream
	r, _ = c.Follow(ctx, live, 13)
	os.WriteFile(live, []byte("x"), 0o644)
	if _, err := io.ReadAll(r); err == nil || !strings.Contains(err.Error(), "shrank") {
		t.Errorf("truncated: %v", err)
	}
}

func TestThroughput(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	srv := sshtest.Start(t, sshtest.Options{})
	c := client(t, srv, t.TempDir(), &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes"}})
	p := filepath.Join(t.TempDir(), "big.trc")
	line := []byte("WAIT #140055553: nam='db file sequential read' ela= 123 file#=7 block#=4711 blocks=1 obj#=73181 tim=12345678901234\n")
	if err := os.WriteFile(p, bytes.Repeat(line, (64<<20)/len(line)), 0o644); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	start := time.Now()
	var n countWriter
	if err := c.Fetch(context.Background(), p, &n, remote.FetchOptions{}); err != nil {
		t.Fatal(err)
	}
	el := time.Since(start)
	if int64(n) != fi.Size() {
		t.Fatalf("fetched %d of %d", n, fi.Size())
	}
	t.Logf("fetch 64 MB, sshlib (x/crypto + pkg/sftp) over loopback: %s, %.0f MB/s", el.Round(time.Millisecond), float64(n)/1e6/el.Seconds())
}

type countWriter int64

func (c *countWriter) Write(p []byte) (int, error) { *c += countWriter(len(p)); return len(p), nil }

func TestReadConfig(t *testing.T) {
	cfg := `# comment
User global
Host dbmint
  HostName 192.168.56.10
  Port 2200
  IdentityFile ~/.ssh/lab_key
Host *.example.com !bad.example.com
  User ops
  IdentityFile "/keys/ex key"
Host *
  User fallback
  Port 2222
  IdentityFile %d/.ssh/id_%r
Match host foo
  User matched
`
	for alias, want := range map[string]hostConfig{
		"dbmint":          {HostName: "192.168.56.10", User: "global", Port: 2200, IdentityFile: []string{"~/.ssh/lab_key", "%d/.ssh/id_%r"}},
		"a.example.com":   {User: "global", Port: 2222, IdentityFile: []string{"/keys/ex key", "%d/.ssh/id_%r"}},
		"bad.example.com": {User: "global", Port: 2222, IdentityFile: []string{"%d/.ssh/id_%r"}},
	} {
		got := readConfig(strings.NewReader(cfg), alias)
		if got.HostName != want.HostName || got.User != want.User || got.Port != want.Port || !slices.Equal(got.IdentityFile, want.IdentityFile) {
			t.Errorf("%s: %+v, want %+v", alias, got, want)
		}
	}
	if got := readConfig(strings.NewReader("Host=x\nPort = 7\nUser=u\n"), "x"); got.Port != 7 || got.User != "u" {
		t.Errorf("= syntax: %+v", got)
	}
	if p := expand("%d/.ssh/id_%r", "/home/me", "me", "h", "oracle", 22); p != "/home/me/.ssh/id_oracle" {
		t.Errorf("expand %q", p)
	}
	if p := expand("lab_key", "/home/me", "me", "h", "oracle", 22); p != filepath.Join("/home/me", ".ssh", "lab_key") {
		t.Errorf("expand relative %q", p)
	}
}

func TestConfigApplied(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "cfguser", Password: "pw"})
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte("Host lab\n  HostName 127.0.0.1\n  Port "+itoa(srv.Port)+"\n  User cfguser\n"), 0o600)
	t.Setenv("SSH_AUTH_SOCK", "")
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"}}
	c := New(Options{Target: remote.Target{Host: "lab"}, Prompter: fp, Home: home})
	defer c.Close()
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if p := fp.Prompts()[1].Text; p != "cfguser@127.0.0.1's password: " {
		t.Errorf("password prompt %q", p)
	}
}
