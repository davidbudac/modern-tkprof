package engine

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/assist"
	"github.com/davidbudac/modern-tkprof/internal/assist/fake"
)

// turnEvent is an event of a turn's NDJSON stream.
type turnEvent struct {
	Type    string
	Text    string
	ID      string
	Name    string
	IsError bool
	Content string
	State   string
	Code    string
	Message string
	Href    string
	Target  assist.Intent
	Usage   assist.Usage
}

type turnStream struct {
	t    *testing.T
	resp *http.Response
	sc   *bufio.Scanner
	seen []turnEvent
}

// post sends a message over HTTP and returns the open stream.
func post(t *testing.T, ts *httptest.Server, cid string, body any) *turnStream {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", ts.URL+"/engine/assist/conversations/"+cid+"/messages", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("messages: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(nil, 1<<20)
	return &turnStream{t: t, resp: resp, sc: sc}
}

// next is the next event; ok false at the end of the stream.
func (s *turnStream) next() (turnEvent, bool) {
	s.t.Helper()
	if !s.sc.Scan() {
		return turnEvent{}, false
	}
	var e turnEvent
	if err := json.Unmarshal(s.sc.Bytes(), &e); err != nil {
		s.t.Fatalf("not an event: %q", s.sc.Text())
	}
	s.seen = append(s.seen, e)
	return e, true
}

func (s *turnStream) until(typ string) turnEvent {
	s.t.Helper()
	for {
		e, ok := s.next()
		if !ok {
			s.t.Fatalf("the stream ended before a %s event: %+v", typ, s.seen)
		}
		if e.Type == typ {
			return e
		}
	}
}

// rest reads to the end and returns every event of the stream.
func (s *turnStream) rest() []turnEvent {
	for _, ok := s.next(); ok; _, ok = s.next() {
	}
	return s.seen
}

func eventTypes(es []turnEvent) []string {
	var out []string
	for _, e := range es {
		if e.Type == "text" && len(out) > 0 && out[len(out)-1] == "text" {
			continue
		}
		out = append(out, e.Type)
	}
	return out
}

// startFake serves a fake OpenAI script; the provider points at it.
func startFake(t *testing.T, script fake.Script) (*fake.OpenAI, string) {
	f := &fake.OpenAI{Script: script}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv.URL + "/v1"
}

func (e *env) conversation(sid string, provider map[string]any, extra map[string]any) assist.ConversationInfo {
	e.t.Helper()
	body := map[string]any{"session": sid, "provider": provider, "consent": true}
	for k, v := range extra {
		body[k] = v
	}
	r := e.req("POST", "/engine/assist/conversations", body)
	if r.code != http.StatusCreated {
		e.t.Fatalf("create: %d %s", r.code, r.body)
	}
	return decode[assist.ConversationInfo](e.t, r.body)
}

// TestConversationTurn: a turn against the fake streams tool_call,
// tool_result, text and done, and every tool_result is what the fake got.
func TestConversationTurn(t *testing.T) {
	e, ts := newServed(t)
	f, base := startFake(t, fake.Script{Steps: []fake.Step{
		{ToolCalls: []fake.ToolCall{{Name: "overview", Arguments: "{}"}, {Name: "executions", Arguments: `{"sql_id":"@0","limit":50}`}}},
		{Text: "Most of the time is SQL*Net message from client.", DeltaDelayMs: 1},
	}})
	sid := e.openReady([]string{traces + "bind_types.trc"}, nil)
	c := e.conversation(sid, map[string]any{"id": "fake", "kind": "openai", "baseUrl": base, "model": "m", "auth": "none"},
		map[string]any{"case": "nightly batch is slow", "notes": []any{}, "view": map[string]any{"view": "overview"}})
	if c.State != assist.StateIdle || c.Session != sid || c.Binds != "mask" || c.Provider.Auth != "none" {
		t.Errorf("created %+v", c)
	}
	es := post(t, ts, c.ID, map[string]any{"text": "where did the time go?"}).rest()
	if got := eventTypes(es); !slices.Equal(got, []string{"usage", "tool_call", "tool_result", "tool_call", "tool_result", "text", "usage", "done"}) {
		t.Fatalf("events %v", got)
	}
	var results []turnEvent
	for _, ev := range es {
		if ev.Type == "tool_result" {
			results = append(results, ev)
		}
	}
	var second struct {
		Messages []struct {
			Role, Content string
			ToolCallID    string `json:"tool_call_id"`
		}
	}
	json.Unmarshal(f.Requests()[1].Body, &second)
	var got []string
	for _, m := range second.Messages {
		if m.Role == "tool" {
			got = append(got, m.Content)
		}
	}
	if len(got) != 2 || got[0] != results[0].Content || got[1] != results[1].Content {
		t.Errorf("the fake got %d tool results that differ from the events", len(got))
	}
	sent := string(f.Requests()[1].Body)
	for _, raw := range []string{"29-FEB-24", "DEADBEEF"} { // bind_types values, masked
		if strings.Contains(sent, raw) {
			t.Errorf("the provider got the bind value %q", raw)
		}
	}
	if !strings.Contains(sent, "nightly batch is slow") {
		t.Errorf("the case text did not reach the model")
	}
	in := decode[assist.ConversationInfo](t, e.req("GET", "/engine/assist/conversations/"+c.ID, nil).body)
	if in.State != assist.StateIdle || in.Turns != 1 || in.Messages != 5 || in.Usage.Requests != 2 {
		t.Errorf("after the turn: %+v", in)
	}
}

// TestConversationKey: the key is asked for with an apikey prompt, held, and
// asked for again after DELETE .../providers/{id}/key.
func TestConversationKey(t *testing.T) {
	e, ts := newServed(t)
	f, base := startFake(t, fake.Script{Key: "sk-test", Loop: true, Steps: []fake.Step{{Text: "ok"}}})
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	c := e.conversation(sid, map[string]any{"id": "prov-1", "name": "Fake", "kind": "openai", "baseUrl": base, "model": "m"}, nil)
	sse := openSSE(t, ts)
	isOpen := func(d string) bool { return decode[PromptEvent](t, []byte(d)).State == "open" }

	s := post(t, ts, c.ID, map[string]any{"text": "hi"})
	if ev := s.until("state"); ev.State != "waiting_key" {
		t.Errorf("state %+v", ev)
	}
	pe := decode[PromptEvent](t, []byte(sse.until("prompt", isOpen)))
	if pe.Kind != "apikey" || pe.Connection != "prov-1" || pe.Echo || !strings.Contains(pe.Text, "Fake") {
		t.Errorf("prompt %+v", pe)
	}
	if r := e.req("POST", "/engine/prompts/"+pe.ID, map[string]any{"answer": "sk-test"}); r.code != http.StatusNoContent {
		t.Fatalf("answer: %d %s", r.code, r.body)
	}
	if ev := s.until("state"); ev.State != "running" {
		t.Errorf("state %+v", ev)
	}
	if es := s.rest(); es[len(es)-1].Type != "done" {
		t.Fatalf("end %+v", es[len(es)-1])
	}
	if es := post(t, ts, c.ID, map[string]any{"text": "again"}).rest(); slices.Contains(eventTypes(es), "state") || es[len(es)-1].Type != "done" {
		t.Errorf("the held key was asked for again: %+v", es)
	}
	if !f.Requests()[0].Auth {
		t.Error("no Authorization header")
	}

	if r := e.req("DELETE", "/engine/assist/providers/prov-1/key", nil); r.code != http.StatusNoContent {
		t.Fatalf("forget: %d", r.code)
	}
	s = post(t, ts, c.ID, map[string]any{"text": "after forget"})
	pe = decode[PromptEvent](t, []byte(sse.until("prompt", isOpen)))
	e.req("POST", "/engine/prompts/"+pe.ID, map[string]any{"cancel": true})
	if es := s.rest(); es[len(es)-1].Code != assist.CodeNoKey {
		t.Errorf("cancelled key prompt: %+v", es[len(es)-1])
	}
	if in := decode[assist.ConversationInfo](t, e.req("GET", "/engine/assist/conversations/"+c.ID, nil).body); in.State != assist.StateCancelled {
		t.Errorf("state %s", in.State)
	}
}

// TestConversationCancel: DELETE ends the open turn with error cancelled at
// once, the provider's request is closed, and the conversation is gone. A
// second message while a turn runs is a 409; a CLI agent's show call over
// HTTP lands on the open turn as an intent.
func TestConversationCancel(t *testing.T) {
	e, ts := newServed(t)
	f, base := startFake(t, fake.Script{Steps: []fake.Step{{Text: "looking", ToolCalls: []fake.ToolCall{{Name: "overview", Arguments: "{}"}}, HangMs: 20000}}})
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	c := e.conversation(sid, map[string]any{"id": "fake", "kind": "openai", "baseUrl": base, "model": "m", "auth": "none"}, nil)
	s := post(t, ts, c.ID, map[string]any{"text": "hi"})
	s.until("text")
	if r := e.req("POST", "/engine/assist/conversations/"+c.ID+"/messages", map[string]any{"text": "second"}); r.code != http.StatusConflict {
		t.Errorf("a second message: %d %s", r.code, r.body)
	}
	r := e.req("POST", "/s/"+sid+"/api/assist/tools/show", map[string]any{"sql_id": "f6jyzt7462kx2"}, assist.ConversationHeader, c.ID)
	if r.code != 200 || !strings.Contains(string(r.body), `"sent":true`) {
		t.Fatalf("show over HTTP: %d %s", r.code, r.body)
	}
	if ev := s.until("intent"); ev.Target.SQLID != "f6jyzt7462kx2" || ev.Href != "mtkprof:#view=statements&sql=f6jyzt7462kx2" {
		t.Errorf("intent %+v", ev)
	}
	start := time.Now()
	if r := e.req("DELETE", "/engine/assist/conversations/"+c.ID, nil); r.code != http.StatusNoContent {
		t.Fatalf("delete: %d", r.code)
	}
	es := s.rest()
	if d := time.Since(start); d > time.Second {
		t.Errorf("cancel took %s", d)
	}
	if l := es[len(es)-1]; l.Type != "error" || l.Code != assist.CodeCancelled {
		t.Errorf("end %+v", l)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !f.Requests()[0].Closed && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !f.Requests()[0].Closed {
		t.Error("the fake did not see the request closed")
	}
	if r := e.req("GET", "/engine/assist/conversations/"+c.ID, nil); r.code != http.StatusNotFound {
		t.Errorf("after delete: %d", r.code)
	}
}

// TestConversationSessionClosed: closing the session ends the open turn with
// session_closed and drops its conversations.
func TestConversationSessionClosed(t *testing.T) {
	e, ts := newServed(t)
	_, base := startFake(t, fake.Script{Steps: []fake.Step{{Text: "slow", HangMs: 20000}}})
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	c := e.conversation(sid, map[string]any{"id": "fake", "kind": "openai", "baseUrl": base, "model": "m", "auth": "none"}, nil)
	s := post(t, ts, c.ID, map[string]any{"text": "hi"})
	s.until("text")
	if r := e.req("DELETE", "/engine/sessions/"+sid, nil); r.code != http.StatusNoContent {
		t.Fatalf("close: %d", r.code)
	}
	if es := s.rest(); es[len(es)-1].Code != assist.CodeSessionClosed {
		t.Errorf("end %+v", es[len(es)-1])
	}
	if r := e.req("GET", "/engine/assist/conversations/"+c.ID, nil); r.code != http.StatusNotFound {
		t.Errorf("after the session closed: %d", r.code)
	}
}

func TestConversationBadRequests(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	good := map[string]any{"id": "p", "kind": "openai", "baseUrl": "http://127.0.0.1:9/v1", "model": "m"}
	with := func(k string, v any) map[string]any {
		p := map[string]any{}
		for a, b := range good {
			p[a] = b
		}
		p[k] = v
		return p
	}
	for _, c := range []struct {
		body map[string]any
		code int
		msg  string
	}{
		{map[string]any{"session": sid, "provider": good}, 400, "consent"},
		{map[string]any{"session": sid, "provider": with("kind", "gemini"), "consent": true}, 400, "provider.kind"},
		{map[string]any{"session": sid, "provider": with("headers", map[string]string{"Authorization": "Bearer sk"}), "consent": true}, 400, "key prompt"},
		{map[string]any{"session": sid, "provider": with("apiKey", "sk"), "consent": true}, 400, "unknown field"},
		{map[string]any{"session": sid, "provider": good, "consent": true, "binds": "none"}, 400, "binds"},
		{map[string]any{"session": sid, "provider": good, "consent": true, "scope": map[string]any{"contexts": []int{99}}}, 400, "contexts"},
		{map[string]any{"session": sid, "provider": good, "consent": true, "notes": []any{map[string]any{"kind": "statement"}}}, 400, "notes[0]"},
		{map[string]any{"session": "snope", "provider": good, "consent": true}, 404, "no session"},
	} {
		r := e.req("POST", "/engine/assist/conversations", c.body)
		env := decode[struct{ Error Error }](t, r.body)
		if r.code != c.code || !strings.Contains(env.Error.Message, c.msg) {
			t.Errorf("%v: %d %s, want %d with %q", c.body, r.code, r.body, c.code, c.msg)
		}
	}
	cid := e.conversation(sid, good, nil).ID
	for _, c := range []struct {
		body any
		msg  string
	}{
		{map[string]any{"text": " "}, "text"},
		{map[string]any{"text": "x", "extra": 1}, "unknown field"},
	} {
		if r := e.req("POST", "/engine/assist/conversations/"+cid+"/messages", c.body); r.code != 400 || !strings.Contains(string(r.body), c.msg) {
			t.Errorf("%v: %d %s", c.body, r.code, r.body)
		}
	}
	for _, p := range []string{"GET /engine/assist/conversations/cnope", "DELETE /engine/assist/conversations/cnope", "POST /engine/assist/conversations/cnope/messages"} {
		m, path, _ := strings.Cut(p, " ")
		if r := e.req(m, path, map[string]any{"text": "x"}); r.code != 404 {
			t.Errorf("%s: %d", p, r.code)
		}
	}
}
