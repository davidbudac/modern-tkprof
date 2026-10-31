// Package assist is what an LLM agent gets to work with on a trace: the
// analysis tools (Tools), the masking of bind values in what they return
// (Redactor), and the stdio MCP server that exposes them to a CLI agent (MCP).
//
// Every tool reads through the slice routes of the session, in process, so a
// tool's numbers are the numbers of the matching /api route for the same scope.
// A result is compact JSON of at most MaxResultTokens tokens; a list that does
// not fit is cut and says so.
package assist

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

// A result is capped at MaxResultTokens tokens, estimated as the brief does:
// bytes over 4.
const (
	MaxResultTokens = 8000
	MaxResultBytes  = MaxResultTokens * 4
)

// ConversationHeader carries the id of the conversation a tool call belongs
// to (MTKPROF_CONVERSATION in the MCP bridge), so the engine can tell whose
// call it is: the show tool of a conversation emits onto its open turn.
const ConversationHeader = "X-Mtkprof-Conversation"

// Scope is the part of the trace a conversation is about: a tim window (µs,
// 0 = open) and session contexts (empty = all), as the slice routes take them.
type Scope struct {
	From     int64 `json:"from"`
	To       int64 `json:"to"`
	Contexts []int `json:"contexts"`
}

// View is what the app shows, in the terms of the URL state of the UI.
type View struct {
	View     string `json:"view"`
	SQLID    string `json:"sql_id,omitempty"` // sql_id, or @N for a statement without one
	Event    string `json:"event,omitempty"`
	From     int64  `json:"from,omitempty"` // the window, tim in µs; both 0 = none
	To       int64  `json:"to,omitempty"`
	Files    []int  `json:"files,omitempty"`
	File     int    `json:"file,omitempty"` // Lines view
	Line     int    `json:"line,omitempty"`
	Contexts []int  `json:"contexts,omitempty"`
}

// Env is what a tool call runs against: one session's trace and the settings
// of the conversation it belongs to.
type Env struct {
	Model  *model.Model
	Source slice.FactSource // the session's facts; read for bind values
	API    http.Handler     // the session's slice routes (slice.Server.Handler)

	// Scope is where a call looks unless its arguments say otherwise.
	Scope Scope
	// Redact masks bind values; nil leaves them as traced.
	Redact *Redactor
	// Notes are the DBA's annotations of the trace and View is what the app
	// shows, both passed in by the caller that creates a conversation (the
	// desktop owns them). nil: not supplied, and the notes and current_view
	// tools say so.
	Notes []report.Note
	View  *View
	// Conversation is the id the call came in with (ConversationHeader); "" for
	// a call outside any conversation.
	Conversation string
	// Show sends a show target (and its mtkprof: link) to the app, as an
	// intent event on the open turn of the conversation. nil: no turn is open,
	// and the show tool says so.
	Show func(target Intent, href string) error
	// MaxBytes overrides MaxResultBytes (0 = the default).
	MaxBytes int
}

func (e Env) maxBytes() int {
	if e.MaxBytes > 0 {
		return e.MaxBytes
	}
	return MaxResultBytes
}

// Result is what a tool returns: compact JSON, the exact payload that goes to
// the model.
type Result struct {
	JSON json.RawMessage
	// Truncated says a list in the result was cut, by the size cap or by the
	// call's own limit; the JSON says where.
	Truncated bool
}

// EstTokens is the size of the result in tokens, as the brief estimates it.
func (r Result) EstTokens() int { return len(r.JSON) / 4 }

// Tool is one analysis tool. Schema is the JSON Schema of its arguments.
type Tool struct {
	Name        string
	Description string
	Schema      json.RawMessage
	Run         func(ctx context.Context, env Env, args json.RawMessage) (Result, error)
}

// Info is a tool as the engine lists it (GET /engine/assist/tools) and as MCP
// tools/list names the fields.
type Info struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// Infos lists the tools.
func Infos() []Info {
	out := make([]Info, len(Tools))
	for i := range Tools {
		out[i] = Info{Tools[i].Name, Tools[i].Description, Tools[i].Schema}
	}
	return out
}

// ArgError is a call the caller got wrong: an argument that does not fit the
// schema, a statement that is not in the trace. The HTTP route answers 400.
type ArgError struct{ Msg string }

func (e *ArgError) Error() string { return e.Msg }

func argErrorf(format string, a ...any) error { return &ArgError{fmt.Sprintf(format, a...)} }

// Tools is the registry.
var Tools = []Tool{
	overviewTool, statementsTool, statementTool, executionsTool, pivotTool, timelineTool,
	linesTool, searchLinesTool, notesTool, currentViewTool, showTool,
}

// Lookup finds a tool by name.
func Lookup(name string) *Tool {
	for i := range Tools {
		if Tools[i].Name == name {
			return &Tools[i]
		}
	}
	return nil
}

// Call runs the tool name. args is the JSON object of its arguments (empty =
// none). An unknown tool and a bad argument are an *ArgError.
func Call(ctx context.Context, env Env, name string, args json.RawMessage) (Result, error) {
	t := Lookup(name)
	if t == nil {
		return Result{}, argErrorf("unknown tool %q", name)
	}
	res, err := t.Run(ctx, env, args)
	var se *statusError
	if errors.As(err, &se) && se.Code >= 400 && se.Code < 500 {
		err = &ArgError{se.Msg}
	}
	return res, err
}

// ---- arguments ----------------------------------------------------------------

// decodeArgs reads the JSON object of a call into v (no unknown fields).
func decodeArgs(raw json.RawMessage, v any) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return argErrorf("arguments: %v", err)
	}
	if dec.More() {
		return argErrorf("arguments: more than one JSON value")
	}
	return nil
}

// scopeArgs are the arguments every scoped tool takes; one that is not given
// falls back to the scope of the conversation.
type scopeArgs struct {
	From     *int64 `json:"from"`
	To       *int64 `json:"to"`
	Contexts *[]int `json:"contexts"`
}

// scope is the effective scope of a call.
func (e Env) scope(a scopeArgs) Scope {
	s := e.Scope
	if a.From != nil {
		s.From = *a.From
	}
	if a.To != nil {
		s.To = *a.To
	}
	if a.Contexts != nil {
		s.Contexts = *a.Contexts
	}
	return s
}

// query is the scope parameters of the slice routes.
func (s Scope) query() url.Values {
	q := url.Values{}
	if s.From != 0 {
		q.Set("from", strconv.FormatInt(s.From, 10))
	}
	if s.To != 0 {
		q.Set("to", strconv.FormatInt(s.To, 10))
	}
	if len(s.Contexts) > 0 {
		ids := make([]string, len(s.Contexts))
		for i, c := range s.Contexts {
			ids[i] = strconv.Itoa(c)
		}
		q.Set("contexts", strings.Join(ids, ","))
	}
	return q
}

// scopeProps is the schema of scopeArgs.
const scopeProps = `"from":{"type":"integer","minimum":0,"description":"window start, trace time (tim) in microseconds; 0 = from the start. Default: the conversation's window."},` +
	`"to":{"type":"integer","minimum":0,"description":"window end, tim in microseconds; 0 = to the end"},` +
	`"contexts":{"type":"array","items":{"type":"integer","minimum":0},"description":"session context ids to look at (see overview); empty = all"}`

// schema builds the JSON Schema of an object of properties.
func schema(props string, required ...string) json.RawMessage {
	var b strings.Builder
	b.WriteString(`{"type":"object","properties":{` + props + `},"additionalProperties":false`)
	if len(required) > 0 {
		b.WriteString(`,"required":["` + strings.Join(required, `","`) + `"]`)
	}
	b.WriteString("}")
	return json.RawMessage(b.String())
}

// ---- statements ---------------------------------------------------------------

// stmtIndex names statements by what the UI's URL names them: the sql_id, or
// @N (the position) for a statement without one or a repeated sql_id.
type stmtIndex struct {
	m     *model.Model
	first map[string]model.ID
}

func newStmtIndex(m *model.Model) *stmtIndex {
	x := &stmtIndex{m: m, first: make(map[string]model.ID, len(m.Statements))}
	for i := range m.Statements {
		if id := m.Statements[i].SQLID; id != "" {
			if _, ok := x.first[id]; !ok {
				x.first[id] = model.ID(i)
			}
		}
	}
	return x
}

func (x *stmtIndex) ref(id model.ID) string {
	if id < 0 || int(id) >= len(x.m.Statements) {
		return ""
	}
	if s := x.m.Statements[id].SQLID; s != "" && x.first[s] == id {
		return s
	}
	return "@" + strconv.Itoa(int(id))
}

func (x *stmtIndex) resolve(ref string) (model.ID, error) {
	n := len(x.m.Statements)
	if ref == "" {
		return 0, argErrorf("sql_id: required (a sql_id, or @N for a statement without one)")
	}
	if strings.HasPrefix(ref, "@") {
		i, err := strconv.Atoi(ref[1:])
		if err != nil || i < 0 || i >= n {
			return 0, argErrorf("sql_id %q: the trace has %d statements, @0 to @%d", ref, n, n-1)
		}
		return model.ID(i), nil
	}
	id, ok := x.first[ref]
	if !ok {
		return 0, argErrorf("sql_id %q is not in this trace", ref)
	}
	return id, nil
}

// preview is text on one line, cut to n characters.
func preview(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// cutText cuts s to n bytes at a character, and says whether it did.
func cutText(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// ---- the slice routes -----------------------------------------------------------

// statusError is an answer of a slice route that is not 200.
type statusError struct {
	Code int
	Msg  string
}

func (e *statusError) Error() string { return e.Msg }

// recorder is the ResponseWriter a route is served into.
type recorder struct {
	h    http.Header
	code int
	body bytes.Buffer
}

func (r *recorder) Header() http.Header         { return r.h }
func (r *recorder) Write(b []byte) (int, error) { return r.body.Write(b) }
func (r *recorder) WriteHeader(code int)        { r.code = code }
func (r *recorder) Flush()                      {}

// get serves GET path?query from the session's routes and returns the body.
func (e Env) get(ctx context.Context, path string, q url.Values) ([]byte, error) {
	u := path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	rec := &recorder{h: http.Header{}, code: http.StatusOK}
	e.API.ServeHTTP(rec, req)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if rec.code != http.StatusOK {
		return nil, &statusError{rec.code, strings.TrimSpace(rec.body.String())}
	}
	return rec.body.Bytes(), nil
}

// getJSON is get decoded into T.
func getJSON[T any](ctx context.Context, e Env, path string, q url.Values) (T, error) {
	var v T
	b, err := e.get(ctx, path, q)
	if err != nil {
		return v, err
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return v, fmt.Errorf("%s: %w", path, err)
	}
	return v, nil
}

// ---- results -----------------------------------------------------------------

// marshal is compact JSON without HTML escaping: a masked bind value is
// "<NUMBER len=2 h=ab12cd34>" and should read like it.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// fit marshals build(n) for the largest n in 0..total whose JSON is at most max
// bytes. build(n) shows the first n items and says itself that it cut the rest.
// cut reports that n < total.
func fit(max, total int, build func(n int) any) (b []byte, cut bool, err error) {
	if b, err = marshal(build(total)); err != nil || len(b) <= max {
		return b, false, err
	}
	lo, hi := 0, total-1 // the answer; build(total) is known not to fit
	var best []byte
	for lo <= hi {
		mid := (lo + hi) / 2
		cand, err := marshal(build(mid))
		if err != nil {
			return nil, false, err
		}
		if len(cand) <= max {
			best, lo = cand, mid+1
		} else {
			hi = mid - 1
		}
	}
	if best == nil {
		return nil, false, fmt.Errorf("the result does not fit %d bytes even without its list", max)
	}
	return best, true, nil
}

// cutHint is the text a cut list carries.
func cutHint(shown, total int, what string, max int) string {
	return fmt.Sprintf("showing %d of %d %s: a result is capped at about %d tokens. Narrow the scope or the arguments.", shown, total, what, max/4)
}

// moreHint is the text of a list that stops at the caller's own limit.
func moreHint(shown, total int, what, how string) string {
	return fmt.Sprintf("showing %d of %d %s: %s", shown, total, what, how)
}

// listResult marshals a result with a list that may need cutting. total is
// the length of the list; build(n) shows n of them.
func (e Env) listResult(total int, build func(n int) any) (Result, error) {
	b, cut, err := fit(e.maxBytes(), total, build)
	return Result{JSON: b, Truncated: cut}, err
}

// plain marshals a result with no list to cut; it must fit.
func (e Env) plain(v any) (Result, error) {
	return e.listResult(0, func(int) any { return v })
}
