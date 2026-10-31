package engine

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// estTokensHeader carries report.BriefResult.EstTokens of POST /s/{id}/api/brief.
const estTokensHeader = "X-Mtkprof-Est-Tokens"

// BriefRequest is the body of POST /s/{id}/api/brief. Every field is optional.
// The notes are the desktop's annotations (report.Note).
type BriefRequest struct {
	Case    string        `json:"case"`
	Notes   []report.Note `json:"notes"`
	Options BriefOptions  `json:"options"`
	Scope   BriefScope    `json:"scope"`
}

// BriefOptions are the limits of a brief (report.BriefOptions); zero selects the default.
type BriefOptions struct {
	MaxStatements int    `json:"maxStatements"`
	MaxSQLChars   int    `json:"maxSqlChars"`
	MaxPlanLines  int    `json:"maxPlanLines"` // -1: no plans
	Binds         string `json:"binds"`        // mask (default), keep, none
	Salt          string `json:"salt"`         // of the masked hashes; default random per brief
}

// BriefScope is the part of the trace a brief is about, as the scope
// parameters of the slice endpoints: a tim window (µs, 0 = open) and session
// contexts (empty = all).
type BriefScope struct {
	From     int64 `json:"from"`
	To       int64 `json:"to"`
	Contexts []int `json:"contexts"`
}

// briefHandler serves POST /s/{id}/api/brief: report.Brief of the session's
// model and facts as text/markdown, the token estimate in a header.
func briefHandler(ss *Session, co *CacheOpened) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req BriefRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil && !errors.Is(err, io.EOF) { // no body: the defaults
			writeError(w, errorf(CodeBadRequest, "body: %v", err))
			return
		}
		f, err := briefFilter(req.Scope, len(co.Model.Contexts))
		if err != nil {
			writeError(w, err)
			return
		}
		binds, err := report.ParseBriefBinds(req.Options.Binds)
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "options.%v", err))
			return
		}
		opts := report.BriefOptions{
			Case: req.Case, Notes: req.Notes, Binds: binds, Salt: req.Options.Salt, Thresholds: ss.th,
			MaxStatements: req.Options.MaxStatements, MaxSQLChars: req.Options.MaxSQLChars, MaxPlanLines: req.Options.MaxPlanLines,
		}
		if err := opts.Check(); err != nil {
			writeError(w, errorf(CodeBadRequest, "%v", err))
			return
		}
		res, err := report.Brief(r.Context(), co.Model, co.Source, f, opts)
		if err != nil {
			if r.Context().Err() == nil {
				writeError(w, err)
			}
			return
		}
		h := w.Header()
		h.Set("Content-Type", "text/markdown; charset=utf-8")
		h.Set(estTokensHeader, strconv.Itoa(res.EstTokens))
		h.Set("Cache-Control", "no-store")
		io.WriteString(w, res.Markdown)
	}
}

// briefFilter reads the scope of a brief; n is the number of session contexts.
func briefFilter(s BriefScope, n int) (analyze.Filter, error) {
	f := analyze.Filter{StartTim: s.From, EndTim: s.To}
	if s.From < 0 || s.To < 0 {
		return f, errorf(CodeBadRequest, "scope: from and to are tim values (µs), 0 or more")
	}
	if s.To != 0 && s.To < s.From {
		return f, errorf(CodeBadRequest, "scope.to: %d is before from: %d", s.To, s.From)
	}
	if len(s.Contexts) > n {
		return f, errorf(CodeBadRequest, "scope.contexts: %d ids for %d session contexts", len(s.Contexts), n)
	}
	for _, c := range s.Contexts {
		if c < 0 || c >= n {
			return f, errorf(CodeBadRequest, "scope.contexts: %d is not a session context (0..%d)", c, n-1)
		}
		f.Contexts = append(f.Contexts, model.ID(c))
	}
	return f, nil
}
