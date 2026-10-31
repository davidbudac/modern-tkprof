// Package fake has scripted stand-ins for the model backends of the
// assistant, for tests and for driving the app without a real model.
//
// OpenAI is an OpenAI-compatible chat completions server that answers each
// request with the next step of a script: a streamed text, tool calls, or an
// HTTP error. It records every request it gets.
package fake

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Script is what the fake answers, one step per request in order.
type Script struct {
	// Key, when set, is the only API key accepted (Authorization: Bearer
	// <key>); any other request is a 401.
	Key string `json:"key,omitempty"`
	// Loop starts the steps again after the last; otherwise a request past
	// the end is a 500 saying so.
	Loop  bool   `json:"loop,omitempty"`
	Steps []Step `json:"steps"`
}

// Step is the answer to one request.
type Step struct {
	// Status other than 0 and 200 answers that HTTP status with an OpenAI
	// error envelope (Error is its message) and a Retry-After header when set.
	Status     int    `json:"status,omitempty"`
	RetryAfter string `json:"retryAfter,omitempty"`
	Error      string `json:"error,omitempty"`

	DelayMs int `json:"delayMs,omitempty"` // before the answer starts
	// Text is streamed in Deltas pieces (default: one per word), DeltaDelayMs
	// apart.
	Text         string `json:"text,omitempty"`
	Deltas       int    `json:"deltas,omitempty"`
	DeltaDelayMs int    `json:"deltaDelayMs,omitempty"`
	// ToolCalls follow the text; each one's arguments are streamed in two
	// halves, as OpenAI does. HangMs keeps the stream open after them.
	ToolCalls []ToolCall `json:"toolCalls,omitempty"`
	HangMs    int        `json:"hangMs,omitempty"`
	// Usage is the usage chunk at the end (default: bytes over 4 of the
	// request and of the answer).
	Usage *Usage `json:"usage,omitempty"`
}

// ToolCall is a tool call the fake makes. Arguments are sent as they are,
// so a script can send malformed ones.
type ToolCall struct {
	ID        string `json:"id,omitempty"` // default call_<request>_<i>
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Usage is the usage of an answer.
type Usage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
}

// Request is a request the fake got.
type Request struct {
	N      int             `json:"n"` // 1-based
	Path   string          `json:"path"`
	Auth   bool            `json:"auth"` // it carried an Authorization header (the key itself is not kept)
	Body   json.RawMessage `json:"body"`
	Status int             `json:"status"`
	// Closed: the client went away before the answer ended.
	Closed bool `json:"closed"`
}

// Load reads a script file.
func Load(path string) (Script, error) {
	var s Script
	b, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(b, &s)
	return s, err
}

// OpenAI serves POST .../chat/completions from a script, and GET
// /fake/requests (the requests so far, as JSON).
type OpenAI struct {
	Script Script
	Log    io.Writer // nil: no log

	mu   sync.Mutex
	next int
	reqs []Request
}

func (f *OpenAI) logf(format string, a ...any) {
	if f.Log != nil {
		fmt.Fprintf(f.Log, "fake openai: "+format+"\n", a...)
	}
}

// Requests are the requests so far.
func (f *OpenAI) Requests() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.reqs...)
}

func (f *OpenAI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/fake/requests":
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(f.Requests())
		return
	case r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/chat/completions"):
		http.Error(w, `{"error":{"message":"the fake answers POST .../chat/completions only"}}`, http.StatusNotFound)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	f.mu.Lock()
	n := len(f.reqs) + 1
	rec := Request{N: n, Path: r.URL.Path, Auth: r.Header.Get("Authorization") != "", Body: json.RawMessage(body)}
	if !json.Valid(body) {
		rec.Body, _ = json.Marshal(string(body))
	}
	var step *Step
	if f.next < len(f.Script.Steps) {
		step = &f.Script.Steps[f.next]
		f.next++
		if f.Script.Loop && f.next == len(f.Script.Steps) {
			f.next = 0
		}
	}
	f.reqs = append(f.reqs, rec)
	f.mu.Unlock()

	status := f.answer(w, r, n, step, body)
	closed := r.Context().Err() != nil
	f.mu.Lock()
	f.reqs[n-1].Status, f.reqs[n-1].Closed = status, closed
	f.mu.Unlock()
	if closed {
		f.logf("request %d: closed by the client", n)
	} else {
		f.logf("request %d: %d", n, status)
	}
}

func errorBody(msg string) string {
	b, _ := json.Marshal(map[string]any{"error": map[string]string{"message": msg, "type": "fake"}})
	return string(b)
}

// answer writes the answer of request n and returns its status.
func (f *OpenAI) answer(w http.ResponseWriter, r *http.Request, n int, step *Step, body []byte) int {
	fail := func(code int, msg string) int {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		io.WriteString(w, errorBody(msg))
		return code
	}
	if f.Script.Key != "" && r.Header.Get("Authorization") != "Bearer "+f.Script.Key {
		return fail(http.StatusUnauthorized, "fake: wrong or no API key")
	}
	if step == nil {
		return fail(http.StatusInternalServerError, fmt.Sprintf("fake: the script has no step for request %d", n))
	}
	if !wait(r, step.DelayMs) {
		return 0
	}
	if step.Status != 0 && step.Status != http.StatusOK {
		if step.RetryAfter != "" {
			w.Header().Set("Retry-After", step.RetryAfter)
		}
		return fail(step.Status, firstNonEmpty(step.Error, fmt.Sprintf("fake: HTTP %d", step.Status)))
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	id := fmt.Sprintf("chatcmpl-fake-%d", n)
	send := func(v any) bool {
		b, _ := json.Marshal(v)
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return r.Context().Err() == nil
	}
	chunk := func(delta map[string]any, finish any) map[string]any {
		return map[string]any{"id": id, "object": "chat.completion.chunk", "model": "fake",
			"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": finish}}}
	}
	if !send(chunk(map[string]any{"role": "assistant", "content": ""}, nil)) {
		return http.StatusOK
	}
	out := 0
	for i, piece := range pieces(step.Text, step.Deltas) {
		if i > 0 && !wait(r, step.DeltaDelayMs) {
			return http.StatusOK
		}
		out += len(piece)
		if !send(chunk(map[string]any{"content": piece}, nil)) {
			return http.StatusOK
		}
	}
	for i, tc := range step.ToolCalls {
		callID := tc.ID
		if callID == "" {
			callID = fmt.Sprintf("call_%d_%d", n, i)
		}
		half := len(tc.Arguments) / 2
		out += len(tc.Name) + len(tc.Arguments)
		first := map[string]any{"index": i, "id": callID, "type": "function", "function": map[string]any{"name": tc.Name, "arguments": tc.Arguments[:half]}}
		rest := map[string]any{"index": i, "function": map[string]any{"arguments": tc.Arguments[half:]}}
		if !send(chunk(map[string]any{"tool_calls": []any{first}}, nil)) || !send(chunk(map[string]any{"tool_calls": []any{rest}}, nil)) {
			return http.StatusOK
		}
	}
	if !wait(r, step.HangMs) {
		return http.StatusOK
	}
	finish := "stop"
	if len(step.ToolCalls) > 0 {
		finish = "tool_calls"
	}
	if !send(chunk(map[string]any{}, finish)) {
		return http.StatusOK
	}
	u := step.Usage
	if u == nil {
		u = &Usage{PromptTokens: int64(len(body) / 4), CompletionTokens: int64(out/4 + 1)}
	}
	send(map[string]any{"id": id, "object": "chat.completion.chunk", "model": "fake", "choices": []any{}, "usage": u})
	io.WriteString(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
	return http.StatusOK
}

// wait sleeps ms, or less when the client goes away (false).
func wait(r *http.Request, ms int) bool {
	if ms <= 0 {
		return r.Context().Err() == nil
	}
	select {
	case <-time.After(time.Duration(ms) * time.Millisecond):
		return true
	case <-r.Context().Done():
		return false
	}
}

// pieces cuts text into n pieces (n <= 0: one per word, the space kept with it).
func pieces(text string, n int) []string {
	if text == "" {
		return nil
	}
	if n <= 0 {
		var out []string
		start := 0
		for i := 1; i < len(text); i++ {
			if text[i-1] == ' ' && text[i] != ' ' {
				out = append(out, text[start:i])
				start = i
			}
		}
		return append(out, text[start:])
	}
	r := []rune(text)
	n = min(n, len(r))
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, string(r[i*len(r)/n:(i+1)*len(r)/n]))
	}
	return out
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}
