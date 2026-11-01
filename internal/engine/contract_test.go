package engine

import (
	"bufio"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/assist"
	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// The contract test reads api/engine.openapi.yaml with a line scanner (no
// YAML dependency): the file keeps 2-space indentation, one mapping key per
// line, and block scalars (`|`) only for text.

const contractFile = "../../api/engine.openapi.yaml"

type yamlKey struct {
	indent int
	key    string
	value  string
}

var yamlKeyRe = regexp.MustCompile(`^( *)("[^"]*"|[^\s#"\-][^:]*):(?: (.*))?$`)

// readYAMLKeys returns the mapping keys of the file in order, skipping list
// items, comments and the text of block scalars.
func readYAMLKeys(t *testing.T) []yamlKey {
	t.Helper()
	f, err := os.Open(contractFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []yamlKey
	block := -1 // indent of the key whose block scalar is being skipped
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimLeft(line, " ")
		indent := len(line) - len(trimmed)
		if trimmed == "" {
			continue
		}
		if block >= 0 {
			if indent > block {
				continue
			}
			block = -1
		}
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.Contains(line, "\t") {
			t.Fatalf("tab in %s: %q", contractFile, line)
		}
		m := yamlKeyRe.FindStringSubmatch(line)
		if m == nil {
			continue // list items and their continuation
		}
		if indent%2 != 0 {
			t.Fatalf("odd indentation in %s: %q", contractFile, line)
		}
		k := yamlKey{indent: indent, key: strings.Trim(m[2], `"`), value: strings.TrimSpace(m[3])}
		if v := k.value; v == "|" || v == ">" || v == "|-" || v == ">-" {
			block = indent
		}
		out = append(out, k)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// children are the indexes of the direct child keys of keys[i] (i = -1: the
// top level).
func children(keys []yamlKey, i int) []int {
	parent := -2
	if i >= 0 {
		parent = keys[i].indent
	}
	var out []int
	want := -1
	for j := i + 1; j < len(keys); j++ {
		if keys[j].indent <= parent {
			break
		}
		if want < 0 {
			want = keys[j].indent
		}
		if keys[j].indent == want {
			out = append(out, j)
		}
	}
	return out
}

// lookup finds the key at path (from the top level); -1 if there is none.
func lookup(keys []yamlKey, path ...string) int {
	i := -1
	for _, p := range path {
		found := -1
		for _, c := range children(keys, i) {
			if keys[c].key == p {
				found = c
				break
			}
		}
		if found < 0 {
			return -1
		}
		i = found
	}
	return i
}

// contractRoutes are "METHOD /path" of every operation under paths.
func contractRoutes(t *testing.T, keys []yamlKey) []string {
	t.Helper()
	p := lookup(keys, "paths")
	if p < 0 {
		t.Fatal("no paths")
	}
	methods := map[string]bool{"get": true, "post": true, "put": true, "patch": true, "delete": true, "head": true, "options": true}
	var out []string
	for _, c := range children(keys, p) {
		path := keys[c].key
		if keys[c].indent != 2 || !strings.HasPrefix(path, "/") {
			t.Errorf("paths: %q at indent %d", path, keys[c].indent)
		}
		n := 0
		for _, m := range children(keys, c) {
			if methods[keys[m].key] {
				out = append(out, strings.ToUpper(keys[m].key)+" "+path)
				n++
			}
		}
		if n == 0 {
			t.Errorf("paths: %s has no operation", path)
		}
	}
	return out
}

// TestContractRoutes: the routes the engine serves are exactly the ones the
// OpenAPI file documents.
func TestContractRoutes(t *testing.T) {
	keys := readYAMLKeys(t)
	doc := contractRoutes(t, keys)
	e := newEnv(t)
	have := e.srv.Routes()
	for _, list := range [][]string{doc, have} {
		s := slices.Clone(list)
		slices.Sort(s)
		if d := slices.Compact(s); len(d) != len(list) {
			t.Errorf("duplicate routes in %v", list)
		}
	}
	for _, r := range have {
		if !slices.Contains(doc, r) {
			t.Errorf("route %s is not documented in %s", r, contractFile)
		}
	}
	for _, r := range doc {
		if !slices.Contains(have, r) {
			t.Errorf("%s documents %s, which the engine does not serve", contractFile, r)
		}
	}
	if n := len(slices.DeleteFunc(slices.Clone(have), func(r string) bool { return !strings.Contains(r, sessionPrefix+"/api/") })); n != 30 {
		t.Errorf("%d session routes, want doc, report, the 18 slice endpoints, the 7 line endpoints, ref, brief and the assist tools", n)
	}
}

// TestRoutesServed: every route of Routes reaches a handler (no catch-all
// 404) on a live engine.
func TestRoutesServed(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "io_waits.trc"}, nil)
	sub := strings.NewReplacer("{id}", "x", "{identity}", strings.Repeat("0", 64))
	for _, r := range e.srv.Routes() {
		method, path, _ := strings.Cut(r, " ")
		if path == "/engine/events" {
			continue // a stream; TestOpenEvents
		}
		if strings.HasPrefix(path, sessionPrefix+"/") {
			path = strings.Replace(path, "{id}", sid, 1)
		} else {
			path = sub.Replace(path)
		}
		g := e.req(method, path, nil)
		if bytes := string(g.body); strings.Contains(bytes, "no route") || g.code == http.StatusMethodNotAllowed || bytes == "404 page not found\n" {
			t.Errorf("%s %s: not routed (%d %s)", method, path, g.code, g.body)
		}
	}
}

// TestContractProtocol: the file's protocol is Protocol.
func TestContractProtocol(t *testing.T) {
	keys := readYAMLKeys(t)
	want := strconv.Itoa(Protocol)
	if i := lookup(keys, "x-mtkprof-protocol"); i < 0 || keys[i].value != want {
		t.Errorf("x-mtkprof-protocol is not %s", want)
	}
	if i := lookup(keys, "info", "version"); i < 0 || strings.Trim(keys[i].value, `"`) != want {
		t.Errorf("info.version is not %q", want)
	}
	if i := lookup(keys, "openapi"); i < 0 || !strings.HasPrefix(keys[i].value, "3.1") {
		t.Errorf("not OpenAPI 3.1")
	}
}

// TestContractSchemas: the control-plane schemas have exactly the JSON
// fields of the Go types, the error codes are the engine's, and every $ref
// resolves.
func TestContractSchemas(t *testing.T) {
	keys := readYAMLKeys(t)
	for name, v := range map[string]any{
		"Health": Health{}, "CacheHealth": CacheHealth{}, "JobInfo": JobInfo{}, "FileInfo": FileInfo{},
		"SessionInfo": SessionInfo{}, "SessionEvent": SessionEvent{}, "PromptEvent": PromptEvent{}, "LogEvent": LogEvent{},
		"CacheItem": CacheItem{}, "CacheList": CacheList{}, "CacheWipe": CacheWipe{}, "SessionOptions": SessionOptions{},
		"ToolInfo": assist.Info{}, "BackendInfo": assist.BackendInfo{}, "BriefRequest": BriefRequest{}, "BriefOptions": BriefOptions{}, "BriefScope": BriefScope{}, "Note": report.Note{}, "NoteStmt": report.NoteStmt{},
		"ConversationRequest": ConversationRequest{}, "MessageRequest": MessageRequest{}, "Provider": assist.Provider{}, "View": assist.View{},
		"ConversationInfo": assist.ConversationInfo{}, "Usage": assist.Usage{}, "Intent": assist.Intent{}, "PivotIntent": assist.PivotIntent{},
		"TextEvent": assist.TextEvent{}, "ToolCallEvent": assist.ToolCallEvent{}, "ToolResultEvent": assist.ToolResultEvent{}, "IntentEvent": assist.IntentEvent{},
		"UsageEvent": assist.UsageEvent{}, "StateEvent": assist.StateEvent{}, "DoneEvent": assist.DoneEvent{}, "ErrorEvent": assist.ErrorEvent{},
		"StmtStats": analyze.StmtStats{}, "ScopeProfile": analyze.ScopeProfile{}, "CallStats": analyze.CallStats{}, "Link": analyze.Link{},
	} {
		p := lookup(keys, "components", "schemas", name, "properties")
		if p < 0 {
			t.Errorf("schema %s: no properties", name)
			continue
		}
		var doc []string
		for _, c := range children(keys, p) {
			doc = append(doc, keys[c].key)
		}
		var have []string
		typ := reflect.TypeOf(v)
		for i := 0; i < typ.NumField(); i++ {
			tag, _, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
			if tag != "" && tag != "-" {
				have = append(have, tag)
			}
		}
		slices.Sort(doc)
		slices.Sort(have)
		if !slices.Equal(doc, have) {
			t.Errorf("schema %s has %v, the Go type %v", name, doc, have)
		}
	}
	i := lookup(keys, "components", "schemas", "ErrorCode", "enum")
	codes := []Code{CodeBadRequest, CodeUnauthorized, CodeNotFound, CodeConflict, CodeCancelled, CodeNeedsPrompt, CodeInternal, CodeRemote}
	var want []string
	for _, c := range codes {
		want = append(want, string(c))
	}
	if i < 0 || keys[i].value != "["+strings.Join(want, ", ")+"]" {
		t.Errorf("ErrorCode enum is not %v", want)
	}
	for name, want := range map[string][]string{
		"TurnErrorCode":     {assist.CodeCancelled, assist.CodeSessionClosed, assist.CodeNoKey, assist.CodeAuth, assist.CodeProvider, assist.CodeTooManySteps, assist.CodeInternal},
		"ConversationState": {string(assist.StateIdle), string(assist.StateRunning), string(assist.StateWaitingKey), string(assist.StateCancelled), string(assist.StateFailed)},
	} {
		if i := lookup(keys, "components", "schemas", name, "enum"); i < 0 || keys[i].value != "["+strings.Join(want, ", ")+"]" {
			t.Errorf("%s enum is not %v", name, want)
		}
	}
	if i := lookup(keys, "components", "schemas", "PromptEvent", "properties", "kind", "enum"); i < 0 ||
		keys[i].value != "["+strings.Join([]string{remote.KindPassword, remote.KindPassphrase, remote.KindOTP, remote.KindHostKey, remote.KindConfirm, remote.KindAPIKey}, ", ")+"]" {
		t.Errorf("PromptEvent kind enum is not the prompt kinds")
	}
	for typ, schema := range map[string]string{"text": "TextEvent", "tool_call": "ToolCallEvent", "tool_result": "ToolResultEvent", "intent": "IntentEvent",
		"usage": "UsageEvent", "state": "StateEvent", "done": "DoneEvent", "error": "ErrorEvent"} {
		if i := lookup(keys, "components", "schemas", schema, "properties", "type", "const"); i < 0 || keys[i].value != typ {
			t.Errorf("%s: type is not %q", schema, typ)
		}
		if i := lookup(keys, "components", "schemas", "TurnEvent", "discriminator", "mapping", typ); i < 0 || keys[i].value != `"#/components/schemas/`+schema+`"` {
			t.Errorf("TurnEvent maps %s elsewhere", typ)
		}
	}

	b, err := os.ReadFile(contractFile)
	if err != nil {
		t.Fatal(err)
	}
	refs := regexp.MustCompile(`\$ref: "#/([^"]+)"`).FindAllStringSubmatch(string(b), -1)
	if len(refs) < 50 {
		t.Fatalf("only %d refs", len(refs))
	}
	for _, m := range refs {
		if lookup(keys, strings.Split(m[1], "/")...) < 0 {
			t.Errorf("$ref %s does not resolve", m[1])
		}
	}
}
