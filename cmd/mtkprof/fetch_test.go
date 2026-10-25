package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshcli"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
)

// sshFixture is an in-process SSH server with password auth, the user's
// ~/.ssh isolated, and the CLI's prompts answered by a fake.
func sshFixture(t *testing.T) (*sshtest.Server, *remote.FakePrompter) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SSH_AUTH_SOCK", "")
	srv := sshtest.Start(t, sshtest.Options{User: "oracle", Password: "pw"})
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"}}
	old := cliPrompter
	cliPrompter = func() remote.Prompter { return fp }
	t.Cleanup(func() { cliPrompter = old })
	return srv, fp
}

func TestCLIFetch(t *testing.T) {
	srv, fp := sshFixture(t)
	spec := "oracle@" + srv.Host + ":" + strconv.Itoa(srv.Port)
	want, _ := os.ReadFile("../../testdata/traces/19c/basic_binds.trc")
	rdir := t.TempDir()
	a, b := filepath.Join(rdir, "a.trc"), filepath.Join(rdir, "b.trc")
	os.WriteFile(a, want, 0o644)
	os.WriteFile(b, want[:5000], 0o644)
	out := filepath.Join(t.TempDir(), "got")
	var stdout, stderr bytes.Buffer
	if err := fetchMain([]string{spec, a, b, "-o", out, "-transport", "lib"}, &stdout, &stderr); err != nil {
		t.Fatalf("%v (%s)", err, stderr.String())
	}
	if got := strings.Fields(stdout.String()); !slices.Equal(got, []string{filepath.Join(out, "a.trc"), filepath.Join(out, "b.trc")}) {
		t.Errorf("printed %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(out, "a.trc")); !bytes.Equal(got, want) {
		t.Errorf("a.trc differs")
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password"}) {
		t.Errorf("prompts %v", k)
	}
	// resume after truncation; the host is known now
	os.Truncate(filepath.Join(out, "a.trc"), 777)
	if err := fetchMain([]string{spec, a, "-o", out, "-transport", "lib"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(out, "a.trc")); !bytes.Equal(got, want) {
		t.Errorf("resumed a.trc differs")
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password", "password"}) {
		t.Errorf("prompts after resume %v", k)
	}
	if err := fetchMain([]string{spec, filepath.Join(rdir, "missing.trc"), "-o", out, "-transport", "lib"}, &stdout, &stderr); err == nil {
		t.Errorf("missing remote file: no error")
	}
	if err := fetchMain([]string{spec, a, filepath.Join(t.TempDir(), "a.trc"), "-o", out}, &stdout, &stderr); err == nil {
		t.Errorf("duplicate base names: no error")
	}
}

func TestCLIFollow(t *testing.T) {
	srv, _ := sshFixture(t)
	spec := "oracle@" + srv.Host + ":" + strconv.Itoa(srv.Port)
	live := filepath.Join(t.TempDir(), "live.trc")
	os.WriteFile(live, []byte("one\n"), 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	old := cliContext
	cliContext = func() (context.Context, context.CancelFunc) { return ctx, cancel }
	t.Cleanup(func() { cliContext = old })
	mirror := filepath.Join(t.TempDir(), "mirror.trc")
	os.WriteFile(mirror, []byte("on"), 0o644) // a partial earlier run
	done := make(chan error, 1)
	var stderr bytes.Buffer
	go func() {
		done <- followMain([]string{spec, live, "-o", mirror, "-transport", "lib"}, os.Stdout, &stderr)
	}()
	wait := func(want string) {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			if b, _ := os.ReadFile(mirror); string(b) == want {
				return
			}
		}
		b, _ := os.ReadFile(mirror)
		t.Fatalf("mirror %q, want %q", b, want)
	}
	wait("one\n")
	f, _ := os.OpenFile(live, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("two\n")
	f.Close()
	wait("one\ntwo\n")
	cancel()
	if err := <-done; err != nil {
		t.Errorf("follow after Ctrl-C: %v", err)
	}
}

func TestAskpassCommand(t *testing.T) {
	fp := &remote.FakePrompter{Answers: []string{"s3cret", "yes"}}
	b, err := sshcli.StartBridge(fp)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	exe, _ := os.Executable()
	env := append(os.Environ(), sshcli.EnvEngine+"="+b.Addr, sshcli.EnvToken+"="+b.Token, sshcli.EnvConn+"=lab")
	// explicit subcommand
	cmd := mtkprof(t, env, "askpass", "oracle@dbmint's password: ")
	out, err := cmd.Output()
	if err != nil || string(out) != "s3cret\n" {
		t.Errorf("askpass: %q %v", out, err)
	}
	// as ssh runs it: the binary with the prompt text only, MTKPROF_ASKPASS=1
	c2 := exec.Command(exe, "The authenticity of host 'x' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")
	c2.Env = append(env, sshcli.EnvAskpassMode+"=1")
	out, err = c2.Output()
	if err != nil || string(out) != "yes\n" {
		t.Errorf("askpass mode: %q %v", out, err)
	}
	if ps := fp.Prompts(); len(ps) != 2 || ps[0].Kind != "password" || ps[0].Connection != "lab" || ps[1].Kind != "hostkey" {
		t.Errorf("prompts %+v", ps)
	}
	// a cancelled prompt: exit 1, nothing printed
	fp.Err = context.Canceled
	c3 := exec.Command(exe, "Verification code: ")
	c3.Env = append(env, sshcli.EnvAskpassMode+"=1")
	out, err = c3.Output()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 || len(out) != 0 {
		t.Errorf("cancelled: %q %v", out, err)
	}
}
