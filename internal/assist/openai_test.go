package assist

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/assist/fake"
)

type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) logf(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, a...))
}

func (l *logLines) count(sub string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, s := range l.lines {
		if strings.Contains(s, sub) {
			n++
		}
	}
	return n
}

type oaTest struct {
	*convTest
	fake *fake.OpenAI
	log  *logLines
}

// newOATest is a conversation on basic_binds.trc with the OpenAI backend
// pointed at a fake running script.
func newOATest(t *testing.T, script fake.Script, auth string) *oaTest {
	t.Helper()
	f := &fake.OpenAI{Script: script}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	p := Provider{ID: "fake", Kind: "openai", BaseURL: srv.URL + "/v1/", Model: "fake-model", Auth: auth, Headers: map[string]string{"X-Title": "mtkprof"}}
	ct := newConvTest(t, p, nil)
	b, _ := newOpenAI(p)
	o := b.(*openAI)
	o.backoff = time.Millisecond
	ct.c.backend = o
	lg := &logLines{}
	ct.c.host.Logf = lg.logf
	return &oaTest{ct, f, lg}
}

// sent is what the fake got in request n (1-based).
func (o *oaTest) sent(n int) oaRequest {
	o.t.Helper()
	reqs := o.fake.Requests()
	if len(reqs) < n {
		o.t.Fatalf("the fake got %d requests, want %d", len(reqs), n)
	}
	var r oaRequest
	if err := json.Unmarshal(reqs[n-1].Body, &r); err != nil {
		o.t.Fatal(err)
	}
	return r
}

func TestOpenAITwoTools(t *testing.T) {
	o := newOATest(t, fake.Script{Steps: []fake.Step{
		{Text: "Let me look.", ToolCalls: []fake.ToolCall{{Name: "overview", Arguments: "{}"}, {Name: "statements", Arguments: `{"limit":3}`}},
			Usage: &fake.Usage{PromptTokens: 1000, CompletionTokens: 20}},
		{Text: "The top statement is [f6jyzt7462kx2](mtkprof:#view=statements&sql=f6jyzt7462kx2).", Usage: &fake.Usage{PromptTokens: 3000, CompletionTokens: 40}},
	}}, AuthNone)
	es := o.run("where did the time go?")
	want := []string{"text", "usage", "tool_call", "tool_result", "tool_call", "tool_result", "text", "usage", "done"}
	if got := types(es); !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
	if text(es) != "Let me look.The top statement is [f6jyzt7462kx2](mtkprof:#view=statements&sql=f6jyzt7462kx2)." {
		t.Errorf("text %q", text(es))
	}
	if d := last(es); d.Usage.InputTokens != 4000 || d.Usage.OutputTokens != 60 || d.Usage.Requests != 2 || d.Total != d.Usage {
		t.Errorf("done %+v", d)
	}
	first, second := o.sent(1), o.sent(2)
	if first.Model != "fake-model" || !first.Stream || !first.StreamOptions.IncludeUsage || len(first.Tools) != len(Tools) {
		t.Errorf("request 1: %+v", first)
	}
	if first.Messages[0].Role != "system" || !strings.Contains(*first.Messages[0].Content, "mtkprof: links") ||
		first.Messages[1].Role != "user" || *first.Messages[1].Content != "where did the time go?" {
		t.Errorf("request 1 messages: %+v", first.Messages)
	}
	// the second request carries the calls and exactly what the tool_result events showed
	m := second.Messages
	if len(m) != 5 || m[2].Role != "assistant" || len(m[2].ToolCalls) != 2 || *m[2].Content != "Let me look." {
		t.Fatalf("request 2 messages: %+v", m)
	}
	results, calls := ofType(es, "tool_result"), ofType(es, "tool_call")
	for i, r := range results {
		tm := m[3+i]
		if tm.Role != "tool" || tm.ToolCallID != m[2].ToolCalls[i].ID || tm.ToolCallID != r.ID || *tm.Content != r.Content || r.IsError {
			t.Errorf("tool message %d: %+v, event %+v", i, tm, r)
		}
	}
	if m[2].ToolCalls[1].Function.Arguments != `{"limit":3}` || calls[1].Name != "statements" || string(calls[1].Args) != `{"limit":3}` {
		t.Errorf("statements call: %+v, event %+v", m[2].ToolCalls[1], calls[1])
	}
	reqs := o.fake.Requests()
	if reqs[0].Auth || reqs[0].Path != "/v1/chat/completions" {
		t.Errorf("auth none sent a key, or the path is %s", reqs[0].Path)
	}
	if roles := len(o.c.messages); roles != 5 { // user, assistant+calls, 2 tool, assistant
		t.Errorf("history of %d messages", roles)
	}
}

func TestOpenAIRetry(t *testing.T) {
	o := newOATest(t, fake.Script{Steps: []fake.Step{
		{Status: 429, RetryAfter: "0", Error: "slow down"},
		{Status: 503},
		{Text: "done after two retries"},
	}}, AuthNone)
	es := o.run("hi")
	if e := last(es); e.Type != "done" || text(es) != "done after two retries" {
		t.Fatalf("end %+v", e)
	}
	if n := len(o.fake.Requests()); n != 3 {
		t.Errorf("%d requests", n)
	}
	if o.log.count("retry 1 of 2") != 1 || o.log.count("retry 2 of 2") != 1 || o.log.count("slow down") != 1 {
		t.Errorf("log %q", o.log.lines)
	}

	o = newOATest(t, fake.Script{Steps: []fake.Step{{Status: 500}, {Status: 502}, {Status: 500, Error: "still down"}}}, AuthNone)
	if e := last(o.run("hi")); e.Code != CodeProvider || !strings.Contains(e.Message, "HTTP 500: still down") || len(o.fake.Requests()) != 3 {
		t.Errorf("after the retries: %+v", e)
	}
	o = newOATest(t, fake.Script{Steps: []fake.Step{{Status: 400, Error: "model not found"}}}, AuthNone)
	if e := last(o.run("hi")); e.Code != CodeProvider || !strings.Contains(e.Message, "model not found") || len(o.fake.Requests()) != 1 {
		t.Errorf("a 400 is not retried: %+v", e)
	}
	if w := (&openAI{backoff: time.Second, maxWait: 30 * time.Second}).retryWait(1, "120"); w != 30*time.Second {
		t.Errorf("Retry-After 120 waits %s", w)
	}
	if w := (&openAI{backoff: time.Second, maxWait: 30 * time.Second}).retryWait(1, ""); w != 2*time.Second {
		t.Errorf("the second retry waits %s", w)
	}
}

func TestOpenAIMalformedToolCalls(t *testing.T) {
	o := newOATest(t, fake.Script{Steps: []fake.Step{
		{ToolCalls: []fake.ToolCall{{Name: "statement", Arguments: `{"sql_id": "f6jyzt7462kx2"`}}},
		{ToolCalls: []fake.ToolCall{{Name: "explain_plan", Arguments: `{}`}, {Name: "statement", Arguments: `{"sqlid":"x"}`}}},
		{ToolCalls: []fake.ToolCall{{Name: "statement", Arguments: `{"sql_id":"f6jyzt7462kx2"}`}}},
		{Text: "Recovered."},
	}}, AuthNone)
	es := o.run("show the select")
	if e := last(es); e.Type != "done" || text(es) != "Recovered." {
		t.Fatalf("end %+v", e)
	}
	results := ofType(es, "tool_result")
	if len(results) != 4 {
		t.Fatalf("%d tool results", len(results))
	}
	for i, want := range []string{"not JSON", `unknown tool "explain_plan"`, "unknown field"} {
		if !results[i].IsError || !strings.HasPrefix(results[i].Content, "error: ") || !strings.Contains(results[i].Content, want) {
			t.Errorf("result %d: %+v, want an error with %q", i, results[i], want)
		}
	}
	if results[3].IsError {
		t.Errorf("the good call failed: %s", results[3].Content)
	}
	// the malformed arguments go back as {}, the model reads why in the result
	second := o.sent(2).Messages
	if a := second[2].ToolCalls[0].Function.Arguments; a != "{}" || *second[3].Content != results[0].Content {
		t.Errorf("request 2: arguments %q, result %q", a, *second[3].Content)
	}
}

func TestOpenAIKey(t *testing.T) {
	o := newOATest(t, fake.Script{Key: "sk-good", Loop: true, Steps: []fake.Step{{Text: "ok"}}}, "")
	out, done := o.turn(context.Background(), "hi")
	<-o.p.asked
	o.p.answers <- "sk-good"
	<-done
	if e := last(out.list(t)); e.Type != "done" || !o.fake.Requests()[0].Auth {
		t.Fatalf("end %+v", e)
	}
	o.keys.Forget("fake")
	out, done = o.turn(context.Background(), "again")
	<-o.p.asked
	o.p.answers <- "sk-bad"
	<-done
	if e := last(out.list(t)); e.Code != CodeAuth || !strings.Contains(e.Message, "dropped") {
		t.Errorf("a refused key: %+v", e)
	}
	if _, held := o.keys.held["fake"]; held {
		t.Error("the refused key is still held")
	}
}

func TestOpenAICancelMidStream(t *testing.T) {
	o := newOATest(t, fake.Script{Steps: []fake.Step{
		{Text: "thinking", ToolCalls: []fake.ToolCall{{Name: "overview", Arguments: "{}"}}, HangMs: 10000},
	}}, AuthNone)
	out, done := o.turn(context.Background(), "hi")
	waitFor(t, "text", func() bool { return text(out.list(t)) == "thinking" })
	start := time.Now()
	o.c.End(ErrCancelled, 2*time.Second)
	<-done
	if d := time.Since(start); d > time.Second {
		t.Errorf("cancel took %s", d)
	}
	if e := last(out.list(t)); e.Code != CodeCancelled {
		t.Errorf("end %+v", e)
	}
	waitFor(t, "the fake to see the request closed", func() bool { r := o.fake.Requests(); return len(r) == 1 && r[0].Closed })
	if m := o.c.messages; len(m) != 2 || m[1].Text != "thinking" || len(m[1].ToolCalls) != 0 {
		t.Errorf("history %+v", m)
	}
}

func TestOpenAIShow(t *testing.T) {
	o := newOATest(t, fake.Script{Steps: []fake.Step{
		{ToolCalls: []fake.ToolCall{{Name: "show", Arguments: `{"sql_id":"f6jyzt7462kx2"}`}}},
		{ToolCalls: []fake.ToolCall{{Name: "show", Arguments: `{"sql_id":"0000000000000"}`}}},
		{Text: "There."},
	}}, AuthNone)
	es := o.run("show me the select")
	want := []string{"usage", "tool_call", "intent", "tool_result", "usage", "tool_call", "tool_result", "text", "usage", "done"}
	if got := types(es); !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
	in := ofType(es, "intent")[0]
	if in.ID != ofType(es, "tool_call")[0].ID || in.Target.View != "statements" || in.Target.SQLID != "f6jyzt7462kx2" || in.Href != "mtkprof:#view=statements&sql=f6jyzt7462kx2" {
		t.Errorf("intent %+v", in)
	}
	if r := ofType(es, "tool_result")[1]; !r.IsError || !strings.Contains(r.Content, "not in this trace") {
		t.Errorf("a bad sql_id: %+v", r)
	}
}

func ofType(es []ev, typ string) []ev {
	var out []ev
	for _, e := range es {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func TestAnswerMerge(t *testing.T) {
	i0, i1 := 0, 1
	var a answer
	for _, d := range []oaToolCall{
		{Index: &i0, ID: "a", Function: oaFunction{Name: "overview", Arguments: `{"fr`}},
		{Index: &i1, ID: "b", Function: oaFunction{Name: "statements", Arguments: `{}`}},
		{Index: &i0, Function: oaFunction{Arguments: `om":1}`}},
	} {
		a.merge(d)
	}
	if len(a.calls) != 2 || a.calls[0] != (ToolCall{"a", "overview", `{"from":1}`}) || a.calls[1] != (ToolCall{"b", "statements", "{}"}) {
		t.Errorf("by index: %+v", a.calls)
	}
	var b answer // a server that sends no index
	for _, d := range []oaToolCall{
		{ID: "x", Function: oaFunction{Name: "overview", Arguments: `{`}},
		{Function: oaFunction{Arguments: `}`}},
		{ID: "y", Function: oaFunction{Name: "timeline", Arguments: `{}`}},
	} {
		b.merge(d)
	}
	if len(b.calls) != 2 || b.calls[0].Args != "{}" || b.calls[1].ID != "y" {
		t.Errorf("without index: %+v", b.calls)
	}
}
