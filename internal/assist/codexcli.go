package assist

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// codexCLI is the backend of the Codex CLI, labelled experimental: one
// `codex exec` per turn, with the user's own Codex home and login (it never
// touches auth.json), the sandbox read-only, every MCP server of the user's
// config switched off, and mtkprof's tools through `mtkprof mcp`.
// --ephemeral writes no session file, so codex keeps nothing between turns:
// each turn sends the conversation so far.
type codexCLI struct {
	p   Provider
	bin string
}

const codexHint = "install the Codex CLI and log in with codex login"

func newCodexCLI(p Provider) (Backend, error) {
	bin, err := lookCLI("codex", codexHint)
	if err != nil {
		return nil, err
	}
	return &codexCLI{p: p, bin: bin}, nil
}

// codexOff are the features off in every run: the shell, apps and plugins
// (with their servers), the browser and computer use, memories, tool
// suggestions, the user's hooks (they would see the trace data), the tools
// that read local images, make images or start sub-agents, and the
// automatic approval reviewer.
var codexOff = []string{"shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser", "memories",
	"tool_suggest", "hooks", "view_image", "image_generation", "multi_agent", "guardian_approval"}

// codexDisallowed are the items of a run mtkprof stops it for: they reach
// past mtkprof's tools.
var codexDisallowed = map[string]string{"command_execution": "a shell command", "file_change": "a file change", "web_search": "a web search"}

// codexServersOK are the MCP servers whose calls a run may make: mtkprof's,
// and codex's own (listing MCP resources).
var codexServersOK = []string{"mtkprof", "codex"}

// tomlString is s as a TOML basic string.
func tomlString(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return strings.TrimSpace(b.String())
}

// codexArgs is the command line of a run in work: servers are switched off,
// mtkprof's server is exe with args and env; the prompt comes on stdin.
func codexArgs(p Provider, work string, servers []string, exe string, args []string, env map[string]string) []string {
	// The approval settings are the user's otherwise, and one that approves
	// lets apply_patch write despite the read-only sandbox.
	out := []string{"exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", work, "-c", `web_search="disabled"`,
		"-c", `approval_policy="never"`, "-c", `approvals_reviewer="user"`}
	for _, f := range codexOff {
		out = append(out, "--disable", f)
	}
	for _, s := range servers {
		if s != "mtkprof" {
			out = append(out, "-c", "mcp_servers."+s+".enabled=false")
		}
	}
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = tomlString(a)
	}
	const m = "mcp_servers.mtkprof."
	out = append(out, "-c", m+"enabled=true", "-c", m+"command="+tomlString(exe), "-c", m+"args=["+strings.Join(quoted, ",")+"]")
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		out = append(out, "-c", m+"env."+k+"="+tomlString(env[k]))
	}
	out = append(out, "-c", m+`env_vars=["`+EnvToken+`"]`, "-c", m+`default_tools_approval_mode="approve"`)
	if p.Model != "" {
		out = append(out, "-m", p.Model)
	}
	return append(out, "-")
}

// codexPrompt is a run's prompt: the instructions, then the conversation.
func codexPrompt(system string, msgs []Message) string {
	return "<instructions>\n" + strings.TrimSpace(system) + "\n</instructions>\n\n" + resend(msgs, resendBytes)
}

func (b *codexCLI) Turn(ctx context.Context, t *Turn) error {
	key, err := t.Key(ctx) // "": the user's own login
	if err != nil {
		return err
	}
	path, err := codexConfigPath()
	var servers []string
	if err == nil {
		servers, err = codexServers(path)
	}
	if err != nil {
		return &TurnError{CodeProvider, "codex: " + err.Error()}
	}
	return b.run(ctx, t, key, servers)
}

func (b *codexCLI) run(ctx context.Context, t *Turn, key string, servers []string) error {
	exe, mcpArgs, err := mcpCommand()
	if err != nil {
		return err
	}
	dir, work, err := cliDirs("codex")
	if err != nil {
		return err
	}
	env := t.mcpEnv()
	set := map[string]string{EnvToken: env[EnvToken]} // forwarded to mtkprof's server by env_vars: not in argv
	delete(env, EnvToken)
	if key != "" {
		set["CODEX_API_KEY"] = key
	}
	p, err := startCLI("codex", b.bin, codexArgs(b.p, work, servers, exe, mcpArgs, env), dir, work, cliEnv(set),
		strings.NewReader(codexPrompt(t.System(), t.Messages())))
	if err != nil {
		return &TurnError{CodeProvider, err.Error()}
	}
	defer p.stop()
	defer context.AfterFunc(ctx, p.stop)()
	ct := &codexTurn{t: t}
	for l := range p.lines {
		done, err := ct.line(l)
		if err != nil {
			p.stop()
			ct.keep()
			var te *TurnError
			if errors.As(err, &te) && te.Code == CodeAuth && key != "" {
				t.ForgetKey()
			}
			return err
		}
		if done {
			ct.keep()
			select { // it exits by itself
			case <-p.exited:
			case <-time.After(5 * time.Second):
			}
			return nil
		}
	}
	ct.keep()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	fail := p.failure()
	if ct.lastErr != "" {
		fail.Message = "codex: " + ct.lastErr
	}
	if codexAuthRe.MatchString(fail.Message) {
		fail.Code = CodeAuth
		if key != "" {
			t.ForgetKey()
		}
	}
	return fail
}

// codexTurn maps the JSONL events of `codex exec --json` to a turn.
type codexTurn struct {
	t       *Turn
	text    strings.Builder
	lastErr string // the message of the last error event
}

type codexEvent struct {
	Type    string `json:"type"`
	Message string `json:"message"` // error
	Item    struct {
		Type    string `json:"type"`
		Text    string `json:"text"`    // agent_message
		Message string `json:"message"` // error
		Server  string `json:"server"`  // mcp_tool_call
		Tool    string `json:"tool"`
		Command string `json:"command"` // command_execution
	} `json:"item"`
	Usage struct {
		InputTokens       int64 `json:"input_tokens"`
		CachedInputTokens int64 `json:"cached_input_tokens"`
		OutputTokens      int64 `json:"output_tokens"`
	} `json:"usage"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"` // turn.failed
}

// codexAuthRe: an error that says the login or the key is missing or bad.
var codexAuthRe = regexp.MustCompile(`(?i)\b401\b|unauthorized|not logged in|codex login|invalid api key|incorrect api key`)

func (c *codexTurn) line(l []byte) (done bool, err error) {
	var e codexEvent
	if json.Unmarshal(l, &e) != nil {
		c.t.Logf("codex: a line that is not JSON: %s", preview(string(l), 200))
		return false, nil
	}
	it := e.Item
	switch e.Type {
	case "item.started", "item.completed":
		if what := codexDisallowed[it.Type]; what != "" {
			c.t.Logf("codex: stopped at %s %s", it.Type, preview(it.Command, 200))
			return false, &TurnError{CodeProvider, fmt.Sprintf("codex tried %s, which mtkprof does not allow, so mtkprof stopped it", what)}
		}
		if it.Type == "mcp_tool_call" && !slices.Contains(codexServersOK, it.Server) {
			return false, &TurnError{CodeProvider, fmt.Sprintf("codex called %s of the MCP server %s, which mtkprof does not allow, so mtkprof stopped it", it.Tool, it.Server)}
		}
		if e.Type == "item.completed" {
			switch it.Type {
			case "agent_message":
				c.add(it.Text)
			case "error": // a warning; the run goes on
				c.t.Logf("codex: %s", preview(it.Message, 300))
			}
		}
	case "turn.completed":
		u := e.Usage
		c.t.Usage(Usage{InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CachedInputTokens: u.CachedInputTokens})
		return true, nil
	case "turn.failed":
		msg := "codex: " + firstNonEmpty(e.Error.Message, "the turn failed")
		if codexAuthRe.MatchString(msg) {
			return false, &TurnError{CodeAuth, msg + " (log in with codex login, or check the API key)"}
		}
		return false, &TurnError{CodeProvider, msg}
	case "error":
		c.lastErr = e.Message
		c.t.Logf("codex: error %s", preview(e.Message, 300))
	}
	return false, nil
}

// add streams one message of the agent; messages are apart by a blank line.
func (c *codexTurn) add(text string) {
	if text = strings.TrimSpace(text); text == "" {
		return
	}
	if c.text.Len() > 0 {
		text = "\n\n" + text
	}
	c.text.WriteString(text)
	c.t.Text(text)
}

func (c *codexTurn) keep() {
	if c.text.Len() > 0 {
		c.t.Add(Message{Role: RoleAssistant, Text: c.text.String()})
	}
}

// codexLogin reads `codex login status`: it exits 0 when logged in.
func codexLogin(ctx context.Context, bin string) (bool, string, error) {
	out, err := runCLI(ctx, bin, "login", "status")
	var ee *exec.ExitError
	if err != nil && !errors.As(err, &ee) {
		return false, "", err
	}
	how, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return err == nil, how, nil
}

// codexConfigPath is the user's Codex config: $CODEX_HOME/config.toml,
// ~/.codex/config.toml by default.
func codexConfigPath() (string, error) {
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = filepath.Join(h, ".codex")
	}
	return filepath.Join(home, "config.toml"), nil
}

// codexServers are the names of the MCP servers the config at path defines
// (none when it does not exist). It reads the file's keys and table names,
// nothing else. A name that `-c mcp_servers.<name>.enabled=false` cannot
// address is an error: the server would stay on.
func codexServers(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	paths, err := tomlKeys(string(b))
	if err != nil {
		return nil, fmt.Errorf("%s: %v", path, err)
	}
	var names []string
	for _, kp := range paths {
		switch k := kp.path; {
		case len(k) == 0 || k[0] != "mcp_servers":
		case len(k) == 1:
			if !kp.value {
				continue // [mcp_servers]: its keys name the servers
			}
			return nil, fmt.Errorf("%s defines mcp_servers in one value; write each server as a [mcp_servers.<name>] table so mtkprof can switch it off", path)
		case k[1] == "" || strings.ContainsAny(k[1], ".="):
			return nil, fmt.Errorf("%s: the MCP server %q cannot be switched off from the command line; rename it (no . or =)", path, k[1])
		case !slices.Contains(names, k[1]):
			names = append(names, k[1])
		}
	}
	return names, nil
}

// tomlPath is a full key path of a TOML document: a table header, or a key
// with its table's path in front (value).
type tomlPath struct {
	path  []string
	value bool
}

// tomlKeys are the key paths of a TOML document. Values are skipped, not
// read.
func tomlKeys(s string) ([]tomlPath, error) {
	var out []tomlPath
	var table []string
	for i := 0; i < len(s); {
		switch c := s[i]; {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			i++
		case c == '#':
			i = lineEnd(s, i)
		case c == '[':
			i++
			array := i < len(s) && s[i] == '['
			if array {
				i++
			}
			k, j, err := tomlKey(s, i, ']')
			if err != nil {
				return nil, err
			}
			i = j + 1
			if array {
				if i >= len(s) || s[i] != ']' {
					return nil, fmt.Errorf("line %d: an unclosed [[table]]", lineOf(s, j))
				}
				i++
			}
			table = k
			out = append(out, tomlPath{path: k})
			i = lineEnd(s, i)
		default:
			k, j, err := tomlKey(s, i, '=')
			if err != nil {
				return nil, err
			}
			out = append(out, tomlPath{path: append(slices.Clone(table), k...), value: true})
			if i, err = skipValue(s, j+1); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

var tomlBare = regexp.MustCompile(`^[A-Za-z0-9_-]+`)

// tomlKey reads a dotted key at i up to end, and returns the index of end.
func tomlKey(s string, i int, end byte) ([]string, int, error) {
	var key []string
	for {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i >= len(s) {
			return nil, i, fmt.Errorf("line %d: a key without an end", lineOf(s, i))
		}
		switch s[i] {
		case '"':
			j := i + 1
			for j < len(s) && s[j] != '"' && s[j] != '\n' {
				if s[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(s) || s[j] != '"' {
				return nil, j, fmt.Errorf("line %d: an unclosed quoted key", lineOf(s, i))
			}
			var seg string
			if err := json.Unmarshal([]byte(s[i:j+1]), &seg); err != nil {
				return nil, j, fmt.Errorf("line %d: a quoted key mtkprof cannot read", lineOf(s, i))
			}
			key = append(key, seg)
			i = j + 1
		case '\'':
			j := strings.IndexAny(s[i+1:], "'\n")
			if j < 0 || s[i+1+j] != '\'' {
				return nil, i, fmt.Errorf("line %d: an unclosed quoted key", lineOf(s, i))
			}
			key = append(key, s[i+1:i+1+j])
			i += j + 2
		default:
			m := tomlBare.FindString(s[i:])
			if m == "" {
				return nil, i, fmt.Errorf("line %d: not a key", lineOf(s, i))
			}
			key = append(key, m)
			i += len(m)
		}
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		switch {
		case i < len(s) && s[i] == '.':
			i++
		case i < len(s) && s[i] == end:
			return key, i, nil
		default:
			return nil, i, fmt.Errorf("line %d: not a key", lineOf(s, i))
		}
	}
}

// skipValue skips the value at i (strings, arrays and inline tables over
// any number of lines) and returns the index after its line.
func skipValue(s string, i int) (int, error) {
	depth := 0
	for i < len(s) {
		switch {
		case strings.HasPrefix(s[i:], `"""`), strings.HasPrefix(s[i:], `'''`):
			q := s[i : i+3]
			j := i + 3
			for {
				k := strings.Index(s[j:], q)
				if k < 0 {
					return 0, fmt.Errorf("line %d: an unclosed multi-line string", lineOf(s, i))
				}
				j += k
				if q == `"""` && escaped(s, j) {
					j++
					continue
				}
				break
			}
			for j+3 < len(s) && s[j+3] == q[0] { // up to two quotes end the content
				j++
			}
			i = j + 3
			continue
		case s[i] == '"':
			j := i + 1
			for j < len(s) && s[j] != '"' && s[j] != '\n' {
				if s[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(s) || s[j] != '"' {
				return 0, fmt.Errorf("line %d: an unclosed string", lineOf(s, i))
			}
			i = j
		case s[i] == '\'':
			j := strings.IndexAny(s[i+1:], "'\n")
			if j < 0 || s[i+1+j] != '\'' {
				return 0, fmt.Errorf("line %d: an unclosed string", lineOf(s, i))
			}
			i += j + 1
		case s[i] == '[' || s[i] == '{':
			depth++
		case s[i] == ']' || s[i] == '}':
			depth--
		case s[i] == '#':
			i = lineEnd(s, i) - 1
		case s[i] == '\n' && depth <= 0:
			return i + 1, nil
		}
		i++
	}
	return i, nil
}

// escaped says whether the quote at j follows an odd run of backslashes.
func escaped(s string, j int) bool {
	n := 0
	for k := j - 1; k >= 0 && s[k] == '\\'; k-- {
		n++
	}
	return n%2 == 1
}

func lineEnd(s string, i int) int {
	if j := strings.IndexByte(s[i:], '\n'); j >= 0 {
		return i + j + 1
	}
	return len(s)
}

func lineOf(s string, i int) int { return strings.Count(s[:min(i, len(s))], "\n") + 1 }
