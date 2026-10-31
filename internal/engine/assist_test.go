package engine

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/assist"
)

func TestAssistToolsList(t *testing.T) {
	e := newEnv(t)
	r := e.req("GET", "/engine/assist/tools", nil)
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.body)
	}
	list := decode[struct{ Tools []assist.Info }](t, r.body)
	if len(list.Tools) != 10 || list.Tools[0].Name != "overview" || list.Tools[9].Name != "current_view" {
		t.Fatalf("%d tools: %+v", len(list.Tools), list.Tools)
	}
	for _, tl := range list.Tools {
		if tl.Description == "" || !json.Valid(tl.InputSchema) {
			t.Errorf("%s: %q %s", tl.Name, tl.Description, tl.InputSchema)
		}
	}
	if r := e.req("GET", "/engine/assist/tools", nil, "Authorization", ""); r.code != 401 {
		t.Errorf("without a token: %d", r.code)
	}
}

var valueToken = regexp.MustCompile(`value=(<[^>]*>)`)

// TestAssistToolRoute: the route runs the tools on a session, agrees with the
// slice routes, masks bind values by default and answers errors in the envelope.
func TestAssistToolRoute(t *testing.T) {
	e := newEnv(t)
	basic := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	types := e.openReady([]string{traces + "bind_types.trc"}, nil)
	tool := func(sid, name string, args any, q string, hdr ...string) resp {
		t.Helper()
		return e.req("POST", "/s/"+sid+"/api/assist/tools/"+name+q, args, hdr...)
	}

	r := tool(basic, "overview", nil, "")
	if r.code != 200 || r.hdr.Get("Content-Type") != "application/json" || r.hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("overview: %d %v", r.code, r.hdr)
	}
	if est, _ := strconv.Atoi(r.hdr.Get(estTokensHeader)); est != len(r.body)/4 || est == 0 {
		t.Errorf("estimate %q for %d bytes", r.hdr.Get(estTokensHeader), len(r.body))
	}
	ov := decode[struct {
		ResponseUs    int64
		Profile       []struct{ Event string }
		TopStatements []struct{ Ref string }
	}](t, r.body)
	prof := decode[analyze.ScopeProfile](t, e.req("GET", "/s/"+basic+"/api/profile", nil).body)
	if ov.ResponseUs != prof.ResponseUs || len(ov.Profile) == 0 || len(ov.TopStatements) != 10 {
		t.Errorf("overview %+v, route %d", ov, prof.ResponseUs)
	}

	// statement: the call table of /api/statements
	var sid string
	stmts := decode[statementsAnswer](t, e.req("GET", "/s/"+basic+"/api/statements", nil).body)
	for _, s := range ov.TopStatements[:1] {
		sid = s.Ref
	}
	r = tool(basic, "statement", map[string]any{"sql_id": sid}, "")
	st := decode[struct {
		ID        int
		CallTable struct{ Fetch analyze.CallStats }
	}](t, r.body)
	if r.code != 200 || st.CallTable.Fetch != stmts.Statements[st.ID].Fetch {
		t.Errorf("statement %s: %d fetch %+v, route %+v", sid, r.code, st.CallTable.Fetch, stmts.Statements[st.ID].Fetch)
	}

	// bind values: masked by default, as traced on request
	execs := func(q string) string {
		var all strings.Builder
		for i := 0; i < 30; i++ {
			r := tool(types, "executions", map[string]any{"sql_id": "@" + strconv.Itoa(i), "limit": 1000}, q)
			if r.code != 200 {
				break
			}
			all.Write(r.body)
		}
		return all.String()
	}
	if m := execs(""); strings.Contains(m, "29-FEB-24") || strings.Contains(m, "DEADBEEF") || !strings.Contains(m, "<TIMESTAMP len=11 h=") {
		t.Errorf("masked executions: %.600s", m)
	}
	if k := execs("?binds=keep"); !strings.Contains(k, "29-FEB-24 01.14.15.123457 PM") {
		t.Errorf("executions with binds=keep: %.600s", k)
	}
	lines := func(q string) string {
		var all strings.Builder
		for from := 1; from > 0; {
			r := tool(types, "lines", map[string]any{"from": from, "n": 500}, q)
			if r.code != 200 {
				t.Fatalf("lines: %d %s", r.code, r.body)
			}
			v := decode[struct {
				Text string
				Next int
			}](t, r.body)
			all.WriteString(v.Text)
			from = v.Next
		}
		return all.String()
	}
	if m := lines(""); strings.Contains(m, "value=29-FEB-24") || strings.Contains(m, "value=DEADBEEF") || !valueToken.MatchString(m) {
		t.Errorf("masked lines hold a value")
	}
	if k := lines("?binds=keep"); !strings.Contains(k, "value=29-FEB-24 01.14.15.123457 PM") {
		t.Errorf("lines with binds=keep lack the value")
	}

	// the envelope
	for _, c := range []struct {
		sid, name string
		args      any
		q         string
		hdr       []string
		code      int
		msg       string
	}{
		{basic, "nope", nil, "", nil, 400, "unknown tool"},
		{basic, "statement", map[string]any{"sql_id": "zzzz"}, "", nil, 400, "not in this trace"},
		{basic, "statement", map[string]any{"sqlid": "x"}, "", nil, 400, "unknown field"},
		{basic, "lines", map[string]any{"file": 9}, "", nil, 400, "not an input file"},
		{basic, "overview", nil, "?binds=all", nil, 400, "binds"},
		{basic, "overview", nil, "", []string{assist.ConversationHeader, strings.Repeat("c", 201)}, 400, "longer than"},
		{basic, "overview", nil, "", []string{"Authorization", ""}, 401, "bearer"},
		{"sdoesnotexist", "overview", nil, "", nil, 404, "no session"},
	} {
		r := tool(c.sid, c.name, c.args, c.q, c.hdr...)
		env := decode[struct{ Error Error }](t, r.body)
		if r.code != c.code || !strings.Contains(env.Error.Message, c.msg) {
			t.Errorf("%s %v: %d %s, want %d with %q", c.name, c.args, r.code, r.body, c.code, c.msg)
		}
	}
	if r := tool(basic, "overview", nil, "", assist.ConversationHeader, "c7"); r.code != http.StatusOK {
		t.Errorf("a conversation id: %d", r.code)
	}
}

type statementsAnswer struct {
	Statements []analyze.StmtStats `json:"statements"`
}

// TestAssistRedactedSession: a session opened with binds=redact holds tokens
// in its model; the tools show those, and the trace text of lines is masked
// with the same salt, so a value has one token everywhere.
func TestAssistRedactedSession(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "basic_binds.trc"}, map[string]any{"binds": "redact", "salt": "abc"})
	r := e.req("POST", "/s/"+sid+"/api/assist/tools/executions", map[string]any{"sql_id": "f6jyzt7462kx2", "limit": 1}, "")
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.body)
	}
	ex := decode[struct {
		Executions []struct{ Binds []struct{ Value string } }
	}](t, r.body)
	tok := ex.Executions[0].Binds[0].Value
	if !strings.HasPrefix(tok, "<NUMBER len=2 h=") {
		t.Fatalf("token %q", tok)
	}
	var all strings.Builder
	for from := 1; from > 0; {
		r := e.req("POST", "/s/"+sid+"/api/assist/tools/lines", map[string]any{"from": from, "n": 500})
		v := decode[struct {
			Text string
			Next int
		}](t, r.body)
		all.WriteString(v.Text)
		from = v.Next
	}
	if !strings.Contains(all.String(), "value="+tok) || strings.Contains(all.String(), "value=Customer 42") {
		t.Errorf("the token %s is not in the masked lines, or a value is", tok)
	}
}
