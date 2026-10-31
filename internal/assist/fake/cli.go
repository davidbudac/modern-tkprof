package fake

import (
	"bufio"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// CLI is a stand-in for the claude and codex CLIs, run as either (name):
// it records how it was run, starts the MCP server its arguments name, and
// replays a recorded session (testdata/claude.jsonl, testdata/codex.jsonl,
// or the file FAKE_CLI_SCRIPT names), making the session's tool calls
// through that server and putting the server's answers in place of the
// recorded ones.
//
// As claude it answers each stream-json message on stdin with the next turn
// of the recording; as codex it reads the prompt on stdin and replays one
// turn. A recording's lines are written as they are, except for these
// directives: {"fake":"turn"} ends a claude turn, {"fake":"sleep","ms":N}
// waits, {"fake":"hang"} waits until it is killed, and
// {"fake":"exit","code":N,"stderr":"..."} exits.
//
// FAKE_CLI_LOG names a file each run appends Records to.
func CLI(name string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	f := &cli{name: name, args: args, out: stdout, errw: stderr, called: map[string]string{}}
	if err := f.run(stdin); err != nil {
		var ex exitCode
		if errors.As(err, &ex) {
			return int(ex)
		}
		fmt.Fprintf(stderr, "fake %s: %v\n", name, err)
		return 1
	}
	return 0
}

// Record is what a run of the fake CLI logs: one start record, then one
// input record per message (claude) or for the prompt (codex).
type Record struct {
	Event string   `json:"event"` // start or input
	Name  string   `json:"name"`
	PID   int      `json:"pid"`
	Args  []string `json:"args,omitempty"`
	Dir   string   `json:"dir,omitempty"`   // the working directory
	Files int      `json:"files,omitempty"` // entries in it at the start
	// Env is the run's environment from MTKPROF_, CODEX_ and CLAUDE_CODE_.
	Env        map[string]string `json:"env,omitempty"`
	Config     string            `json:"config,omitempty"`     // claude: the --mcp-config file
	ConfigMode string            `json:"configMode,omitempty"` // its permissions, as ls shows them
	MCPPID     int               `json:"mcpPid,omitempty"`     // the MCP server it started
	Text       string            `json:"text,omitempty"`       // input: the message or prompt
}

//go:embed testdata/claude.jsonl
var claudeRecording []byte

//go:embed testdata/codex.jsonl
var codexRecording []byte

type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit %d", int(e)) }

type cli struct {
	name   string
	args   []string
	out    io.Writer
	errw   io.Writer
	mcp    *mcpClient
	start  Record
	called map[string]string // recorded tool call id -> the server's answer
	failed map[string]bool
}

func (f *cli) log(r Record) {
	path := os.Getenv("FAKE_CLI_LOG")
	if path == "" {
		return
	}
	r.Name, r.PID = f.name, os.Getpid()
	b, _ := json.Marshal(r)
	if fh, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		fh.Write(append(b, '\n'))
		fh.Close()
	}
}

func (f *cli) run(stdin io.Reader) error {
	dir, _ := os.Getwd()
	ents, _ := os.ReadDir(dir)
	f.start = Record{Event: "start", Args: f.args, Dir: dir, Files: len(ents), Env: map[string]string{}}
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "MTKPROF_") || strings.HasPrefix(k, "CODEX_") || strings.HasPrefix(k, "CLAUDE_CODE_") {
			f.start.Env[k] = v
		}
	}
	var server *mcpServer
	var err error
	switch f.name {
	case "claude":
		server, err = f.claudeServer()
	case "codex":
		server, err = f.codexServer()
	default:
		err = fmt.Errorf("not claude or codex")
	}
	if err != nil {
		return err
	}
	if f.mcp, err = startMCP(server); err != nil {
		return err
	}
	defer f.mcp.close()
	f.start.MCPPID = f.mcp.cmd.Process.Pid
	f.log(f.start)
	turns, err := f.recording()
	if err != nil {
		return err
	}
	if f.name == "codex" {
		prompt, err := io.ReadAll(stdin)
		if err != nil {
			return err
		}
		f.log(Record{Event: "input", Text: string(prompt)})
		return f.replay(turns[0])
	}
	sc := bufio.NewScanner(stdin)
	sc.Buffer(nil, 16<<20)
	for n := 0; sc.Scan(); n++ {
		var m struct {
			Type    string `json:"type"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Type != "user" {
			return fmt.Errorf("stdin: not a stream-json user message: %s", sc.Text())
		}
		f.log(Record{Event: "input", Text: m.Message.Content})
		if err := f.replay(turns[min(n, len(turns)-1)]); err != nil {
			return err
		}
	}
	return sc.Err()
}

// recording is the session to replay, split into turns.
func (f *cli) recording() ([][]string, error) {
	b := claudeRecording
	if f.name == "codex" {
		b = codexRecording
	}
	if path := os.Getenv("FAKE_CLI_SCRIPT"); path != "" {
		var err error
		if b, err = os.ReadFile(path); err != nil {
			return nil, err
		}
	}
	turns := [][]string{nil}
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); l == "" {
			continue
		}
		if l == `{"fake":"turn"}` {
			turns = append(turns, nil)
			continue
		}
		turns[len(turns)-1] = append(turns[len(turns)-1], l)
	}
	return turns, nil
}

func (f *cli) replay(lines []string) error {
	for _, l := range lines {
		var d struct {
			Fake   string `json:"fake"`
			MS     int    `json:"ms"`
			Code   int    `json:"code"`
			Stderr string `json:"stderr"`
		}
		json.Unmarshal([]byte(l), &d)
		switch d.Fake {
		case "sleep":
			time.Sleep(time.Duration(d.MS) * time.Millisecond)
			continue
		case "hang":
			select {}
		case "exit":
			fmt.Fprintln(f.errw, d.Stderr)
			return exitCode(d.Code)
		}
		out, err := f.toolCalls(l)
		if err != nil {
			return err
		}
		if _, err := io.WriteString(f.out, out+"\n"); err != nil {
			return err
		}
	}
	return nil
}

// toolCalls makes the tool calls of a recorded line and returns the line
// with the server's answers in place of the recorded ones.
func (f *cli) toolCalls(l string) (string, error) {
	var m map[string]any
	if json.Unmarshal([]byte(l), &m) != nil {
		return l, nil
	}
	switch f.name {
	case "claude":
		msg, _ := m["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		changed := false
		for _, c := range content {
			b, _ := c.(map[string]any)
			switch {
			case m["type"] == "assistant" && b["type"] == "tool_use":
				name, _ := b["name"].(string)
				if tool, ok := strings.CutPrefix(name, "mcp__mtkprof__"); ok {
					if err := f.call(fmt.Sprint(b["id"]), tool, b["input"]); err != nil {
						return "", err
					}
				}
			case m["type"] == "user" && b["type"] == "tool_result":
				if text, ok := f.called[fmt.Sprint(b["tool_use_id"])]; ok {
					b["content"] = []any{map[string]any{"type": "text", "text": text}}
					b["is_error"] = f.failed[fmt.Sprint(b["tool_use_id"])]
					changed = true
				}
			}
		}
		if !changed {
			return l, nil
		}
	case "codex":
		it, _ := m["item"].(map[string]any)
		if it["type"] != "mcp_tool_call" || it["server"] != "mtkprof" {
			return l, nil
		}
		id := fmt.Sprint(it["id"])
		if m["type"] == "item.started" {
			return l, f.call(id, fmt.Sprint(it["tool"]), it["arguments"])
		}
		text, ok := f.called[id]
		if !ok {
			return l, nil
		}
		if f.failed[id] {
			it["result"], it["error"], it["status"] = nil, map[string]any{"message": text}, "failed"
		} else {
			it["result"] = map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "structured_content": nil}
		}
	}
	b, err := json.Marshal(m)
	return string(b), err
}

func (f *cli) call(id, tool string, args any) error {
	if args == nil {
		args = map[string]any{}
	}
	res, err := f.mcp.request("tools/call", map[string]any{"name": tool, "arguments": args})
	if err != nil {
		return fmt.Errorf("tools/call %s: %v", tool, err)
	}
	var r struct {
		Content []struct{ Text string } `json:"content"`
		IsError bool                    `json:"isError"`
	}
	if err := json.Unmarshal(res, &r); err != nil || len(r.Content) == 0 {
		return fmt.Errorf("tools/call %s: an answer without content: %s", tool, res)
	}
	if f.failed == nil {
		f.failed = map[string]bool{}
	}
	f.called[id], f.failed[id] = r.Content[0].Text, r.IsError
	return nil
}

// mcpServer is how to start an MCP server.
type mcpServer struct {
	command string
	args    []string
	env     []string
}

var reEnvRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`)

// claudeServer reads the mtkprof server of the --mcp-config file. Like
// claude, it expands ${VAR} in the server's env and passes its own
// environment on.
func (f *cli) claudeServer() (*mcpServer, error) {
	var path string
	for i, a := range f.args {
		if a == "--mcp-config" && i+1 < len(f.args) {
			path = f.args[i+1]
		}
	}
	if path == "" {
		return nil, errors.New("no --mcp-config")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	f.start.Config, f.start.ConfigMode = string(b), st.Mode().Perm().String()
	var cfg struct {
		MCPServers map[string]struct {
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, err
	}
	s, ok := cfg.MCPServers["mtkprof"]
	if !ok {
		return nil, errors.New("no mtkprof server in the MCP config")
	}
	env := os.Environ()
	for k, v := range s.Env {
		env = append(env, k+"="+reEnvRef.ReplaceAllStringFunc(v, func(ref string) string {
			m := reEnvRef.FindStringSubmatch(ref)
			if v, ok := os.LookupEnv(m[1]); ok {
				return v
			}
			return m[2]
		}))
	}
	return &mcpServer{s.Command, s.Args, env}, nil
}

// codexEnvKeep is what codex passes on to an MCP server of the environment
// it was started with, besides the server's env_vars.
var codexEnvKeep = []string{"HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "SystemRoot", "TEMP", "TMP"}

// codexServer reads the mtkprof server of the -c overrides (values in the
// JSON-compatible subset of TOML that the backend writes). Like codex, it
// gives the server a few variables of its own environment, the server's env
// and its env_vars.
func (f *cli) codexServer() (*mcpServer, error) {
	s := &mcpServer{}
	vars := map[string]string{}
	var forward []string
	for i, a := range f.args {
		if a != "-c" || i+1 >= len(f.args) {
			continue
		}
		k, v, _ := strings.Cut(f.args[i+1], "=")
		rest, ok := strings.CutPrefix(k, "mcp_servers.mtkprof.")
		if !ok {
			continue
		}
		var err error
		switch {
		case rest == "command":
			err = json.Unmarshal([]byte(v), &s.command)
		case rest == "args":
			err = json.Unmarshal([]byte(v), &s.args)
		case rest == "env_vars":
			err = json.Unmarshal([]byte(v), &forward)
		case strings.HasPrefix(rest, "env."):
			var val string
			err = json.Unmarshal([]byte(v), &val)
			vars[strings.TrimPrefix(rest, "env.")] = val
		}
		if err != nil {
			return nil, fmt.Errorf("-c %s: %v", f.args[i+1], err)
		}
	}
	if s.command == "" {
		return nil, errors.New("no -c mcp_servers.mtkprof.command")
	}
	for _, k := range append(codexEnvKeep, forward...) {
		if v, ok := os.LookupEnv(k); ok {
			vars[k] = v
		}
	}
	for k, v := range vars {
		s.env = append(s.env, k+"="+v)
	}
	return s, nil
}

// mcpClient speaks to an MCP server over its stdio.
type mcpClient struct {
	mu  sync.Mutex
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
	n   int
}

// startMCP starts the server; its stderr is not the CLI's.
func startMCP(s *mcpServer) (*mcpClient, error) {
	cmd := exec.Command(s.command, s.args...)
	cmd.Env = s.env
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting the MCP server: %v", err)
	}
	c := &mcpClient{cmd: cmd, in: in, out: bufio.NewReader(out)}
	if _, err := c.request("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "fake", "version": "0"}}); err != nil {
		c.close()
		return nil, fmt.Errorf("MCP initialize: %v", err)
	}
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	in.Write(append(b, '\n'))
	return c, nil
}

func (c *mcpClient) request(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": c.n, "method": method, "params": params})
	if _, err := c.in.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	line, err := c.out.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var r struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &r); err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, errors.New(r.Error.Message)
	}
	return r.Result, nil
}

func (c *mcpClient) close() {
	c.in.Close()
	c.cmd.Wait()
}
