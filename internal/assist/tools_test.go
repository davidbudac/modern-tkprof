package assist

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

const traces = "../../testdata/traces/19c/"

// loadEnv serves a fixture the way a session does: its model with the facts,
// the line indexes and the slice routes on top.
func loadEnv(t *testing.T, name string, masked bool) Env {
	t.Helper()
	m, err := model.Build(traces+name+".trc", model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	src := slice.MemSource(m)
	var lis []*trace.LineIndex
	for _, fe := range m.File.Files {
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { li.Close() })
		lis = append(lis, li)
	}
	srv := slice.NewServer(m, src).WithLines(lis)
	srv.AllowOrigin = slice.NoCORS
	env := Env{Model: m, Source: src, API: srv.Handler()}
	if masked {
		env.Redact = &Redactor{Salt: "test-salt", ModelRaw: true}
	}
	return env
}

func call(t *testing.T, env Env, tool string, args string) (Result, map[string]any) {
	t.Helper()
	res, err := Call(context.Background(), env, tool, json.RawMessage(args))
	if err != nil {
		t.Fatalf("%s %s: %v", tool, args, err)
	}
	if len(res.JSON) > env.maxBytes() {
		t.Errorf("%s %s: %d bytes, cap %d", tool, args, len(res.JSON), env.maxBytes())
	}
	if strings.Contains(string(res.JSON), "\\u003c") {
		t.Errorf("%s: HTML-escaped output", tool)
	}
	var v map[string]any
	if err := json.Unmarshal(res.JSON, &v); err != nil {
		t.Fatalf("%s: %v\n%s", tool, err, res.JSON)
	}
	return res, v
}

func route[T any](t *testing.T, env Env, path string, q url.Values) T {
	t.Helper()
	v, err := getJSON[T](context.Background(), env, path, q)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func num(v any) int64 { f, _ := v.(float64); return int64(math.Round(f)) }

func list(v any) []any { l, _ := v.([]any); return l }

func obj(v any) map[string]any { o, _ := v.(map[string]any); return o }

// argsOf are the argument structs the schemas describe.
var argsOf = map[string]any{
	"overview": scopeArgs{}, "statements": statementsArgs{}, "statement": statementArgs{}, "executions": executionsArgs{},
	"pivot": pivotArgs{}, "timeline": timelineArgs{}, "lines": linesArgs{}, "search_lines": searchArgs{}, "notes": notesArgs{}, "current_view": struct{}{},
	"show": Intent{},
}

func jsonFields(t reflect.Type) []string {
	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.Anonymous {
			out = append(out, jsonFields(f.Type)...)
			continue
		}
		if tag, _, _ := strings.Cut(f.Tag.Get("json"), ","); tag != "" && tag != "-" {
			out = append(out, tag)
		}
	}
	return out
}

func TestToolsRegistry(t *testing.T) {
	want := []string{"overview", "statements", "statement", "executions", "pivot", "timeline", "lines", "search_lines", "notes", "current_view", "show"}
	var have []string
	for _, tl := range Tools {
		have = append(have, tl.Name)
	}
	if !reflect.DeepEqual(have, want) {
		t.Fatalf("tools %v, want %v", have, want)
	}
	for _, tl := range Tools {
		if tl.Description == "" || tl.Run == nil {
			t.Errorf("%s: no description or Run", tl.Name)
		}
		var s struct {
			Type       string                    `json:"type"`
			Properties map[string]map[string]any `json:"properties"`
			Required   []string                  `json:"required"`
			Additional *bool                     `json:"additionalProperties"`
		}
		if err := json.Unmarshal(tl.Schema, &s); err != nil {
			t.Errorf("%s: schema: %v", tl.Name, err)
			continue
		}
		if s.Type != "object" || s.Additional == nil || *s.Additional {
			t.Errorf("%s: schema is not a closed object", tl.Name)
		}
		var props []string
		for p, def := range s.Properties {
			props = append(props, p)
			if def["type"] == nil {
				t.Errorf("%s.%s: no type", tl.Name, p)
			}
		}
		fields := jsonFields(reflect.TypeOf(argsOf[tl.Name]))
		if len(props) != len(fields) {
			t.Errorf("%s: schema has %v, the arguments %v", tl.Name, props, fields)
		}
		for _, f := range fields {
			if s.Properties[f] == nil {
				t.Errorf("%s: schema lacks %q", tl.Name, f)
			}
		}
		for _, r := range s.Required {
			if s.Properties[r] == nil {
				t.Errorf("%s: required %q is not a property", tl.Name, r)
			}
		}
	}
}

func TestToolsOnBasicBinds(t *testing.T) {
	env := loadEnv(t, "basic_binds", true)
	const sqlID = "f6jyzt7462kx2" // the 10-execution select
	var allStats = route[statementsReply](t, env, "/api/statements", nil).Statements

	t.Run("overview", func(t *testing.T) {
		_, v := call(t, env, "overview", `{}`)
		prof := route[analyze.ScopeProfile](t, env, "/api/profile", nil)
		if got := num(v["responseUs"]); got != prof.ResponseUs {
			t.Errorf("responseUs %d, route %d", got, prof.ResponseUs)
		}
		var fromTool int64
		for _, p := range list(v["profile"]) {
			if o := obj(p); o["event"] == "CPU" {
				fromTool = num(o["us"])
			}
		}
		if fromTool != prof.CPUUs {
			t.Errorf("cpu %d, route %d", fromTool, prof.CPUUs)
		}
		fnd := route[struct {
			Findings []analyze.Finding `json:"findings"`
		}](t, env, "/api/findings", nil)
		if got := int(num(v["findingsTotal"])); got != len(fnd.Findings) {
			t.Errorf("findingsTotal %d, route %d", got, len(fnd.Findings))
		}
		if got := len(list(v["topStatements"])); got != overviewStatements {
			t.Errorf("%d top statements", got)
		}
		top := obj(list(v["topStatements"])[0])
		if top["ref"] != sqlID {
			t.Errorf("top statement %v, want %s", top["ref"], sqlID)
		}
	})

	t.Run("statements", func(t *testing.T) {
		_, v := call(t, env, "statements", `{"limit":100,"sort":"elapsed"}`)
		rows := list(v["statements"])
		if len(rows) == 0 {
			t.Fatal("no statements")
		}
		for _, r := range rows {
			o := obj(r)
			s := &allStats[int(num(o["id"]))]
			if num(o["elapsedUs"]) != s.Elapsed || num(o["cpuUs"]) != s.CPU || num(o["executions"]) != s.Executions || num(o["calls"]) != s.AllCalls.Count || num(o["rows"]) != s.AllCalls.Rows {
				t.Errorf("statement %v: %v differs from the route %+v", o["ref"], o, s.AllCalls)
			}
		}
		for i := 1; i < len(rows); i++ {
			if num(obj(rows[i-1])["elapsedUs"]) < num(obj(rows[i])["elapsedUs"]) {
				t.Errorf("rows are not sorted by elapsed at %d", i)
			}
		}
		_, v = call(t, env, "statements", `{"limit":3}`)
		if len(list(v["statements"])) != 3 || v["truncated"] != true || !strings.Contains(v["hint"].(string), "raise limit") {
			t.Errorf("a limit of 3: %v", v)
		}
	})

	t.Run("statement", func(t *testing.T) {
		_, v := call(t, env, "statement", `{"sql_id":"`+sqlID+`"}`)
		var id int
		for i := range env.Model.Statements {
			if env.Model.Statements[i].SQLID == sqlID {
				id = i
			}
		}
		s := allStats[id]
		ct := obj(v["callTable"])
		wantFetch, _ := json.Marshal(s.Fetch)
		gotFetch, _ := json.Marshal(ct["fetch"])
		var a, b map[string]any
		json.Unmarshal(wantFetch, &a)
		json.Unmarshal(gotFetch, &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("fetch row %v, route %v", b, a)
		}
		if ct["close"] == nil || ct["parse"] == nil || ct["exec"] == nil {
			t.Errorf("call table %v", ct)
		}
		if !strings.Contains(v["sql"].(string), "mtk_basic_binds") {
			t.Errorf("sql %v", v["sql"])
		}
		if len(list(v["plans"])) != 1 || len(list(obj(list(v["plans"])[0])["rows"])) == 0 {
			t.Errorf("plans %v", v["plans"])
		}
		if len(list(v["topWaits"])) == 0 {
			t.Error("no top waits")
		}
		// a statement without a sql_id is named @N
		_, v = call(t, env, "statement", `{"sql_id":"@0"}`)
		if v["ref"] != "@0" {
			t.Errorf("@0 is %v", v["ref"])
		}
	})

	t.Run("executions", func(t *testing.T) {
		_, v := call(t, env, "executions", `{"sql_id":"`+sqlID+`","limit":3,"sort":"e"}`)
		var id int
		for i := range env.Model.Statements {
			if env.Model.Statements[i].SQLID == sqlID {
				id = i
			}
		}
		resp := route[slice.ExecResponse](t, env, "/api/executions", url.Values{"stmt": {strconv.Itoa(id)}, "sort": {"e"}, "limit": {"3"}})
		if int(num(v["total"])) != resp.Total {
			t.Errorf("total %v, route %d", v["total"], resp.Total)
		}
		rows := list(v["executions"])
		if len(rows) != 3 {
			t.Fatalf("%d executions", len(rows))
		}
		for i, r := range rows {
			o := obj(r)
			if num(o["elapsedUs"]) != resp.Rows[i].E || num(o["line"]) != int64(resp.Rows[i].Line) || num(o["execNo"]) != int64(resp.Rows[i].ExecNo) {
				t.Errorf("execution %d: %v, route %+v", i, o, resp.Rows[i])
			}
			for _, b := range list(o["binds"]) {
				bo := obj(b)
				if val, _ := bo["value"].(string); val != "" && !strings.HasPrefix(val, "<") {
					t.Errorf("a bind value escaped the mask: %v", bo)
				}
			}
		}
		// the same value gets the same token inside one conversation: :0 and :7 are both the number 1
		tok := func(e, pos int) string {
			return obj(list(obj(list(v["executions"])[e])["binds"])[pos])["value"].(string)
		}
		if tok(0, 0) != tok(0, 7) || tok(0, 0) == tok(0, 8) || !strings.HasPrefix(tok(0, 0), "<NUMBER len=2 h=") {
			t.Errorf("tokens of 1, 1 and 1000: %s %s %s", tok(0, 0), tok(0, 7), tok(0, 8))
		}
		// a window narrows it like the route does
		mid := env.Model.Span.FirstTim + (env.Model.Span.LastTim-env.Model.Span.FirstTim)/2
		_, v = call(t, env, "executions", `{"sql_id":"`+sqlID+`","from":`+strconv.FormatInt(mid, 10)+`}`)
		resp = route[slice.ExecResponse](t, env, "/api/executions", url.Values{"stmt": {strconv.Itoa(id)}, "from": {strconv.FormatInt(mid, 10)}})
		if int(num(v["total"])) != resp.Total || resp.Total == 0 || resp.Total == 10 {
			t.Errorf("windowed total %v, route %d", v["total"], resp.Total)
		}
	})

	t.Run("pivot", func(t *testing.T) {
		mid := env.Model.Span.FirstTim + (env.Model.Span.LastTim-env.Model.Span.FirstTim)/2
		_, v := call(t, env, "pivot", `{"fact":"waits","by":["event"],"from":`+strconv.FormatInt(mid, 10)+`}`)
		resp := route[slice.PivotResponse](t, env, "/api/pivot", url.Values{"fact": {"waits"}, "by": {"event"}, "from": {strconv.FormatInt(mid, 10)}})
		if int(num(v["groups"])) != resp.Groups || int(num(v["facts"])) != resp.Facts {
			t.Errorf("groups %v facts %v, route %d %d", v["groups"], v["facts"], resp.Groups, resp.Facts)
		}
		// the default measures are ela, count, avg, max, share
		ela := analyze.MeasureIndex(analyze.FactWaits, "ela")
		if got := list(v["total"])[0].(float64); got != math.Round(resp.Total[ela]*100)/100 {
			t.Errorf("total time %v, route %v", got, resp.Total[ela])
		}
		if first := obj(list(v["rows"])[0]); first["labels"].([]any)[0] != resp.Rows[0].Labels[0] {
			t.Errorf("first row %v, route %v", first, resp.Rows[0])
		}
		_, v = call(t, env, "pivot", `{"fact":"waits","by":["event"],"event":"log file sync"}`)
		if int(num(v["groups"])) != 1 {
			t.Errorf("one event: %v", v["groups"])
		}
	})

	t.Run("timeline", func(t *testing.T) {
		_, v := call(t, env, "timeline", `{"buckets":10,"events":2}`)
		n := len(list(v["cpuUs"]))
		if n < 10 || n > 12 || int(num(v["buckets"])) != n {
			t.Errorf("%d buckets", n)
		}
		evs := list(v["events"])
		if len(evs) != 2 {
			t.Fatalf("%d events", len(evs))
		}
		for _, e := range evs {
			if len(list(obj(e)["us"])) != n {
				t.Errorf("series %v has %d buckets, not %d", obj(e)["event"], len(list(obj(e)["us"])), n)
			}
		}
		if len(list(v["otherEventsUs"])) != n {
			t.Error("no summed rest")
		}
		// zoomed on the second half, the buckets start there
		mid := env.Model.Span.FirstTim + (env.Model.Span.LastTim-env.Model.Span.FirstTim)/2
		_, v = call(t, env, "timeline", `{"buckets":4,"from":`+strconv.FormatInt(mid, 10)+`}`)
		if first := num(v["firstTim"]); first > mid || first < mid-num(v["bucketUs"]) {
			t.Errorf("firstTim %d, window starts at %d", first, mid)
		}
	})

	t.Run("lines", func(t *testing.T) {
		_, v := call(t, env, "lines", `{"from":75,"n":4}`)
		raw, err := env.readLines(context.Background(), 0, 75, 78)
		if err != nil {
			t.Fatal(err)
		}
		var want strings.Builder
		for i, l := range raw {
			want.WriteString(strconv.Itoa(75+i) + "\t" + l + "\n")
		}
		if v["text"] != want.String() || num(v["next"]) != 79 {
			t.Errorf("lines 75-78:\n%v\nwant:\n%s", v["text"], want.String())
		}
		_, v = call(t, env, "lines", `{"from":3055,"n":50}`)
		if num(v["lines"]) != 5 || v["next"] != nil {
			t.Errorf("the end of the file: %v lines, next %v", v["lines"], v["next"])
		}
	})

	t.Run("search_lines", func(t *testing.T) {
		_, v := call(t, env, "search_lines", `{"q":"PARSING IN CURSOR","limit":5}`)
		hits := list(v["hits"])
		if len(hits) != 5 || v["truncated"] != true || num(v["next"]) <= num(obj(hits[4])["line"]) {
			t.Errorf("hits %v next %v", len(hits), v["next"])
		}
		for _, h := range hits {
			if !strings.Contains(obj(h)["text"].(string), "PARSING IN CURSOR") {
				t.Errorf("hit %v", h)
			}
		}
		_, v = call(t, env, "search_lines", `{"q":"parsing in cursor","ignore_case":true,"regex":true,"limit":1}`)
		if len(list(v["hits"])) != 1 {
			t.Errorf("ignore_case: %v", v)
		}
	})

	t.Run("notes and view are empty without a conversation", func(t *testing.T) {
		_, v := call(t, env, "notes", `{}`)
		if v["supplied"] != false || num(v["count"]) != 0 || v["message"] == "" {
			t.Errorf("notes %v", v)
		}
		_, v = call(t, env, "current_view", `{}`)
		if v["supplied"] != false || v["view"] != nil || v["message"] == "" {
			t.Errorf("view %v", v)
		}
	})
}

func TestNotesAndViewSupplied(t *testing.T) {
	env := loadEnv(t, "basic_binds", true)
	const sqlID = "f6jyzt7462kx2"
	var st *model.Statement
	for i := range env.Model.Statements {
		if env.Model.Statements[i].SQLID == sqlID {
			st = &env.Model.Statements[i]
		}
	}
	env.Notes = []report.Note{
		{ID: "a", Kind: report.NoteStatement, Note: "the slow one", Stmt: &report.NoteStmt{SQLID: sqlID, Hash: report.NoteHash(st.Kind, st.Text)}},
		{ID: "b", Kind: report.NoteExecution, Note: "first run", Stmt: &report.NoteStmt{SQLID: sqlID, Hash: "00000000"}, ExecNo: 1, CursorLine: 75},
		{ID: "c", Kind: report.NoteStatement, Note: "from another trace", Stmt: &report.NoteStmt{SQLID: "0000000000000", Hash: "deadbeef"}},
		{ID: "d", Kind: report.NoteWindow, Note: "the batch", From: 10778900000, To: 10778950000, Label: "batch"},
	}
	_, v := call(t, env, "notes", `{}`)
	notes := list(v["notes"])
	if v["supplied"] != true || len(notes) != 4 {
		t.Fatalf("notes %v", v)
	}
	if obj(notes[0])["statement"] != sqlID || obj(notes[1])["statement"] != sqlID {
		t.Errorf("statement notes resolve to %v / %v", obj(notes[0])["statement"], obj(notes[1])["statement"])
	}
	if c := obj(notes[2]); c["statementNotInTrace"] != true {
		t.Errorf("a note about another statement: %v", c)
	}
	_, v = call(t, env, "notes", `{"sql_id":"`+sqlID+`"}`)
	if len(list(v["notes"])) != 2 {
		t.Errorf("notes of the statement: %v", v["notes"])
	}
	_, v = call(t, env, "notes", `{"kind":"window"}`)
	if n := list(v["notes"]); len(n) != 1 || obj(n[0])["label"] != "batch" {
		t.Errorf("window notes: %v", n)
	}
	env.Notes = []report.Note{}
	if _, v = call(t, env, "notes", `{}`); v["supplied"] != true || num(v["count"]) != 0 {
		t.Errorf("an empty list of notes: %v", v)
	}

	env.View = &View{View: "statements", SQLID: sqlID, From: 1, To: 2}
	_, v = call(t, env, "current_view", `{}`)
	if o := obj(v["view"]); v["supplied"] != true || o["view"] != "statements" || o["sql_id"] != sqlID {
		t.Errorf("view %v", v)
	}
}

func TestToolScopeDefaults(t *testing.T) {
	env := loadEnv(t, "basic_binds", true)
	mid := env.Model.Span.FirstTim + (env.Model.Span.LastTim-env.Model.Span.FirstTim)/2
	env.Scope = Scope{From: mid}
	_, v := call(t, env, "overview", `{}`)
	whole := route[analyze.ScopeProfile](t, env, "/api/profile", url.Values{"from": {strconv.FormatInt(mid, 10)}})
	if num(v["responseUs"]) != whole.ResponseUs || num(obj(v["scope"])["from"]) != mid {
		t.Errorf("the conversation's window: %v", obj(v["scope"]))
	}
	// an argument overrides it, 0 reopens the window
	_, v = call(t, env, "overview", `{"from":0}`)
	full := route[analyze.ScopeProfile](t, env, "/api/profile", nil)
	if num(v["responseUs"]) != full.ResponseUs || full.ResponseUs == whole.ResponseUs {
		t.Errorf("from 0: %v, route %d", v["responseUs"], full.ResponseUs)
	}
}

func TestToolCap(t *testing.T) {
	env := loadEnv(t, "basic_binds", true)
	env.MaxBytes = 2500
	res, v := call(t, env, "executions", `{"sql_id":"f6jyzt7462kx2","limit":10000}`)
	if !res.Truncated || v["truncated"] != true {
		t.Fatalf("not truncated: %d bytes", len(res.JSON))
	}
	shown := len(list(v["executions"]))
	if shown == 0 || shown >= 10 || num(v["shown"]) != int64(shown) || !strings.Contains(v["hint"].(string), "capped at about 625 tokens") {
		t.Errorf("shown %d of %v: %v", shown, v["total"], v["hint"])
	}
	if num(v["total"]) != 10 {
		t.Errorf("total %v", v["total"])
	}
	res, v = call(t, env, "statements", `{"limit":100}`)
	if !res.Truncated || len(list(v["statements"])) >= 22 {
		t.Errorf("statements not cut: %d", len(list(v["statements"])))
	}
	// the default cap is the 8,000 tokens
	env.MaxBytes = 0
	res, _ = call(t, env, "executions", `{"sql_id":"f6jyzt7462kx2","limit":10000}`)
	if res.Truncated || res.EstTokens() > MaxResultTokens {
		t.Errorf("ten executions are %d tokens", res.EstTokens())
	}
}

func TestFit(t *testing.T) {
	build := func(n int) any { return map[string]any{"items": make([]int, n)} } // [0,0,..]: 2 bytes an item
	b, cut, err := fit(100, 10, build)
	if err != nil || cut || len(b) > 100 {
		t.Fatalf("10 items: %s %v %v", b, cut, err)
	}
	b, cut, err = fit(30, 100, build)
	if err != nil || !cut || len(b) > 30 || len(b) < 28 {
		t.Fatalf("100 items in 30 bytes: %s %v %v", b, cut, err)
	}
	if _, _, err = fit(5, 100, build); err == nil {
		t.Error("an envelope over the cap is an error")
	}
}

func TestToolErrors(t *testing.T) {
	env := loadEnv(t, "basic_binds", true)
	for _, c := range []struct{ tool, args, want string }{
		{"nope", `{}`, `unknown tool "nope"`},
		{"statement", `{}`, "sql_id: required"},
		{"statement", `{"sql_id":"zzzz"}`, "not in this trace"},
		{"statement", `{"sql_id":"@9999"}`, "the trace has"},
		{"statement", `{"sql_id":"@x"}`, "the trace has"},
		{"statement", `{"sqlid":"a"}`, "unknown field"},
		{"statement", `[1]`, "arguments"},
		{"statement", `{"sql_id":"@1"} {}`, "more than one"},
		{"statements", `{"sort":"fun"}`, "sort"},
		{"statements", `{"limit":101}`, "limit"},
		{"statements", `{"from":-1}`, "from"},
		{"statements", `{"contexts":[99]}`, "contexts"},
		{"executions", `{"sql_id":"@1","limit":10001}`, "limit"},
		{"executions", `{"sql_id":"@1","sort":"x"}`, "sort"},
		{"pivot", `{}`, "no dimension"},
		{"pivot", `{"by":["event"],"fact":"x"}`, "fact"},
		{"pivot", `{"by":["nonsense"]}`, "nonsense"},
		{"pivot", `{"by":["event"],"fact":"waits","event":"no such event"}`, "not in this trace"},
		{"timeline", `{"buckets":1}`, "buckets"},
		{"lines", `{"file":2}`, "not an input file"},
		{"lines", `{"n":501}`, "n:"},
		{"search_lines", `{}`, "q: required"},
		{"search_lines", `{"q":"(","regex":true}`, "regex"},
		{"notes", `{"kind":"x"}`, "kind"},
		{"current_view", `{"a":1}`, "unknown field"},
	} {
		_, err := Call(context.Background(), env, c.tool, json.RawMessage(c.args))
		var ae *ArgError
		if !errors.As(err, &ae) || !strings.Contains(ae.Msg, c.want) {
			t.Errorf("%s %s: %v, want an ArgError with %q", c.tool, c.args, err, c.want)
		}
	}
	// no arguments at all is the same as {}
	for _, args := range []string{"", "null", "  "} {
		if _, err := Call(context.Background(), env, "overview", json.RawMessage(args)); err != nil {
			t.Errorf("overview %q: %v", args, err)
		}
	}
}

func TestStmtIndex(t *testing.T) {
	env := loadEnv(t, "basic_binds", false)
	x := newStmtIndex(env.Model)
	for i := range env.Model.Statements {
		r := x.ref(model.ID(i))
		id, err := x.resolve(r)
		if err != nil || id != model.ID(i) {
			t.Errorf("statement %d: ref %q resolves to %d, %v", i, r, id, err)
		}
	}
	if r := x.ref(0); r != "@0" {
		t.Errorf("ref(0) = %q", r)
	}
}
