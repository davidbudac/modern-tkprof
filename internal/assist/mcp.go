package assist

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// The environment `mtkprof mcp` reads, set by whoever launches the CLI agent.
const (
	EnvEngine       = "MTKPROF_ENGINE"       // host:port (or a URL) of the engine
	EnvToken        = "MTKPROF_TOKEN"        // its bearer token
	EnvSession      = "MTKPROF_SESSION"      // the session the tools read
	EnvConversation = "MTKPROF_CONVERSATION" // the conversation the calls belong to (optional)
)

// ToolsPath is where the engine lists its tools; a tool is called at
// /s/{session}/api/assist/tools/{name}.
const ToolsPath = "/engine/assist/tools"

// ToolPath is the route of one tool of a session.
func ToolPath(session, name string) string {
	return "/s/" + url.PathEscape(session) + "/api/assist/tools/" + url.PathEscape(name)
}

// MCP protocol versions the server speaks. The messages it uses (initialize,
// tools/list, tools/call, ping) are the same in all of them.
var mcpVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// JSON-RPC error codes.
const (
	rpcParseError     = -32700
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
	rpcInternalError  = -32603
)

// MCP is a stdio MCP server whose tools live in the engine: tools/list and
// tools/call are forwarded to its HTTP routes. It speaks line-delimited
// JSON-RPC; it never reads anything but the protocol from its input.
type MCP struct {
	Engine        string // host:port, or a URL
	Token         string
	Session       string
	Conversation  string
	Name, Version string       // serverInfo
	Client        *http.Client // nil: http.DefaultClient
	Log           io.Writer    // nil: nothing is logged
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type mcpContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type mcpToolResult struct {
	Content []mcpContent `json:"content"`
	IsError bool         `json:"isError,omitempty"`
}

func (s *MCP) logf(format string, a ...any) {
	if s.Log != nil {
		fmt.Fprintf(s.Log, "mtkprof mcp: "+format+"\n", a...)
	}
}

// Serve answers the requests on r until it ends (the agent went away) or ctx
// is done. Requests are answered in order.
func (s *MCP) Serve(ctx context.Context, r io.Reader, w io.Writer) error {
	br := bufio.NewReader(r)
	for ctx.Err() == nil {
		line, err := br.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			if werr := s.handle(ctx, line, w); werr != nil {
				return werr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
	return ctx.Err()
}

func (s *MCP) send(w io.Writer, resp rpcResponse) error {
	resp.JSONRPC = "2.0"
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

func (s *MCP) fail(w io.Writer, id json.RawMessage, code int, format string, a ...any) error {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return s.send(w, rpcResponse{ID: id, Error: &rpcError{code, fmt.Sprintf(format, a...)}})
}

func (s *MCP) handle(ctx context.Context, line []byte, w io.Writer) error {
	var req rpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return s.fail(w, nil, rpcParseError, "parse error: %v", err)
	}
	if len(req.ID) == 0 { // a notification: no answer, whatever it is
		s.logf("notification %s", req.Method)
		return nil
	}
	if req.Method == "" { // a response to a request of ours; there are none
		return nil
	}
	reply := func(v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return s.fail(w, req.ID, rpcInternalError, "%v", err)
		}
		return s.send(w, rpcResponse{ID: req.ID, Result: b})
	}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		version := mcpVersions[0]
		for _, v := range mcpVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		s.logf("initialize: client asks for %q, answering %q", p.ProtocolVersion, version)
		return reply(map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": s.Name, "version": s.Version},
		})
	case "ping":
		return reply(struct{}{})
	case "tools/list":
		tools, err := s.listTools(ctx)
		if err != nil {
			return s.fail(w, req.ID, rpcInternalError, "%v", err)
		}
		return reply(map[string]any{"tools": tools})
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			return s.fail(w, req.ID, rpcInvalidParams, "tools/call: want params {name, arguments}")
		}
		return reply(s.callTool(ctx, p.Name, p.Arguments))
	}
	return s.fail(w, req.ID, rpcMethodNotFound, "method not found: %s", req.Method)
}

func (s *MCP) base() string {
	if strings.Contains(s.Engine, "://") {
		return strings.TrimRight(s.Engine, "/")
	}
	return "http://" + s.Engine
}

func (s *MCP) do(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base()+path, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s.Conversation != "" {
		req.Header.Set(ConversationHeader, s.Conversation)
	}
	c := s.Client
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	return resp.StatusCode, b, err
}

// engineError is the text of an engine error envelope, else the body.
func engineError(status int, body []byte) string {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &env) == nil && env.Error.Message != "" {
		return env.Error.Code + ": " + env.Error.Message
	}
	if t := strings.TrimSpace(string(body)); t != "" {
		return fmt.Sprintf("HTTP %d: %s", status, t)
	}
	return fmt.Sprintf("HTTP %d", status)
}

func (s *MCP) listTools(ctx context.Context) (json.RawMessage, error) {
	status, body, err := s.do(ctx, http.MethodGet, ToolsPath, nil)
	if err != nil {
		return nil, fmt.Errorf("engine: %v", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("engine: %s", engineError(status, body))
	}
	var list struct {
		Tools json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &list); err != nil || len(list.Tools) == 0 {
		return nil, fmt.Errorf("engine: unexpected answer from %s", ToolsPath)
	}
	return list.Tools, nil
}

// callTool runs a tool in the engine. What goes wrong with the call itself (a
// bad argument, an unknown tool, a session that is gone) is a result with
// isError, which the model sees and can act on; protocol errors are the
// caller's, in handle.
func (s *MCP) callTool(ctx context.Context, name string, args json.RawMessage) mcpToolResult {
	toolErr := func(format string, a ...any) mcpToolResult {
		return mcpToolResult{Content: []mcpContent{{"text", fmt.Sprintf(format, a...)}}, IsError: true}
	}
	if s.Session == "" {
		return toolErr("%s is not set: the tools have no trace to read", EnvSession)
	}
	if t := bytes.TrimSpace(args); len(t) == 0 || string(t) == "null" {
		args = json.RawMessage("{}")
	}
	status, body, err := s.do(ctx, http.MethodPost, ToolPath(s.Session, name), args)
	if err != nil {
		return toolErr("engine: %v", err)
	}
	if status == http.StatusBadRequest { // the call's own fault: the text the engine's tool_result shows
		var env struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		if json.Unmarshal(body, &env) == nil && env.Error.Code == "bad_request" {
			return toolErr("%s", ToolErrorText(env.Error.Message))
		}
	}
	if status != http.StatusOK {
		return toolErr("%s", engineError(status, body))
	}
	return mcpToolResult{Content: []mcpContent{{"text", string(body)}}}
}
