package engine

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

// TestBriefEndpoint: POST /s/{id}/api/brief answers what `mtkprof brief`
// prints for the same trace, scope and options (the CLI's model holds all
// facts, the session's is the aggregate one), for a session opened from
// scratch and one opened from the cache.
func TestBriefEndpoint(t *testing.T) {
	e := newEnv(t)
	for _, fx := range []string{"basic_binds.trc", "bind_types.trc", "multisession_a.trc"} {
		full, _ := cliModels(t, traces+fx)
		for _, pass := range []string{"parsed", "cached"} {
			sid := e.openReady([]string{traces + fx}, nil)
			if hit := e.wait(sid).Hit; hit != (pass == "cached") {
				t.Fatalf("%s %s: hit %v", fx, pass, hit)
			}
			post := func(body any) resp {
				t.Helper()
				return e.req("POST", "/s/"+sid+"/api/brief", body)
			}
			cli := func(f analyze.Filter, o report.BriefOptions) string {
				t.Helper()
				res, err := report.Brief(context.Background(), full, slice.MemSource(full), f, o)
				if err != nil {
					t.Fatal(err)
				}
				return res.Markdown
			}
			from := full.Span.FirstTim + (full.Span.LastTim-full.Span.FirstTim)/2
			note := report.Note{Kind: report.NoteWindow, Note: "WINDOWNOTE", From: from, To: full.Span.LastTim, Label: "second half"}
			for _, tc := range []struct {
				name string
				body any
				f    analyze.Filter
				o    report.BriefOptions
			}{
				{"empty", nil, analyze.Filter{}, report.BriefOptions{Salt: ""}},
				{"empty object", map[string]any{"options": map[string]any{"salt": "s"}}, analyze.Filter{}, report.BriefOptions{Salt: "s"}},
				{"keep", map[string]any{"options": map[string]any{"binds": "keep"}}, analyze.Filter{}, report.BriefOptions{Binds: report.BriefBindsKeep}},
				{"none", map[string]any{"options": map[string]any{"binds": "none", "maxStatements": 3, "maxSqlChars": 120, "maxPlanLines": -1}},
					analyze.Filter{}, report.BriefOptions{Binds: report.BriefBindsNone, MaxStatements: 3, MaxSQLChars: 120, MaxPlanLines: report.BriefNoPlans}},
				{"window", map[string]any{"scope": map[string]any{"from": from}, "options": map[string]any{"salt": "w"}},
					analyze.Filter{StartTim: from}, report.BriefOptions{Salt: "w"}},
				{"window to", map[string]any{"scope": map[string]any{"from": full.Span.FirstTim + 1, "to": from}, "options": map[string]any{"binds": "keep"}},
					analyze.Filter{StartTim: full.Span.FirstTim + 1, EndTim: from}, report.BriefOptions{Binds: report.BriefBindsKeep}},
				{"contexts", map[string]any{"scope": map[string]any{"contexts": []int{0}}, "options": map[string]any{"binds": "keep"}},
					analyze.Filter{Contexts: []model.ID{0}}, report.BriefOptions{Binds: report.BriefBindsKeep}},
				{"case and notes", map[string]any{"case": "the job is slow", "notes": []report.Note{note}, "options": map[string]any{"salt": "n"}},
					analyze.Filter{}, report.BriefOptions{Case: "the job is slow", Notes: []report.Note{note}, Salt: "n"}},
			} {
				r := post(tc.body)
				if r.code != 200 {
					t.Fatalf("%s %s %s: %d %s", fx, pass, tc.name, r.code, r.body)
				}
				if tc.o.Salt == "" && tc.o.Binds == report.BriefBindsMask { // random salts: only the shape can match
					if !strings.HasPrefix(string(r.body), "# Trace brief\n") || !strings.HasSuffix(string(r.body), "\n") || !strings.Contains(string(r.body), "\n## For the agent\n") {
						t.Errorf("%s %s %s: not a brief", fx, pass, tc.name)
					}
				} else if want := cli(tc.f, tc.o); string(r.body) != want {
					t.Errorf("%s %s %s: %d bytes, the CLI's brief has %d", fx, pass, tc.name, len(r.body), len(want))
				}
				if ct := r.hdr.Get("Content-Type"); ct != "text/markdown; charset=utf-8" {
					t.Errorf("%s %s %s: Content-Type %q", fx, pass, tc.name, ct)
				}
				if n := r.hdr.Get("X-Mtkprof-Est-Tokens"); n != strconv.Itoa(len(r.body)/4) {
					t.Errorf("%s %s %s: X-Mtkprof-Est-Tokens %q for %d bytes", fx, pass, tc.name, n, len(r.body))
				}
			}
		}
	}
}

func TestBriefEndpointErrors(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	path := "/s/" + sid + "/api/brief"
	for _, tc := range []struct {
		name string
		body any
	}{
		{"unknown field", map[string]any{"scope": map[string]any{"window": 1}}},
		{"binds", map[string]any{"options": map[string]any{"binds": "redact"}}},
		{"maxStatements", map[string]any{"options": map[string]any{"maxStatements": 51}}},
		{"maxPlanLines", map[string]any{"options": map[string]any{"maxPlanLines": -2}}},
		{"context", map[string]any{"scope": map[string]any{"contexts": []int{99}}}},
		{"negative context", map[string]any{"scope": map[string]any{"contexts": []int{-1}}}},
		{"to before from", map[string]any{"scope": map[string]any{"from": 9, "to": 3}}},
		{"negative from", map[string]any{"scope": map[string]any{"from": -1}}},
		{"note kind", map[string]any{"notes": []map[string]any{{"kind": "bogus", "note": "x"}}}},
		{"note without stmt", map[string]any{"notes": []map[string]any{{"kind": "statement", "note": "x"}}}},
		{"not an object", []int{1}},
	} {
		r := e.req("POST", path, tc.body)
		if r.code != 400 || !strings.Contains(string(r.body), `"bad_request"`) {
			t.Errorf("%s: %d %s", tc.name, r.code, r.body)
		}
	}
	if r := e.req("POST", path, nil, "Authorization", ""); r.code != http.StatusUnauthorized || !strings.Contains(string(r.body), `"unauthorized"`) {
		t.Errorf("no token: %d %s", r.code, r.body)
	}
	if r := e.req("POST", "/s/s-nope/api/brief", nil); r.code != http.StatusNotFound || !strings.Contains(string(r.body), `"not_found"`) {
		t.Errorf("no session: %d %s", r.code, r.body)
	}
	if r := e.req("GET", path, nil); r.code != http.StatusMethodNotAllowed && r.code != http.StatusNotFound {
		t.Errorf("GET: %d", r.code)
	}
	if r := e.req("DELETE", "/engine/sessions/"+sid, nil); r.code != 204 {
		t.Fatalf("close: %d", r.code)
	}
	if r := e.req("POST", path, nil); r.code != http.StatusNotFound || !strings.Contains(string(r.body), `"not_found"`) {
		t.Errorf("closed session: %d %s", r.code, r.body)
	}
}
