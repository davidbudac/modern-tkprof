package assist

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"time"
)

// The events of a turn, one JSON object per line (NDJSON) on the answer of
// POST /engine/assist/conversations/{c}/messages, told apart by "type". A
// turn ends with exactly one done or error event.

// TextEvent is a piece of the answer's text. Pieces arriving within
// textEvery of the last text event are sent together.
type TextEvent struct {
	Type string `json:"type"` // text
	Text string `json:"text"`
}

// ToolCallEvent is a tool call of the model, before it runs.
type ToolCallEvent struct {
	Type string `json:"type"` // tool_call
	ID   string `json:"id"`
	Name string `json:"name"`
	// Args are the arguments: a JSON object, or a string holding what the
	// model sent when that is not JSON (the call then fails).
	Args json.RawMessage `json:"args"`
}

// ToolResultEvent is what went back to the model for a tool call.
type ToolResultEvent struct {
	Type      string `json:"type"` // tool_result
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsError   bool   `json:"isError"`
	Content   string `json:"content"` // exactly the text the model is given
	EstTokens int    `json:"estTokens"`
}

// IntentEvent asks the app to move its view (the show tool).
type IntentEvent struct {
	Type   string `json:"type"` // intent
	ID     string `json:"id"`   // the show call's tool call id
	Target Intent `json:"target"`
	Href   string `json:"href"` // the target as an mtkprof: link (the UI's URL hash)
}

// UsageEvent is the token count of one model request.
type UsageEvent struct {
	Type              string `json:"type"` // usage
	InputTokens       int64  `json:"inputTokens"`
	OutputTokens      int64  `json:"outputTokens"`
	CachedInputTokens int64  `json:"cachedInputTokens,omitempty"`
}

// StateEvent is a change of the conversation's state inside a turn: waiting
// for the provider's API key (a prompt of kind apikey on /engine/events),
// and running again once it is answered.
type StateEvent struct {
	Type     string `json:"type"` // state
	State    State  `json:"state"`
	Provider string `json:"provider,omitempty"` // waiting_key: the provider id the prompt names
}

// DoneEvent ends a turn that answered.
type DoneEvent struct {
	Type  string `json:"type"`  // done
	Usage Usage  `json:"usage"` // this turn
	Total Usage  `json:"total"` // the conversation so far
}

// ErrorEvent ends a turn that did not (TurnError).
type ErrorEvent struct {
	Type    string `json:"type"` // error
	Code    string `json:"code"`
	Message string `json:"message"`
}

// textEvery is how often text events go out at most.
const textEvery = 50 * time.Millisecond

// stream writes the events of one turn. Text is coalesced: the first piece
// goes out at once, the pieces that follow within textEvery wait for the end
// of that interval, and any other event sends the text before it, so the
// order holds. Events written before attach are kept until then. Safe for
// concurrent use (a tool call of a CLI agent arrives on another request).
type stream struct {
	mu       sync.Mutex
	w        io.Writer
	flush    func() error
	early    [][]byte
	text     strings.Builder
	lastText time.Time
	timer    *time.Timer
	closed   bool
	failed   bool // a write failed: the reader is gone
	every    time.Duration
}

func newStream() *stream { return &stream{every: textEvery} }

// attach starts writing to w, the events so far first.
func (s *stream) attach(w io.Writer, flush func() error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.w, s.flush = w, flush
	for _, b := range s.early {
		s.writeLocked(b)
	}
	s.early = nil
	s.flushLocked()
}

func (s *stream) Text(piece string) {
	if piece == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.text.WriteString(piece)
	if s.timer != nil {
		return
	}
	if wait := s.every - time.Since(s.lastText); wait > 0 {
		s.timer = time.AfterFunc(wait, s.tick)
		return
	}
	s.textLocked()
	s.flushLocked()
}

func (s *stream) tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.timer = nil
	if !s.closed {
		s.textLocked()
		s.flushLocked()
	}
}

// event writes v after the text so far.
func (s *stream) event(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.textLocked()
	s.lineLocked(v)
	s.flushLocked()
}

// close writes the text so far and v (the last event), and stops the stream.
func (s *stream) close(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.textLocked()
	s.lineLocked(v)
	s.flushLocked()
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

func (s *stream) textLocked() {
	if s.text.Len() == 0 {
		return
	}
	s.lineLocked(TextEvent{Type: "text", Text: s.text.String()})
	s.text.Reset()
	s.lastText = time.Now()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

func (s *stream) lineLocked(v any) {
	b, err := marshal(v)
	if err != nil {
		b, _ = marshal(ErrorEvent{Type: "error", Code: CodeInternal, Message: "encoding an event: " + err.Error()})
	}
	b = append(b, '\n')
	if s.w == nil {
		s.early = append(s.early, b)
		return
	}
	s.writeLocked(b)
}

func (s *stream) writeLocked(b []byte) {
	if s.failed {
		return
	}
	if _, err := s.w.Write(b); err != nil {
		s.failed = true
	}
}

func (s *stream) flushLocked() {
	if s.w != nil && s.flush != nil && !s.failed {
		if s.flush() != nil {
			s.failed = true
		}
	}
}
