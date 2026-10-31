package assist

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"
)

// A CLI agent (claude, codex) runs as a child of the engine: in an empty
// temp directory, in its own process group (killed on cancel), with the
// engine's environment less its own MTKPROF_ variables, and with mtkprof's
// tools as its only tools, through `mtkprof mcp`. Those tool calls reach the
// engine over HTTP (Conversation.CallTool) and are the turn's tool events;
// from the agent's own output a backend maps only the text, the usage and
// how the turn ended.

// mcpCommand is the command line of `mtkprof mcp`: this executable.
var mcpCommand = func() (string, []string, error) {
	exe, err := os.Executable()
	return exe, []string{"mcp"}, err
}

// cliWaitDelay bounds the wait for a CLI agent's output once it has exited.
const cliWaitDelay = 2 * time.Second

// lookCLI finds a CLI agent's command on PATH; hint says how to get it.
func lookCLI(cmd, hint string) (string, error) {
	path, err := exec.LookPath(cmd)
	if err != nil {
		return "", fmt.Errorf("provider.kind %s: the %s CLI was not found on PATH (%s)", cmd, cmd, hint)
	}
	return path, nil
}

// cliEnv is the environment of a CLI agent: the engine's without its own
// MTKPROF_ variables, and set.
func cliEnv(set map[string]string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := set[k]; ok || strings.HasPrefix(strings.ToUpper(k), "MTKPROF_") {
			continue
		}
		env = append(env, kv)
	}
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env = append(env, k+"="+set[k])
	}
	return env
}

// cliDirs makes the temp directory of a CLI agent's process (mode 0700) and
// the empty working directory in it.
func cliDirs(kind string) (dir, work string, err error) {
	if dir, err = os.MkdirTemp("", "mtkprof-"+kind+"-"); err != nil {
		return "", "", err
	}
	work = dir + string(os.PathSeparator) + "work"
	if err = os.Mkdir(work, 0o700); err != nil {
		os.RemoveAll(dir)
		return "", "", err
	}
	return dir, work, nil
}

// cliProc is a running CLI agent.
type cliProc struct {
	name   string
	cmd    *exec.Cmd
	stdin  io.WriteCloser // nil: stdin was given whole
	lines  chan []byte    // stdout, one line at a time; closed at its end
	stderr *tailBuffer
	quit   chan struct{} // closed by stop
	exited chan struct{} // closed once it has exited and its directory is gone
	err    error         // how it exited, once exited is closed
	once   sync.Once
}

// startCLI starts bin in work with env; dir (holding work) is removed when
// the process has ended. stdin nil: the process gets a pipe to write to.
func startCLI(name, bin string, args []string, dir, work string, env []string, stdin io.Reader) (*cliProc, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir, cmd.Env, cmd.SysProcAttr, cmd.WaitDelay = work, env, sysProcAttr(), cliWaitDelay
	p := &cliProc{name: name, cmd: cmd, lines: make(chan []byte, 64), stderr: &tailBuffer{max: 8 << 10},
		quit: make(chan struct{}), exited: make(chan struct{})}
	cmd.Stderr = p.stderr
	fail := func(err error) (*cliProc, error) {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("starting %s: %w", name, err)
	}
	var err error
	if stdin != nil {
		cmd.Stdin = stdin
	} else if p.stdin, err = cmd.StdinPipe(); err != nil {
		return fail(err)
	}
	r, w, err := os.Pipe() // not StdoutPipe: Wait must not close it under the reader
	if err != nil {
		return fail(err)
	}
	cmd.Stdout = w
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		return fail(err)
	}
	w.Close()
	go p.read(r)
	go func() {
		p.err = cmd.Wait()
		os.RemoveAll(dir)
		close(p.exited)
	}()
	return p, nil
}

func (p *cliProc) read(r *os.File) {
	defer close(p.lines)
	defer r.Close()
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := readLine(br)
		if l := bytes.TrimSpace(line); len(l) > 0 {
			select {
			case p.lines <- l:
			case <-p.quit:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// send writes one line to the process's stdin.
func (p *cliProc) send(line []byte) error {
	_, err := p.stdin.Write(append(line, '\n'))
	return err
}

// stop kills the process group and waits for the end, a few seconds at most.
func (p *cliProc) stop() {
	p.once.Do(func() {
		close(p.quit)
		select {
		case <-p.exited:
		default:
			killGroup(p.cmd)
		}
	})
	select {
	case <-p.exited:
	case <-time.After(cliWaitDelay + time.Second):
	}
}

// failure is a provider error for a process that ended without finishing
// the turn: how it exited and the end of its stderr.
func (p *cliProc) failure() *TurnError {
	select {
	case <-p.exited:
	case <-time.After(cliWaitDelay + time.Second):
	}
	msg := p.name + " ended before answering"
	var ee *exec.ExitError
	select {
	case <-p.exited:
		if errors.As(p.err, &ee) {
			msg = fmt.Sprintf("%s exited with status %d before answering", p.name, ee.ExitCode())
		}
	default:
	}
	if s := p.stderr.String(); s != "" {
		msg += ": " + s
	}
	return &TurnError{CodeProvider, msg}
}

// tailBuffer keeps the last max bytes written to it.
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

// String is what was kept, its lines joined with " | ".
func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var keep []string
	for _, l := range strings.Split(string(t.b), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			keep = append(keep, l)
		}
	}
	return preview(strings.Join(keep, " | "), 1000)
}

// resendBytes bounds the earlier messages resent to a CLI agent that does
// not hold the conversation (about 100k tokens); the newest are kept.
const resendBytes = 400_000

// resend is the prompt that gives a CLI agent the conversation so far: the
// earlier texts of the DBA and of the answers, newest last, then the new
// message (the last of msgs).
func resend(msgs []Message, limit int) string {
	if len(msgs) == 0 {
		return ""
	}
	msg := msgs[len(msgs)-1].Text
	var parts []string
	size, left := 0, 0
	for i := len(msgs) - 2; i >= 0; i-- {
		m := msgs[i]
		who := map[string]string{RoleUser: "The DBA", RoleAssistant: "You"}[m.Role]
		if who == "" || m.Text == "" {
			continue
		}
		part := "### " + who + "\n\n" + strings.TrimSpace(m.Text)
		if size+len(part) > limit {
			left = i + 1
			break
		}
		parts = append(parts, part)
		size += len(part)
	}
	if len(parts) == 0 {
		return msg
	}
	slices.Reverse(parts)
	var b strings.Builder
	b.WriteString("<conversation>\nThe conversation so far, oldest first")
	if left > 0 {
		fmt.Fprintf(&b, " (%d earlier messages left out)", left)
	}
	b.WriteString(":\n\n" + strings.Join(parts, "\n\n") + "\n</conversation>\n\nThe DBA's new message:\n\n" + msg)
	return b.String()
}

// BackendInfo is a provider kind as GET /engine/assist/backends reports it.
type BackendInfo struct {
	Kind         string   `json:"kind"`
	Auth         []string `json:"auth"` // the auth modes it takes, its default first
	Experimental bool     `json:"experimental"`
	Command      string   `json:"command,omitempty"` // the CLI it runs
	Path         string   `json:"path,omitempty"`    // where the CLI was found
	Version      string   `json:"version,omitempty"`
	LoggedIn     *bool    `json:"loggedIn,omitempty"` // the CLI's own login
	Login        string   `json:"login,omitempty"`    // how it is logged in, or that it is not
	Error        string   `json:"error,omitempty"`    // "not found", or what failed asking it
}

// probeTimeout bounds each command ProbeBackends runs.
const probeTimeout = 10 * time.Second

// ProbeBackends reports every provider kind: for a CLI, where it is, its
// version and its login state.
func ProbeBackends(ctx context.Context) []BackendInfo {
	kinds := BackendKinds()
	out := make([]BackendInfo, len(kinds))
	var wg sync.WaitGroup
	for i, name := range kinds {
		k := Backends[name]
		out[i] = BackendInfo{Kind: name, Auth: k.Auth, Experimental: k.Experimental, Command: k.Command}
		if k.Command == "" {
			continue
		}
		wg.Add(1)
		go func(in *BackendInfo) {
			defer wg.Done()
			path, err := exec.LookPath(k.Command)
			if err != nil {
				in.Error = "not found"
				return
			}
			in.Path = path
			v, err := runCLI(ctx, path, "--version")
			if err != nil {
				in.Error = err.Error()
				return
			}
			in.Version, _, _ = strings.Cut(strings.TrimSpace(string(v)), "\n")
			ok, how, err := k.Login(ctx, path)
			if err != nil {
				in.Error = err.Error()
				return
			}
			in.LoggedIn, in.Login = &ok, how
		}(&out[i])
	}
	wg.Wait()
	return out
}

// runCLI runs a short command of a CLI and returns its output (stdout and
// stderr); an error that it exited non-zero comes with that output.
func runCLI(ctx context.Context, bin string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir, cmd.Env, cmd.SysProcAttr, cmd.WaitDelay = os.TempDir(), cliEnv(nil), sysProcAttr(), time.Second
	cmd.Cancel = func() error { return killGroup(cmd) }
	out := &tailBuffer{max: 64 << 10}
	cmd.Stdout, cmd.Stderr = out, out
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return nil, fmt.Errorf("%s %s did not answer within %s", bin, strings.Join(args, " "), probeTimeout)
	case err != nil && !errors.As(err, &ee):
		return nil, err
	}
	out.mu.Lock()
	defer out.mu.Unlock()
	return out.b, err
}
