// Package sshcli reaches a host with the system's OpenSSH binaries (ssh,
// sftp) run as subprocesses: ~/.ssh/config, bastions, agents and MFA work as
// in the user's terminal. Credentials go through SSH_ASKPASS (this mtkprof
// binary, RunAskpass) to the engine's prompts (docs/PLAN-DESKTOP.md § 6,
// docs/REMOTE.md).
//
// Remote commands are POSIX sh run through `sh -c '...'` (the login shell
// may be csh), single-quoted with the '\'' escape, and limited to what AIX,
// Solaris and Linux all have:
//
//   - tail -c +N -- FILE (byte offset, 1-based, no size suffixes) and
//     tail -c +N -f -- FILE; never GNU's --follow, --bytes or -F.
//   - gzip -1 -c only (no --fast, no -k); its presence is probed with
//     `command -v gzip`, which a pre-POSIX Bourne shell (Solaris 10's
//     /bin/sh) lacks: the probe then fails and the fetch is uncompressed.
//   - [ -r FILE ], [ -d DIR ], for/do/done, backquotes instead of $(...).
//
// Listing uses sftp's own `ls -ln` (formatted by the client, the same on
// every server OS) instead of the remote ls.
package sshcli

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// ErrAskpassIgnored: ssh failed asking for a credential without running
// SSH_ASKPASS (Windows 11's ssh.exe is reported to ignore it,
// Win32-OpenSSH #2115). The caller switches the connection to the library
// transport (sshlib).
var ErrAskpassIgnored = errors.New("ssh did not use SSH_ASKPASS")

// Locate finds ssh and sftp on PATH (Windows: also
// %SystemRoot%\System32\OpenSSH).
func Locate() (sshPath, sftpPath string, err error) {
	find := func(name string) (string, error) {
		p, err := exec.LookPath(name)
		if err == nil {
			return p, nil
		}
		if runtime.GOOS == "windows" {
			if root := os.Getenv("SystemRoot"); root != "" {
				p := filepath.Join(root, "System32", "OpenSSH", name+".exe")
				if _, serr := os.Stat(p); serr == nil {
					return p, nil
				}
			}
		}
		return "", err
	}
	if sshPath, err = find("ssh"); err != nil {
		return "", "", err
	}
	if sftpPath, err = find("sftp"); err != nil {
		return "", "", err
	}
	return sshPath, sftpPath, nil
}

// AskpassEnv is how the spawned ssh reaches the prompts.
type AskpassEnv struct {
	Program string // SSH_ASKPASS: the mtkprof binary ("" = os.Executable())
	Engine  string // host:port serving POST /engine/askpass (the engine or a Bridge)
	Token   string // its bearer token
	Conn    string // the connection id prompts carry
}

// Client runs ssh and sftp for one target. Safe for concurrent use.
type Client struct {
	Target  remote.Target
	SSH     string // ssh binary ("" = Locate)
	SFTP    string // sftp binary ("" = Locate)
	Askpass AskpassEnv
	// Args are extra options put before the destination (tests: -F
	// /dev/null, -o UserKnownHostsFile=...).
	Args []string
	// NoMultiplex disables ControlMaster connection sharing (default on
	// where OpenSSH has it: one authentication, so one password or OTP
	// prompt, per connection instead of per command).
	NoMultiplex bool
	// ControlDir holds the ControlMaster sockets ("" = /tmp/mtkprof-ssh-<uid>).
	ControlDir string

	mu      sync.Mutex
	gzip    int  // 0 unknown, 1 the host has gzip, -1 it has not
	spawned bool // a master may be running
}

// Transport implements remote.SSH.
func (c *Client) Transport() string { return "cli" }

// Error is a failed ssh or sftp run.
type Error struct {
	Op     string
	Code   int    // exit status (-1: killed)
	Stderr string // the last lines of its stderr
}

func (e *Error) Error() string {
	msg := fmt.Sprintf("ssh %s: exit %d", e.Op, e.Code)
	if e.Stderr != "" {
		msg += ": " + e.Stderr
	}
	return msg
}

func (c *Client) binaries() (string, string, error) {
	s, f := c.SSH, c.SFTP
	if s == "" || f == "" {
		ls, lf, err := Locate()
		if err != nil {
			return "", "", err
		}
		if s == "" {
			s = ls
		}
		if f == "" {
			f = lf
		}
	}
	return s, f, nil
}

// options are the -o options of every ssh and sftp run.
func (c *Client) options() []string {
	o := []string{"-o", "BatchMode=no", "-o", "StrictHostKeyChecking=ask"}
	if c.Target.User != "" {
		o = append(o, "-o", "User="+c.Target.User)
	}
	if c.Target.Port > 0 {
		o = append(o, "-o", "Port="+strconv.Itoa(c.Target.Port))
	}
	if dir := c.controlDir(); dir != "" {
		o = append(o, "-o", "ControlMaster=auto", "-o", "ControlPath="+filepath.Join(dir, "%C"), "-o", "ControlPersist=60")
	}
	return append(o, c.Args...)
}

// controlDir is the ControlMaster socket directory ("" = no multiplexing).
func (c *Client) controlDir() string {
	if c.NoMultiplex || !multiplexDefault {
		return ""
	}
	dir := c.ControlDir
	if dir == "" {
		// /tmp rather than os.TempDir: macOS's is too long for a socket path
		dir = filepath.Join("/tmp", "mtkprof-ssh-"+strconv.Itoa(os.Getuid()))
	}
	// ssh binds <dir>/<40 hex>.<16 random> first; a Unix socket path has
	// at most 104 bytes on macOS (108 on Linux)
	if len(dir) > 104-1-40-17 {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm()&0o077 != 0 {
		return "" // someone else's or too open: no sharing
	}
	return dir
}

// spawn is one ssh or sftp process.
type spawn struct {
	op     string
	cmd    *exec.Cmd
	stderr *tailBuffer
	mark   string
}

// start starts ssh (sftp false: remoteCmd on the host) or sftp (batch from stdin).
func (c *Client) start(ctx context.Context, op string, sftp bool, remoteCmd string, stdin io.Reader, stdout io.Writer) (*spawn, io.ReadCloser, error) {
	if err := c.Target.Check(); err != nil {
		return nil, nil, err
	}
	sshBin, sftpBin, err := c.binaries()
	if err != nil {
		return nil, nil, err
	}
	var cmd *exec.Cmd
	if sftp {
		host := c.Target.Host
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		args := append(c.options(), "-b", "-", host)
		cmd = exec.CommandContext(ctx, sftpBin, args...)
	} else {
		args := append(c.options(), "-x", "-T", "--", c.Target.Host, remoteCmd)
		cmd = exec.CommandContext(ctx, sshBin, args...)
	}
	sp := &spawn{op: op, cmd: cmd, stderr: &tailBuffer{max: 4 << 10}}
	env, err := c.env(sp)
	if err != nil {
		return nil, nil, err
	}
	cmd.Env = env
	cmd.SysProcAttr = sysProcAttr()
	cmd.Stdin = stdin
	cmd.Stderr = sp.stderr
	cmd.WaitDelay = 2 * time.Second // a ControlPersist master may hold our pipes
	var out io.ReadCloser
	if stdout != nil {
		cmd.Stdout = stdout
	} else if out, err = cmd.StdoutPipe(); err != nil {
		os.Remove(sp.mark)
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		os.Remove(sp.mark)
		return nil, nil, err
	}
	c.mu.Lock()
	c.spawned = true
	c.mu.Unlock()
	return sp, out, nil
}

// env is the spawn environment: the askpass bridge (see AskpassEnv).
func (c *Client) env(sp *spawn) ([]string, error) {
	prog := c.Askpass.Program
	if prog == "" {
		var err error
		if prog, err = os.Executable(); err != nil {
			return nil, err
		}
	}
	f, err := os.CreateTemp("", "mtkprof-askpass-*")
	if err != nil {
		return nil, err
	}
	f.Close()
	sp.mark = f.Name()
	var id [6]byte
	rand.Read(id[:])
	set := map[string]string{
		"SSH_ASKPASS":         prog,
		"SSH_ASKPASS_REQUIRE": "force",
		EnvAskpassMode:        "1",
		EnvEngine:             c.Askpass.Engine,
		EnvToken:              c.Askpass.Token,
		EnvConn:               c.Askpass.Conn,
		EnvSpawn:              hex.EncodeToString(id[:]),
		EnvMark:               sp.mark,
	}
	if runtime.GOOS != "windows" && os.Getenv("DISPLAY") == "" {
		set["DISPLAY"] = "mtkprof:0" // OpenSSH before 8.4 uses SSH_ASKPASS only with DISPLAY set (no X11: -x)
	}
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := set[k]; !ok {
			env = append(env, kv)
		}
	}
	for k, v := range set {
		env = append(env, k+"="+v)
	}
	return env, nil
}

// askpassIgnoredRe: ssh printed a prompt itself or gave up on a method that
// needs one.
var askpassIgnoredRe = regexp.MustCompile(`(?i)(password:|passphrase for|verification code|permission denied \([^)]*(password|keyboard-interactive))`)

// wait waits for the process and turns a failure into an error.
func (sp *spawn) wait(ctx context.Context) error {
	err := sp.cmd.Wait()
	defer os.Remove(sp.mark)
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	msg := sp.stderr.clean()
	code := -1
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if !errors.Is(err, exec.ErrWaitDelay) {
		return fmt.Errorf("ssh %s: %w", sp.op, err)
	} else {
		return nil // exited 0; a background master kept the pipes open
	}
	if fi, serr := os.Stat(sp.mark); serr == nil && fi.Size() == 0 && askpassIgnoredRe.MatchString(msg) {
		return fmt.Errorf("%w: %s", ErrAskpassIgnored, msg)
	}
	return &Error{Op: sp.op, Code: code, Stderr: msg}
}

// output runs a remote command and returns its stdout (at most 4 MB).
func (c *Client) output(ctx context.Context, op, cmd string) (string, error) {
	var out limitBuffer
	out.max = 4 << 20
	sp, _, err := c.start(ctx, op, false, cmd, nil, &out)
	if err != nil {
		return "", err
	}
	if err := sp.wait(ctx); err != nil {
		return out.String(), err
	}
	return out.String(), nil
}

// Test implements remote.SSH: the host's uname -sr.
func (c *Client) Test(ctx context.Context) (string, error) {
	out, err := c.output(ctx, "test", remote.ShCommand("uname -sr"))
	return strings.TrimSpace(out), err
}

// Diag implements remote.SSH (remote.DiagScript).
func (c *Client) Diag(ctx context.Context) ([]string, error) {
	out, err := c.output(ctx, "diag", remote.ShCommand(remote.DiagScript))
	if err != nil {
		return nil, err
	}
	return remote.ParseDiag(out), nil
}

// Ls implements remote.SSH with sftp -b - and `ls -ln path`.
func (c *Client) Ls(ctx context.Context, path string) ([]remote.Entry, error) {
	if strings.ContainsAny(path, "\r\n") {
		return nil, fmt.Errorf("ls: bad path %q", path)
	}
	var out limitBuffer
	out.max = 64 << 20
	sp, _, err := c.start(ctx, "ls", true, "", strings.NewReader("ls -ln "+sftpQuote(path)+"\n"), &out)
	if err != nil {
		return nil, err
	}
	if err := sp.wait(ctx); err != nil {
		return nil, err
	}
	return ParseLs(out.String(), time.Now())
}

// sftpQuote quotes an argument of an sftp batch command (double quotes;
// quoted glob characters are literal).
func sftpQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// hasGzip probes the host for gzip once per client.
func (c *Client) hasGzip(ctx context.Context) (bool, error) {
	c.mu.Lock()
	g := c.gzip
	c.mu.Unlock()
	if g != 0 {
		return g > 0, nil
	}
	out, err := c.output(ctx, "probe", remote.ShCommand("command -v gzip >/dev/null 2>&1 && echo yes"))
	var e *Error
	switch {
	case err == nil && strings.TrimSpace(out) == "yes":
		g = 1
	case err == nil || (errors.As(err, &e) && e.Code == 1 && e.Stderr == ""):
		g = -1
	default:
		return false, err
	}
	c.mu.Lock()
	c.gzip = g
	c.mu.Unlock()
	return g > 0, nil
}

// readScript is the script streaming path from byte from (0-based) on.
// follow: tail -f runs in the background while cat waits for the end of
// stdin (ssh closes it when we stop or the connection drops), then kills
// it; otherwise an idle tail -f would stay on the host until the file grows
// (sshd only closes its pipes).
func readScript(path string, from int64, follow, gz bool) string {
	q := remote.ShQuote(path)
	s := "[ -r " + q + " ] || { echo 'mtkprof: cannot read the file' >&2; exit 3; }; "
	t := "tail -c +" + strconv.FormatInt(from+1, 10)
	switch {
	case follow:
		return s + t + " -f -- " + q + " & t=$!; cat >/dev/null; kill $t 2>/dev/null; exit 0"
	case gz:
		return s + t + " -- " + q + " | gzip -1 -c"
	}
	return s + "exec " + t + " -- " + q
}

// Fetch implements remote.SSH: ssh host 'tail -c +N -- path' (| gzip -1 -c
// when the host has gzip), gunzipped here.
func (c *Client) Fetch(ctx context.Context, path string, w io.Writer, o remote.FetchOptions) error {
	gz := false
	if !o.NoGzip {
		var err error
		if gz, err = c.hasGzip(ctx); err != nil {
			return err
		}
	}
	parent := ctx
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sp, out, err := c.start(ctx, "fetch", false, remote.ShCommand(readScript(path, o.From, false, gz)), nil, nil)
	if err != nil {
		return err
	}
	pw := &progressWriter{ctx: ctx, w: w, pos: o.From, fn: o.Progress}
	var cerr error
	if gz {
		var zr *gzip.Reader
		if zr, cerr = gzip.NewReader(out); cerr == nil {
			_, cerr = io.Copy(pw, zr)
		} else if errors.Is(cerr, io.EOF) {
			cerr = nil // no gzip stream at all: the script failed (wait says why)
		}
	} else {
		_, cerr = io.Copy(pw, out)
	}
	if cerr != nil {
		cancel() // stop ssh
	}
	io.Copy(io.Discard, out)
	werr := sp.wait(ctx)
	switch {
	case parent.Err() != nil:
		return parent.Err()
	case pw.werr != nil:
		return pw.werr
	case werr != nil && !errors.Is(werr, context.Canceled):
		return wrapRead(werr, path)
	case cerr != nil:
		return fmt.Errorf("fetch %s: %w", path, cerr)
	}
	return nil
}

// wrapRead names the file in a "cannot read" failure.
func wrapRead(err error, path string) error {
	var e *Error
	if errors.As(err, &e) && e.Code == 3 && strings.Contains(e.Stderr, "mtkprof: cannot read") {
		return fmt.Errorf("%s: cannot read the file", path)
	}
	return err
}

// Follow implements remote.SSH: ssh host 'tail -c +N -f -- path' (see
// readScript). Close ends ssh's stdin, which stops the remote tail, and
// kills ssh if it has not exited 2 s later.
func (c *Client) Follow(ctx context.Context, path string, from int64) (io.ReadCloser, error) {
	ctx, cancel := context.WithCancel(ctx)
	inR, inW, err := os.Pipe()
	if err != nil {
		cancel()
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		cancel()
		return nil, err
	}
	// our own pipes, not StdoutPipe: wait runs while the stream is read
	sp, _, err := c.start(ctx, "follow", false, remote.ShCommand(readScript(path, from, true, false)), inR, outW)
	inR.Close() // ssh has its copies
	outW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		cancel()
		return nil, err
	}
	r := &followReader{cancel: cancel, stdin: inW, out: outR, done: make(chan struct{})}
	go func() {
		r.err = wrapRead(sp.wait(ctx), path)
		close(r.done)
	}()
	return r, nil
}

type followReader struct {
	cancel context.CancelFunc
	stdin  io.Closer
	out    io.ReadCloser
	done   chan struct{} // ssh has exited; err is set
	err    error
	once   sync.Once
}

func (r *followReader) Read(p []byte) (int, error) {
	n, err := r.out.Read(p)
	if err == io.EOF {
		<-r.done
		if r.err != nil {
			return n, r.err
		}
		return n, io.EOF
	}
	return n, err
}

func (r *followReader) Close() error {
	r.once.Do(func() {
		r.stdin.Close()
		select {
		case <-r.done:
		case <-time.After(2 * time.Second):
			r.cancel()
			<-r.done
		}
		r.cancel()
		r.out.Close()
	})
	return nil
}

// Close implements remote.SSH: stops the ControlMaster of this target.
func (c *Client) Close() error {
	c.mu.Lock()
	spawned := c.spawned
	c.spawned = false
	c.mu.Unlock()
	if !spawned || c.controlDir() == "" {
		return nil
	}
	sshBin, _, err := c.binaries()
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, sshBin, append(c.options(), "-O", "exit", "--", c.Target.Host)...)
	cmd.SysProcAttr = sysProcAttr()
	cmd.WaitDelay = time.Second
	cmd.Run() // no master running is fine
	return nil
}

// progressWriter counts, reports and stops at the end of ctx.
type progressWriter struct {
	ctx  context.Context
	w    io.Writer
	pos  int64
	fn   func(int64)
	werr error // the destination's error
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.w.Write(b)
	p.pos += int64(n)
	if err != nil {
		p.werr = err
		return n, err
	}
	if p.fn != nil {
		p.fn(p.pos)
	}
	return n, nil
}

// tailBuffer keeps the last max bytes written.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = t.b[len(t.b)-t.max:]
	}
	return len(p), nil
}

// clean is the stderr without OpenSSH's chatter, on one line.
func (t *tailBuffer) clean() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var keep []string
	for _, l := range strings.Split(string(t.b), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "Warning: Permanently added") {
			continue
		}
		keep = append(keep, l)
	}
	return strings.Join(keep, " | ")
}

// limitBuffer is a bytes.Buffer that fails past max bytes.
type limitBuffer struct {
	bytes.Buffer
	max int
}

func (l *limitBuffer) Write(p []byte) (int, error) {
	if l.Len()+len(p) > l.max {
		return 0, errors.New("output too large")
	}
	return l.Buffer.Write(p)
}
