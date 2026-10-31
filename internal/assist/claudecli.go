package assist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// claudeCLI is the backend of Claude Code's CLI: one `claude -p` process per
// conversation in stream-json mode, fed one message per turn on stdin. The
// process holds the conversation and writes no transcript. A process that
// was stopped (a cancelled turn) or died is started again with the
// conversation so far.
type claudeCLI struct {
	p   Provider
	bin string

	mu     sync.Mutex
	proc   *cliProc // nil: none runs
	closed bool
}

const claudeHint = "install Claude Code and log in with claude auth login"

func newClaudeCLI(p Provider) (Backend, error) {
	bin, err := lookCLI("claude", claudeHint)
	if err != nil {
		return nil, err
	}
	return &claudeCLI{p: p, bin: bin}, nil
}

// claudeToolPrefix names mtkprof's tools in claude, the only tools it gets.
const claudeToolPrefix = "mcp__mtkprof__"

// claudeArgs is the command line of the process; dir holds its files.
func claudeArgs(p Provider, dir string) []string {
	tools := make([]string, len(Tools))
	for i, t := range Tools {
		tools[i] = claudeToolPrefix + t.Name
	}
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "", "--strict-mcp-config", "--mcp-config", filepath.Join(dir, "mcp.json"), "--allowedTools", strings.Join(tools, ","),
		"--setting-sources", "", "--no-session-persistence", "--system-prompt-file", filepath.Join(dir, "system.md")}
	if p.Model != "" {
		args = append(args, "--model", p.Model)
	}
	return args
}

// claudeEnv turns off what would write the conversation down (auto memory)
// or bring in the user's own instructions (CLAUDE.md files).
var claudeEnv = map[string]string{"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1"}

// start starts the process: its MCP config and system prompt are files of
// mode 0600 in its temp directory. The token is not in them: the config
// names ${MTKPROF_TOKEN}, which claude expands from its environment.
func (b *claudeCLI) start(t *Turn) (*cliProc, error) {
	exe, mcpArgs, err := mcpCommand()
	if err != nil {
		return nil, err
	}
	dir, work, err := cliDirs("claude")
	if err != nil {
		return nil, err
	}
	env := t.mcpEnv()
	set := map[string]string{EnvToken: env[EnvToken]}
	maps.Copy(set, claudeEnv)
	env[EnvToken] = "${" + EnvToken + "}"
	cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"mtkprof": map[string]any{
		"type": "stdio", "command": exe, "args": mcpArgs, "env": env}}})
	for name, data := range map[string][]byte{"mcp.json": cfg, "system.md": []byte(t.System())} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			os.RemoveAll(dir)
			return nil, err
		}
	}
	return startCLI("claude", b.bin, claudeArgs(b.p, dir), dir, work, cliEnv(set), nil)
}

// process is the running process, started when there is none (fresh).
func (b *claudeCLI) process(t *Turn) (p *cliProc, fresh bool, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, false, ErrSessionClosed
	}
	if b.proc != nil {
		select {
		case <-b.proc.exited:
		default:
			return b.proc, false, nil
		}
	}
	if b.proc, err = b.start(t); err != nil {
		return nil, false, &TurnError{CodeProvider, err.Error()}
	}
	return b.proc, true, nil
}

// drop stops p; the next turn starts a new process.
func (b *claudeCLI) drop(p *cliProc) {
	b.mu.Lock()
	if b.proc == p {
		b.proc = nil
	}
	b.mu.Unlock()
	p.stop()
}

// Close stops the process: the conversation has ended.
func (b *claudeCLI) Close() error {
	b.mu.Lock()
	p := b.proc
	b.proc, b.closed = nil, true
	b.mu.Unlock()
	if p != nil {
		p.stop()
	}
	return nil
}

func (b *claudeCLI) Turn(ctx context.Context, t *Turn) error {
	p, fresh, err := b.process(t)
	if err != nil {
		return err
	}
	defer context.AfterFunc(ctx, func() { b.drop(p) })()
	msg := t.Message()
	if fresh {
		msg = resend(t.Messages(), resendBytes)
	}
	line, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": msg}})
	ct := &claudeTurn{t: t, msgs: map[string]bool{}, streamed: map[string]bool{}}
	if err := p.send(line); err == nil {
		for l := range p.lines {
			done, err := ct.line(l)
			if err != nil || done {
				if err != nil {
					b.drop(p)
				}
				ct.keep()
				return err
			}
		}
	}
	b.drop(p)
	ct.keep()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return p.failure()
}

// claudeTurn maps the lines of claude's stream-json output to a turn.
type claudeTurn struct {
	t        *Turn
	text     strings.Builder // the answer so far
	msgs     map[string]bool // the model's messages (one per request)
	streamed map[string]bool // the messages whose text came in deltas
	cur      string          // the message being streamed
	last     string          // the message whose text came last
}

type (
	claudeInit struct {
		Model      string   `json:"model"`
		Tools      []string `json:"tools"`
		MCPServers []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"mcp_servers"`
	}
	claudeStreamEvent struct {
		Event struct {
			Type    string `json:"type"`
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		} `json:"event"`
	}
	claudeAssistant struct {
		Message struct {
			ID      string `json:"id"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	claudeResult struct {
		Subtype        string          `json:"subtype"`
		IsError        bool            `json:"is_error"`
		Result         string          `json:"result"`
		Errors         json.RawMessage `json:"errors"`
		APIErrorStatus json.RawMessage `json:"api_error_status"`
		Usage          struct {
			InputTokens              int64 `json:"input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
		} `json:"usage"`
	}
)

// claudeAuthRe: a failed turn's text that says the login is missing or bad.
var claudeAuthRe = regexp.MustCompile(`(?i)not logged in|/login|log in again|invalid api key|authentication_error|oauth token`)

// line handles one line of output; done: the turn has ended (its error).
func (c *claudeTurn) line(l []byte) (done bool, err error) {
	var head struct{ Type, Subtype string }
	if json.Unmarshal(l, &head) != nil {
		c.t.Logf("claude: a line that is not JSON: %s", preview(string(l), 200))
		return false, nil
	}
	switch head.Type {
	case "system":
		if head.Subtype == "init" {
			var in claudeInit
			json.Unmarshal(l, &in)
			c.t.Logf("claude: model %s, tools %s", in.Model, strings.Join(in.Tools, " "))
			return false, in.check()
		}
	case "stream_event":
		var se claudeStreamEvent
		json.Unmarshal(l, &se)
		switch e := se.Event; e.Type {
		case "message_start":
			c.cur = e.Message.ID
		case "content_block_delta":
			if e.Delta.Type == "text_delta" {
				c.streamed[c.cur] = true
				c.add(c.cur, e.Delta.Text)
			}
		}
	case "assistant":
		var a claudeAssistant
		json.Unmarshal(l, &a)
		c.msgs[a.Message.ID] = true
		if !c.streamed[a.Message.ID] {
			for _, b := range a.Message.Content {
				if b.Type == "text" {
					c.add(a.Message.ID, b.Text)
				}
			}
		}
	case "result":
		var r claudeResult
		json.Unmarshal(l, &r)
		u := r.Usage
		c.t.Usage(Usage{InputTokens: u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens, OutputTokens: u.OutputTokens,
			CachedInputTokens: u.CacheReadInputTokens, Requests: len(c.msgs)})
		return true, r.err()
	}
	return false, nil
}

// add streams a piece of message id's text; the texts of two messages are
// apart by a blank line.
func (c *claudeTurn) add(id, piece string) {
	if piece == "" {
		return
	}
	if id != c.last && c.text.Len() > 0 && !strings.HasSuffix(c.text.String(), "\n") {
		c.text.WriteString("\n\n")
		c.t.Text("\n\n")
	}
	c.last = id
	c.text.WriteString(piece)
	c.t.Text(piece)
}

// keep adds the answer so far to the history.
func (c *claudeTurn) keep() {
	if c.text.Len() > 0 {
		c.t.Add(Message{Role: RoleAssistant, Text: c.text.String()})
	}
}

// check fails a process that offers a tool other than mtkprof's, or whose
// mtkprof server did not start.
func (in claudeInit) check() error {
	var other []string
	for _, t := range in.Tools {
		if !strings.HasPrefix(t, claudeToolPrefix) {
			other = append(other, t)
		}
	}
	if len(other) > 0 {
		return &TurnError{CodeProvider, fmt.Sprintf("claude offered tools other than mtkprof's (%s), so mtkprof stopped it", strings.Join(other, ", "))}
	}
	for _, s := range in.MCPServers {
		if s.Name == "mtkprof" && (s.Status == "failed" || s.Status == "needs-auth") {
			return &TurnError{CodeProvider, fmt.Sprintf("the mtkprof tools did not start in claude (%s)", s.Status)}
		}
	}
	return nil
}

func (r claudeResult) err() error {
	if !r.IsError && r.Subtype == "success" {
		return nil
	}
	msg := strings.TrimSpace(r.Result)
	if msg == "" {
		var errs []string
		if json.Unmarshal(r.Errors, &errs) == nil {
			msg = strings.Join(errs, "; ")
		}
	}
	if msg == "" {
		msg = r.Subtype
	}
	status, _ := strconv.Atoi(strings.Trim(string(r.APIErrorStatus), `"`))
	if status == 401 || status == 403 || claudeAuthRe.MatchString(msg) {
		return &TurnError{CodeAuth, fmt.Sprintf("claude: %s (log in with claude auth login)", msg)}
	}
	return &TurnError{CodeProvider, "claude: " + msg}
}

// claudeLogin reads `claude auth status`.
func claudeLogin(ctx context.Context, bin string) (bool, string, error) {
	out, err := runCLI(ctx, bin, "auth", "status")
	var st struct {
		LoggedIn   bool   `json:"loggedIn"`
		AuthMethod string `json:"authMethod"`
	}
	if jerr := json.Unmarshal(out, &st); jerr != nil {
		if err == nil {
			err = errors.New("not JSON")
		}
		return false, "", fmt.Errorf("claude auth status: %v: %s", err, preview(strings.TrimSpace(string(out)), 200))
	}
	if !st.LoggedIn {
		return false, "not logged in", nil
	}
	return true, st.AuthMethod, nil
}
