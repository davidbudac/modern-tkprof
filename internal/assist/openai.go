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
	"strconv"
	"strings"
	"time"
)

// openAI is the backend of an OpenAI-compatible chat completions endpoint
// (OpenAI, a proxy like LiteLLM, or a local server: Ollama, LM Studio,
// vLLM). The engine runs the agent loop: it streams the model's answer, runs
// the tool calls in process, and sends the results back until the model
// answers without calling a tool.
type openAI struct {
	p      Provider
	client *http.Client // no timeout: a request lives as long as its turn
	// A 429 or 5xx is retried maxRetries times, after backoff, then twice that
	// (Retry-After when the provider sends one, at most maxWait).
	backoff, maxWait time.Duration
	maxSteps         int // model requests per turn
	unnamed          int // tool calls that came without an id, named call_N
}

const maxRetries = 2

func newOpenAI(p Provider) Backend {
	return &openAI{p: p, client: &http.Client{}, backoff: time.Second, maxWait: 30 * time.Second, maxSteps: 25}
}

// The wire format of /chat/completions.
type (
	oaRequest struct {
		Model         string      `json:"model"`
		Messages      []oaMessage `json:"messages"`
		Tools         []oaTool    `json:"tools"`
		Stream        bool        `json:"stream"`
		StreamOptions struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
	}
	oaMessage struct {
		Role       string       `json:"role"`
		Content    *string      `json:"content"` // null: an assistant message with tool calls only
		ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
		ToolCallID string       `json:"tool_call_id,omitempty"`
	}
	oaToolCall struct {
		Index    *int       `json:"index,omitempty"`
		ID       string     `json:"id,omitempty"`
		Type     string     `json:"type,omitempty"`
		Function oaFunction `json:"function"`
	}
	oaFunction struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments"`
	}
	oaTool struct {
		Type     string `json:"type"`
		Function struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Parameters  json.RawMessage `json:"parameters"`
		} `json:"function"`
	}
	// oaChunk is a streamed chunk, or a whole answer (message) from a server
	// that does not stream.
	oaChunk struct {
		Choices []struct {
			Delta   oaDelta  `json:"delta"`
			Message *oaDelta `json:"message"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens        int64 `json:"prompt_tokens"`
			CompletionTokens    int64 `json:"completion_tokens"`
			PromptTokensDetails *struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
		Error json.RawMessage `json:"error"`
	}
	oaDelta struct {
		Content   string       `json:"content"`
		ToolCalls []oaToolCall `json:"tool_calls"`
	}
)

func oaTools() []oaTool {
	out := make([]oaTool, len(Tools))
	for i, t := range Tools {
		out[i].Type = "function"
		out[i].Function.Name, out[i].Function.Description, out[i].Function.Parameters = t.Name, t.Description, t.Schema
	}
	return out
}

// oaMessages is the history in the wire format, the system message first.
func oaMessages(system string, msgs []Message) []oaMessage {
	out := []oaMessage{{Role: "system", Content: &system}}
	for i := range msgs {
		m := &msgs[i]
		om := oaMessage{Role: m.Role, ToolCallID: m.ToolCallID}
		if m.Text != "" || len(m.ToolCalls) == 0 {
			om.Content = &m.Text
		}
		for _, tc := range m.ToolCalls {
			args := tc.Args
			if !json.Valid([]byte(args)) { // the call failed and said so; servers that parse the history must not choke on it
				args = "{}"
			}
			om.ToolCalls = append(om.ToolCalls, oaToolCall{ID: tc.ID, Type: "function", Function: oaFunction{Name: tc.Name, Arguments: args}})
		}
		out = append(out, om)
	}
	return out
}

func (o *openAI) Turn(ctx context.Context, t *Turn) error {
	key, err := t.Key(ctx)
	if err != nil {
		return err
	}
	tools := oaTools()
	for step := 0; step < o.maxSteps; step++ {
		req := oaRequest{Model: o.p.Model, Messages: oaMessages(t.System(), t.Messages()), Tools: tools, Stream: true}
		req.StreamOptions.IncludeUsage = true
		body, err := json.Marshal(req)
		if err != nil {
			return err
		}
		resp, err := o.post(ctx, t, key, body)
		if err != nil {
			return err
		}
		a, err := o.read(t, resp)
		resp.Body.Close()
		if a.usage != nil {
			t.Usage(*a.usage)
		}
		text := a.text.String()
		if err != nil {
			if text != "" { // what the DBA saw stays in the history
				t.Add(Message{Role: RoleAssistant, Text: text})
			}
			return err
		}
		if len(a.calls) == 0 {
			t.Add(Message{Role: RoleAssistant, Text: text})
			return nil
		}
		for i := range a.calls {
			if a.calls[i].ID == "" {
				o.unnamed++
				a.calls[i].ID = "call_" + strconv.Itoa(o.unnamed)
			}
		}
		group := []Message{{Role: RoleAssistant, Text: text, ToolCalls: a.calls}}
		for _, call := range a.calls {
			out := t.Tool(ctx, call.ID, call.Name, json.RawMessage(call.Args))
			if ctx.Err() != nil { // the calls are not all answered: keep only the text
				if text != "" {
					t.Add(Message{Role: RoleAssistant, Text: text})
				}
				return ctx.Err()
			}
			group = append(group, Message{Role: RoleTool, ToolCallID: call.ID, Text: out.Content})
		}
		t.Add(group...)
	}
	return &TurnError{CodeTooManySteps, fmt.Sprintf("the model made %d requests in a row without answering", o.maxSteps)}
}

// post sends one request; 429 and 5xx are retried.
func (o *openAI) post(ctx context.Context, t *Turn, key string, body []byte) (*http.Response, error) {
	endpoint := strings.TrimRight(o.p.BaseURL, "/") + "/chat/completions"
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, &TurnError{CodeProvider, err.Error()}
		}
		h := req.Header
		for k, v := range o.p.Headers {
			h.Set(k, v)
		}
		h.Set("Content-Type", "application/json")
		h.Set("Accept", "text/event-stream")
		if key != "" {
			h.Set("Authorization", "Bearer "+key)
		}
		resp, err := o.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, &TurnError{CodeProvider, fmt.Sprintf("%s could not be reached: %v", o.p.label(), err)}
		}
		if resp.StatusCode == http.StatusOK {
			return resp, nil
		}
		msg := providerMessage(resp)
		code := resp.StatusCode
		if (code == http.StatusTooManyRequests || code >= 500) && attempt < maxRetries {
			wait := o.retryWait(attempt, resp.Header.Get("Retry-After"))
			t.Logf("%s answered HTTP %d (%s): retry %d of %d in %s", o.p.label(), code, msg, attempt+1, maxRetries, wait)
			select {
			case <-time.After(wait):
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if code == http.StatusUnauthorized || code == http.StatusForbidden {
			if o.p.needsKey() {
				t.ForgetKey()
				return nil, &TurnError{CodeAuth, fmt.Sprintf("%s refused the key (HTTP %d: %s); it was dropped, the next message asks for it", o.p.label(), code, msg)}
			}
			return nil, &TurnError{CodeAuth, fmt.Sprintf("%s refused the request (HTTP %d: %s); does it need a key?", o.p.label(), code, msg)}
		}
		return nil, &TurnError{CodeProvider, fmt.Sprintf("%s answered HTTP %d: %s", o.p.label(), code, msg)}
	}
}

// retryWait is the wait before retry attempt+1.
func (o *openAI) retryWait(attempt int, retryAfter string) time.Duration {
	wait := o.backoff << attempt
	if s, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && s >= 0 {
		wait = time.Duration(s) * time.Second
	} else if at, err := http.ParseTime(retryAfter); err == nil {
		wait = max(time.Until(at), 0)
	}
	return min(wait, o.maxWait)
}

// providerMessage is the message of an error answer: the "error" of an
// OpenAI envelope, else the start of the body.
func providerMessage(resp *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if m := errorMessage(b); m != "" {
		return m
	}
	if t := strings.Join(strings.Fields(string(b)), " "); t != "" {
		return preview(t, 300)
	}
	return http.StatusText(resp.StatusCode)
}

// errorMessage reads {"error": {"message": ...}}, {"error": "..."} or
// {"message": ...}.
func errorMessage(b []byte) string {
	var env struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(b, &env) != nil {
		return ""
	}
	return preview(firstNonEmpty(errorText(env.Error), env.Message), 300)
}

func errorText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var e struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Message != "" {
		return e.Message
	}
	return string(raw)
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

// answer is what one model request returned.
type answer struct {
	text  strings.Builder
	calls []ToolCall
	index []int // the wire index of each call
	usage *Usage
}

// merge adds a piece of a streamed tool call: a new call, or more of the
// arguments of one under way (by index; by id for a server that sends none).
func (a *answer) merge(d oaToolCall) {
	i := -1
	switch {
	case d.Index != nil:
		for j, x := range a.index {
			if x == *d.Index {
				i = j
			}
		}
	case len(a.calls) > 0 && (d.ID == "" || d.ID == a.calls[len(a.calls)-1].ID):
		i = len(a.calls) - 1
	}
	if i < 0 {
		idx := len(a.calls)
		if d.Index != nil {
			idx = *d.Index
		}
		a.calls = append(a.calls, ToolCall{ID: d.ID, Name: d.Function.Name, Args: d.Function.Arguments})
		a.index = append(a.index, idx)
		return
	}
	c := &a.calls[i]
	if c.ID == "" {
		c.ID = d.ID
	}
	if c.Name == "" {
		c.Name = d.Function.Name
	}
	c.Args += d.Function.Arguments
}

func (a *answer) apply(t *Turn, ch *oaChunk) {
	for _, c := range ch.Choices {
		d := c.Delta
		if c.Message != nil {
			d = *c.Message
		}
		if d.Content != "" {
			a.text.WriteString(d.Content)
			t.Text(d.Content)
		}
		for _, tc := range d.ToolCalls {
			a.merge(tc)
		}
	}
	if u := ch.Usage; u != nil { // some servers repeat it, growing: the last one counts
		a.usage = &Usage{InputTokens: u.PromptTokens, OutputTokens: u.CompletionTokens}
		if u.PromptTokensDetails != nil {
			a.usage.CachedInputTokens = u.PromptTokensDetails.CachedTokens
		}
	}
}

// maxStreamLine bounds one line of the event stream.
const maxStreamLine = 16 << 20

// read reads the answer: server-sent events of chunks, or one JSON answer
// from a server that does not stream.
func (o *openAI) read(t *Turn, resp *http.Response) (a *answer, err error) {
	a = &answer{}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		var ch oaChunk
		if err := json.NewDecoder(io.LimitReader(resp.Body, maxStreamLine)).Decode(&ch); err != nil {
			return a, &TurnError{CodeProvider, fmt.Sprintf("%s sent an answer that is not JSON: %v", o.p.label(), err)}
		}
		if m := errorText(ch.Error); m != "" {
			return a, &TurnError{CodeProvider, fmt.Sprintf("%s: %s", o.p.label(), m)}
		}
		a.apply(t, &ch)
		return a, nil
	}
	br := bufio.NewReaderSize(resp.Body, 64<<10)
	for {
		line, rerr := readLine(br)
		if data, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:")); ok {
			data = bytes.TrimSpace(data)
			if string(data) == "[DONE]" {
				return a, nil
			}
			var ch oaChunk
			if err := json.Unmarshal(data, &ch); err != nil {
				return a, &TurnError{CodeProvider, fmt.Sprintf("%s sent a stream event that is not JSON: %s", o.p.label(), preview(string(data), 200))}
			}
			if m := errorText(ch.Error); m != "" {
				return a, &TurnError{CodeProvider, fmt.Sprintf("%s: %s", o.p.label(), m)}
			}
			a.apply(t, &ch)
		}
		switch {
		case rerr == io.EOF:
			return a, nil
		case rerr != nil:
			return a, &TurnError{CodeProvider, fmt.Sprintf("the stream of %s broke off: %v", o.p.label(), rerr)}
		}
	}
}

// readLine reads one line, at most maxStreamLine bytes.
func readLine(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		frag, err := br.ReadSlice('\n')
		line = append(line, frag...)
		if !errors.Is(err, bufio.ErrBufferFull) {
			return line, err
		}
		if len(line) > maxStreamLine {
			return line, fmt.Errorf("a line of more than %d bytes", maxStreamLine)
		}
	}
}
