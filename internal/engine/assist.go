package engine

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/assist"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// assistTools serves GET /engine/assist/tools: the analysis tools with their
// argument schemas (the shape of MCP tools/list).
func (s *Server) assistTools(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Tools []assist.Info `json:"tools"`
	}{assist.Infos()})
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

// toolEnv is what a tool call runs against. The conversation id of the call
// is carried along; the conversations of E3 hold their own scope, notes and
// view, and take them from there.
func (ss *Session) toolEnv(co *CacheOpened, api http.Handler, r *http.Request) (assist.Env, error) {
	env := assist.Env{Model: co.Model, Source: co.Source, API: api, Conversation: r.Header.Get(assist.ConversationHeader)}
	if len(env.Conversation) > maxConversationID {
		return env, errorf(CodeBadRequest, "%s: longer than %d bytes", assist.ConversationHeader, maxConversationID)
	}
	switch v := r.URL.Query().Get("binds"); v {
	case "", "mask":
		salt := ss.assistSalt()
		if ss.bindMode == model.BindsRedact {
			salt = ss.salt // the same tokens the redacted model holds
		}
		env.Redact = &assist.Redactor{Salt: salt, ModelRaw: ss.bindMode == model.BindsKeep}
	case "keep":
	default:
		return env, errorf(CodeBadRequest, "binds: want mask or keep, not %q", v)
	}
	return env, nil
}

// toolHandler serves POST /s/{id}/api/assist/tools/{name}: the body is the
// JSON object of the tool's arguments (empty = none), the answer its result.
// Bind values are masked unless ?binds=keep.
func toolHandler(ss *Session, co *CacheOpened, api http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		args, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "body: %v", err))
			return
		}
		env, err := ss.toolEnv(co, api, r)
		if err != nil {
			writeError(w, err)
			return
		}
		res, err := assist.Call(r.Context(), env, r.PathValue("name"), args)
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
