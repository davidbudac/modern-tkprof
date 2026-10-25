package sshcli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
	"golang.org/x/crypto/ssh"
)

// openssh is a client running this machine's real ssh and sftp against the
// in-process server (password auth, unknown host key), asking through a
// bridge answered by fp. Skipped without OpenSSH.
func openssh(t *testing.T, fp *remote.FakePrompter) (*Client, *sshtest.Server, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("ControlMaster and setsid paths are tested on Unix")
	}
	sshBin, sftpBin, err := Locate()
	if err != nil {
		t.Skip("no OpenSSH client:", err)
	}
	srv := sshtest.Start(t, sshtest.Options{Password: "s3cret"})
	b, err := StartBridge(fp)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	kh := filepath.Join(t.TempDir(), "known_hosts")
	c := &Client{Target: remote.Target{Host: srv.Host, Port: srv.Port, User: "oracle"}, SSH: sshBin, SFTP: sftpBin,
		Askpass:    b.Env("c1"),
		ControlDir: shortDir(t),
		Args: []string{"-F", "/dev/null", "-o", "UserKnownHostsFile=" + kh, "-o", "GlobalKnownHostsFile=/dev/null",
			"-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2"}}
	t.Cleanup(func() { c.Close() })
	return c, srv, kh
}

func TestOpenSSH(t *testing.T) {
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "s3cret"}}
	c, srv, kh := openssh(t, fp)
	ctx := context.Background()
	out, err := c.Test(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, runtimeUname(t)) {
		t.Errorf("Test: %q", out)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password"}) {
		t.Fatalf("prompts %v", k)
	}
	if p := fp.Prompts()[0]; p.Fingerprint != ssh.FingerprintSHA256(srv.HostKey) {
		t.Errorf("hostkey prompt fingerprint %q, want %q (text %q)", p.Fingerprint, ssh.FingerprintSHA256(srv.HostKey), p.Text)
	}
	if b, _ := os.ReadFile(kh); !bytes.Contains(b, []byte(strings.TrimSpace(string(ssh.MarshalAuthorizedKey(srv.HostKey)))[:40])) {
		t.Errorf("known_hosts not written by ssh after yes: %q", b)
	}

	dir := t.TempDir()
	want, _ := os.ReadFile(fixture)
	os.WriteFile(filepath.Join(dir, "basic binds.trc"), want, 0o640)
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	ents, err := c.Ls(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 2 || ents[0].Name != "basic binds.trc" || ents[0].Size != int64(len(want)) || ents[0].Path != filepath.Join(dir, "basic binds.trc") || !ents[1].Dir {
		t.Errorf("ls: %+v", ents)
	}
	var buf bytes.Buffer
	if err := c.Fetch(ctx, ents[0].Path, &buf, remote.FetchOptions{}); err != nil || !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("fetch: %d bytes, %v", buf.Len(), err)
	}
	buf.Reset()
	if err := c.Fetch(ctx, ents[0].Path, &buf, remote.FetchOptions{From: 1000, NoGzip: true}); err != nil || !bytes.Equal(buf.Bytes(), want[1000:]) {
		t.Fatalf("fetch from 1000: %d bytes, %v", buf.Len(), err)
	}
	// one authentication for all of it: the ControlMaster carries the rest
	if n := srv.Logins(); n != 1 {
		t.Errorf("%d logins, want 1 (multiplexed)", n)
	}
	if k := fp.Kinds(); len(k) != 2 {
		t.Errorf("asked again: %v", k)
	}
	c.Close()
	if _, err := c.Test(ctx); err != nil {
		t.Fatal(err)
	}
	if n := srv.Logins(); n != 2 {
		t.Errorf("%d logins after Close, want a new master", n)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password"}) {
		t.Errorf("after Close: prompts %v, want the password from the bridge's cache", k)
	}
}

// shortDir is a ControlMaster directory short enough for a socket path.
func shortDir(t *testing.T) string {
	d, err := os.MkdirTemp("/tmp", "mtkcm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func runtimeUname(t *testing.T) string {
	b, err := exec.Command("uname", "-s").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

func TestOpenSSHWrongPassword(t *testing.T) {
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "wrong"}}
	c, _, _ := openssh(t, fp)
	c.NoMultiplex = true
	_, err := c.Test(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Permission denied") {
		t.Fatalf("wrong password: %v", err)
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password", "password"}) {
		t.Errorf("prompts %v (NumberOfPasswordPrompts=2)", k)
	}
}

func TestOpenSSHFollowAndThroughput(t *testing.T) {
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "s3cret"}}
	c, srv, _ := openssh(t, fp)
	ctx := context.Background()
	p := filepath.Join(t.TempDir(), "live.trc")
	os.WriteFile(p, []byte("head\n"), 0o644)
	r, err := c.Follow(ctx, p, 0)
	if err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 5)
	if _, err := io.ReadFull(r, head); err != nil || string(head) != "head\n" {
		t.Fatalf("follow head %q %v", head, err)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	start := time.Now()
	f.WriteString("WAIT #1\n")
	f.Close()
	line := make([]byte, 8)
	if _, err := io.ReadFull(r, line); err != nil || string(line) != "WAIT #1\n" {
		t.Fatalf("follow %q %v", line, err)
	}
	t.Logf("follow latency (OpenSSH, local tail -f): %s", time.Since(start).Round(time.Millisecond))
	start = time.Now()
	r.Close()
	if el := time.Since(start); el > time.Second {
		t.Errorf("Close took %s: the remote tail did not stop at the end of stdin", el)
	}
	time.Sleep(3500 * time.Millisecond)
	if l := srv.Lingered(); len(l) > 0 {
		t.Errorf("remote processes outlived the session: %q", l)
	}

	// throughput: a 64 MB trace-like file, gzip and plain
	big := filepath.Join(t.TempDir(), "big.trc")
	var src bytes.Buffer
	for i := 0; src.Len() < 64<<20; i++ {
		src.WriteString("WAIT #140055553: nam='db file sequential read' ela= 123 file#=7 block#=")
		src.WriteString(itoa(int64(i * 7919 % 1000003)))
		src.WriteString(" blocks=1 obj#=73181 tim=12345678901234\n")
	}
	os.WriteFile(big, src.Bytes(), 0o644)
	sum := sha256.Sum256(src.Bytes())
	for _, noGzip := range []bool{false, true} {
		h := sha256.New()
		start := time.Now()
		if err := c.Fetch(ctx, big, h, remote.FetchOptions{NoGzip: noGzip}); err != nil {
			t.Fatal(err)
		}
		el := time.Since(start)
		if !bytes.Equal(h.Sum(nil), sum[:]) {
			t.Errorf("sha256 differs (noGzip %v)", noGzip)
		}
		t.Logf("fetch 64 MB, OpenSSH over loopback, gzip=%v: %s, %.0f MB/s", !noGzip, el.Round(time.Millisecond), float64(src.Len())/1e6/el.Seconds())
	}
}
