package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// PromptEvent is the payload of a prompt event. State is "open" when the
// prompt is raised and "closed" when it is answered, cancelled or withdrawn
// (the asker gave up), so every attached UI can dismiss it.
type PromptEvent struct {
	ID         string `json:"id"`
	Connection string `json:"connection"`
	Kind       string `json:"kind"`
	Text       string `json:"text"`
	Echo       bool   `json:"echo"`
	State      string `json:"state"`
	// Fingerprint is the SHA256 fingerprint of an unknown SSH host key (kind hostkey).
	Fingerprint string `json:"fingerprint,omitempty"`
	// Endpoint is where an API key is sent (kind apikey): the provider's kind and base URL.
	Endpoint string `json:"endpoint,omitempty"`
}

type promptAnswer struct {
	answer string
	cancel bool
}

type pendingPrompt struct {
	ev PromptEvent
	ch chan promptAnswer // buffered 1
}

// prompts is the engine's remote.Prompter: Ask raises a prompt event and
// waits for POST /engine/prompts/{id}. Answers are handed to the asker and
// never kept or logged.
type prompts struct {
	bc     *broadcaster
	mu     sync.Mutex
	open   map[string]*pendingPrompt
	order  []string
	closed bool
}

func newPrompts(bc *broadcaster) *prompts {
	return &prompts{bc: bc, open: map[string]*pendingPrompt{}}
}

var _ remote.Prompter = (*prompts)(nil)

// Ask implements remote.Prompter.
func (p *prompts) Ask(ctx context.Context, q remote.Prompt) (string, error) {
	if !remote.ValidKind(q.Kind) {
		return "", fmt.Errorf("prompt kind %q", q.Kind)
	}
	pp := &pendingPrompt{ch: make(chan promptAnswer, 1),
		ev: PromptEvent{ID: newID("p"), Connection: q.Connection, Kind: q.Kind, Text: q.Text, Echo: q.Echo, State: "open", Fingerprint: q.Fingerprint, Endpoint: q.Endpoint}}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return "", ErrPromptCancelled
	}
	p.open[pp.ev.ID] = pp
	p.order = append(p.order, pp.ev.ID)
	p.mu.Unlock()
	p.bc.publish("prompt", pp.ev)
	defer p.remove(pp)
	select {
	case a := <-pp.ch:
		if a.cancel {
			return "", ErrPromptCancelled
		}
		return a.answer, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// remove forgets a prompt and announces it closed.
func (p *prompts) remove(pp *pendingPrompt) {
	p.mu.Lock()
	_, ok := p.open[pp.ev.ID]
	delete(p.open, pp.ev.ID)
	for i, id := range p.order {
		if id == pp.ev.ID {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
	p.mu.Unlock()
	if ok {
		ev := pp.ev
		ev.State = "closed"
		p.bc.publish("prompt", ev)
	}
}

// answer delivers the answer to prompt id; false when there is no such open prompt.
func (p *prompts) answer(id string, a promptAnswer) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp := p.open[id]
	if pp == nil {
		return false
	}
	select {
	case pp.ch <- a:
		return true
	default: // answered already, the asker has not picked it up yet
		return false
	}
}

// get is the open prompt id, if any.
func (p *prompts) get(id string) (PromptEvent, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp := p.open[id]
	if pp == nil {
		return PromptEvent{}, false
	}
	return pp.ev, true
}

// pending lists the open prompts in the order they were raised.
func (p *prompts) pending() []PromptEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]PromptEvent, 0, len(p.order))
	for _, id := range p.order {
		out = append(out, p.open[id].ev)
	}
	return out
}

// close cancels every open prompt and refuses new ones.
func (p *prompts) close() {
	p.mu.Lock()
	p.closed = true
	var all []*pendingPrompt
	for _, pp := range p.open {
		all = append(all, pp)
	}
	p.mu.Unlock()
	for _, pp := range all {
		select {
		case pp.ch <- promptAnswer{cancel: true}:
		default:
		}
	}
}

// getPrompt serves GET /engine/prompts/{id}: the open prompt, so the desktop
// shell can check an apikey prompt's endpoint before it answers with a stored key.
func (s *Server) getPrompt(w http.ResponseWriter, r *http.Request) {
	ev, ok := s.prompts.get(r.PathValue("id"))
	if !ok {
		writeError(w, errorf(CodeNotFound, "no open prompt %q", r.PathValue("id")))
		return
	}
	writeJSON(w, http.StatusOK, ev)
}

// answerPrompt serves POST /engine/prompts/{id} with {"answer": "..."} or {"cancel": true}.
func (s *Server) answerPrompt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Answer *string `json:"answer"`
		Cancel bool    `json:"cancel"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, errorf(CodeBadRequest, "body: want {\"answer\": \"...\"} or {\"cancel\": true}"))
		return
	}
	if body.Answer == nil && !body.Cancel {
		writeError(w, errorf(CodeBadRequest, "body: want {\"answer\": \"...\"} or {\"cancel\": true}"))
		return
	}
	a := promptAnswer{cancel: body.Cancel}
	if body.Answer != nil {
		a.answer = *body.Answer
	}
	if !s.prompts.answer(r.PathValue("id"), a) {
		writeError(w, errorf(CodeNotFound, "no open prompt %q", r.PathValue("id")))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
