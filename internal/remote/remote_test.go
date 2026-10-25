package remote

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestClassifyPrompt(t *testing.T) {
	for text, want := range map[string]string{
		"oracle@dbmint's password: ":                          KindPassword,
		"(oracle@dbmint) Password: ":                          KindPassword,
		"Enter passphrase for key '/home/u/.ssh/id_rsa': ":    KindPassphrase,
		"Enter PIN for ECDSA-SK key /home/u/.ssh/id_ecdsa_sk": KindPassphrase,
		"Verification code: ":                                 KindOTP,
		"One-time password (OATH) for `oracle': ":             KindOTP,
		"Allow use of key /home/u/.ssh/id_rsa?":               KindConfirm,
	} {
		if k, _ := ClassifyPrompt(text); k != want {
			t.Errorf("%q: %s, want %s", text, k, want)
		}
	}
	hk := "The authenticity of host '[dbmint]:2200 ([192.168.56.10]:2200)' can't be established.\n" +
		"ED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.\n" +
		"This key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
	if k, fp := ClassifyPrompt(hk); k != KindHostKey || fp != "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" {
		t.Errorf("hostkey: %s %q", k, fp)
	}
	p := Prompt{Kind: KindHostKey, Fingerprint: "SHA256:abc"}
	for ans, want := range map[string]bool{"yes": true, "Y": true, " YES ": true, "SHA256:abc": true, "no": false, "": false, "yess": false} {
		if Yes(ans, p) != want {
			t.Errorf("Yes(%q) != %v", ans, want)
		}
	}
}

func TestParseTarget(t *testing.T) {
	for spec, want := range map[string]Target{
		"oracle@dbmint:2200": {Host: "dbmint", Port: 2200, User: "oracle"},
		"dbmint":             {Host: "dbmint"},
		"u@[::1]:22":         {Host: "::1", Port: 22, User: "u"},
		"::1":                {Host: "::1"},
		"a.b-c.example":      {Host: "a.b-c.example"},
	} {
		got, err := ParseTarget(spec)
		if err != nil || got != want {
			t.Errorf("%q: %+v %v, want %+v", spec, got, err, want)
		}
	}
	for _, bad := range []string{"", "u@", "-oProxyCommand=x", "h:0", "h:99999", "h:x", "[::1", "u@h@x", "a b", "h'x"} {
		if _, err := ParseTarget(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if s := (Target{Host: "::1", Port: 2200, User: "u"}).String(); s != "u@[::1]:2200" {
		t.Errorf("String %q", s)
	}
}

func TestShQuoteAndDiagScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	for _, s := range []string{"plain", "it's", "a b", `"$HOME" \ ; rm -rf /`, "'"} {
		out, err := exec.Command("sh", "-c", "printf %s "+ShQuote(s)).Output()
		if err != nil || string(out) != s {
			t.Errorf("ShQuote(%q): %q %v", s, out, err)
		}
	}
	if strings.Contains(DiagScript, "\n") || strings.Contains(DiagScript, "$(") {
		t.Errorf("DiagScript must be one Bourne-shell line")
	}
	// the script parses under sh -n, and through ShCommand as a login shell would get it
	if out, err := exec.Command("sh", "-n", "-c", DiagScript).CombinedOutput(); err != nil {
		t.Errorf("sh -n: %v %s", err, out)
	}
	base := t.TempDir()
	os.MkdirAll(base+"/diag/rdbms/a/a/trace", 0o755)
	os.MkdirAll(base+"/diag/rdbms/b/b/cdump", 0o755)
	cmd := exec.Command("sh", "-c", ShCommand(DiagScript))
	cmd.Env = append(os.Environ(), "ORACLE_BASE="+base)
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if dirs := ParseDiag(string(out) + string(out)); len(dirs) == 0 || dirs[0] != base+"/diag/rdbms/a/a/trace" {
		t.Errorf("diag %v (output %q)", dirs, out)
	}
	if d := ParseDiag("/x/trace\nnoise\n/x/trace\r\n/y/alert\n"); len(d) != 1 {
		t.Errorf("ParseDiag %v", d)
	}
}

func TestModeString(t *testing.T) {
	for m, want := range map[fs.FileMode]string{
		0o640: "-rw-r-----", fs.ModeDir | 0o755: "drwxr-xr-x", fs.ModeSymlink | 0o777: "lrwxrwxrwx",
		fs.ModeSetuid | 0o755: "-rwsr-xr-x", fs.ModeDir | fs.ModeSticky | 0o1777&0o777: "drwxrwxrwt", fs.ModeSetgid | 0o640: "-rw-r-S---",
	} {
		if got := ModeString(m); got != want {
			t.Errorf("%v: %s, want %s", m, got, want)
		}
	}
}

func TestTerminalPrompter(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var out strings.Builder
	tp := &TerminalPrompter{In: r, Out: &out}
	w.WriteString("hunter2\r\ny\nnope\n")
	w.Close()
	if a, err := tp.Ask(context.Background(), Prompt{Kind: KindPassword, Text: "pw: "}); a != "hunter2" || err != nil {
		t.Errorf("password %q %v", a, err)
	}
	if a, _ := tp.Ask(context.Background(), Prompt{Kind: KindHostKey, Text: "Continue?", Echo: true}); a != "yes" {
		t.Errorf("hostkey %q", a)
	}
	if a, _ := tp.Ask(context.Background(), Prompt{Kind: KindConfirm, Text: "ok (yes/no)? ", Echo: true}); a != "no" {
		t.Errorf("confirm %q", a)
	}
	if out.String() != "pw: Continue? (yes/no) ok (yes/no)? " {
		t.Errorf("printed %q", out.String())
	}
	if _, err := tp.Ask(context.Background(), Prompt{Kind: KindOTP, Text: "code: "}); err == nil {
		t.Errorf("EOF: no error")
	}
	// ctx ends while waiting
	r2, w2, _ := os.Pipe()
	defer w2.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&TerminalPrompter{In: r2, Out: &out}).Ask(ctx, Prompt{Kind: KindOTP, Text: "code: ", Echo: true}); err != context.Canceled {
		t.Errorf("cancelled: %v", err)
	}
}

func TestFakePrompter(t *testing.T) {
	f := &FakePrompter{Answers: []string{"a"}, ByKind: map[string]string{KindOTP: "123"}}
	ctx := context.Background()
	if a, _ := f.Ask(ctx, Prompt{Kind: KindPassword}); a != "a" {
		t.Errorf("scripted %q", a)
	}
	if a, _ := f.Ask(ctx, Prompt{Kind: KindOTP}); a != "123" {
		t.Errorf("by kind %q", a)
	}
	if _, err := f.Ask(ctx, Prompt{Kind: KindPassword}); err != ErrNoAnswer {
		t.Errorf("unscripted: %v", err)
	}
	if k := f.Kinds(); strings.Join(k, ",") != "password,otp,password" {
		t.Errorf("kinds %v", k)
	}
}
