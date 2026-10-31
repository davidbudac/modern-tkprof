package engine

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/assist"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// assistTools serves GET /engine/assist/tools: the analysis tools with their
// argument schemas (the shape of MCP tools/list).
func (s *Server) assistTools(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Tools []assist.Info `json:"tools"`
	}{assist.Infos()})
}

// assistBackends serves GET /engine/assist/backends: the provider kinds,
// with each CLI's path, version and login state.
func (s *Server) assistBackends(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Backends []assist.BackendInfo `json:"backends"`
	}{assist.ProbeBackends(r.Context())})
}

// maxConversationID bounds the id a tool call names its conversation by.
const maxConversationID = 200

// assistSalt is the salt of the masked bind hashes of the calls that belong to
// no conversation: one per session, random.
func (ss *Session) assistSalt() string {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.toolSalt == "" {
		ss.toolSalt = assist.NewSalt()
	}
	return ss.toolSalt
}

// redactor is the masking of binds ("" or mask, keep) on this session: a
// session opened with binds=redact masks with its own salt (the tokens its
// model holds), any other with salt.
func (ss *Session) redactor(binds, salt string) (*assist.Redactor, error) {
	switch binds {
	case "", "mask":
		if ss.bindMode == model.BindsRedact {
			salt = ss.salt
		}
		return &assist.Redactor{Salt: salt, ModelRaw: ss.bindMode == model.BindsKeep}, nil
	case "keep":
		return nil, nil
	}
	return nil, errorf(CodeBadRequest, "binds: want mask or keep, not %q", binds)
}

// toolHandler serves POST /s/{id}/api/assist/tools/{name}: the body is the
// JSON object of the tool's arguments (empty = none), the answer its result.
// A call of a conversation (assist.ConversationHeader) runs with its scope,
// masking, notes and view, and shows on its open turn; any other masks bind
// values unless ?binds=keep.
func (s *Server) toolHandler(ss *Session, co *CacheOpened, api http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		args, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "body: %v", err))
			return
		}
		base := assist.Env{Model: co.Model, Source: co.Source, API: api}
		name := r.PathValue("name")
		var res assist.Result
		switch cid := r.Header.Get(assist.ConversationHeader); {
		case len(cid) > maxConversationID:
			writeError(w, errorf(CodeBadRequest, "%s: longer than %d bytes", assist.ConversationHeader, maxConversationID))
			return
		case cid != "":
			c := s.convs.get(cid)
			if c == nil || c.Session() != ss.id {
				writeError(w, errorf(CodeNotFound, "no conversation %q on session %s", cid, ss.id))
				return
			}
			res, err = c.CallTool(r.Context(), base, name, args)
		default:
			if base.Redact, err = ss.redactor(r.URL.Query().Get("binds"), ss.assistSalt()); err != nil {
				writeError(w, err)
				return
			}
			res, err = assist.Call(r.Context(), base, name, args)
		}
		var ae *assist.ArgError
		switch {
		case errors.As(err, &ae):
			writeError(w, errorf(CodeBadRequest, "%s", ae.Msg))
		case err != nil:
			if r.Context().Err() == nil {
				writeError(w, err)
			}
		default:
			h := w.Header()
			h.Set("Content-Type", "application/json")
			h.Set(estTokensHeader, strconv.Itoa(res.EstTokens()))
			h.Set("Cache-Control", "no-store")
			w.Write(res.JSON)
		}
	}
}

// ---- conversations ----------------------------------------------------------------

// conversations are the engine's conversations by id. A conversation lives
// until DELETE or the end of its session.
type conversations struct {
	mu sync.Mutex
	m  map[string]*assist.Conversation
}

func (cs *conversations) get(id string) *assist.Conversation {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.m[id]
}

func (cs *conversations) add(c *assist.Conversation) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if cs.m == nil {
		cs.m = map[string]*assist.Conversation{}
	}
	cs.m[c.ID()] = c
}

// take removes the conversations of session ("" = all) and returns them.
func (cs *conversations) take(session string) []*assist.Conversation {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	var out []*assist.Conversation
	for id, c := range cs.m {
		if session == "" || c.Session() == session {
			out = append(out, c)
			delete(cs.m, id)
		}
	}
	return out
}

// endWait bounds how long ending a conversation waits for its open turn.
const endWait = 5 * time.Second

// endConversations ends the conversations of a session that is closing ("" =
// every one, the engine stops): their open turns end with session_closed.
func (s *Server) endConversations(session string) {
	for _, c := range s.convs.take(session) {
		c.End(assist.ErrSessionClosed, endWait)
	}
}

// ConversationRequest is the body of POST /engine/assist/conversations.
type ConversationRequest struct {
	Session  string          `json:"session"`
	Provider assist.Provider `json:"provider"`
	// Consent: the DBA agreed to send what this trace shows to this provider.
	Consent bool          `json:"consent"`
	Case    string        `json:"case"`
	Notes   []report.Note `json:"notes"` // absent: not supplied
	View    *assist.View  `json:"view"`  // absent: not supplied
	Scope   BriefScope    `json:"scope"`
	Binds   string        `json:"binds"` // mask (default) or keep
}

// MessageRequest is the body of POST /engine/assist/conversations/{c}/messages.
type MessageRequest struct {
	Text  string        `json:"text"`
	View  *assist.View  `json:"view"`  // the view now (absent: unchanged)
	Notes []report.Note `json:"notes"` // the notes now (absent: unchanged)
}

// maxMessageBytes bounds the text of one message.
const maxMessageBytes = 100_000

// decodeBody reads a JSON body of at most 16 MB with no unknown fields.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errorf(CodeBadRequest, "body: %v", err)
	}
	return nil
}

// createConversation serves POST /engine/assist/conversations: a conversation
// about a ready session's trace with a provider. 201 ConversationInfo.
func (s *Server) createConversation(w http.ResponseWriter, r *http.Request) {
	var req ConversationRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if !req.Consent {
		writeError(w, errorf(CodeBadRequest, "consent: the DBA has not agreed to send this trace to the provider"))
		return
	}
	if err := req.Provider.Check(); err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	if err := (report.BriefOptions{Case: req.Case, Notes: req.Notes}).Check(); err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	s.mu.Lock()
	ss := s.sessions[req.Session]
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeNotFound, "no session %q", req.Session))
		return
	}
	var m *model.Model
	ss.use.RLock()
	if ss.op != nil {
		co, _ := ss.op.trace()
		m = co.Model
	}
	ss.use.RUnlock()
	if m == nil {
		writeError(w, errorf(CodeConflict, "session %s is %s", ss.id, ss.Info().State))
		return
	}
	if _, err := briefFilter(req.Scope, len(m.Contexts)); err != nil {
		writeError(w, err)
		return
	}
	redact, err := ss.redactor(req.Binds, assist.NewSalt())
	if err != nil {
		writeError(w, err)
		return
	}
	var files []string
	for _, f := range m.File.Files {
		files = append(files, f.Name)
	}
	// a CLI agent's `mtkprof mcp` calls back where this request came in
	var addr string
	if a, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		addr = a.String()
	}
	c, err := assist.NewConversation(assist.Config{ID: newID("c"), Session: ss.id, Provider: req.Provider, Case: req.Case, Notes: req.Notes,
		View: req.View, Scope: assist.Scope{From: req.Scope.From, To: req.Scope.To, Contexts: req.Scope.Contexts}, Redact: redact, Files: files},
		assist.Host{Trace: s.traceOf(ss), Keys: s.keys, Logf: func(f string, a ...any) { s.logf("info", f, a...) }, Engine: addr, Token: string(s.token)})
	if err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	s.convs.add(c)
	s.mu.Lock()
	alive := s.sessions[ss.id] == ss
	s.mu.Unlock()
	if !alive { // closed meanwhile, its conversations already ended
		s.convs.take(ss.id)
		writeError(w, errorf(CodeConflict, "session %s was closed", ss.id))
		return
	}
	p := req.Provider
	s.logf("info", "conversation %s: session %s, provider %s (%s, %s, model %q)", c.ID(), ss.id, p.ID, p.Kind, p.BaseURL, p.Model)
	writeJSON(w, http.StatusCreated, c.Info())
}

// traceOf runs fn on the current trace of ss for a conversation's tool call,
// as a request on the session's mount would.
func (s *Server) traceOf(ss *Session) func(func(assist.Env) error) error {
	return func(fn func(assist.Env) error) error {
		if !s.beginSession(ss) {
			return assist.ErrSessionClosed
		}
		defer ss.end()
		ss.use.RLock()
		defer ss.use.RUnlock()
		if ss.op == nil {
			return assist.ErrSessionClosed
		}
		co, api := ss.op.trace()
		return fn(assist.Env{Model: co.Model, Source: co.Source, API: api})
	}
}

// beginSession marks a request on ss (Session.begin) while ss is open.
func (s *Server) beginSession(ss *Session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[ss.id] != ss {
		return false
	}
	ss.begin()
	return true
}

func (s *Server) conversation(w http.ResponseWriter, r *http.Request) *assist.Conversation {
	c := s.convs.get(r.PathValue("c"))
	if c == nil {
		writeError(w, errorf(CodeNotFound, "no conversation %q", r.PathValue("c")))
	}
	return c
}

// getConversation serves GET /engine/assist/conversations/{c}.
func (s *Server) getConversation(w http.ResponseWriter, r *http.Request) {
	if c := s.conversation(w, r); c != nil {
		writeJSON(w, http.StatusOK, c.Info())
	}
}

// deleteConversation serves DELETE /engine/assist/conversations/{c}: the
// open turn is cancelled (its stream ends with error cancelled) and the
// conversation ends. 204 once the turn has ended.
func (s *Server) deleteConversation(w http.ResponseWriter, r *http.Request) {
	c := s.conversation(w, r)
	if c == nil {
		return
	}
	s.convs.mu.Lock()
	delete(s.convs.m, c.ID())
	s.convs.mu.Unlock()
	c.End(assist.ErrCancelled, endWait)
	w.WriteHeader(http.StatusNoContent)
}

// postMessage serves POST /engine/assist/conversations/{c}/messages: one turn,
// streamed as NDJSON events (assist's TextEvent ... ErrorEvent) on the answer.
// The turn ends when the model has answered, on DELETE of the conversation,
// when the session closes, or when this request goes away.
func (s *Server) postMessage(w http.ResponseWriter, r *http.Request) {
	c := s.conversation(w, r)
	if c == nil {
		return
	}
	var req MessageRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if strings.TrimSpace(req.Text) == "" || len(req.Text) > maxMessageBytes {
		writeError(w, errorf(CodeBadRequest, "text: want 1 to %d bytes", maxMessageBytes))
		return
	}
	if err := (report.BriefOptions{Notes: req.Notes}).Check(); err != nil {
		writeError(w, errorf(CodeBadRequest, "%v", err))
		return
	}
	s.mu.Lock()
	ss := s.sessions[c.Session()]
	if ss != nil {
		ss.begin() // a turn keeps its session from idle eviction
	}
	s.mu.Unlock()
	if ss == nil {
		writeError(w, errorf(CodeConflict, "the session of conversation %s is closed", c.ID()))
		return
	}
	defer ss.end()
	t, err := c.Begin(r.Context(), assist.UserMessage{Text: req.Text, View: req.View, Notes: req.Notes})
	if err != nil {
		writeError(w, errorf(CodeConflict, "conversation %s: %v", c.ID(), err))
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/x-ndjson")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	t.Run(w, http.NewResponseController(w).Flush)
}

// forgetProviderKey serves DELETE /engine/assist/providers/{id}/key: the key
// held for the provider is dropped; its next turn asks again. 204.
func (s *Server) forgetProviderKey(w http.ResponseWriter, r *http.Request) {
	s.keys.Forget(r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}
