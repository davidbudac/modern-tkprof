package sshconn

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshcli"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshlib"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
)

func TestMain(m *testing.M) {
	if os.Getenv(sshcli.EnvAskpassMode) == "1" {
		os.Exit(sshcli.RunAskpass(os.Args[1:], os.Stdout, os.Stderr, nil))
	}
	os.Exit(m.Run())
}

func fakes(t *testing.T) string {
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
	t.Setenv("SSH_AUTH_SOCK", "")
	for _, k := range []string{"FAKE_SSH_PASSWORD", "FAKE_SSH_HOSTKEY", "FAKE_SSH_IGNORE_ASKPASS", "FAKE_SSH_NO_GZIP", "FAKE_SFTP_LS"} {
		t.Setenv(k, "")
	}
	return logs
}

func TestAutoSwitchesOnIgnoredAskpass(t *testing.T) {
	logs := fakes(t)
	t.Setenv("FAKE_SSH_IGNORE_ASKPASS", "1")
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"}}
	var switched error
	c, err := New(remote.Target{Host: srv.Host, Port: srv.Port, User: "oracle"}, Options{Conn: "c1", Prompter: fp,
		Lib: &sshlib.Options{Home: t.TempDir()}, OnSwitch: func(err error) { switched = err }})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Transport() != CLI {
		t.Fatalf("auto with ssh on PATH: %s", c.Transport())
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.trc"), []byte("x"), 0o644)
	ents, err := c.Ls(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 1 || c.Transport() != Lib || !errors.Is(switched, sshcli.ErrAskpassIgnored) {
		t.Fatalf("ls %+v, transport %s, switched %v", ents, c.Transport(), switched)
	}
	n := len(sshtest.Calls(logs))
	if _, err := c.Diag(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sshtest.Calls(logs)) != n {
		t.Errorf("ssh ran again after the switch")
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"hostkey", "password"}) || fp.Prompts()[0].Connection != "c1" {
		t.Errorf("prompts %v", fp.Prompts())
	}

	// transport cli: the failure is reported, no switch
	c2, _ := New(remote.Target{Host: srv.Host, Port: srv.Port}, Options{Transport: CLI, Prompter: fp})
	defer c2.Close()
	if _, err := c2.Test(context.Background()); !errors.Is(err, sshcli.ErrAskpassIgnored) || c2.Transport() != CLI {
		t.Errorf("cli: %v, %s", err, c2.Transport())
	}
}

func TestAutoWithoutSSH(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	srv := sshtest.Start(t, sshtest.Options{})
	c, err := New(remote.Target{Host: srv.Host, Port: srv.Port}, Options{
		Prompter: &remote.FakePrompter{ByKind: map[string]string{remote.KindHostKey: "yes"}}, Lib: &sshlib.Options{Home: t.TempDir()}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Transport() != Lib {
		t.Errorf("no ssh: %s", c.Transport())
	}
	if _, err := c.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := New(remote.Target{Host: "h"}, Options{Transport: CLI}); err == nil {
		t.Errorf("cli without ssh accepted")
	}
	if _, err := New(remote.Target{Host: "h"}, Options{Transport: "telnet"}); err == nil {
		t.Errorf("bad transport accepted")
	}
	if _, err := New(remote.Target{Host: "-oProxyCommand=x"}, Options{}); err == nil {
		t.Errorf("option-like host accepted")
	}
}

func TestCLIBridgeForTerminalUse(t *testing.T) {
	fakes(t)
	t.Setenv("FAKE_SSH_PASSWORD", "pw")
	fp := &remote.FakePrompter{ByKind: map[string]string{remote.KindPassword: "pw"}}
	c, err := New(remote.Target{Host: "dbmint", User: "oracle"}, Options{Transport: CLI, Prompter: fp, Conn: "x",
		CLI: &sshcli.Client{NoMultiplex: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for i := 0; i < 2; i++ {
		if _, err := c.Test(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if k := fp.Kinds(); !slices.Equal(k, []string{"password"}) {
		t.Errorf("prompts %v: want one password, then the bridge's cache", k)
	}
}
