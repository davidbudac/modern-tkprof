package assist

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/report"
)

// The instructions every conversation starts with: what the agent is, how it
// works with the tools and how it cites evidence (mtkprof: links).
//
//go:embed system_prompt.md
var systemPrompt string

// State is where a conversation is. One turn is open at a time: it starts
// running and ends idle (answered), cancelled or failed.
type State string

const (
	StateIdle       State = "idle"
	StateRunning    State = "running"
	StateWaitingKey State = "waiting_key" // the open turn waits for the provider's API key prompt
	StateCancelled  State = "cancelled"
	StateFailed     State = "failed"
)

// transitions are the moves of the state machine. A cancelled or failed
// conversation takes the next message like an idle one.
var transitions = map[State][]State{
	StateIdle:       {StateRunning},
	StateRunning:    {StateWaitingKey, StateIdle, StateCancelled, StateFailed},
	StateWaitingKey: {StateRunning, StateCancelled, StateFailed},
	StateCancelled:  {StateRunning},
	StateFailed:     {StateRunning},
}

// The codes of a turn's error event.
const (
	CodeCancelled     = "cancelled"      // DELETE of the conversation, or the reader of the turn went away
	CodeSessionClosed = "session_closed" // the trace's session was closed, or the engine stopped
	CodeNoKey         = "no_key"         // the API key prompt was cancelled
	CodeAuth          = "auth"           // the provider refused the key (it is dropped; the next turn asks again)
	CodeProvider      = "provider"       // the provider answered an error or could not be reached
	CodeTooManySteps  = "too_many_steps" // the model kept calling tools without answering
	CodeInternal      = "internal"
)

// TurnError is how a turn ended without an answer: the code and message of
// its error event.
type TurnError struct{ Code, Message string }

func (e *TurnError) Error() string { return e.Code + ": " + e.Message }

var (
	ErrCancelled     = &TurnError{CodeCancelled, "the turn was cancelled"}
	ErrSessionClosed = &TurnError{CodeSessionClosed, "the session was closed"}
	// ErrBusy: a message while a turn is open (the engine answers 409).
	ErrBusy = errors.New("a turn is open: wait for its end or cancel it")
)

// endState is the state a turn that ended with e leaves.
func endState(e *TurnError) State {
	switch e.Code {
	case CodeCancelled, CodeSessionClosed, CodeNoKey:
		return StateCancelled
	}
	return StateFailed
}

// Message roles.
const (
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
)

// Message is one message of a conversation's history, in no backend's format.
type Message struct {
	Role       string
	Text       string
	ToolCalls  []ToolCall // assistant: the calls it made
	ToolCallID string     // tool: the call it answers
}

// ToolCall is a tool call of the model, its arguments as sent.
type ToolCall struct {
	ID, Name, Args string
}

// Usage counts the tokens of model requests.
type Usage struct {
	InputTokens       int64 `json:"inputTokens"`
	OutputTokens      int64 `json:"outputTokens"`
	CachedInputTokens int64 `json:"cachedInputTokens"`
	Requests          int   `json:"requests"`
}

func (u *Usage) add(v Usage) {
	u.InputTokens += v.InputTokens
	u.OutputTokens += v.OutputTokens
	u.CachedInputTokens += v.CachedInputTokens
	u.Requests += v.Requests
}

// Backend runs the turns of one conversation with a model; Backends makes
// one per conversation. Turn answers the turn's message: it streams the
// answer with t.Text, counts tokens with t.Usage, runs the model's tool calls
// with t.Tool, records the history with t.Add, and returns once the model has
// answered (nil) or the turn cannot go on. A backend that holds something
// (a process) also implements io.Closer; Close runs when the conversation
// ends.
type Backend interface {
	Turn(ctx context.Context, t *Turn) error
}

// Host is what a conversation gets from the engine.
type Host struct {
	// Trace runs fn on the current trace of the conversation's session (an
	// Env with Model, Source and API set); ErrSessionClosed once it is gone.
	Trace func(fn func(Env) error) error
	Keys  *Keys
	Logf  func(format string, a ...any) // nil: discarded
	// Engine (host:port) and Token are where a CLI agent's `mtkprof mcp`
	// calls the tools of the conversation.
	Engine, Token string
}

// Config is a new conversation.
type Config struct {
	ID       string
	Session  string
	Provider Provider
	Case     string        // the DBA's description of the problem
	Notes    []report.Note // nil: not supplied
	View     *View         // nil: not supplied
	Scope    Scope
	Redact   *Redactor // nil: bind values as traced
	Files    []string  // the names of the trace's files
}

// Conversation is one chat about one session's trace with one provider.
type Conversation struct {
	id, session string
	provider    Provider
	created     time.Time
	host        Host
	backend     Backend
	redact      *Redactor
	system      string

	mu       sync.Mutex
	state    State
	scope    Scope
	notes    []report.Note
	view     *View
	messages []Message
	usage    Usage
	turns    int
	lastErr  *TurnError
	turn     *Turn      // the open turn
	ended    *TurnError // set once the conversation is over
	calls    int        // tool calls that came without an id (a CLI agent's)

	moved func(from, to State) // tests: every move, under mu
}

// NewConversation makes an idle conversation.
func NewConversation(cfg Config, h Host) (*Conversation, error) {
	if err := cfg.Provider.Check(); err != nil {
		return nil, err
	}
	b, err := Backends[cfg.Provider.Kind].New(cfg.Provider)
	if err != nil {
		return nil, err
	}
	c := &Conversation{id: cfg.ID, session: cfg.Session, provider: cfg.Provider, created: time.Now(), host: h,
		backend: b, redact: cfg.Redact, system: systemMessage(cfg),
		state: StateIdle, scope: cfg.Scope, notes: cfg.Notes, view: cfg.View}
	return c, nil
}

// systemMessage is the system prompt and what this conversation is about.
func systemMessage(cfg Config) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(systemPrompt))
	b.WriteString("\n\n## This conversation\n\n")
	if len(cfg.Files) > 0 {
		fmt.Fprintf(&b, "- Trace files: %s.\n", strings.Join(cfg.Files, ", "))
	}
	sc := cfg.Scope
	switch {
	case sc.From == 0 && sc.To == 0:
		b.WriteString("- Scope: the whole trace")
	case sc.To == 0:
		fmt.Fprintf(&b, "- Scope: from tim %d to the end", sc.From)
	default:
		fmt.Fprintf(&b, "- Scope: tim %d to %d", sc.From, sc.To)
	}
	if len(sc.Contexts) > 0 {
		fmt.Fprintf(&b, ", session contexts %v", sc.Contexts)
	}
	b.WriteString(". The tools look there unless you pass from, to or contexts.\n")
	if cfg.Redact != nil {
		b.WriteString("- Bind values are masked.\n")
	} else {
		b.WriteString("- Bind values are shown as traced.\n")
	}
	if cfg.Notes == nil {
		b.WriteString("- No notes were supplied.\n")
	} else {
		fmt.Fprintf(&b, "- The DBA has %d notes on this trace (the notes tool).\n", len(cfg.Notes))
	}
	if t := strings.TrimSpace(cfg.Case); t != "" {
		b.WriteString("\nThe DBA describes the case:\n\n")
		for _, l := range strings.Split(t, "\n") {
			b.WriteString(strings.TrimRight("> "+l, " ") + "\n")
		}
	} else {
		b.WriteString("- The DBA gave no case description.\n")
	}
	return b.String()
}

func (c *Conversation) ID() string      { return c.id }
func (c *Conversation) Session() string { return c.session }

// moveLocked changes the state; a move the machine does not have is a bug.
func (c *Conversation) moveLocked(to State) {
	if !slices.Contains(transitions[c.state], to) {
		panic(fmt.Sprintf("conversation %s: no move from %s to %s", c.id, c.state, to))
	}
	if c.moved != nil {
		c.moved(c.state, to)
	}
	c.state = to
}

// ConversationInfo is a conversation as the engine reports it.
type ConversationInfo struct {
	ID       string   `json:"id"`
	Session  string   `json:"session"`
	State    State    `json:"state"`
	Provider Provider `json:"provider"`
	Scope    Scope    `json:"scope"`
	Binds    string   `json:"binds"` // mask or keep
	Turns    int      `json:"turns"`
	Messages int      `json:"messages"`
	Usage    Usage    `json:"usage"`
	Created  string   `json:"created"`         // RFC 3339
	Error    string   `json:"error,omitempty"` // how the last turn failed, "code: message"
}

// Info is a snapshot of the conversation.
func (c *Conversation) Info() ConversationInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	in := ConversationInfo{ID: c.id, Session: c.session, State: c.state, Provider: c.provider, Scope: c.scope, Binds: "keep",
		Turns: c.turns, Messages: len(c.messages), Usage: c.usage, Created: c.created.UTC().Format(time.RFC3339)}
	if c.redact != nil {
		in.Binds = "mask"
	}
	if in.Scope.Contexts == nil {
		in.Scope.Contexts = []int{}
	}
	if c.lastErr != nil {
		in.Error = c.lastErr.Error()
	}
	return in
}

// UserMessage is what the DBA sends, with what changed in the app since the
// last one (nil: unchanged).
type UserMessage struct {
	Text  string
	View  *View
	Notes []report.Note
}

// Begin opens a turn for m: ErrBusy while one is open, the reason once the
// conversation has ended. The turn's context is ctx's (the request), which
// End cancels too. Run runs it.
func (c *Conversation) Begin(ctx context.Context, m UserMessage) (*Turn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ended != nil {
		return nil, c.ended
	}
	if c.turn != nil {
		return nil, ErrBusy
	}
	if m.View != nil {
		c.view = m.View
	}
	if m.Notes != nil {
		c.notes = m.Notes
	}
	c.moveLocked(StateRunning)
	t := &Turn{c: c, message: m.Text, out: newStream(), done: make(chan struct{})}
	t.ctx, t.cancel = context.WithCancelCause(ctx)
	c.turn = t
	c.turns++
	c.messages = append(c.messages, Message{Role: RoleUser, Text: m.Text})
	return t, nil
}

// End ends the conversation: no turn opens again, and the open turn is
// cancelled with why (its stream ends with that error). It returns once the
// open turn has ended, or after wait.
func (c *Conversation) End(why *TurnError, wait time.Duration) {
	c.mu.Lock()
	if c.ended == nil {
		c.ended = why
	}
	t := c.turn
	c.mu.Unlock()
	if t != nil {
		t.cancel(why)
		select {
		case <-t.done:
		case <-time.After(wait):
		}
	}
	if cl, ok := c.backend.(io.Closer); ok {
		cl.Close()
	}
}

// CallTool runs a tool call that arrived over HTTP (a CLI agent's, through
// `mtkprof mcp`) on base, the session's trace the request holds: with the
// conversation's scope, masking, notes and view, and with its tool_call and
// tool_result events on the open turn, if one is.
func (c *Conversation) CallTool(ctx context.Context, base Env, name string, args json.RawMessage) (Result, error) {
	c.mu.Lock()
	t := c.turn
	c.calls++
	id := fmt.Sprintf("mcp_%d", c.calls)
	c.mu.Unlock()
	return c.call(ctx, t, &base, id, name, args)
}

// env is base with the conversation's part: scope, masking, notes, view, and
// the show hook of turn t (nil: no turn is open).
func (c *Conversation) env(base Env, t *Turn, id string) Env {
	c.mu.Lock()
	defer c.mu.Unlock()
	base.Scope, base.Redact, base.Notes, base.View, base.Conversation = c.scope, c.redact, c.notes, c.view, c.id
	base.Show = nil
	if t != nil {
		base.Show = func(target Intent, href string) error { return t.intent(id, target, href) }
	}
	return base
}

// call runs tool name for turn t (nil: none is open), on base, or (base nil)
// on the session's current trace through the host. With a turn, the call and
// what goes back to the model are events.
func (c *Conversation) call(ctx context.Context, t *Turn, base *Env, id, name string, args json.RawMessage) (Result, error) {
	if a := bytes.TrimSpace(args); len(a) == 0 || string(a) == "null" {
		args = json.RawMessage("{}")
	}
	if t != nil {
		t.out.event(ToolCallEvent{Type: "tool_call", ID: id, Name: name, Args: argsValue(args)})
	}
	var res Result
	var err error
	switch {
	case !json.Valid(args):
		err = argErrorf("the arguments are not JSON: send them as one JSON object")
	case base != nil:
		res, err = Call(ctx, c.env(*base, t, id), name, args)
	default:
		res, err = c.callHosted(ctx, t, id, name, args)
	}
	if t != nil && ctx.Err() == nil {
		out := toolOutput(res, err)
		t.out.event(ToolResultEvent{Type: "tool_result", ID: id, Name: name, IsError: out.IsError, Content: out.Content, EstTokens: len(out.Content) / 4})
	}
	return res, err
}

// callHosted runs a tool on the session's trace, and returns when ctx ends
// even if the tool has not (it finishes on its own).
func (c *Conversation) callHosted(ctx context.Context, t *Turn, id, name string, args json.RawMessage) (Result, error) {
	type answer struct {
		res Result
		err error
	}
	ch := make(chan answer, 1)
	go func() {
		var a answer
		defer func() {
			if r := recover(); r != nil { // a tool that panics fails this call, not the engine
				a = answer{err: fmt.Errorf("the tool %s failed: %v", name, r)}
			}
			ch <- a
		}()
		if err := c.host.Trace(func(b Env) error {
			a.res, a.err = Call(ctx, c.env(b, t, id), name, args)
			return nil
		}); err != nil {
			a.err = err
		}
	}()
	select {
	case a := <-ch:
		return a.res, a.err
	case <-ctx.Done():
		return Result{}, context.Cause(ctx)
	}
}

// argsValue is the args of a tool_call event: the JSON as sent, or a string
// holding what was sent when it is not JSON.
func argsValue(args json.RawMessage) json.RawMessage {
	if json.Valid(args) {
		return args
	}
	b, _ := json.Marshal(string(args))
	return b
}

// ToolOutput is what goes back to the model for a tool call.
type ToolOutput struct {
	Content string
	IsError bool
}

// ToolErrorText is the text the model gets for a tool call that failed.
func ToolErrorText(msg string) string { return "error: " + msg }

func toolOutput(res Result, err error) ToolOutput {
	var ae *ArgError
	switch {
	case err == nil:
		return ToolOutput{Content: string(res.JSON)}
	case errors.As(err, &ae):
		return ToolOutput{Content: ToolErrorText(ae.Msg), IsError: true}
	}
	return ToolOutput{Content: ToolErrorText("internal: " + err.Error()), IsError: true}
}

// Turn is the open turn of a conversation: one message of the DBA and the
// model's answer to it. The methods other than Run are for the backend.
type Turn struct {
	c       *Conversation
	message string
	ctx     context.Context
	cancel  context.CancelCauseFunc
	out     *stream
	done    chan struct{}
	usage   Usage // the backend's goroutine only, until Run reads it
}

// Run runs the turn to its end, writing its events to w (flush after each
// line), and leaves the conversation idle, cancelled or failed.
func (t *Turn) Run(w io.Writer, flush func() error) {
	defer close(t.done)
	t.out.attach(w, flush)
	te := t.outcome(t.runBackend())
	c := t.c
	c.mu.Lock()
	defer c.mu.Unlock()
	c.usage.add(t.usage)
	if te == nil {
		c.moveLocked(StateIdle)
		c.lastErr = nil
		t.out.close(DoneEvent{Type: "done", Usage: t.usage, Total: c.usage})
	} else {
		c.moveLocked(endState(te))
		c.lastErr = te
		t.out.close(ErrorEvent{Type: "error", Code: te.Code, Message: te.Message})
		c.logf("turn %d ended: %s", c.turns, te)
	}
	c.turn = nil
	t.cancel(nil)
}

func (t *Turn) runBackend() (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("the %s backend failed: %v", t.c.provider.Kind, r)
		}
	}()
	return t.c.backend.Turn(t.ctx, t)
}

// outcome is how a turn ended: nil (answered) or its error.
func (t *Turn) outcome(err error) *TurnError {
	var te *TurnError
	if t.ctx.Err() != nil {
		if errors.As(context.Cause(t.ctx), &te) {
			return te
		}
		return &TurnError{CodeCancelled, "the reader of the turn went away"}
	}
	switch {
	case err == nil:
		return nil
	case errors.As(err, &te):
		return te
	}
	return &TurnError{CodeInternal, err.Error()}
}

func (c *Conversation) logf(format string, a ...any) {
	if c.host.Logf != nil {
		c.host.Logf("conversation %s: "+format, append([]any{c.id}, a...)...)
	}
}

// Message is the DBA's text this turn answers.
func (t *Turn) Message() string { return t.message }

// Provider is the conversation's provider.
func (t *Turn) Provider() Provider { return t.c.provider }

// System is the system message: the instructions and what the conversation
// is about.
func (t *Turn) System() string { return t.c.system }

// Messages is the history, this turn's message and what it added so far last.
func (t *Turn) Messages() []Message {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	return slices.Clone(t.c.messages)
}

// Add appends to the history. A backend adds an assistant message with tool
// calls together with the answers to all of them, so the history stays one a
// model accepts whatever ends the turn.
func (t *Turn) Add(m ...Message) {
	t.c.mu.Lock()
	t.c.messages = append(t.c.messages, m...)
	t.c.mu.Unlock()
}

// Text streams a piece of the answer.
func (t *Turn) Text(piece string) { t.out.Text(piece) }

// Usage counts the tokens of u.Requests model requests (0: one).
func (t *Turn) Usage(u Usage) {
	u.Requests = max(u.Requests, 1)
	t.usage.add(u)
	t.out.event(UsageEvent{Type: "usage", InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CachedInputTokens: u.CachedInputTokens})
}

// mcpEnv is the environment of the `mtkprof mcp` that serves this
// conversation's tools to a CLI agent.
func (t *Turn) mcpEnv() map[string]string {
	c := t.c
	return map[string]string{EnvEngine: c.host.Engine, EnvToken: c.host.Token, EnvSession: c.session, EnvConversation: c.id}
}

// Logf writes to the engine's log.
func (t *Turn) Logf(format string, a ...any) { t.c.logf(format, a...) }

// Key is the provider's API key, asked for when none is held ("" for a
// provider with auth none). While the prompt is open the conversation is
// waiting_key.
func (t *Turn) Key(ctx context.Context) (string, error) {
	p := t.c.provider
	if !p.needsKey() {
		return "", nil
	}
	waited := false
	key, err := t.c.host.Keys.Get(ctx, p, func() {
		waited = true
		t.move(StateWaitingKey)
	})
	if err == nil && waited {
		t.move(StateRunning)
	}
	return key, err
}

// ForgetKey drops the provider's key (the provider refused it).
func (t *Turn) ForgetKey() { t.c.host.Keys.Forget(t.c.provider.ID) }

func (t *Turn) move(s State) {
	c := t.c
	c.mu.Lock()
	c.moveLocked(s)
	c.mu.Unlock()
	ev := StateEvent{Type: "state", State: s}
	if s == StateWaitingKey {
		ev.Provider = c.provider.ID
	}
	t.out.event(ev)
}

// Tool runs a tool call of the model in process and returns what goes back
// to it, the same text as the tool_result event.
func (t *Turn) Tool(ctx context.Context, id, name string, args json.RawMessage) ToolOutput {
	res, err := t.c.call(ctx, t, nil, id, name, args)
	return toolOutput(res, err)
}

// intent sends a show target on the turn, while it is open.
func (t *Turn) intent(id string, target Intent, href string) error {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	if t.c.turn != t {
		return errors.New("the turn has ended: there is no view to move")
	}
	t.out.event(IntentEvent{Type: "intent", ID: id, Target: target, Href: href})
	return nil
}
