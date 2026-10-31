package assist

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Intent is a place in the app that the show tool sends, checked against the
// trace: a view and what it selects. Its ids are the ones the UI's URL state
// uses: sql_id or @N, an execution by cursorLine and execNo, a window in tim.
type Intent struct {
	View       string       `json:"view"`
	SQLID      string       `json:"sql_id,omitempty"`
	ExecNo     int32        `json:"execNo,omitempty"` // with cursorLine: one execution of the statement
	CursorLine int          `json:"cursorLine,omitempty"`
	Event      string       `json:"event,omitempty"` // a wait event name
	From       int64        `json:"from,omitempty"`  // the window, tim in µs
	To         int64        `json:"to,omitempty"`
	Contexts   []int        `json:"contexts,omitempty"`
	File       int          `json:"file,omitempty"` // lines: the input file and the line
	Line       int          `json:"line,omitempty"`
	Pivot      *PivotIntent `json:"pivot,omitempty"`
}

// PivotIntent is the configuration of the Pivot view an intent asks for.
type PivotIntent struct {
	Fact  string   `json:"fact"`
	By    []string `json:"by"`
	Sort  string   `json:"sort,omitempty"` // the measure the rows are sorted by
	SQLID string   `json:"sql_id,omitempty"`
	Event string   `json:"event,omitempty"`
}

// showViews are the views a show target can name.
var showViews = []string{"overview", "statements", "waits", "timeline", "sessions", "pivot", "lines"}

type showOut struct {
	Sent   bool   `json:"sent"`
	Href   string `json:"href"`
	Target Intent `json:"target"`
	Note   string `json:"note"`
}

var showTool = Tool{
	Name: "show",
	Description: "Move the DBA's view in the app to something you found: a view, a statement (sql_id), one execution (sql_id with cursorLine and execNo from executions), " +
		"a wait event, a time window (from and to, tim), session contexts, a trace line (view lines, file and line) or a Pivot (view pivot with pivot). " +
		"Call it only when the DBA asks to see, open or go to something. The answer's href is the mtkprof: link of the same place, to cite. " +
		"Without a view, it is lines for a line, pivot for a pivot, statements for a sql_id, waits for an event, else overview.",
	Schema: schema(`"view":{"type":"string","enum":["overview","statements","waits","timeline","sessions","pivot","lines"]},` +
		`"sql_id":{"type":"string","description":"the statement: its sql_id, or @N"},` +
		`"execNo":{"type":"integer","minimum":1,"description":"with cursorLine: the execution (executions.execNo)"},` +
		`"cursorLine":{"type":"integer","minimum":1,"description":"with execNo: the trace line of the execution's cursor (executions.cursorLine)"},` +
		`"event":{"type":"string","description":"a wait event name"},` +
		`"from":{"type":"integer","minimum":0,"description":"window start, tim in microseconds"},` +
		`"to":{"type":"integer","minimum":0,"description":"window end, tim in microseconds"},` +
		`"contexts":{"type":"array","items":{"type":"integer","minimum":0},"description":"session context ids"},` +
		`"file":{"type":"integer","minimum":0,"description":"view lines: the input file index"},` +
		`"line":{"type":"integer","minimum":1,"description":"view lines: the trace line, 1-based"},` +
		`"pivot":{"type":"object","additionalProperties":false,"required":["by"],"properties":{` +
		`"fact":{"type":"string","enum":["calls","waits"],"default":"calls"},` +
		`"by":{"type":"array","minItems":1,"maxItems":2,"items":{"type":"string"},"description":"one or two dimension ids (see pivot)"},` +
		`"sort":{"type":"string","description":"the measure id the rows are sorted by"},` +
		`"sql_id":{"type":"string","description":"only the rows of this statement"},` +
		`"event":{"type":"string","description":"only the waits of this event (fact waits)"}}}`),
	Run: runShow,
}

func runShow(_ context.Context, e Env, raw json.RawMessage) (Result, error) {
	var in Intent
	if err := decodeArgs(raw, &in); err != nil {
		return Result{}, err
	}
	if err := e.checkIntent(&in); err != nil {
		return Result{}, err
	}
	href := e.href(in)
	if e.Show == nil {
		return Result{}, argErrorf("show moves the view of an open conversation turn, and this call has none")
	}
	if err := e.Show(in, href); err != nil {
		return Result{}, argErrorf("show: %v", err)
	}
	return e.plain(showOut{Sent: true, Href: href, Target: in,
		Note: "sent to the app: it moves the view, or offers the DBA a button to, as the DBA has set it"})
}

// checkIntent checks a target against the trace and fills in the view and
// the normal form of its ids.
func (e Env) checkIntent(in *Intent) error {
	m := e.Model
	x := newStmtIndex(m)
	if in.View == "" {
		switch {
		case in.Pivot != nil:
			in.View = "pivot"
		case in.Line > 0 || in.File > 0:
			in.View = "lines"
		case in.SQLID != "":
			in.View = "statements"
		case in.Event != "":
			in.View = "waits"
		default:
			in.View = "overview"
		}
	}
	if !slices.Contains(showViews, in.View) {
		return argErrorf("view: want one of %s", strings.Join(showViews, ", "))
	}
	if in.SQLID != "" {
		id, err := x.resolve(in.SQLID)
		if err != nil {
			return err
		}
		in.SQLID = x.ref(id)
		if in.ExecNo != 0 || in.CursorLine != 0 {
			if err := e.checkExec(id, in); err != nil {
				return err
			}
		}
	} else if in.ExecNo != 0 || in.CursorLine != 0 {
		return argErrorf("execNo and cursorLine name an execution of the statement sql_id names")
	}
	if in.Event != "" && e.eventID(in.Event) < 0 {
		return argErrorf("event %q is not in this trace", in.Event)
	}
	if in.From != 0 || in.To != 0 {
		lo, hi := m.Span.FirstTim, m.Span.LastTim
		in.From, in.To = max(in.From, lo), min(in.To, hi)
		if in.To <= in.From {
			return argErrorf("from and to: want a window inside the trace, tim %d to %d", lo, hi)
		}
	}
	for _, c := range in.Contexts {
		if c < 0 || c >= len(m.Contexts) {
			return argErrorf("contexts: %d is not a session context (0 to %d)", c, len(m.Contexts)-1)
		}
	}
	if in.File != 0 || in.Line != 0 {
		if in.View != "lines" {
			return argErrorf("file and line go with view lines")
		}
		if _, err := e.fileName(in.File); err != nil {
			return err
		}
		if n := m.File.Files[in.File].Lines; n > 0 && in.Line > n {
			return argErrorf("line: file %d has %d lines", in.File, n)
		}
	}
	if in.Pivot != nil {
		if in.View != "pivot" {
			return argErrorf("pivot goes with view pivot")
		}
		return e.checkPivot(x, in.Pivot)
	}
	return nil
}

// checkExec checks that statement id has an execution execNo of the cursor
// opened at cursorLine.
func (e Env) checkExec(id model.ID, in *Intent) error {
	if in.ExecNo < 1 || in.CursorLine < 1 {
		return argErrorf("an execution is named by both cursorLine and execNo (see executions)")
	}
	for _, c := range e.Model.Cursors {
		if c.Statement != id || c.Line != in.CursorLine {
			continue
		}
		if in.ExecNo > c.Execs {
			return argErrorf("execNo %d: the cursor at line %d has %d executions", in.ExecNo, in.CursorLine, c.Execs)
		}
		return nil
	}
	return argErrorf("cursorLine %d: no cursor of %s opens at that line (see executions)", in.CursorLine, in.SQLID)
}

func (e Env) eventID(name string) int {
	for i := range e.Model.Events {
		if e.Model.Events[i].Name == name {
			return i
		}
	}
	return -1
}

func (e Env) checkPivot(x *stmtIndex, p *PivotIntent) error {
	if p.Fact == "" {
		p.Fact = "calls"
	}
	fact, err := analyze.ParseFact(p.Fact)
	if err != nil {
		return argErrorf("pivot.fact: want calls or waits")
	}
	if len(p.By) < 1 || len(p.By) > 2 {
		return argErrorf("pivot.by: one or two dimensions (%s)", dimIDs(fact))
	}
	for _, d := range p.By {
		if !slices.ContainsFunc(analyze.Dims(fact), func(x analyze.Dim) bool { return x.ID == d }) {
			return argErrorf("pivot.by: %q is not a %s dimension (%s)", d, p.Fact, dimIDs(fact))
		}
	}
	if p.Sort != "" && analyze.MeasureIndex(fact, p.Sort) < 0 {
		return argErrorf("pivot.sort: %q is not a %s measure", p.Sort, p.Fact)
	}
	if p.SQLID != "" {
		id, err := x.resolve(p.SQLID)
		if err != nil {
			return err
		}
		p.SQLID = x.ref(id)
	}
	if p.Event != "" {
		if fact != analyze.FactWaits {
			return argErrorf("pivot.event goes with fact waits")
		}
		if e.eventID(p.Event) < 0 {
			return argErrorf("pivot.event %q is not in this trace", p.Event)
		}
	}
	return nil
}

// href is the target as an mtkprof: link: the URL hash of the UI
// (web/src/app/urlstate.ts), with win in µs from the trace's first tim, and
// exec and contexts, which the desktop adds.
func (e Env) href(in Intent) string {
	var kv []string
	add := func(k, v string) { kv = append(kv, k+"="+hashEscape(v)) }
	add("view", in.View)
	if in.SQLID != "" {
		add("sql", in.SQLID)
	}
	if in.Event != "" {
		add("ev", in.Event)
	}
	if in.From != 0 || in.To != 0 {
		base := e.Model.Span.FirstTim
		add("win", fmt.Sprintf("%d-%d", in.From-base, in.To-base))
	}
	if in.ExecNo > 0 {
		add("exec", fmt.Sprintf("%d:%d", in.CursorLine, in.ExecNo))
	}
	if len(in.Contexts) > 0 {
		ids := make([]string, len(in.Contexts))
		for i, c := range in.Contexts {
			ids[i] = strconv.Itoa(c)
		}
		add("contexts", strings.Join(ids, ","))
	}
	if in.View == "lines" {
		if in.File != 0 {
			add("file", strconv.Itoa(in.File))
		}
		if in.Line > 0 {
			add("line", strconv.Itoa(in.Line))
		}
	}
	return "mtkprof:#" + strings.Join(kv, "&")
}

// hashEscape escapes a value of the hash as URLSearchParams reads it (a space
// is +), and leaves the characters of ids and event names readable.
func hashEscape(v string) string { return readable.Replace(url.QueryEscape(v)) }

var readable = strings.NewReplacer("%40", "@", "%3A", ":", "%2C", ",", "%2F", "/", "%2A", "*")
