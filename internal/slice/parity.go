package slice

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// ParityQueries lists GET requests that exercise every slicing endpoint for
// model m (every pivot dimension, scope filter, statement and event, and the
// detail of the first executions of every statement, as listed by h). The
// parity tests (spill vs model, index cache vs spill) send each to two
// handlers and require equal answers.
func ParityQueries(m *model.Model, h http.Handler) ([]string, error) {
	var q []string
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	for _, fact := range []analyze.Fact{analyze.FactCalls, analyze.FactWaits} {
		for _, d := range analyze.Dims(fact) {
			q = append(q, fmt.Sprintf("/api/pivot?fact=%s&by=%s", fact, d.ID))
		}
		q = append(q,
			fmt.Sprintf("/api/pivot?fact=%s&by=stmt,session", fact),
			fmt.Sprintf("/api/pivot?fact=%s&by=time&from=%d&to=%d", fact, mid, m.Span.LastTim),
			fmt.Sprintf("/api/pivot?fact=%s&by=stmt&contexts=0", fact),
			fmt.Sprintf("/api/pivot?fact=%s&by=stmt&contexts=%d,0&idle=0", fact, len(m.Contexts)-1),
		)
	}
	q = append(q, "/api/pivot?fact=waits&by=callKind,class", "/api/pivot?fact=calls&by=dep,kind&limit=3")
	q = append(q, "/api/timeline", "/api/timeline?contexts=0", "/api/timeline?idle=0&bucket=1000",
		"/api/calls", "/api/calls?limit=7&longest=3", fmt.Sprintf("/api/calls?from=%d", mid),
		"/api/waits?scope=all", "/api/waits?scope=all&sort=tim&limit=10", "/api/waits/hist?scope=all",
		"/api/waits/scatter?scope=all", "/api/waits/scatter?scope=all&max=5", "/api/waits/by?scope=all&by=stmt",
		"/api/waits/by?scope=all&by=obj", "/api/waits/by?scope=all&by=p1&limit=3", "/api/waits/by?scope=all&by=p2",
		"/api/profile", "/api/profile?idle=0&contexts=0", fmt.Sprintf("/api/profile?from=%d", mid),
		fmt.Sprintf("/api/profile?from=%d&to=%d&contexts=0,%d", m.Span.FirstTim, mid, len(m.Contexts)-1), "/api/stmt/roles",
		"/api/statements", "/api/statements?contexts=-", "/api/statements?contexts=0", "/api/stmt/roles?contexts=0", "/api/stmt/roles?contexts=-&idle=0",
		"/api/timeline?contexts=-", "/api/profile?contexts=-", "/api/calls?contexts=-", "/api/pivot?fact=calls&by=stmt&contexts=-",
		"/api/pivot?fact=waits&by=event&contexts=-", "/api/waits?scope=all&contexts=-", fmt.Sprintf("/api/statements?contexts=%d", len(m.Contexts)-1),
		fmt.Sprintf("/api/statements?from=%d&to=%d", mid, m.Span.LastTim),
		"/api/io/map?limit=500", fmt.Sprintf("/api/io/map?limit=500&from=%d&contexts=0&idle=0", mid), "/api/io/map?contexts=-",
		"/api/io/map?limit=300&reads=1", "/api/io/hot", "/api/io/hot?limit=5&sort=max", "/api/io/hot?sort=us&contexts=0", fmt.Sprintf("/api/io/hot?from=%d", mid), "/api/io/hot?contexts=-",
		"/api/io/density", "/api/io/density?x=time&xbins=40&ybins=16", fmt.Sprintf("/api/io/density?x=time&from=%d&contexts=0", mid), "/api/io/density?contexts=-")
	for e := range m.Events {
		q = append(q, fmt.Sprintf("/api/waits?event=%d", e), fmt.Sprintf("/api/waits/hist?event=%d", e),
			fmt.Sprintf("/api/waits/scatter?event=%d&max=3", e), fmt.Sprintf("/api/waits/by?event=%d&by=p1", e),
			fmt.Sprintf("/api/profile?event=%d", e), fmt.Sprintf("/api/io/map?event=%d&limit=7", e), fmt.Sprintf("/api/io/hot?event=%d&limit=3", e),
			fmt.Sprintf("/api/io/density?event=%d&xbins=20&ybins=8", e))
	}
	var all []string
	for s := range m.Statements {
		all = append(all, fmt.Sprint(s))
		q = append(q, fmt.Sprintf("/api/pivot?fact=calls&by=kind&stmt=%d", s), fmt.Sprintf("/api/pivot?fact=waits&by=event&stmt=%d", s),
			fmt.Sprintf("/api/calls?stmt=%d", s), fmt.Sprintf("/api/waits?stmt=%d", s), fmt.Sprintf("/api/waits?stmt=%d&sort=tim", s),
			fmt.Sprintf("/api/waits/hist?stmt=%d", s), fmt.Sprintf("/api/waits/by?stmt=%d&by=obj", s),
			fmt.Sprintf("/api/timeline?stmt=%d", s), fmt.Sprintf("/api/profile?stmt=%d", s),
			fmt.Sprintf("/api/stmt/waits?stmt=%d", s), fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=1000", s),
			fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=1000&phases=1", s),
			fmt.Sprintf("/api/stmt/waitspans?stmt=%d&gap=1000", s), fmt.Sprintf("/api/stmt/waitspans?stmt=%d&gap=0&idle=0&contexts=0", s),
			fmt.Sprintf("/api/executions?stmt=%d", s), fmt.Sprintf("/api/executions?stmt=%d&sort=e&limit=5&offset=1", s),
			fmt.Sprintf("/api/executions?stmt=%d&sort=fetches", s),
			fmt.Sprintf("/api/executions?stmt=%d&contexts=0", s), fmt.Sprintf("/api/executions?stmt=%d&contexts=-", s),
			fmt.Sprintf("/api/executions?stmt=%d&from=%d&to=%d", s, mid, m.Span.LastTim),
			fmt.Sprintf("/api/stmt/waits?stmt=%d&contexts=0", s), fmt.Sprintf("/api/stmt/spans?stmt=%d&gap=1000&contexts=0", s),
			fmt.Sprintf("/api/waits?stmt=%d&contexts=0", s), fmt.Sprintf("/api/waits?stmt=%d&contexts=-", s),
			fmt.Sprintf("/api/io/map?stmt=%d", s), fmt.Sprintf("/api/io/map?stmt=%d&limit=3&contexts=0", s),
			fmt.Sprintf("/api/io/map?stmt=%d&limit=50&reads=1", s), fmt.Sprintf("/api/io/hot?stmt=%d", s), fmt.Sprintf("/api/io/density?stmt=%d&xbins=30&ybins=10", s))
	}
	if len(all) > 0 {
		q = append(q, "/api/stmt/waits?stmt="+strings.Join(all, ","), "/api/stmt/spans?stmt="+strings.Join(all, ",")+"&gap=0", "/api/stmt/spans?stmt="+strings.Join(all, ",")+"&gap=500&phases=1")
	}
	// every execution in detail, from the executions the server itself lists
	for s := range m.Statements {
		rec := &bufResponse{h: http.Header{}, code: 200}
		h.ServeHTTP(rec, &http.Request{Method: "GET", URL: mustURL(fmt.Sprintf("/api/executions?stmt=%d&limit=40", s)), Header: http.Header{}})
		if rec.code != 200 {
			continue
		}
		var er ExecResponse
		if err := json.Unmarshal(rec.body.Bytes(), &er); err != nil {
			return nil, err
		}
		for _, r := range er.Rows {
			q = append(q, fmt.Sprintf("/api/executions/detail?stmt=%d&cursor=%d&execNo=%d", s, r.Cursor, r.ExecNo),
				fmt.Sprintf("/api/executions/trace?stmt=%d&cursor=%d&execNo=%d", s, r.Cursor, r.ExecNo))
		}
	}
	return q, nil
}

// bufResponse is a minimal http.ResponseWriter (net/http/httptest registers
// a command-line flag, which a library must not do).
type bufResponse struct {
	h    http.Header
	code int
	body bytes.Buffer
}

func (r *bufResponse) Header() http.Header         { return r.h }
func (r *bufResponse) Write(b []byte) (int, error) { return r.body.Write(b) }
func (r *bufResponse) WriteHeader(code int)        { r.code = code }

func mustURL(s string) *url.URL {
	u, err := url.ParseRequestURI(s)
	if err != nil {
		panic(err)
	}
	return u
}
