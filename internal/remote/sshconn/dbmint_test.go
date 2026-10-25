package sshconn

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// TestDbmint runs against a real host: MTKPROF_SSH_TEST=user@host:port
// (e.g. oracle@dbmint:2200), MTKPROF_SSH_TEST_PATH a trace on it (default
// /home/oracle/modern-tkprof-gen/out/basic_binds.trc). Keys or an agent
// must let `ssh -o BatchMode=yes` in; other prompts go to the terminal.
// Checks, for the cli and lib transports: Test, Diag finds a .../trace
// directory, fetch (cli with and without gzip, lib over SFTP, and scp when
// present) gives the same sha256, a truncated local copy resumes to it, and
// a line appended on the host reaches Follow (latency logged).
func TestDbmint(t *testing.T) {
	spec := os.Getenv("MTKPROF_SSH_TEST")
	if spec == "" {
		t.Skip("set MTKPROF_SSH_TEST=user@host:port to run against a real host")
	}
	rpath := os.Getenv("MTKPROF_SSH_TEST_PATH")
	if rpath == "" {
		rpath = "/home/oracle/modern-tkprof-gen/out/basic_binds.trc"
	}
	target, err := remote.ParseTarget(spec)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	sums := map[string]string{}
	var size int64
	for _, tr := range []string{CLI, Lib} {
		s, err := New(target, Options{Transport: tr, Conn: "dbmint-test", Prompter: &remote.TerminalPrompter{}})
		if err != nil {
			t.Fatalf("%s: %v", tr, err)
		}
		defer s.Close()
		srv, err := s.Test(ctx)
		if err != nil {
			t.Fatalf("%s test: %v", tr, err)
		}
		t.Logf("%s: %s", tr, srv)
		dirs, err := s.Diag(ctx)
		if err != nil || len(dirs) == 0 || !strings.HasSuffix(dirs[0], "/trace") {
			t.Errorf("%s diag: %v %v", tr, dirs, err)
		}
		t.Logf("%s diag: %v", tr, dirs)
		e, err := remote.Stat(ctx, s, rpath)
		if err != nil {
			t.Fatalf("%s stat: %v", tr, err)
		}
		size = e.Size
		for _, noGzip := range []bool{false, true} {
			if tr == Lib && noGzip {
				continue
			}
			name := tr
			if tr == CLI {
				name += map[bool]string{false: "+gzip", true: ""}[noGzip]
			}
			local := filepath.Join(t.TempDir(), path.Base(rpath))
			start := time.Now()
			n, err := remote.FetchFile(ctx, s, rpath, local, e.Size, noGzip, nil)
			el := time.Since(start)
			if err != nil || n != e.Size {
				t.Fatalf("%s fetch: %d of %d bytes, %v", name, n, e.Size, err)
			}
			sums[name] = fileSum(t, local)
			t.Logf("%s fetch: %d bytes in %s (%.1f MB/s)", name, n, el.Round(time.Millisecond), float64(n)/1e6/el.Seconds())
			// resume
			os.Truncate(local, n/2)
			if n2, err := remote.FetchFile(ctx, s, rpath, local, e.Size, noGzip, nil); err != nil || n2 != n || fileSum(t, local) != sums[name] {
				t.Errorf("%s resume: %d bytes, %v", name, n2, err)
			}
		}
		followLatency(t, s, target, tr)
	}
	if scp, err := exec.LookPath("scp"); err == nil {
		local := filepath.Join(t.TempDir(), "scp.trc")
		args := []string{"-q", "-o", "BatchMode=yes"}
		if target.Port > 0 {
			args = append(args, "-P", strconv.Itoa(target.Port))
		}
		host := target.Host
		if target.User != "" {
			host = target.User + "@" + host
		}
		if out, err := exec.Command(scp, append(args, host+":"+rpath, local)...).CombinedOutput(); err == nil {
			sums["scp"] = fileSum(t, local)
		} else {
			t.Logf("scp: %v %s", err, out)
		}
	}
	var first string
	for _, sum := range sums {
		if first == "" {
			first = sum
		}
		if sum != first {
			t.Errorf("sha256 differ: %v", sums)
			break
		}
	}
	t.Logf("%d bytes, sha256 %s (%d ways)", size, first, len(sums))
}

func fileSum(t *testing.T, p string) string {
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

// followLatency appends to a scratch file on the host (with the system ssh,
// BatchMode) and measures how long the line takes to come out of Follow.
func followLatency(t *testing.T, s remote.SSH, target remote.Target, tr string) {
	t.Helper()
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Logf("%s follow: no ssh to write on the host", tr)
		return
	}
	run := func(cmd string) error {
		args := []string{"-o", "BatchMode=yes", "-T"}
		if target.Port > 0 {
			args = append(args, "-p", strconv.Itoa(target.Port))
		}
		if target.User != "" {
			args = append(args, "-l", target.User)
		}
		out, err := exec.Command(sshBin, append(args, target.Host, cmd)...).CombinedOutput()
		if err != nil {
			t.Logf("ssh %s: %v %s", cmd, err, out)
		}
		return err
	}
	scratch := "/tmp/mtkprof-follow-" + strconv.FormatInt(time.Now().UnixNano(), 36) + ".trc"
	if run("echo start > "+scratch) != nil {
		return
	}
	defer run("rm -f " + scratch)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, err := s.Follow(ctx, scratch, 0)
	if err != nil {
		t.Errorf("%s follow: %v", tr, err)
		return
	}
	defer r.Close()
	lines := make(chan string, 16)
	go func() {
		var buf bytes.Buffer
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			buf.Write(b[:n])
			for {
				l, rerr := buf.ReadString('\n')
				if rerr != nil {
					buf.WriteString(l)
					break
				}
				lines <- strings.TrimSpace(l)
			}
			if err != nil {
				close(lines)
				return
			}
		}
	}()
	if l := <-lines; l != "start" {
		t.Errorf("%s follow first line %q", tr, l)
		return
	}
	start := time.Now()
	if run("echo appended >> "+scratch) != nil {
		return
	}
	select {
	case l := <-lines:
		el := time.Since(start)
		if l != "appended" || el > 2*time.Second {
			t.Errorf("%s follow: %q after %s (budget 2 s)", tr, l, el)
		}
		t.Logf("%s follow latency: %s (includes one ssh round trip to append)", tr, el.Round(time.Millisecond))
	case <-time.After(10 * time.Second):
		t.Errorf("%s follow: the appended line did not arrive", tr)
	}
}
