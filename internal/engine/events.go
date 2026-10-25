package engine

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Event is one server-sent event: event: <Type>, data: <Data>.
type Event struct {
	Type string // job, session, prompt or log
	Data []byte // JSON
}

// subBuffer is the number of events a subscriber may lag behind.
const subBuffer = 256

// broadcaster fans events out to the SSE subscribers. Each has a buffered
// channel; a subscriber that falls subBuffer events behind is disconnected
// (its channel closed) rather than silently losing events: the client
// reconnects and re-reads the state with GET /engine/sessions and /jobs,
// and the pending prompts are replayed on connect.
type broadcaster struct {
	mu     sync.Mutex
	subs   map[chan Event]struct{}
	closed bool
}

func newBroadcaster() *broadcaster { return &broadcaster{subs: map[chan Event]struct{}{}} }

// subscribe returns the channel of a new subscriber (closed when the
// subscriber is dropped or the broadcaster closes) and its cancel function.
func (b *broadcaster) subscribe() (<-chan Event, func()) {
	ch := make(chan Event, subBuffer)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		close(ch)
		return ch, func() {}
	}
	b.subs[ch] = struct{}{}
	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
	}
}

// publish sends an event to every subscriber.
func (b *broadcaster) publish(typ string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	ev := Event{Type: typ, Data: data}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default: // too slow: drop the subscriber
			delete(b.subs, ch)
			close(ch)
		}
	}
}

func (b *broadcaster) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for ch := range b.subs {
		delete(b.subs, ch)
		close(ch)
	}
}

// LogEvent is the payload of a log event.
type LogEvent struct {
	Level   string `json:"level"` // info or error
	Message string `json:"message"`
}

// events serves GET /engine/events.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	ch, cancel := s.bc.subscribe()
	defer cancel()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	write := func(typ string, data []byte) bool {
		if _, err := w.Write([]byte("event: " + typ + "\ndata: ")); err != nil {
			return false
		}
		w.Write(data)
		w.Write([]byte("\n\n"))
		return rc.Flush() == nil
	}
	w.Write([]byte(": mtkprof engine\n\n"))
	rc.Flush()
	// state a reconnecting client cannot get otherwise: open prompts
	for _, p := range s.prompts.pending() {
		b, _ := json.Marshal(p)
		if !write("prompt", b) {
			return
		}
	}
	tick := time.NewTicker(s.keepAlive)
	defer tick.Stop()
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if !write(ev.Type, ev.Data) {
				return
			}
		case <-tick.C:
			if _, err := w.Write([]byte(": keepalive\n\n")); err != nil || rc.Flush() != nil {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}
