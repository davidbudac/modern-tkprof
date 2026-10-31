package assist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

// Sizes of the lists the tools build, and how much of a text they keep.
const (
	overviewStatements = 10
	overviewProfile    = 15
	overviewContexts   = 8
	overviewEvidence   = 3
	maxSummaryChars    = 300
	maxEvidenceChars   = 240
	sqlPreviewChars    = 160
	statementSQLBytes  = 4000
	statementLinks     = 5
	statementWaits     = 6
	statementPlans     = 3
	statementPlanRows  = 100
	bindValueBytes     = 200
	maxExecRequest     = slice.MaxExecutions
)

const unitsNote = "Times are microseconds. tim is the trace clock in microseconds (trace.firstTim to trace.lastTim)."

// ---- shared shapes --------------------------------------------------------------

type scopeOut struct {
	From     int64 `json:"from"`
	To       int64 `json:"to"`
	Contexts []int `json:"contexts,omitempty"`
}

func (e Env) scopeOut(s Scope) scopeOut {
	o := scopeOut{From: s.From, To: s.To, Contexts: s.Contexts}
	if o.From == 0 {
		o.From = e.Model.Span.FirstTim
	}
	if o.To == 0 {
		o.To = e.Model.Span.LastTim
	}
	return o
}

// stmtRow is a statement in a list.
type stmtRow struct {
	Ref        string   `json:"ref"` // sql_id, or @N
	ID         model.ID `json:"id"`
	Kind       string   `json:"kind,omitempty"` // other than a plain sql
	Command    string   `json:"command,omitempty"`
	SQL        string   `json:"sql,omitempty"`
	OwnUs      int64    `json:"ownUs"` // elapsed without recursive children, plus idle between its calls
	ElapsedUs  int64    `json:"elapsedUs"`
	CPUUs      int64    `json:"cpuUs"`
	WaitUs     int64    `json:"waitUs"` // inside calls
	IdleUs     int64    `json:"idleUs"` // between calls
	Calls      int64    `json:"calls"`
	Executions int64    `json:"executions"`
	Rows       int64    `json:"rows"`
	Disk       int64    `json:"disk"`
	Query      int64    `json:"query"`
	Current    int64    `json:"current"`
	HardParses int64    `json:"hardParses,omitempty"`
	Errors     int      `json:"errors,omitempty"`
	FirstTim   int64    `json:"firstTim"`
	LastTim    int64    `json:"lastTim"`
}

func own(s *analyze.StmtStats) int64 { return s.SelfElapsed + s.IdleUs }

func inScope(s *analyze.StmtStats) bool {
	return s.AllCalls.Count > 0 || s.Errors > 0 || s.PXElapsed > 0
}

func stmtRowOf(m *model.Model, x *stmtIndex, s *analyze.StmtStats) stmtRow {
	st := &m.Statements[s.ID]
	r := stmtRow{Ref: x.ref(s.ID), ID: s.ID, Command: ref.CommandName(st.OCT), SQL: preview(st.Text, sqlPreviewChars),
		OwnUs: own(s), ElapsedUs: s.Elapsed, CPUUs: s.CPU, WaitUs: s.WaitUs, IdleUs: s.IdleUs, Calls: s.AllCalls.Count,
		Executions: s.Executions, Rows: s.AllCalls.Rows, Disk: s.AllCalls.Disk, Query: s.AllCalls.Query, Current: s.AllCalls.Current,
		HardParses: s.HardParses, Errors: s.Errors, FirstTim: s.FirstTim, LastTim: s.LastTim}
	if st.Kind != model.StmtSQL {
		r.Kind = st.Kind.String()
	}
	return r
}

type statementsReply struct {
	Statements []analyze.StmtStats `json:"statements"`
}

// ---- overview --------------------------------------------------------------------

type fileOut struct {
	Index    int    `json:"index"`
	Name     string `json:"name"`
	Lines    int    `json:"lines"`
	SizeByte int64  `json:"bytes"`
}

type sessionOut struct {
	ID      model.ID `json:"id"`
	Session string   `json:"session"`
	Service string   `json:"service,omitempty"`
	Module  string   `json:"module,omitempty"`
	Action  string   `json:"action,omitempty"`
}

type profileOut struct {
	Event string `json:"event"`
	Class string `json:"class,omitempty"`
	Idle  bool   `json:"idle,omitempty"`
	Us    int64  `json:"us"`
	Count int64  `json:"count,omitempty"`
	MaxUs int64  `json:"maxUs,omitempty"`
}

type evidenceOut struct {
	Label      string `json:"label"`
	Value      string `json:"value"`
	Statement  string `json:"statement,omitempty"`
	ExecNo     int32  `json:"execNo,omitempty"`
	CursorLine int    `json:"cursorLine,omitempty"` // with execNo: names the execution
	Line       int    `json:"line,omitempty"`       // trace line
	Us         int64  `json:"us,omitempty"`
}

type findingOut struct {
	Rule         string        `json:"rule"`
	Title        string        `json:"title"`
	Severity     string        `json:"severity"`
	Summary      string        `json:"summary"`
	Statement    string        `json:"statement,omitempty"`
	ImpactUs     int64         `json:"impactUs"`
	Scope        string        `json:"scope,omitempty"` // "set": about the whole trace set
	Evidence     []evidenceOut `json:"evidence,omitempty"`
	MoreEvidence int           `json:"moreEvidence,omitempty"`
}

type overviewOut struct {
	Units        string       `json:"units"`
	Database     string       `json:"database"`
	Instance     string       `json:"instance"`
	Files        []fileOut    `json:"files"`
	Contexts     []sessionOut `json:"contexts"`
	ContextTotal int          `json:"contextTotal"`
	Trace        struct {
		FirstTim int64 `json:"firstTim"`
		LastTim  int64 `json:"lastTim"`
	} `json:"trace"`
	Scope           scopeOut     `json:"scope"`
	Binds           string       `json:"binds"`
	ResponseUs      int64        `json:"responseUs"`
	WallUs          int64        `json:"wallUs"`
	Sessions        int          `json:"sessions"`
	Calls           int64        `json:"calls"`
	Waits           int64        `json:"waits"`
	Profile         []profileOut `json:"profile"`
	OtherUs         int64        `json:"otherComponentsUs,omitempty"`
	UnaccountedUs   int64        `json:"unaccountedUs"`
	StatementsTotal int          `json:"statementsInScope"`
	Statements      []stmtRow    `json:"topStatements"`
	Findings        []findingOut `json:"findings"`
	FindingsTotal   int          `json:"findingsTotal"`
	Truncated       bool         `json:"truncated,omitempty"`
	Hint            string       `json:"hint,omitempty"`
}

func (e Env) bindsNote() string {
	switch {
	case e.Model.Diag.BindMode == model.BindsNone.String():
		return "none: the trace was opened without bind values"
	case e.Redact != nil:
		return "masked: <TYPE len=N h=hash>, equal values share a hash within this conversation"
	case e.Model.Diag.BindMode == model.BindsRedact.String():
		return "redacted when the trace was opened"
	}
	return "as traced"
}

var overviewTool = Tool{
	Name: "overview",
	Description: "The trace in one answer: database, files, sessions, the window looked at, response time and its split into CPU and wait events, " +
		"the top statements by own time (sql_id, or @N for one without), and the findings mtkprof's rules report with their evidence. " +
		"Start here. " + unitsNote,
	Schema: schema(scopeProps),
	Run:    runOverview,
}

func runOverview(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a scopeArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	sc := e.scope(a)
	q := sc.query()
	prof, err := getJSON[analyze.ScopeProfile](ctx, e, "/api/profile", q)
	if err != nil {
		return Result{}, err
	}
	stats, err := getJSON[statementsReply](ctx, e, "/api/statements", q)
	if err != nil {
		return Result{}, err
	}
	fnd, err := getJSON[struct {
		Findings []analyze.Finding `json:"findings"`
	}](ctx, e, "/api/findings", q)
	if err != nil {
		return Result{}, err
	}
	m := e.Model
	x := newStmtIndex(m)
	out := overviewOut{Units: unitsNote, Database: m.File.Version, Instance: m.File.Instance, Scope: e.scopeOut(sc), Binds: e.bindsNote(),
		ResponseUs: prof.ResponseUs, WallUs: prof.WallUs, Sessions: prof.Sessions, Calls: prof.Calls, Waits: prof.Waits,
		ContextTotal: len(m.Contexts), Files: []fileOut{}, Contexts: []sessionOut{}, Statements: []stmtRow{}}
	out.Trace.FirstTim, out.Trace.LastTim = m.Span.FirstTim, m.Span.LastTim
	for i, fe := range m.File.Files {
		out.Files = append(out.Files, fileOut{Index: i, Name: fe.Name, Lines: fe.Lines, SizeByte: fe.Size})
	}
	for i := range m.Contexts {
		if i == overviewContexts {
			break
		}
		c := &m.Contexts[i]
		out.Contexts = append(out.Contexts, sessionOut{ID: c.ID, Session: analyze.SessionName(c), Service: c.Service, Module: c.Module, Action: c.Action})
	}

	rows := []profileOut{{Event: "CPU", Us: prof.CPUUs}}
	accounted := prof.CPUUs
	for _, ev := range prof.Events {
		rows = append(rows, profileOut{Event: ev.Name, Class: ev.Class, Idle: ev.Idle, Us: ev.Us, Count: ev.Count, MaxUs: ev.MaxUs})
		accounted += ev.Us
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Us > rows[j].Us })
	if len(rows) > overviewProfile {
		for _, r := range rows[overviewProfile:] {
			out.OtherUs += r.Us
		}
		rows = rows[:overviewProfile]
	}
	out.Profile = rows
	out.UnaccountedUs = prof.ResponseUs - accounted

	var ids []int
	for i := range stats.Statements {
		if inScope(&stats.Statements[i]) {
			ids = append(ids, i)
		}
	}
	out.StatementsTotal = len(ids)
	sort.SliceStable(ids, func(a, b int) bool { return own(&stats.Statements[ids[a]]) > own(&stats.Statements[ids[b]]) })
	for _, i := range ids[:min(len(ids), overviewStatements)] {
		out.Statements = append(out.Statements, stmtRowOf(m, x, &stats.Statements[i]))
	}

	findings := make([]findingOut, 0, len(fnd.Findings))
	for i := range fnd.Findings {
		findings = append(findings, e.findingOut(x, &fnd.Findings[i]))
	}
	out.FindingsTotal = len(findings)
	res, err := e.listResult(len(findings), func(n int) any {
		out.Findings = findings[:n]
		out.Truncated = n < len(findings)
		out.Hint = ""
		if out.Truncated {
			out.Hint = cutHint(n, len(findings), "findings", e.maxBytes())
		}
		return out
	})
	return res, err
}

func (e Env) findingOut(x *stmtIndex, f *analyze.Finding) findingOut {
	m := e.Model
	sum, _ := cutText(f.Summary, maxSummaryChars)
	o := findingOut{Rule: f.Rule, Title: f.Title, Severity: f.Severity, Summary: sum, Statement: x.ref(f.Statement), ImpactUs: f.ImpactUs, Scope: f.Scope}
	for i := range f.Evidence {
		if i == overviewEvidence {
			o.MoreEvidence = len(f.Evidence) - i
			break
		}
		ev := &f.Evidence[i]
		v, _ := cutText(strings.Join(strings.Fields(e.Redact.EvidenceValue(f.Rule, *ev)), " "), maxEvidenceChars)
		eo := evidenceOut{Label: ev.Label, Value: v, Statement: x.ref(ev.Statement), ExecNo: ev.ExecNo, Line: ev.Line, Us: ev.Us}
		if ev.Cursor >= 0 && int(ev.Cursor) < len(m.Cursors) {
			eo.CursorLine = m.Cursors[ev.Cursor].Line
		}
		o.Evidence = append(o.Evidence, eo)
	}
	return o
}

// ---- statements ------------------------------------------------------------------

var statementSorts = map[string]func(s *analyze.StmtStats) int64{
	"own":        own,
	"elapsed":    func(s *analyze.StmtStats) int64 { return s.Elapsed },
	"cpu":        func(s *analyze.StmtStats) int64 { return s.CPU },
	"wait":       func(s *analyze.StmtStats) int64 { return s.WaitUs },
	"idle":       func(s *analyze.StmtStats) int64 { return s.IdleUs },
	"executions": func(s *analyze.StmtStats) int64 { return s.Executions },
	"rows":       func(s *analyze.StmtStats) int64 { return s.AllCalls.Rows },
	"disk":       func(s *analyze.StmtStats) int64 { return s.AllCalls.Disk },
	"query":      func(s *analyze.StmtStats) int64 { return s.AllCalls.Query },
}

const defaultStatementLimit, maxStatementLimit = 20, 100

type statementsArgs struct {
	scopeArgs
	Sort  string `json:"sort"`
	Limit int    `json:"limit"`
}

var statementsTool = Tool{
	Name: "statements",
	Description: "The statements with time in the scope, ranked, with their SQL text (cut), time split, executions, rows and block gets. " +
		"sort: own (default: elapsed without recursive children plus idle time between its calls), elapsed, cpu, wait, idle, executions, rows, disk, query. " +
		"Use statement for one statement's detail. " + unitsNote,
	Schema: schema(scopeProps + `,"sort":{"type":"string","enum":["own","elapsed","cpu","wait","idle","executions","rows","disk","query"],"default":"own"},` +
		`"limit":{"type":"integer","minimum":1,"maximum":100,"default":20}`),
	Run: runStatements,
}

type statementsOut struct {
	Scope      scopeOut  `json:"scope"`
	Sort       string    `json:"sort"`
	InScope    int       `json:"statementsInScope"`
	Shown      int       `json:"shown"`
	Statements []stmtRow `json:"statements"`
	Truncated  bool      `json:"truncated,omitempty"`
	Hint       string    `json:"hint,omitempty"`
}

func runStatements(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a statementsArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	if a.Sort == "" {
		a.Sort = "own"
	}
	key := statementSorts[a.Sort]
	if key == nil {
		return Result{}, argErrorf("sort: %q is not one of own, elapsed, cpu, wait, idle, executions, rows, disk, query", a.Sort)
	}
	if a.Limit == 0 {
		a.Limit = defaultStatementLimit
	}
	if a.Limit < 1 || a.Limit > maxStatementLimit {
		return Result{}, argErrorf("limit: want 1 to %d", maxStatementLimit)
	}
	sc := e.scope(a.scopeArgs)
	stats, err := getJSON[statementsReply](ctx, e, "/api/statements", sc.query())
	if err != nil {
		return Result{}, err
	}
	var ids []int
	for i := range stats.Statements {
		if inScope(&stats.Statements[i]) {
			ids = append(ids, i)
		}
	}
	sort.SliceStable(ids, func(p, q int) bool { return key(&stats.Statements[ids[p]]) > key(&stats.Statements[ids[q]]) })
	inScopeN := len(ids)
	ids = ids[:min(len(ids), a.Limit)]
	x := newStmtIndex(e.Model)
	rows := make([]stmtRow, len(ids))
	for i, id := range ids {
		rows[i] = stmtRowOf(e.Model, x, &stats.Statements[id])
	}
	out := statementsOut{Scope: e.scopeOut(sc), Sort: a.Sort, InScope: inScopeN}
	res, err := e.listResult(len(rows), func(n int) any {
		out.Statements, out.Shown = rows[:n], n
		out.Truncated = n < inScopeN
		out.Hint = ""
		switch {
		case n < len(rows):
			out.Hint = cutHint(n, len(rows), "statements", e.maxBytes())
		case out.Truncated:
			out.Hint = moreHint(n, inScopeN, "statements in scope", "raise limit (up to 100) or sort by another measure")
		}
		return out
	})
	return res, err
}

// ---- statement -------------------------------------------------------------------

type statementArgs struct {
	scopeArgs
	SQLID string `json:"sql_id"`
}

type linkOut struct {
	Ref       string `json:"ref"`
	Calls     int64  `json:"calls"`
	ElapsedUs int64  `json:"elapsedUs"`
}

type waitOut struct {
	Event  string `json:"event"`
	Class  string `json:"class,omitempty"`
	Us     int64  `json:"us"`
	Count  int64  `json:"count"`
	MaxUs  int64  `json:"maxUs"`
	MaxAt  int32  `json:"longestAtLine"`
	Object int64  `json:"objectId,omitempty"`
}

type planRowOut struct {
	ID        int    `json:"id"`
	Depth     int    `json:"depth"`
	Operation string `json:"operation"`
	Object    string `json:"object,omitempty"`
	EstRows   *int64 `json:"estRows,omitempty"`
	Rows      *int64 `json:"rows,omitempty"`
	Starts    *int64 `json:"starts,omitempty"`
	ElapsedUs *int64 `json:"elapsedUs,omitempty"`
	Gets      *int64 `json:"gets,omitempty"`
	Reads     *int64 `json:"reads,omitempty"`
	Access    string `json:"access,omitempty"`
	Filter    string `json:"filter,omitempty"`
}

type planOut struct {
	Hash      string       `json:"planHash"`
	Line      int          `json:"traceLine,omitempty"` // of the dump shown
	Rows      []planRowOut `json:"rows"`
	RowsTotal int          `json:"rowsTotal"`
}

type callTable struct {
	Parse *analyze.CallStats `json:"parse,omitempty"`
	Exec  *analyze.CallStats `json:"exec,omitempty"`
	Fetch *analyze.CallStats `json:"fetch,omitempty"`
	Close *analyze.CallStats `json:"close,omitempty"`
	Other *analyze.CallStats `json:"other,omitempty"`
	Total *analyze.CallStats `json:"total,omitempty"` // parse + exec + fetch, tkprof's total row
}

type statementOut struct {
	stmtRow
	Scope     scopeOut  `json:"scope"`
	SQLCut    bool      `json:"sqlTruncated,omitempty"`
	FirstLine int       `json:"firstLine"`
	Cursors   int       `json:"cursors"`
	InScope   bool      `json:"inScope"`
	ChildUs   int64     `json:"recursiveChildrenUs"`
	CallTable callTable `json:"callTable"`
	Children  []linkOut `json:"recursiveStatements,omitempty"`
	Parents   []linkOut `json:"calledFrom,omitempty"`
	TopWaits  []waitOut `json:"topWaits,omitempty"`
	Plans     []planOut `json:"plans,omitempty"`
	Truncated bool      `json:"truncated,omitempty"`
	Hint      string    `json:"hint,omitempty"`
}

var statementTool = Tool{
	Name: "statement",
	Description: "One statement in full: its SQL text, the call table (parse, exec, fetch, close with counts, cpu, elapsed, disk, query, current, rows), time split, " +
		"recursive statements it runs and the ones that call it, its top wait events, and its execution plans (rows of a STAT dump, with actual rows and times where the trace has them). " +
		"sql_id is the sql_id, or @N for a statement without one. " + unitsNote,
	Schema: schema(scopeProps+`,"sql_id":{"type":"string","description":"the statement's sql_id, or @N for a statement without one"}`, "sql_id"),
	Run:    runStatement,
}

func nonEmpty(c analyze.CallStats) *analyze.CallStats {
	if c.Count == 0 {
		return nil
	}
	return &c
}

func (e Env) linkOuts(x *stmtIndex, ls []analyze.Link) []linkOut {
	var out []linkOut
	for i, l := range ls {
		if i == statementLinks {
			break
		}
		out = append(out, linkOut{Ref: x.ref(l.Statement), Calls: l.Calls, ElapsedUs: l.Elapsed})
	}
	return out
}

func planRowOf(r report.PlanRow) planRowOut {
	return planRowOut{ID: r.ID, Depth: r.Depth, Operation: r.Operation, Object: r.ObjectName, EstRows: r.Cardinality, Rows: r.ActualRows, Starts: r.Starts,
		ElapsedUs: r.ActualElapsedUs, Gets: r.CRBufferGets, Reads: r.PhysicalReads, Access: r.AccessPreds, Filter: r.FilterPreds}
}

func runStatement(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a statementArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	m := e.Model
	x := newStmtIndex(m)
	id, err := x.resolve(a.SQLID)
	if err != nil {
		return Result{}, err
	}
	sc := e.scope(a.scopeArgs)
	q := sc.query()
	stats, err := getJSON[statementsReply](ctx, e, "/api/statements", q)
	if err != nil {
		return Result{}, err
	}
	s := &stats.Statements[id]
	st := &m.Statements[id]
	row := stmtRowOf(m, x, s)
	row.SQL, _ = cutText(strings.TrimRight(st.Text, " \t\r\n"), statementSQLBytes)
	out := statementOut{stmtRow: row, Scope: e.scopeOut(sc), FirstLine: st.FirstLine, Cursors: s.Cursors, InScope: inScope(s), ChildUs: s.ChildUs,
		CallTable: callTable{Parse: nonEmpty(s.Parse), Exec: nonEmpty(s.Exec), Fetch: nonEmpty(s.Fetch), Close: nonEmpty(s.Close), Other: nonEmpty(s.Other), Total: nonEmpty(s.Total)},
		Children:  e.linkOuts(x, s.Children), Parents: e.linkOuts(x, s.Parents)}
	out.SQLCut = len(strings.TrimRight(st.Text, " \t\r\n")) > len(row.SQL)

	wq := with(q, "stmt", strconv.Itoa(int(id)), "max", strconv.Itoa(statementWaits))
	waits, err := getJSON[struct {
		Waits map[string][]analyze.StmtEventWait `json:"waits"`
	}](ctx, e, "/api/stmt/waits", wq)
	if err != nil {
		return Result{}, err
	}
	for _, w := range waits.Waits[strconv.Itoa(int(id))] {
		wo := waitOut{Us: w.Us, Count: w.Count, MaxUs: w.MaxUs, MaxAt: w.MaxLin, Object: max(w.Obj, 0)}
		if w.Event >= 0 && int(w.Event) < len(m.Events) {
			wo.Event, wo.Class = m.Events[w.Event].Name, m.Events[w.Event].Class
		}
		out.TopWaits = append(out.TopWaits, wo)
	}

	var plans []planOut
	for i, h := range s.PlanHashes {
		if i == statementPlans {
			break
		}
		hash := strconv.FormatUint(h, 10)
		b, err := e.get(ctx, "/api/plan", with(nil, "stmt", strconv.Itoa(int(id)), "plh", hash))
		if err != nil {
			var se *statusError
			if errors.As(err, &se) && se.Code == 404 {
				continue
			}
			return Result{}, err
		}
		var rows []report.PlanRow
		if err := json.Unmarshal(b, &rows); err != nil {
			return Result{}, err
		}
		po := planOut{Hash: hash, RowsTotal: len(rows)}
		for j, r := range rows {
			if j == 0 {
				po.Line = r.TraceLine
			}
			if j == statementPlanRows {
				break
			}
			po.Rows = append(po.Rows, planRowOf(r))
		}
		plans = append(plans, po)
	}
	total := 0
	for _, p := range plans {
		total += len(p.Rows)
	}
	return e.listResult(total, func(n int) any {
		out.Plans = nil
		for _, p := range plans {
			k := min(n, len(p.Rows))
			n -= k
			c := p
			c.Rows = p.Rows[:k]
			out.Plans = append(out.Plans, c)
		}
		out.Truncated = false
		out.Hint = ""
		for _, p := range out.Plans {
			if len(p.Rows) < p.RowsTotal {
				out.Truncated = true
			}
		}
		if out.Truncated {
			out.Hint = "plan rows are cut; the plan rows shown are the first of each dump"
		}
		return out
	})
}

// with is a copy of q with the key/value pairs set.
func with(q url.Values, kv ...string) url.Values {
	out := url.Values{}
	for k, v := range q {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out.Set(kv[i], kv[i+1])
	}
	return out
}

// ---- executions ------------------------------------------------------------------

type executionsArgs struct {
	scopeArgs
	SQLID  string `json:"sql_id"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
	Sort   string `json:"sort"`
}

type bindOut struct {
	Pos   int32  `json:"pos"`
	Type  string `json:"type"`
	Value string `json:"value,omitempty"`
	Null  bool   `json:"null,omitempty"`
	Same  bool   `json:"sameAsEarlier,omitempty"` // "No oacdef": a name bound again
	Cut   bool   `json:"cut,omitempty"`           // the value is longer than shown
}

type execOut struct {
	ExecNo     int32     `json:"execNo"`
	CursorLine int       `json:"cursorLine"` // execNo of the cursor opened at this trace line names the execution
	Line       int32     `json:"line"`       // trace line of the EXEC
	StartTim   int64     `json:"startTim"`
	EndTim     int64     `json:"endTim"`
	ElapsedUs  int64     `json:"elapsedUs"`
	CPUUs      int64     `json:"cpuUs"`
	WaitUs     int64     `json:"waitUs"`
	IdleUs     int64     `json:"idleUs"`
	Rows       int64     `json:"rows"`
	Disk       int64     `json:"disk"`
	Query      int64     `json:"query"`
	Current    int64     `json:"current"`
	Fetches    int       `json:"fetches"`
	Session    model.ID  `json:"context"`
	Binds      []bindOut `json:"binds,omitempty"`
}

type executionsOut struct {
	Ref       string    `json:"ref"`
	Scope     scopeOut  `json:"scope"`
	Sort      string    `json:"sort"`
	Binds     string    `json:"binds"`
	Total     int       `json:"total"`
	AvgUs     float64   `json:"avgElapsedUs"`
	Offset    int       `json:"offset"`
	Shown     int       `json:"shown"`
	Rows      []execOut `json:"executions"`
	Truncated bool      `json:"truncated,omitempty"`
	Hint      string    `json:"hint,omitempty"`
}

const maxExecLimit = 10000

var executionsTool = Tool{
	Name: "executions",
	Description: "The executions of one statement (EXEC with its FETCHes) with elapsed, cpu, waits, rows, gets and the bind values of each. " +
		"sort: e (elapsed, default), c, waitEla, r, p, cr, fetches, start, file (trace order). Bind values are masked unless the conversation was set to show them: " +
		"a masked value is <TYPE len=N h=hash>, the same hash for equal values. An execution is named by execNo and cursorLine. " + unitsNote,
	Schema: schema(scopeProps+`,"sql_id":{"type":"string","description":"the statement's sql_id, or @N for a statement without one"},`+
		`"limit":{"type":"integer","minimum":1,"maximum":10000,"default":10},`+
		`"offset":{"type":"integer","minimum":0,"default":0},`+
		`"sort":{"type":"string","enum":["e","c","waitEla","r","p","cr","fetches","start","file"],"default":"e"}`, "sql_id"),
	Run: runExecutions,
}

func bindOutOf(b slice.BindRow) bindOut {
	o := bindOut{Pos: b.Pos, Type: b.Type, Null: b.IsNull, Same: b.NoDef}
	if !b.IsNull && !b.NoDef {
		o.Value, o.Cut = cutText(b.Value, bindValueBytes)
		if b.Dump {
			o.Value, o.Cut = cutText(strings.Join(strings.Fields(o.Value), " "), 80)
		}
	}
	return o
}

func runExecutions(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a executionsArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	if a.Limit == 0 {
		a.Limit = 10
	}
	if a.Limit < 1 || a.Limit > maxExecLimit {
		return Result{}, argErrorf("limit: want 1 to %d", maxExecLimit)
	}
	if a.Offset < 0 {
		return Result{}, argErrorf("offset: want 0 or more")
	}
	if a.Sort == "" {
		a.Sort = "e"
	}
	m := e.Model
	x := newStmtIndex(m)
	id, err := x.resolve(a.SQLID)
	if err != nil {
		return Result{}, err
	}
	sc := e.scope(a.scopeArgs)
	q := sc.query()
	q.Set("stmt", strconv.Itoa(int(id)))
	q.Set("limit", strconv.Itoa(min(a.Limit, maxExecRequest)))
	q.Set("offset", strconv.Itoa(a.Offset))
	q.Set("sort", a.Sort)
	resp, err := getJSON[slice.ExecResponse](ctx, e, "/api/executions", q)
	if err != nil {
		return Result{}, err
	}
	rows := make([]execOut, len(resp.Rows))
	for i := range resp.Rows {
		r := &resp.Rows[i]
		e.Redact.BindRows(e.Source, r.BindSet, r.Binds)
		o := execOut{ExecNo: r.ExecNo, Line: r.Line, StartTim: r.StartTim, EndTim: r.EndTim, ElapsedUs: r.E, CPUUs: r.C, WaitUs: r.WaitEla, IdleUs: r.IdleEla,
			Rows: r.R, Disk: r.P, Query: r.CR, Current: r.CU, Fetches: r.Fetches, Session: r.Ctx}
		if r.Cursor >= 0 && int(r.Cursor) < len(m.Cursors) {
			o.CursorLine = m.Cursors[r.Cursor].Line
		}
		for _, b := range r.Binds {
			o.Binds = append(o.Binds, bindOutOf(b))
		}
		rows[i] = o
	}
	out := executionsOut{Ref: x.ref(id), Scope: e.scopeOut(sc), Sort: a.Sort, Binds: e.bindsNote(), Total: resp.Total, AvgUs: math.Round(resp.AvgE*10) / 10, Offset: a.Offset}
	res, err := e.listResult(len(rows), func(n int) any {
		out.Rows, out.Shown = rows[:n], n
		out.Truncated = a.Offset+n < resp.Total
		out.Hint = ""
		switch {
		case n < len(rows):
			out.Hint = cutHint(n, len(rows), "executions", e.maxBytes()) + fmt.Sprintf(" The next page starts at offset %d.", a.Offset+n)
		case out.Truncated:
			out.Hint = moreHint(a.Offset+n, resp.Total, "executions", fmt.Sprintf("the next page starts at offset %d", a.Offset+n))
		}
		return out
	})
	return res, err
}

// ---- pivot -----------------------------------------------------------------------

type pivotArgs struct {
	scopeArgs
	Fact    string   `json:"fact"`
	By      []string `json:"by"`
	Measure []string `json:"measure"`
	SQLID   string   `json:"sql_id"`
	Event   string   `json:"event"`
	Limit   int      `json:"limit"`
}

type pivotRowOut struct {
	Labels []string  `json:"labels"`
	Extra  []string  `json:"extra,omitempty"`
	Values []float64 `json:"values"`
}

type pivotOut struct {
	Units     string            `json:"units"`
	Scope     scopeOut          `json:"scope"`
	Fact      string            `json:"fact"`
	Dims      []analyze.Dim     `json:"dims"`
	Measures  []analyze.Measure `json:"measures"`
	Groups    int               `json:"groups"`
	Facts     int               `json:"facts"`
	Total     []float64         `json:"total"`
	Rows      []pivotRowOut     `json:"rows"`
	Shown     int               `json:"shown"`
	Truncated bool              `json:"truncated,omitempty"`
	Hint      string            `json:"hint,omitempty"`
}

var defaultPivotMeasures = map[analyze.Fact][]string{
	analyze.FactCalls: {"e", "count", "c", "wait", "idle", "r"},
	analyze.FactWaits: {"ela", "count", "avg", "max", "share"},
}

const defaultPivotLimit, maxPivotLimit = 25, 200

func dimIDs(f analyze.Fact) string {
	var ids []string
	for _, d := range analyze.Dims(f) {
		ids = append(ids, d.ID)
	}
	return strings.Join(ids, ", ")
}

var pivotTool = Tool{
	Name: "pivot",
	Description: "Group the calls (fact calls) or the waits (fact waits) of the scope by one or more dimensions and total measures per group, biggest first. " +
		"calls dimensions: " + dimIDs(analyze.FactCalls) + ". waits dimensions: " + dimIDs(analyze.FactWaits) + ". " +
		"calls measures: count, e, selfE, c, selfC, p, cr, cu, r, mis, wait, idle, avgE, maxE. waits measures: count, ela, avg, min, max, share. " +
		"The first measure orders the rows. sql_id and event (a wait event name, waits only) narrow the rows. Example: waits by event. " + unitsNote,
	Schema: schema(scopeProps+`,"fact":{"type":"string","enum":["calls","waits"],"default":"calls"},`+
		`"by":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"string"},"description":"dimension ids, e.g. [\"event\"] for waits or [\"stmt\"] for calls"},`+
		`"measure":{"type":"array","items":{"type":"string"},"description":"measure ids; the first orders the rows"},`+
		`"sql_id":{"type":"string","description":"only the rows of this statement (sql_id or @N)"},`+
		`"event":{"type":"string","description":"only the waits of this event (waits only)"},`+
		`"limit":{"type":"integer","minimum":1,"maximum":200,"default":25}`, "by"),
	Run: runPivot,
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func runPivot(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a pivotArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	if a.Fact == "" {
		a.Fact = "calls"
	}
	fact, err := analyze.ParseFact(a.Fact)
	if err != nil {
		return Result{}, argErrorf("fact: want calls or waits")
	}
	if len(a.By) == 0 {
		return Result{}, argErrorf("by: no dimension given (have %s)", dimIDs(fact))
	}
	if a.Limit == 0 {
		a.Limit = defaultPivotLimit
	}
	if a.Limit < 1 || a.Limit > maxPivotLimit {
		return Result{}, argErrorf("limit: want 1 to %d", maxPivotLimit)
	}
	if len(a.Measure) == 0 {
		a.Measure = defaultPivotMeasures[fact]
	}
	sc := e.scope(a.scopeArgs)
	q := sc.query()
	q.Set("fact", a.Fact)
	q.Set("by", strings.Join(a.By, ","))
	q.Set("measure", strings.Join(a.Measure, ","))
	q.Set("limit", strconv.Itoa(a.Limit))
	if a.SQLID != "" {
		id, err := newStmtIndex(e.Model).resolve(a.SQLID)
		if err != nil {
			return Result{}, err
		}
		q.Set("stmt", strconv.Itoa(int(id)))
	}
	if a.Event != "" {
		found := false
		for i := range e.Model.Events {
			if e.Model.Events[i].Name == a.Event {
				q.Set("event", strconv.Itoa(i))
				found = true
				break
			}
		}
		if !found {
			return Result{}, argErrorf("event %q is not in this trace", a.Event)
		}
	}
	resp, err := getJSON[slice.PivotResponse](ctx, e, "/api/pivot", q)
	if err != nil {
		return Result{}, err
	}
	rows := make([]pivotRowOut, len(resp.Rows))
	for i, r := range resp.Rows {
		o := pivotRowOut{Labels: r.Labels, Values: make([]float64, len(r.Values))}
		for _, x := range r.Extra {
			t, _ := cutText(strings.Join(strings.Fields(x), " "), sqlPreviewChars)
			o.Extra = append(o.Extra, t)
		}
		for j, v := range r.Values {
			o.Values[j] = round2(v)
		}
		rows[i] = o
	}
	total := make([]float64, len(resp.Total))
	for i, v := range resp.Total {
		total[i] = round2(v)
	}
	out := pivotOut{Scope: e.scopeOut(sc), Fact: a.Fact, Dims: resp.Dims, Measures: resp.Measures, Groups: resp.Groups, Facts: resp.Facts, Total: total}
	return e.listResult(len(rows), func(n int) any {
		out.Rows, out.Shown = rows[:n], n
		out.Truncated = n < resp.Groups
		out.Hint = ""
		switch {
		case n < len(rows):
			out.Hint = cutHint(n, len(rows), "groups", e.maxBytes())
		case out.Truncated:
			out.Hint = moreHint(n, resp.Groups, "groups", "raise limit (up to 200) or narrow the scope")
		}
		return out
	})
}

// ---- timeline --------------------------------------------------------------------

type timelineArgs struct {
	scopeArgs
	Buckets int `json:"buckets"`
	Events  int `json:"events"`
}

type seriesOut struct {
	Event   string  `json:"event"`
	Class   string  `json:"class,omitempty"`
	Idle    bool    `json:"idle,omitempty"`
	TotalUs int64   `json:"totalUs"`
	Us      []int64 `json:"us"`
}

type timelineOut struct {
	Scope    scopeOut    `json:"scope"`
	FirstTim int64       `json:"firstTim"` // tim of bucket 0
	BucketUs int64       `json:"bucketUs"`
	N        int         `json:"buckets"`
	CPUUs    []int64     `json:"cpuUs"` // CPU of the top-level calls per bucket
	Events   []seriesOut `json:"events"`
	OtherUs  []int64     `json:"otherEventsUs,omitempty"`
}

const defaultBuckets, maxBuckets, defaultTimelineEvents, maxTimelineEvents = 24, 120, 5, 15

var timelineTool = Tool{
	Name: "timeline",
	Description: "CPU and wait time over the scope's window in buckets: for each bucket the CPU of the top-level calls and the time of the biggest wait events. " +
		"The buckets cover the window (the whole trace when none). Use it to see when something happened, then narrow with from and to. " + unitsNote,
	Schema: schema(scopeProps + `,"buckets":{"type":"integer","minimum":2,"maximum":120,"default":24},` +
		`"events":{"type":"integer","minimum":0,"maximum":15,"default":5,"description":"wait events listed (the biggest by time); the rest are summed"}`),
	Run: runTimeline,
}

func runTimeline(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a timelineArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	if a.Buckets == 0 {
		a.Buckets = defaultBuckets
	}
	if a.Buckets < 2 || a.Buckets > maxBuckets {
		return Result{}, argErrorf("buckets: want 2 to %d", maxBuckets)
	}
	if a.Events == 0 {
		a.Events = defaultTimelineEvents
	}
	if a.Events < 0 || a.Events > maxTimelineEvents {
		return Result{}, argErrorf("events: want 0 to %d", maxTimelineEvents)
	}
	m := e.Model
	sc := e.scope(a.scopeArgs)
	so := e.scopeOut(sc)
	win := so.To - so.From
	if win <= 0 {
		return Result{}, argErrorf("the window is empty: from %d, to %d", so.From, so.To)
	}
	bucket := (win + int64(a.Buckets) - 1) / int64(a.Buckets)
	q := sc.query()
	q.Set("bucket", strconv.FormatInt(bucket, 10))
	ts, err := getJSON[analyze.SpanSeries](ctx, e, "/api/timeline", q)
	if err != nil {
		return Result{}, err
	}
	// The route's buckets run from the first tim of the trace; keep the ones of the window.
	b0 := max((so.From-ts.FirstTim)/ts.BucketUs, 0)
	b1 := min((so.To-ts.FirstTim)/ts.BucketUs, int64(ts.N-1))
	if b1 < b0 {
		b1 = b0
	}
	ints := func(v []float64) []int64 {
		out := make([]int64, 0, b1-b0+1)
		for i := b0; i <= b1 && int(i) < len(v); i++ {
			out = append(out, int64(math.Round(v[i])))
		}
		return out
	}
	out := timelineOut{Scope: so, FirstTim: ts.FirstTim + b0*ts.BucketUs, BucketUs: ts.BucketUs, CPUUs: ints(ts.CPU), Events: []seriesOut{}}
	out.N = len(out.CPUUs)
	series := make([]seriesOut, 0, len(ts.Events))
	for _, es := range ts.Events {
		if es.Event < 0 || int(es.Event) >= len(m.Events) {
			continue
		}
		ev := &m.Events[es.Event]
		us := ints(es.Us)
		var tot int64
		for _, v := range us {
			tot += v
		}
		series = append(series, seriesOut{Event: ev.Name, Class: ev.Class, Idle: ev.Idle, TotalUs: tot, Us: us})
	}
	sort.SliceStable(series, func(i, j int) bool { return series[i].TotalUs > series[j].TotalUs })
	if len(series) > a.Events {
		other := make([]int64, out.N)
		for _, s := range series[a.Events:] {
			for i, v := range s.Us {
				other[i] += v
			}
		}
		out.OtherUs = other
		series = series[:a.Events]
	}
	out.Events = series
	return e.plain(out)
}
