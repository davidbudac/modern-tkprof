package assist

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func newLocalMCP(t *testing.T, l *Local) *MCP {
	t.Helper()
	t.Cleanup(l.Close)
	return &MCP{Local: l, Instructions: LocalInstructions, Name: "mtkprof", Version: "test"}
}

func rpcCall(id int, name, args string) string {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": json.RawMessage(args)}})
	return string(b)
}

// TestLocalMCP is `mtkprof mcp` without an engine: the agent opens a trace with
// open_trace and the tools answer on it in process, as they do in the engine.
func TestLocalMCP(t *testing.T) {
	path, err := filepath.Abs(traces + "basic_binds.trc")
	if err != nil {
		t.Fatal(err)
	}
	s := newLocalMCP(t, &Local{})
	rs := serve(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		rpcCall(3, "overview", `{}`),
		rpcCall(4, "open_trace", `{"paths":["/no/such/file.trc"]}`),
		rpcCall(5, "open_trace", `{"paths":[`+jsonString(path)+`]}`),
		rpcCall(6, "statement", `{"sql_id":"f6jyzt7462kx2"}`),
		rpcCall(7, "show", `{}`),
	)
	if len(rs) != 7 {
		t.Fatalf("%d replies", len(rs))
	}
	var init struct{ Instructions string }
	json.Unmarshal(rs[0].Result, &init)
	if !strings.Contains(init.Instructions, "open_trace") {
		t.Errorf("initialize: no instructions: %s", rs[0].Result)
	}
	var list struct {
		Tools []Info `json:"tools"`
	}
	json.Unmarshal(rs[1].Result, &list)
	names := map[string]bool{}
	for _, tl := range list.Tools {
		names[tl.Name] = true
		var sch map[string]any
		if json.Unmarshal(tl.InputSchema, &sch) != nil || sch["type"] != "object" {
			t.Errorf("%s: schema %s", tl.Name, tl.InputSchema)
		}
	}
	if !names["open_trace"] || !names["overview"] || !names["search_lines"] || names["show"] || names["notes"] || names["current_view"] {
		t.Errorf("tools listed: %v", names)
	}
	if got := toolResult(t, rs[2]); !got.IsError || !strings.Contains(got.Content[0].Text, "open_trace") {
		t.Errorf("a call before open_trace: %+v", got)
	}
	if got := toolResult(t, rs[3]); !got.IsError || !strings.Contains(got.Content[0].Text, "no such file") {
		t.Errorf("open_trace of a missing file: %+v", got)
	}
	want, err := Call(context.Background(), loadEnv(t, "basic_binds", true), "overview", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResult(t, rs[4])
	if got.IsError || !strings.Contains(got.Content[0].Text, `"files"`) {
		t.Fatalf("open_trace: %+v", got)
	}
	// the masking salt differs per server, so compare the shapes, not the hashes
	if len(got.Content[0].Text) != len(want.JSON) {
		t.Errorf("open_trace answers %d bytes, the overview of the engine's tool %d", len(got.Content[0].Text), len(want.JSON))
	}
	if got := toolResult(t, rs[5]); got.IsError || !strings.Contains(got.Content[0].Text, `"ref":"f6jyzt7462kx2"`) {
		t.Errorf("statement: %+v", got)
	}
	if got := toolResult(t, rs[6]); !got.IsError || !strings.Contains(got.Content[0].Text, "desktop app") {
		t.Errorf("show: %+v", got)
	}
}

// TestLocalOpenLater: the traces of the command line open on the first call,
// and bind values are masked unless KeepBinds.
func TestLocalOpenLater(t *testing.T) {
	for _, keep := range []bool{false, true} {
		l := &Local{KeepBinds: keep}
		l.OpenLater([]string{traces + "basic_binds.trc"})
		rs := serve(t, newLocalMCP(t, l), rpcCall(1, "executions", `{"sql_id":"f6jyzt7462kx2","limit":1}`))
		got := toolResult(t, rs[0])
		if got.IsError {
			t.Fatalf("keep=%v: %+v", keep, got)
		}
		if masked := strings.Contains(got.Content[0].Text, "<NUMBER len=2 h="); masked == keep {
			t.Errorf("keep=%v: masked=%v: %.400s", keep, masked, got.Content[0].Text)
		}
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
