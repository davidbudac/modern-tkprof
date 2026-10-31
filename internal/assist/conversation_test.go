package assist

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// events is a turn's stream as the client reads it.
type events struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (e *events) Write(b []byte) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.buf.Write(b)
}

type ev struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Args    json.RawMessage `json:"args"`
	IsError bool            `json:"isError"`
	Content string          `json:"content"`
	State   State           `json:"state"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Href    string          `json:"href"`
	Target  Intent          `json:"target"`
	Usage   Usage           `json:"usage"`
	Total   Usage           `json:"total"`
}

func (e *events) list(t *testing.T) []ev {
	t.Helper()
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []ev
	sc := bufio.NewScanner(bytes.NewReader(e.buf.Bytes()))
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var v ev
		if err := json.Unmarshal(sc.Bytes(), &v); err != nil {
			t.Fatalf("not an event: %q", sc.Text())
		}
		out = append(out, v)
	}
	return out
}

// types are the event types, consecutive text events counted once.
func types(es []ev) []string {
	var out []string
	for _, e := range es {
		if e.Type == "text" && len(out) > 0 && out[len(out)-1] == "text" {
			continue
		}
		out = append(out, e.Type)
	}
	return out
}

func text(es []ev) string {
	var b strings.Builder
	for _, e := range es {
		if e.Type == "text" {
			b.WriteString(e.Text)
		}
	}
	return b.String()
}

// waitFor polls until ok or fails the test after 5 s.
func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// prompter answers prompts from the test: each Ask sends its prompt on asked
// and waits for an answer (or an error) on answers.
type prompter struct {
	asked   chan remote.Prompt
	answers chan any
}

func newPrompter() *prompter {
	return &prompter{asked: make(chan remote.Prompt, 4), answers: make(chan any, 4)}
}

func (p *prompter) Ask(ctx context.Context, q remote.Prompt) (string, error) {
	p.asked <- q
	select {
	case a := <-p.answers:
		if err, ok := a.(error); ok {
			return "", err
		}
		return a.(string), nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// backendFunc is a scripted backend.
type backendFunc func(ctx context.Context, t *Turn) error

func (f backendFunc) Turn(ctx context.Context, t *Turn) error { return f(ctx, t) }

type convTest struct {
	t     *testing.T
	c     *Conversation
	keys  *Keys
	p     *prompter
	moves [][2]State
	block chan struct{} // closed: hosted tool calls run (until then they wait)
}

var testProvider = Provider{ID: "p1", Kind: "openai", BaseURL: "http://127.0.0.1:9/v1", Model: "m"}

func newConvTest(t *testing.T, p Provider, b Backend) *convTest {
	t.Helper()
	env := loadEnv(t, "basic_binds", false)
	ct := &convTest{t: t, p: newPrompter(), block: make(chan struct{})}
	close(ct.block)
	ct.keys = &Keys{Prompter: ct.p}
	trace := func(fn func(Env) error) error {
		<-ct.block
		return fn(env)
	}
	c, err := NewConversation(Config{ID: "c1", Session: "s1", Provider: p, Case: "slow batch\nsince Monday", Redact: &Redactor{Salt: "s", ModelRaw: true}},
		Host{Trace: trace, Keys: ct.keys})
	if err != nil {
		t.Fatal(err)
	}
	c.backend = b
	c.moved = func(from, to State) { ct.moves = append(ct.moves, [2]State{from, to}) }
	ct.c = c
	return ct
}

// turn runs one message and returns its events; the turn runs in the
// background until done is closed.
func (ct *convTest) turn(ctx context.Context, msg string) (out *events, done chan struct{}) {
	ct.t.Helper()
	tn, err := ct.c.Begin(ctx, UserMessage{Text: msg})
	if err != nil {
		ct.t.Fatalf("Begin: %v", err)
	}
	out, done = &events{}, make(chan struct{})
	go func() {
		defer close(done)
		tn.Run(out, func() error { return nil })
	}()
	return out, done
}

func (ct *convTest) run(msg string) []ev {
	ct.t.Helper()
	out, done := ct.turn(context.Background(), msg)
	<-done
	return out.list(ct.t)
}

func (ct *convTest) state() State { return ct.c.Info().State }

func (ct *convTest) moved() [][2]State {
	ct.c.mu.Lock()
	defer ct.c.mu.Unlock()
	return slices.Clone(ct.moves)
}

func last(es []ev) ev {
	if len(es) == 0 {
		return ev{}
	}
	return es[len(es)-1]
}

// TestConversation drives every move of the state machine and checks the
// events and the history each leaves.
func TestConversation(t *testing.T) {
	var seen [][2]State
	record := func(ct *convTest) { seen = append(seen, ct.moved()...) }

	t.Run("answered, then failed, then answered again", func(t *testing.T) {
		fail := false
		ct := newConvTest(t, testProvider, backendFunc(func(ctx context.Context, tn *Turn) error {
			if fail {
				return &TurnError{CodeProvider, "the provider is down"}
			}
			tn.Text("hel")
			tn.Text("lo")
			tn.Usage(Usage{InputTokens: 100, OutputTokens: 5})
			tn.Add(Message{Role: RoleAssistant, Text: "hello"})
			return nil
		}))
		ct.keys.held = map[string]string{"p1": "k"}
		es := ct.run("hi")
		if got := types(es); !slices.Equal(got, []string{"text", "usage", "done"}) || text(es) != "hello" {
			t.Errorf("events %v %q", got, text(es))
		}
		if d := last(es); d.Usage.InputTokens != 100 || d.Usage.Requests != 1 || d.Total.OutputTokens != 5 {
			t.Errorf("done %+v", d)
		}
		if ct.state() != StateIdle {
			t.Errorf("state %s", ct.state())
		}
		fail = true
		if e := last(ct.run("again")); e.Type != "error" || e.Code != CodeProvider || ct.state() != StateFailed {
			t.Errorf("failed turn: %+v, state %s", e, ct.state())
		}
		if in := ct.c.Info(); !strings.Contains(in.Error, "provider") || in.Turns != 2 {
			t.Errorf("info %+v", in)
		}
		fail = false
		if e := last(ct.run("once more")); e.Type != "done" || ct.state() != StateIdle || ct.c.Info().Error != "" {
			t.Errorf("after a failure: %+v, %s", e, ct.state())
		}
		var roles []string
		for _, m := range ct.c.messages {
			roles = append(roles, m.Role)
		}
		if !slices.Equal(roles, []string{"user", "assistant", "user", "user", "assistant"}) {
			t.Errorf("history %v", roles)
		}
		if ct.c.Info().Usage.Requests != 2 {
			t.Errorf("total usage %+v", ct.c.Info().Usage)
		}
		record(ct)
	})

	keyed := backendFunc(func(ctx context.Context, tn *Turn) error {
		key, err := tn.Key(ctx)
		if err != nil {
			return err
		}
		tn.Text("key " + key)
		return nil
	})

	t.Run("key asked once, held after", func(t *testing.T) {
		ct := newConvTest(t, testProvider, keyed)
		out, done := ct.turn(context.Background(), "hi")
		q := <-ct.p.asked
		if q.Kind != remote.KindAPIKey || q.Connection != "p1" || q.Echo || !strings.Contains(q.Text, "API key") {
			t.Errorf("prompt %+v", q)
		}
		waitFor(t, "waiting_key", func() bool { return ct.state() == StateWaitingKey })
		ct.p.answers <- " sk-1 "
		<-done
		es := out.list(t)
		if got := types(es); !slices.Equal(got, []string{"state", "state", "text", "done"}) || es[0].State != StateWaitingKey || es[1].State != StateRunning || text(es) != "key sk-1" {
			t.Errorf("events %+v", es)
		}
		if e := last(ct.run("again")); e.Type != "done" || len(ct.p.asked) != 0 {
			t.Errorf("second turn asked again: %+v", e)
		}
		ct.keys.Forget("p1")
		_, done = ct.turn(context.Background(), "after forget")
		<-ct.p.asked
		ct.p.answers <- "sk-2"
		<-done
		record(ct)
	})

	t.Run("key prompt cancelled by the user", func(t *testing.T) {
		ct := newConvTest(t, testProvider, keyed)
		out, done := ct.turn(context.Background(), "hi")
		<-ct.p.asked
		ct.p.answers <- errors.New("prompt cancelled")
		<-done
		if e := last(out.list(t)); e.Code != CodeNoKey || ct.state() != StateCancelled {
			t.Errorf("end %+v, state %s", e, ct.state())
		}
		_, done = ct.turn(context.Background(), "again") // a cancelled conversation takes the next message
		<-ct.p.asked
		ct.p.answers <- "sk"
		<-done
		if ct.state() != StateIdle {
			t.Errorf("state %s", ct.state())
		}
		record(ct)
	})

	t.Run("ended while waiting for the key", func(t *testing.T) {
		ct := newConvTest(t, testProvider, keyed)
		out, done := ct.turn(context.Background(), "hi")
		<-ct.p.asked
		waitFor(t, "waiting_key", func() bool { return ct.state() == StateWaitingKey })
		ct.c.End(ErrCancelled, time.Second)
		<-done
		if e := last(out.list(t)); e.Code != CodeCancelled || ct.state() != StateCancelled {
			t.Errorf("end %+v, state %s", e, ct.state())
		}
		if _, err := ct.c.Begin(context.Background(), UserMessage{Text: "x"}); err != ErrCancelled {
			t.Errorf("Begin after End: %v", err)
		}
		record(ct)
	})

	t.Run("cancelled during a tool call", func(t *testing.T) {
		ct := newConvTest(t, Provider{ID: "local", Kind: "openai", BaseURL: "http://127.0.0.1:9/v1", Model: "m", Auth: AuthNone}, backendFunc(func(ctx context.Context, tn *Turn) error {
			tn.Text("looking")
			out := tn.Tool(ctx, "c1", "overview", nil)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			tn.Add(Message{Role: RoleAssistant, ToolCalls: []ToolCall{{"c1", "overview", "{}"}}}, Message{Role: RoleTool, ToolCallID: "c1", Text: out.Content})
			return nil
		}))
		ct.block = make(chan struct{}) // the tool hangs
		defer close(ct.block)
		out, done := ct.turn(context.Background(), "hi")
		waitFor(t, "the tool call", func() bool { return slices.Contains(types(out.list(t)), "tool_call") })
		start := time.Now()
		ct.c.End(ErrCancelled, 2*time.Second)
		<-done
		if d := time.Since(start); d > time.Second {
			t.Errorf("cancel took %s", d)
		}
		es := out.list(t)
		if got := types(es); !slices.Equal(got, []string{"text", "tool_call", "error"}) || last(es).Code != CodeCancelled {
			t.Errorf("events %v %+v", got, last(es))
		}
		if tc := es[1]; tc.ID != "c1" || tc.Name != "overview" || string(tc.Args) != "{}" {
			t.Errorf("tool_call %+v", tc)
		}
		if n := len(ct.c.messages); n != 1 || ct.state() != StateCancelled {
			t.Errorf("%d messages, state %s", n, ct.state())
		}
		record(ct)
	})

	t.Run("the reader goes away", func(t *testing.T) {
		ct := newConvTest(t, testProvider, backendFunc(func(ctx context.Context, tn *Turn) error {
			<-ctx.Done()
			return ctx.Err()
		}))
		ctx, cancel := context.WithCancel(context.Background())
		out, done := ct.turn(ctx, "hi")
		if _, err := ct.c.Begin(context.Background(), UserMessage{Text: "second"}); err != ErrBusy {
			t.Errorf("a second message while running: %v", err)
		}
		cancel()
		<-done
		if e := last(out.list(t)); e.Code != CodeCancelled || ct.state() != StateCancelled {
			t.Errorf("end %+v, %s", e, ct.state())
		}
		record(ct)
	})

	t.Run("session closed", func(t *testing.T) {
		ct := newConvTest(t, testProvider, backendFunc(func(ctx context.Context, tn *Turn) error {
			<-ctx.Done()
			return ctx.Err()
		}))
		out, done := ct.turn(context.Background(), "hi")
		ct.c.End(ErrSessionClosed, time.Second)
		<-done
		if e := last(out.list(t)); e.Code != CodeSessionClosed {
			t.Errorf("end %+v", e)
		}
		record(ct)
	})

	t.Run("failed while waiting for the key", func(t *testing.T) {
		ct := newConvTest(t, testProvider, backendFunc(func(ctx context.Context, tn *Turn) error {
			tn.move(StateWaitingKey)
			panic("the prompter broke")
		}))
		if e := last(ct.run("hi")); e.Code != CodeInternal || !strings.Contains(e.Message, "the prompter broke") || ct.state() != StateFailed {
			t.Errorf("end %+v, %s", e, ct.state())
		}
		record(ct)
	})

	var all [][2]State
	for from, tos := range transitions {
		for _, to := range tos {
			all = append(all, [2]State{from, to})
		}
	}
	for _, m := range all {
		if !slices.Contains(seen, m) {
			t.Errorf("no test moves %s to %s", m[0], m[1])
		}
	}
}

// TestConversationTools: a tool call of the backend and one over HTTP (a CLI
// agent's) both run with the conversation's scope and masking, and both show
// as events of the open turn; show sends an intent only while one is open.
func TestConversationTools(t *testing.T) {
	env := loadEnv(t, "basic_binds", false)
	inTurn := make(chan *Turn, 1)
	release := make(chan struct{})
	ct := newConvTest(t, Provider{ID: "local", Kind: "openai", BaseURL: "http://127.0.0.1:9/v1", Model: "m", Auth: AuthNone}, backendFunc(func(ctx context.Context, tn *Turn) error {
		out := tn.Tool(ctx, "call_1", "executions", json.RawMessage(`{"sql_id":"f6jyzt7462kx2","limit":1}`))
		if out.IsError || !strings.Contains(out.Content, "<") {
			return fmt.Errorf("executions: %+v", out)
		}
		if out := tn.Tool(ctx, "call_2", "show", json.RawMessage(`{"sql_id":"zzzz"}`)); !out.IsError || !strings.Contains(out.Content, "not in this trace") {
			return fmt.Errorf("show of a bad sql_id: %+v", out)
		}
		if out := tn.Tool(ctx, "call_3", "statement", json.RawMessage(`{"sql_id":`)); !out.IsError || out.Content != ToolErrorText("the arguments are not JSON: send them as one JSON object") {
			return fmt.Errorf("bad JSON: %+v", out)
		}
		inTurn <- tn
		<-release
		return nil
	}))
	out, done := ct.turn(context.Background(), "hi")
	<-inTurn
	res, err := ct.c.CallTool(context.Background(), env, "show", json.RawMessage(`{"sql_id":"f6jyzt7462kx2"}`))
	if err != nil || !strings.Contains(string(res.JSON), `"href":"mtkprof:#view=statements&sql=f6jyzt7462kx2"`) {
		t.Fatalf("show over HTTP: %s %v", res.JSON, err)
	}
	close(release)
	<-done
	es := out.list(t)
	want := []string{"tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "intent", "tool_result", "done"}
	if got := types(es); !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
	in, results, calls := ofType(es, "intent")[0], ofType(es, "tool_result"), ofType(es, "tool_call")
	if in.ID != "mcp_1" || in.Target.View != "statements" || in.Target.SQLID != "f6jyzt7462kx2" || in.Href != "mtkprof:#view=statements&sql=f6jyzt7462kx2" {
		t.Errorf("intent %+v", in)
	}
	if results[0].Content == "" || results[0].IsError || results[1].Content == "" || !results[1].IsError {
		t.Errorf("tool results %+v %+v", results[0], results[1])
	}
	if string(calls[2].Args) != `"{\"sql_id\":"` {
		t.Errorf("bad JSON args as a string: %s", calls[2].Args)
	}
	// no turn open: show is a tool error
	if _, err := ct.c.CallTool(context.Background(), env, "show", json.RawMessage(`{"view":"waits"}`)); err == nil || !strings.Contains(err.Error(), "has none") {
		t.Errorf("show without a turn: %v", err)
	}
}

func TestSystemMessage(t *testing.T) {
	ct := newConvTest(t, testProvider, nil)
	sys := ct.c.system
	for _, want := range []string{"mtkprof: links", "`exec`", "`contexts`", "win=", "## This conversation", "Scope: the whole trace", "Bind values are masked",
		"No notes were supplied", "> slow batch\n> since Monday\n"} {
		if !strings.Contains(sys, want) {
			t.Errorf("system message lacks %q", want)
		}
	}
}

func TestProviderCheck(t *testing.T) {
	ok := Provider{ID: "ollama.local", Kind: "openai", BaseURL: "http://localhost:11434/v1", Model: "qwen3", Headers: map[string]string{"X-Title": "mtkprof"}, Auth: "none"}
	if err := ok.Check(); err != nil {
		t.Fatal(err)
	}
	p := testProvider
	if err := p.Check(); err != nil || p.Auth != AuthBearer {
		t.Errorf("default auth: %v %q", err, p.Auth)
	}
	for kind, auth := range map[string]string{"claude": AuthLogin, "codex": AuthLogin} {
		p := Provider{ID: "p", Kind: kind, Model: "claude-sonnet-4-5[1m]"}
		if err := p.Check(); err != nil || p.Auth != auth {
			t.Errorf("%s: %v %q", kind, err, p.Auth)
		}
	}
	for _, c := range []struct {
		mod  func(*Provider)
		want string
	}{
		{func(p *Provider) { p.ID = "a/b" }, "provider.id"},
		{func(p *Provider) { p.Kind = "gpt" }, "provider.kind"},
		{func(p *Provider) { p.BaseURL = "ftp://x" }, "baseUrl"},
		{func(p *Provider) { p.BaseURL = "https://user:pw@x/v1" }, "no user"},
		{func(p *Provider) { p.BaseURL = "https://x/v1?key=1" }, "no user, query"},
		{func(p *Provider) { p.Model = "" }, "model"},
		{func(p *Provider) { p.Auth = "basic" }, "auth"},
		{func(p *Provider) { p.Headers = map[string]string{"Authorization": "Bearer x"} }, "credential"},
		{func(p *Provider) { p.Headers = map[string]string{"x-api-key": "x"} }, "credential"},
		{func(p *Provider) { p.Headers = map[string]string{"X-Custom": "Bearer abc"} }, "credential"},
		{func(p *Provider) { p.Headers = map[string]string{"X-A": "a\nb"} }, "one line"},
		{func(p *Provider) { p.Headers = map[string]string{"bad name": "a"} }, "header name"},
		{func(p *Provider) { p.Kind, p.Auth = "claude", "" }, "takes no baseUrl"},
		{func(p *Provider) { p.Kind, p.BaseURL, p.Model, p.Auth = "claude", "", "", "bearer" }, "kind claude takes login"},
		{func(p *Provider) {
			p.Kind, p.BaseURL, p.Model, p.Auth = "codex", "", "--dangerously-bypass-approvals-and-sandbox", ""
		}, "provider.model"},
		{func(p *Provider) { p.Kind, p.BaseURL, p.Model, p.Auth = "codex", "", "", "none" }, "kind codex takes login or bearer"},
	} {
		p := ok
		p.Headers = nil
		c.mod(&p)
		if err := p.Check(); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: %v, want %q", p, err, c.want)
		}
	}
}

// TestKeysOnePrompt: two turns that need the same provider's key share one
// prompt; when the turn that asked goes away, the other asks again.
func TestKeysOnePrompt(t *testing.T) {
	p := newPrompter()
	k := &Keys{Prompter: p}
	type got struct {
		key string
		err error
	}
	get := func(ctx context.Context) chan got {
		ch := make(chan got, 1)
		go func() {
			key, err := k.Get(ctx, testProvider, nil)
			ch <- got{key, err}
		}()
		return ch
	}
	ctx1, cancel1 := context.WithCancel(context.Background())
	a := get(ctx1)
	<-p.asked
	b := get(context.Background())
	time.Sleep(10 * time.Millisecond)
	if len(p.asked) != 0 {
		t.Fatal("a second prompt for the same provider")
	}
	cancel1()
	if r := <-a; !errors.Is(r.err, context.Canceled) {
		t.Errorf("the turn that went away: %+v", r)
	}
	<-p.asked // b asks itself
	p.answers <- "sk"
	if r := <-b; r.key != "sk" || r.err != nil {
		t.Errorf("b: %+v", r)
	}
	if key, err := k.Get(context.Background(), testProvider, func() { t.Error("waits for a held key") }); key != "sk" || err != nil {
		t.Errorf("held: %q %v", key, err)
	}
}
