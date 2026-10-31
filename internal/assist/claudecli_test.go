//go:build !windows

package assist

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var claudeProvider = Provider{ID: "claude-1", Kind: "claude", Model: "sonnet"}

// TestClaudeCLITurns: two turns on one claude process replay the recording;
// mtkprof's tool call shows once, from the MCP side; the argv, the 0600 MCP
// config without the token, the environment and the empty working directory
// are as specified, and Close leaves no process and no temp directory.
func TestClaudeCLITurns(t *testing.T) {
	ct := newCLITest(t, claudeProvider)
	es := ct.run("Call overview and tell me the top statement id only.")
	if got := types(es); !slices.Equal(got, []string{"tool_call", "tool_result", "text", "usage", "done"}) {
		t.Fatalf("events %v", got)
	}
	if names := toolEvents(t, es); !slices.Equal(names, []string{"overview"}) {
		t.Errorf("tools %v", names)
	}
	if text(es) != "Top statement id: **3fa9**" {
		t.Errorf("text %q", text(es))
	}
	// the recorded result: input, cache writes and cache reads; two messages (requests)
	if d := last(es); d.Usage.InputTokens != 4+719+5937 || d.Usage.CachedInputTokens != 5937 || d.Usage.OutputTokens != 49 || d.Usage.Requests != 2 {
		t.Errorf("usage %+v", d.Usage)
	}
	es = ct.run("What was its share of response time? One sentence, no tool calls.")
	if got := types(es); !slices.Equal(got, []string{"text", "usage", "done"}) || text(es) != "Statement 3fa9 accounted for 81% of the 12.4 s response time." {
		t.Errorf("second turn %v %q", got, text(es))
	}
	if d := last(es); d.Usage.InputTokens != 4+35+3387 || d.Usage.CachedInputTokens != 3387 || d.Usage.OutputTokens != 29 || d.Usage.Requests != 1 {
		t.Errorf("second usage %+v", d.Usage)
	}

	runs := ct.runs()
	if len(runs) != 1 {
		t.Fatalf("%d claude processes, want one for both turns", len(runs))
	}
	r := runs[0]
	if !slices.Equal(r.inputs, []string{"Call overview and tell me the top statement id only.", "What was its share of response time? One sentence, no tool calls."}) {
		t.Errorf("stdin %q", r.inputs)
	}
	dir := filepath.Dir(r.Args[slices.Index(r.Args, "--mcp-config")+1])
	if !strings.HasSuffix(r.Dir, filepath.Join(dir, "work")) || !strings.HasPrefix(filepath.Base(dir), "mtkprof-claude-") || r.Files != 0 {
		t.Errorf("working directory %s with %d files, temp directory %s", r.Dir, r.Files, dir)
	}
	want := withDir([]string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "", "--strict-mcp-config", "--mcp-config", "$DIR/mcp.json",
		"--allowedTools", "mcp__mtkprof__overview,mcp__mtkprof__statements,mcp__mtkprof__statement,mcp__mtkprof__executions,mcp__mtkprof__pivot," +
			"mcp__mtkprof__timeline,mcp__mtkprof__lines,mcp__mtkprof__search_lines,mcp__mtkprof__notes,mcp__mtkprof__current_view,mcp__mtkprof__show",
		"--setting-sources", "", "--no-session-persistence", "--system-prompt-file", "$DIR/system.md", "--model", "sonnet"}, dir)
	if !slices.Equal(r.Args, want) {
		t.Errorf("argv\n got %q\nwant %q", r.Args, want)
	}
	if r.ConfigMode != "-rw-------" {
		t.Errorf("MCP config mode %s", r.ConfigMode)
	}
	for _, s := range []string{`"MTKPROF_TOKEN":"${MTKPROF_TOKEN}"`, `"MTKPROF_SESSION":"s1"`, `"MTKPROF_CONVERSATION":"c1"`, `"MTKPROF_ENGINE":"127.0.0.1:`, `"args":["mcp"]`} {
		if !strings.Contains(r.Config, s) {
			t.Errorf("MCP config lacks %s: %s", s, r.Config)
		}
	}
	if strings.Contains(r.Config, cliToken) || slices.ContainsFunc(r.Args, func(a string) bool { return strings.Contains(a, cliToken) }) {
		t.Error("the token is in the MCP config or the argv")
	}
	if r.Env[EnvToken] != cliToken || r.Env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] != "1" || r.Env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] != "1" || r.Env[EnvSession] != "" {
		t.Errorf("claude's environment %v", r.Env)
	}
	if len(ct.leftovers()) != 1 {
		t.Errorf("temp directories while the process runs: %v", ct.leftovers())
	}
	ct.c.End(ErrCancelled, time.Second)
	gone(t, 2*time.Second, r.PID, r.MCPPID)
	if l := ct.leftovers(); len(l) != 0 {
		t.Errorf("left behind: %v", l)
	}
	if roles := ct.c.Info().Messages; roles != 4 {
		t.Errorf("%d messages in the history, want the two questions and the two answers", roles)
	}
}

// TestClaudeCLICancel: a cancel mid-stream kills the process group at once;
// the next turn starts a new process and gives it the conversation so far.
func TestClaudeCLICancel(t *testing.T) {
	ct := newCLITest(t, claudeProvider)
	ct.script(`{"type":"system","subtype":"init","tools":["mcp__mtkprof__overview"],"mcp_servers":[{"name":"mtkprof","status":"connected"}]}`,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking at the trace"}}}`,
		`{"fake":"hang"}`)
	ctx, cancel := context.WithCancel(context.Background())
	out, done := ct.turn(ctx, "where did the time go?")
	waitFor(t, "the first text", func() bool { return slices.ContainsFunc(out.list(t), func(e ev) bool { return e.Type == "text" }) })
	r := ct.runs()[0]
	start := time.Now()
	cancel()
	<-done
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("cancel took %s", d)
	}
	if e := last(out.list(t)); e.Type != "error" || e.Code != CodeCancelled {
		t.Errorf("end %+v", e)
	}
	gone(t, 2*time.Second, r.PID, r.MCPPID)
	if l := ct.leftovers(); len(l) != 0 {
		t.Errorf("left behind: %v", l)
	}

	ct.script(`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m2"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Mostly SQL*Net."}}}`,
		`{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Mostly SQL*Net."}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Mostly SQL*Net.","usage":{"input_tokens":10,"output_tokens":3}}`)
	if es := ct.run("and now?"); last(es).Type != "done" || text(es) != "Mostly SQL*Net." {
		t.Errorf("after the cancel: %v %q", types(es), text(es))
	}
	runs := ct.runs()
	if len(runs) != 2 || len(runs[1].inputs) != 1 {
		t.Fatalf("runs %+v", runs)
	}
	for _, s := range []string{"<conversation>", "### The DBA\n\nwhere did the time go?", "### You\n\nLooking at the trace", "The DBA's new message:\n\nand now?"} {
		if !strings.Contains(runs[1].inputs[0], s) {
			t.Errorf("the new process got %q, without %q", runs[1].inputs[0], s)
		}
	}
}

// TestClaudeCLIFailures: a process that offers other tools, a turn that is
// not logged in, and a process that dies end the turn with an error.
func TestClaudeCLIFailures(t *testing.T) {
	for _, c := range []struct {
		name   string
		script []string
		code   string
		msg    string
	}{
		{"other tools", []string{`{"type":"system","subtype":"init","tools":["Bash","mcp__mtkprof__overview"],"mcp_servers":[{"name":"mtkprof","status":"connected"}]}`, `{"fake":"hang"}`},
			CodeProvider, "tools other than mtkprof's (Bash)"},
		{"mcp failed", []string{`{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"mtkprof","status":"failed"}]}`, `{"fake":"hang"}`},
			CodeProvider, "did not start in claude (failed)"},
		{"not logged in", []string{`{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","usage":{}}`},
			CodeAuth, "claude: Not logged in"},
		{"api error", []string{`{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","errors":["overloaded"],"api_error_status":529,"usage":{}}`},
			CodeProvider, "claude: overloaded"},
		{"exits", []string{`{"fake":"exit","code":3,"stderr":"boom"}`}, CodeProvider, "claude exited with status 3 before answering: boom"},
	} {
		t.Run(c.name, func(t *testing.T) {
			ct := newCLITest(t, claudeProvider)
			ct.script(c.script...)
			e := last(ct.run("hi"))
			if e.Type != "error" || e.Code != c.code || !strings.Contains(e.Message, c.msg) {
				t.Errorf("end %+v, want %s %q", e, c.code, c.msg)
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
