//go:build !windows

package assist

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var codexProvider = Provider{ID: "codex-1", Kind: "codex", Model: "gpt-5.5"}

// codexHome is a Codex home whose config.toml defines servers in every way
// TOML allows, and a multi-line string that only looks like one.
func codexHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	cfg := `model = "gpt-5.5"
mcp_servers.top.command = "x"
notes = """
[mcp_servers.not_a_server]
"""

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.node_repl]
command = "node"
args = [
  "repl.js", # [mcp_servers.in_an_array]
]

[mcp_servers.node_repl.env]
A = "1"

[mcp_servers."computer-use"]
command = "cu"

[mcp_servers.mtkprof]
command = "mtkprof"

[mcp_servers]
inline = { command = "y", args = ["[mcp_servers.nope]"] }
dotted.command = "z"

[profiles.fast]
model = "o4"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", home)
	return home
}

// TestCodexCLITurns: each turn is one codex run in a fresh empty directory
// that is gone after it; the argv switches off the user's servers and the
// features and carries no token; the prompt holds the instructions and,
// from the second turn, the conversation so far.
func TestCodexCLITurns(t *testing.T) {
	codexHome(t)
	ct := newCLITest(t, codexProvider)
	es := ct.run("Call overview, then try ls / and /etc/hosts.")
	if got := types(es); !slices.Equal(got, []string{"text", "tool_call", "tool_result", "text", "usage", "done"}) {
		t.Fatalf("events %v", got)
	}
	if names := toolEvents(t, es); !slices.Equal(names, []string{"overview"}) {
		t.Errorf("tools %v", names)
	}
	if s := text(es); !strings.HasPrefix(s, "I’ll check the available tools") || !strings.Contains(s, ".\n\n`functions.exec`") || !strings.Contains(s, "\n\nTools:") {
		t.Errorf("text %q", s)
	}
	if d := last(es); d.Usage.InputTokens != 89568 || d.Usage.CachedInputTokens != 79744 || d.Usage.OutputTokens != 1061 || d.Usage.Requests != 1 {
		t.Errorf("usage %+v", d.Usage)
	}
	if l := ct.leftovers(); len(l) != 0 {
		t.Errorf("left behind after the turn: %v", l)
	}
	if ct.log.count("Codex is ignoring 1 unrecognized configuration setting") != 2 {
		t.Errorf("the warnings were not logged: %v", ct.log.lines)
	}
	ct.run("And the top statement?")

	runs := ct.runs()
	if len(runs) != 2 {
		t.Fatalf("%d codex runs, want one per turn", len(runs))
	}
	r := runs[0]
	work := r.Args[slices.Index(r.Args, "-C")+1]
	if !strings.HasSuffix(r.Dir, work) || filepath.Base(work) != "work" || !strings.HasPrefix(filepath.Base(filepath.Dir(work)), "mtkprof-codex-") || r.Files != 0 {
		t.Errorf("working directory %s (-C %s) with %d files", r.Dir, work, r.Files)
	}
	exe, _ := os.Executable()
	want := withDir([]string{"exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", "$DIR", "-c", `web_search="disabled"`,
		"-c", `approval_policy="never"`, "-c", `approvals_reviewer="user"`,
		"--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins", "--disable", "browser_use",
		"--disable", "computer_use", "--disable", "in_app_browser", "--disable", "memories", "--disable", "tool_suggest", "--disable", "hooks",
		"--disable", "view_image", "--disable", "image_generation", "--disable", "multi_agent", "--disable", "guardian_approval",
		"-c", "mcp_servers.top.enabled=false", "-c", "mcp_servers.openaiDeveloperDocs.enabled=false", "-c", "mcp_servers.node_repl.enabled=false",
		"-c", "mcp_servers.computer-use.enabled=false", "-c", "mcp_servers.inline.enabled=false", "-c", "mcp_servers.dotted.enabled=false",
		"-c", "mcp_servers.mtkprof.enabled=true", "-c", "mcp_servers.mtkprof.command=" + tomlString(exe), "-c", `mcp_servers.mtkprof.args=["mcp"]`,
		"-c", "mcp_servers.mtkprof.env.MTKPROF_CONVERSATION=\"c1\"", "-c", "mcp_servers.mtkprof.env.MTKPROF_ENGINE=\"" + ct.c.host.Engine + "\"",
		"-c", "mcp_servers.mtkprof.env.MTKPROF_SESSION=\"s1\"", "-c", `mcp_servers.mtkprof.env_vars=["MTKPROF_TOKEN"]`,
		"-c", `mcp_servers.mtkprof.default_tools_approval_mode="approve"`, "-m", "gpt-5.5", "-"}, work)
	if !slices.Equal(r.Args, want) {
		t.Errorf("argv\n got %q\nwant %q", r.Args, want)
	}
	if slices.ContainsFunc(r.Args, func(a string) bool { return strings.Contains(a, cliToken) }) {
		t.Error("the token is in the argv")
	}
	if r.Env[EnvToken] != cliToken || r.Env[EnvSession] != "" || r.Env["CODEX_API_KEY"] != "" {
		t.Errorf("codex's environment %v", r.Env)
	}
	if p := r.inputs[0]; !strings.HasPrefix(p, "<instructions>\n# mtkprof trace analyst") || !strings.Contains(p, "> slow batch") ||
		!strings.HasSuffix(p, "</instructions>\n\nCall overview, then try ls / and /etc/hosts.") {
		t.Errorf("first prompt %q", preview(p, 300))
	}
	p := runs[1].inputs[0]
	for _, s := range []string{"</instructions>\n\n<conversation>", "### The DBA\n\nCall overview, then try ls / and /etc/hosts.", "### You\n\nI’ll check the available tools",
		"The DBA's new message:\n\nAnd the top statement?"} {
		if !strings.Contains(p, s) {
			t.Errorf("second prompt lacks %q", s)
		}
	}
	for _, r := range runs {
		gone(t, time.Second, r.PID, r.MCPPID)
	}
}

// TestCodexCLIStops: a run that reaches past mtkprof's tools is stopped,
// and one that fails says why.
func TestCodexCLIStops(t *testing.T) {
	codexHome(t)
	for _, c := range []struct {
		name   string
		script []string
		code   string
		msg    string
	}{
		{"shell", []string{`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls /","status":"in_progress"}}`, `{"fake":"hang"}`},
			CodeProvider, "codex tried a shell command"},
		{"patch", []string{`{"type":"item.started","item":{"id":"i1","type":"file_change","changes":[],"status":"in_progress"}}`, `{"fake":"hang"}`},
			CodeProvider, "codex tried a file change"},
		{"other server", []string{`{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"node_repl","tool":"js","arguments":{}}}`, `{"fake":"hang"}`},
			CodeProvider, "js of the MCP server node_repl"},
		{"turn failed", []string{`{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}`, `{"fake":"hang"}`},
			CodeAuth, "codex: unexpected status 401 Unauthorized"},
		{"error then exit", []string{`{"type":"error","message":"stream disconnected before completion"}`, `{"fake":"exit","code":1,"stderr":"x"}`},
			CodeProvider, "codex: stream disconnected before completion"},
	} {
		t.Run(c.name, func(t *testing.T) {
			ct := newCLITest(t, codexProvider)
			ct.script(c.script...)
			start := time.Now()
			e := last(ct.run("hi"))
			if e.Type != "error" || e.Code != c.code || !strings.Contains(e.Message, c.msg) {
				t.Errorf("end %+v, want %s %q", e, c.code, c.msg)
			}
			if d := time.Since(start); d > 2*time.Second {
				t.Errorf("took %s", d)
			}
			for _, r := range ct.runs() {
				gone(t, 2*time.Second, r.PID, r.MCPPID)
			}
			if l := ct.leftovers(); len(l) != 0 {
				t.Errorf("left behind: %v", l)
			}
		})
	}
}

// TestCodexCLIKey: with auth bearer the turn asks for the key and hands it
// to codex as CODEX_API_KEY, in its environment only.
func TestCodexCLIKey(t *testing.T) {
	codexHome(t)
	ct := newCLITest(t, Provider{ID: "codex-key", Kind: "codex", Auth: AuthBearer})
	out, done := ct.turn(t.Context(), "hi")
	q := <-ct.p.asked
	if q.Connection != "codex-key" || !strings.Contains(q.Text, "the codex CLI") {
		t.Errorf("prompt %+v", q)
	}
	ct.p.answers <- "sk-test"
	<-done
	if e := last(out.list(t)); e.Type != "done" {
		t.Fatalf("end %+v", e)
	}
	r := ct.runs()[0]
	if r.Env["CODEX_API_KEY"] != "sk-test" || slices.Contains(r.Args, "-m") || slices.ContainsFunc(r.Args, func(a string) bool { return strings.Contains(a, "sk-test") }) {
		t.Errorf("env %v, args %q", r.Env, r.Args)
	}
}

func TestCodexCLIServers(t *testing.T) {
	home := codexHome(t)
	got, err := codexServers(filepath.Join(home, "config.toml"))
	if err != nil || !slices.Equal(got, []string{"top", "openaiDeveloperDocs", "node_repl", "computer-use", "mtkprof", "inline", "dotted"}) {
		t.Errorf("servers %q %v", got, err)
	}
	if got, err := codexServers(filepath.Join(home, "none.toml")); got != nil || err != nil {
		t.Errorf("no config: %q %v", got, err)
	}
	for cfg, want := range map[string]string{
		"mcp_servers = { a = { command = \"x\" } }\n": "in one value",
		"[mcp_servers.\"a.b\"]\ncommand = \"x\"\n":    `"a.b" cannot be switched off`,
		"[mcp_servers.a\ncommand = \"x\"\n":           "not a key",
		"x = \"\"\"\nopen\n":                          "unclosed multi-line string",
	} {
		path := filepath.Join(t.TempDir(), "config.toml")
		os.WriteFile(path, []byte(cfg), 0o600)
		if _, err := codexServers(path); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", cfg, err, want)
		}
	}
}
