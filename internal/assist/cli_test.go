//go:build !windows

package assist

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/assist/fake"
)

// TestMain: this test binary is also the fake claude and codex (run under
// those names) and the `mtkprof mcp` they start (run with the argument mcp).
func TestMain(m *testing.M) {
	switch name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe"); name {
	case "claude", "codex":
		os.Exit(fake.CLI(name, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) == 2 && os.Args[1] == "mcp" {
		s := &MCP{Engine: os.Getenv(EnvEngine), Token: os.Getenv(EnvToken), Session: os.Getenv(EnvSession),
			Conversation: os.Getenv(EnvConversation), Name: "mtkprof", Version: "test", Log: os.Stderr}
		if s.Engine == "" || s.Token == "" {
			fmt.Fprintln(os.Stderr, "mtkprof mcp: no engine or no token")
			os.Exit(2)
		}
		s.Serve(context.Background(), os.Stdin, os.Stdout)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// cliTest is a conversation on basic_binds.trc with a CLI backend run
// against the fake CLIs, whose `mtkprof mcp` calls the conversation's tools
// on an engine stand-in.
type cliTest struct {
	*convTest
	logPath string
	tmp     string // TMPDIR: where the backend makes its temp directories
	token   string
	log     *logLines
}

const cliToken = "engine-token-0123456789abcdef0123456789"

func newCLITest(t *testing.T, p Provider) *cliTest {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLIs are this test binary under another name")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin, tmp, logs := t.TempDir(), t.TempDir(), t.TempDir()
	for _, name := range []string{"claude", "codex"} {
		if err := os.Symlink(exe, filepath.Join(bin, name)); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("TMPDIR", tmp)
	t.Setenv("FAKE_CLI_LOG", filepath.Join(logs, "runs.jsonl"))
	t.Setenv("FAKE_CLI_SCRIPT", "")
	t.Setenv(EnvSession, "leaked-from-the-engine") // the engine's own MTKPROF_ variables stay with it
	old := mcpCommand
	mcpCommand = func() (string, []string, error) { return exe, []string{"mcp"}, nil }
	t.Cleanup(func() { mcpCommand = old })

	if err := p.Check(); err != nil {
		t.Fatal(err)
	}
	b, err := Backends[p.Kind].New(p)
	if err != nil {
		t.Fatal(err)
	}
	ct := &cliTest{convTest: newConvTest(t, p, b), logPath: filepath.Join(logs, "runs.jsonl"), tmp: tmp, token: cliToken, log: &logLines{}}
	ct.c.host.Logf = ct.log.logf
	base := loadEnv(t, "basic_binds", false)
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+ToolsPath, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"tools": Infos()})
	})
	mux.HandleFunc("POST /s/{sid}/api/assist/tools/{name}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+cliToken || r.PathValue("sid") != "s1" || r.Header.Get(ConversationHeader) != "c1" {
			http.Error(w, `{"error":{"code":"unauthorized","message":"wrong token, session or conversation"}}`, http.StatusUnauthorized)
			return
		}
		args, _ := io.ReadAll(r.Body)
		res, err := ct.c.CallTool(r.Context(), base, r.PathValue("name"), args)
		var ae *ArgError
		switch {
		case errors.As(err, &ae):
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "bad_request", "message": ae.Msg}})
		case err != nil:
			http.Error(w, err.Error(), http.StatusInternalServerError)
		default:
			w.Write(res.JSON)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	ct.c.host.Engine, ct.c.host.Token = srv.Listener.Addr().String(), cliToken
	t.Cleanup(func() { ct.c.End(ErrCancelled, time.Second) })
	return ct
}

// script makes the fake replay lines (directives and recorded lines).
func (ct *cliTest) script(lines ...string) {
	ct.t.Helper()
	path := filepath.Join(ct.t.TempDir(), "script.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		ct.t.Fatal(err)
	}
	ct.t.Setenv("FAKE_CLI_SCRIPT", path)
}

// runs are the fake's runs so far: each start record with its inputs.
func (ct *cliTest) runs() []run {
	ct.t.Helper()
	f, err := os.Open(ct.logPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		ct.t.Fatal(err)
	}
	defer f.Close()
	var out []run
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 16<<20)
	for sc.Scan() {
		var r fake.Record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			ct.t.Fatal(err)
		}
		if r.Event == "start" {
			out = append(out, run{Record: r})
			continue
		}
		for i := range out {
			if out[i].PID == r.PID {
				out[i].inputs = append(out[i].inputs, r.Text)
			}
		}
	}
	return out
}

type run struct {
	fake.Record
	inputs []string
}

// leftovers are the backend's temp directories still there.
func (ct *cliTest) leftovers() []string {
	ents, _ := os.ReadDir(ct.tmp)
	var out []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "mtkprof-") {
			out = append(out, e.Name())
		}
	}
	return out
}

// gone waits until none of pids is a process any more.
func gone(t *testing.T, within time.Duration, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(within)
	for _, pid := range pids {
		for syscall.Kill(pid, 0) == nil {
			if time.Now().After(deadline) {
				t.Errorf("process %d is still there after %s", pid, within)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// toolEvents checks that each tool call shows once, as tool_call then
// tool_result with an mcp_N id, and returns the names called.
func toolEvents(t *testing.T, es []ev) []string {
	t.Helper()
	var names []string
	seen := map[string]int{}
	for _, e := range es {
		switch e.Type {
		case "tool_call":
			names = append(names, e.Name)
			seen[e.ID]++
			if !strings.HasPrefix(e.ID, "mcp_") || seen[e.ID] > 1 {
				t.Errorf("tool_call %+v", e)
			}
		case "tool_result":
			if seen[e.ID] != 1 || e.IsError || !strings.HasPrefix(e.Content, "{") {
				t.Errorf("tool_result %s %q", e.ID, preview(e.Content, 100))
			}
			seen[e.ID]++
		}
	}
	for id, n := range seen {
		if n != 2 {
			t.Errorf("tool call %s: %d events, want a tool_call and a tool_result", id, n)
		}
	}
	return names
}

// withDir puts dir (the run's temp directory) into the expected argv.
func withDir(args []string, dir string) []string {
	out := slices.Clone(args)
	for i := range out {
		out[i] = strings.ReplaceAll(out[i], "$DIR", dir)
	}
	return out
}
