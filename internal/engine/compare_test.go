package engine

import (
	"encoding/json"
	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/report"
)

func TestCompareSessions(t *testing.T) {
	e := newEnv(t)
	a := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	b := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	r := e.req("GET", "/engine/compare?a="+a+"&b="+b, nil)
	if r.code != 200 {
		t.Fatalf("compare: %d %s", r.code, r.body)
	}
	var doc report.CompareDocument
	if err := json.Unmarshal(r.body, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Format != 2 || doc.Compare.A == nil || doc.Compare.B == nil || len(doc.Compare.Diff.Statements) == 0 {
		t.Fatal("missing comparison data")
	}
	for _, metric := range doc.Compare.Diff.Totals {
		if metric.Delta != 0 {
			t.Fatalf("self comparison delta: %+v", metric)
		}
	}
	for _, tc := range []struct {
		query string
		code  int
	}{
		{"", 400}, {"?a=" + a + "&b=" + a, 400}, {"?a=" + a + "&b=missing", 404},
	} {
		if r := e.req("GET", "/engine/compare"+tc.query, nil); r.code != tc.code {
			t.Errorf("%s: %d, want %d", tc.query, r.code, tc.code)
		}
	}
	// A live source (even one with a snapshot) is not an immutable baseline.
	e.srv.mu.Lock()
	ss := e.srv.sessions[b]
	e.srv.mu.Unlock()
	ss.mu.Lock()
	ss.state = SessionLive
	ss.mu.Unlock()
	if r := e.req("GET", "/engine/compare?a="+a+"&b="+b, nil); r.code != 409 {
		t.Fatalf("live source: %d", r.code)
	}
	ss.mu.Lock()
	ss.state = SessionReady
	ss.mu.Unlock()
	e.req("DELETE", "/engine/sessions/"+b, nil)
	if r := e.req("GET", "/engine/compare?a="+a+"&b="+b, nil); r.code != 404 {
		t.Fatalf("closed source: %d", r.code)
	}
}

func TestCompareSessionsUsesExistingComparisonSemantics(t *testing.T) {
	e := newEnv(t)
	a := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	b := e.openReady([]string{traces + "io_waits.trc"}, nil)
	r := e.req("GET", "/engine/compare?a="+a+"&b="+b, nil)
	if r.code != 200 {
		t.Fatalf("compare: %d %s", r.code, r.body)
	}
	var doc report.CompareDocument
	if err := json.Unmarshal(r.body, &doc); err != nil {
		t.Fatal(err)
	}
	want := analyze.Compare(e.srv.sessions[a].op.co.Model, e.srv.sessions[b].op.co.Model)
	if !reflect.DeepEqual(doc.Compare.Diff, want) {
		t.Fatal("route changed the CLI comparison semantics")
	}
	if len(doc.Compare.Diff.Events) == 0 {
		t.Fatal("missing wait event deltas")
	}
}
