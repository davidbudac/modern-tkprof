package assist

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// engineStub answers the routes `mtkprof mcp` calls the way the engine does,
// from a loaded trace; it records what it was sent.
type engineStub struct {
	t     *testing.T
	env   Env
	token string
	mu    sync.Mutex
	conv  []string
}

func (s *engineStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+s.token {
		http.Error(w, `{"error":{"code":"unauthorized","message":"missing or wrong bearer token"}}`, http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == ToolsPath:
		json.NewEncoder(w).Encode(map[string]any{"tools": Infos()})
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/s/s1/api/assist/tools/"):
		s.mu.Lock()
		s.conv = append(s.conv, r.Header.Get(ConversationHeader))
		s.mu.Unlock()
		args, _ := io.ReadAll(r.Body)
		res, err := Call(r.Context(), s.env, strings.TrimPrefix(r.URL.Path, "/s/s1/api/assist/tools/"), args)
		var ae *ArgError
		if errors.As(err, &ae) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "bad_request", "message": ae.Msg}})
			return
		}
		if err != nil {
			s.t.Error(err)
		}
		w.Write(res.JSON)
	default:
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":{"code":"not_found","message":"no session"}}`)
	}
}

type rpcReplyT struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// serve feeds the requests (one JSON object per line) to a server and returns
// its replies.
func serve(t *testing.T, s *MCP, requests ...string) []rpcReplyT {
	t.Helper()
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(strings.Join(requests, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	var replies []rpcReplyT
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if l == "" {
			continue
		}
		var r rpcReplyT
		if err := json.Unmarshal([]byte(l), &r); err != nil {
			t.Fatalf("%q: %v", l, err)
		}
		replies = append(replies, r)
	}
	return replies
}

func newMCP(t *testing.T) (*MCP, *engineStub, *httptest.Server) {
	t.Helper()
	stub := &engineStub{t: t, env: loadEnv(t, "basic_binds", true), token: "tok"}
	ts := httptest.NewServer(stub)
	t.Cleanup(ts.Close)
	return &MCP{Engine: strings.TrimPrefix(ts.URL, "http://"), Token: "tok", Session: "s1", Conversation: "c42", Name: "mtkprof", Version: "test"}, stub, ts
}

type toolText struct {
	Content []struct{ Type, Text string }
	IsError bool
}

func toolResult(t *testing.T, r rpcReplyT) toolText {
	t.Helper()
	if r.Error != nil {
		t.Fatalf("protocol error %+v", r.Error)
	}
	var tt toolText
	if err := json.Unmarshal(r.Result, &tt); err != nil || len(tt.Content) != 1 || tt.Content[0].Type != "text" {
		t.Fatalf("result %s: %v", r.Result, err)
	}
	return tt
}

func TestMCPInitialize(t *testing.T) {
	s, _, _ := newMCP(t)
	for _, c := range []struct{ asked, want string }{
		{"2025-11-25", "2025-11-25"}, {"2025-06-18", "2025-06-18"}, {"2025-03-26", "2025-03-26"}, {"2024-11-05", "2024-11-05"},
		{"2099-01-01", "2025-11-25"}, {"", "2025-11-25"},
	} {
		req := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` + c.asked + `","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`
		rs := serve(t, s, req)
		if len(rs) != 1 || rs[0].Error != nil {
			t.Fatalf("%q: %+v", c.asked, rs)
		}
		var res struct {
			ProtocolVersion string
			Capabilities    struct{ Tools map[string]any }
			ServerInfo      struct{ Name, Version string }
		}
		json.Unmarshal(rs[0].Result, &res)
		if res.ProtocolVersion != c.want || res.Capabilities.Tools == nil || res.ServerInfo.Name != "mtkprof" || res.ServerInfo.Version != "test" {
			t.Errorf("asked %q: %+v", c.asked, res)
		}
	}
}

func TestMCPMethods(t *testing.T) {
	s, stub, _ := newMCP(t)
	rs := serve(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`, // a notification: no reply
		`{"jsonrpc":"2.0","id":"p","method":"ping"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"overview","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"statement","arguments":{"sql_id":"f6jyzt7462kx2"}}}`,
	)
	if len(rs) != 5 {
		t.Fatalf("%d replies for 5 requests and a notification: %+v", len(rs), rs)
	}
	if string(rs[1].ID) != `"p"` || string(rs[1].Result) != "{}" {
		t.Errorf("ping: %s %s", rs[1].ID, rs[1].Result)
	}
	var list struct {
		Tools []Info `json:"tools"`
	}
	json.Unmarshal(rs[2].Result, &list)
	if len(list.Tools) != len(Tools) {
		t.Fatalf("%d tools listed", len(list.Tools))
	}
	for i, tl := range list.Tools {
		if tl.Name != Tools[i].Name || tl.Description != Tools[i].Description || !json.Valid(tl.InputSchema) {
			t.Errorf("tool %d: %+v", i, tl.Name)
		}
		var sch map[string]any
		json.Unmarshal(tl.InputSchema, &sch)
		if sch["type"] != "object" {
			t.Errorf("%s: schema %v", tl.Name, sch)
		}
	}
	direct, err := Call(context.Background(), stub.env, "overview", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResult(t, rs[3]); got.IsError || got.Content[0].Text != string(direct.JSON) {
		t.Errorf("overview over MCP is not the overview of the tool (error %v)", got.IsError)
	}
	if got := toolResult(t, rs[4]); got.IsError || !strings.Contains(got.Content[0].Text, `"ref":"f6jyzt7462kx2"`) {
		t.Errorf("statement: %+v", got)
	}
	if len(stub.conv) != 2 || stub.conv[0] != "c42" {
		t.Errorf("the engine saw conversations %v", stub.conv)
	}
}

func TestMCPErrors(t *testing.T) {
	s, _, ts := newMCP(t)
	rs := serve(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"statement","arguments":{"sql_id":"zzzz"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"statement","arguments":{"bad":1}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"overview"}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}`,
		`{"jsonrpc":"2.0","id":6,"method":"resources/list"}`,
		`not json`,
		`{"jsonrpc":"2.0","id":7,"method":"ping"}`,
	)
	if len(rs) != 8 {
		t.Fatalf("%d replies", len(rs))
	}
	for i, want := range []string{`unknown tool "nope"`, "not in this trace", "unknown field"} { // the engine's 400s are results the model can read
		got := toolResult(t, rs[i])
		if !got.IsError || !strings.Contains(got.Content[0].Text, want) || !strings.HasPrefix(got.Content[0].Text, ToolErrorText("")) {
			t.Errorf("call %d: %+v, want an error with %q", i+1, got, want)
		}
	}
	if got := toolResult(t, rs[3]); got.IsError {
		t.Errorf("a call without arguments: %+v", got)
	}
	for i, want := range map[int]int{4: rpcInvalidParams, 5: rpcMethodNotFound, 6: rpcParseError} { // the protocol's own errors
		if rs[i].Error == nil || rs[i].Error.Code != want {
			t.Errorf("reply %d: %+v, want code %d", i, rs[i].Error, want)
		}
	}
	if string(rs[6].ID) != "null" || rs[7].Error != nil {
		t.Errorf("after a parse error: %+v %+v", rs[6], rs[7])
	}

	// no session, a wrong token, an engine that is gone
	call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"overview"}}`
	list := `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
	noSession := *s
	noSession.Session = ""
	if got := toolResult(t, serve(t, &noSession, call)[0]); !got.IsError || !strings.Contains(got.Content[0].Text, EnvSession) {
		t.Errorf("no session: %+v", got)
	}
	wrong := *s
	wrong.Token = "nope"
	if got := toolResult(t, serve(t, &wrong, call)[0]); !got.IsError || !strings.Contains(got.Content[0].Text, "unauthorized") {
		t.Errorf("wrong token: %+v", got)
	}
	if rs := serve(t, &wrong, list); rs[0].Error == nil || rs[0].Error.Code != rpcInternalError {
		t.Errorf("tools/list with a wrong token: %+v", rs[0])
	}
	ts.Close()
	if got := toolResult(t, serve(t, s, call)[0]); !got.IsError || !strings.Contains(got.Content[0].Text, "engine") {
		t.Errorf("engine gone: %+v", got)
	}
}

func TestMCPEngineAddress(t *testing.T) {
	for in, want := range map[string]string{"127.0.0.1:41233": "http://127.0.0.1:41233", "http://h:1/": "http://h:1", "https://h:2": "https://h:2"} {
		if got := (&MCP{Engine: in}).base(); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
	if p := ToolPath("s a", "x/y"); p != "/s/s%20a/api/assist/tools/x%2Fy" {
		t.Errorf("%q", p)
	}
}
