package engine

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/opt"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

const (
	optDir        = "../../testdata/opt/19c/"
	optTwo        = optDir + "opt_two.trc"
	optInterleave = "../../testdata/traces/19c/opt_interleaved.trc"
)

func fileLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.TrimSuffix(string(b), "\n")
	return strings.Split(strings.ReplaceAll(s, "\r", ""), "\n")
}

type optDocShape struct {
	Opt *struct {
		File   opt.File `json:"file"`
		Digest *struct {
			Dumps []opt.Dump        `json:"dumps"`
			Lines []report.OptLines `json:"lines"`
		} `json:"digest"`
	} `json:"opt"`
	Diag struct {
		Notes []string `json:"notes"`
	} `json:"diag"`
}

// TestOptSession: a 10053 file is a session like any other, with the document's opt member, the two api/opt
// routes and optSqlIds; a 10046 session has neither.
func TestOptSession(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{optTwo}, nil)
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid, nil).body)
	if got := strings.Join(si.OptSQLIDs, ","); got != "267mhyr5wydy6,4c6x0jk0jpuzn" {
		t.Errorf("optSqlIds %q", got)
	}
	if si.Hit {
		t.Errorf("first open is a hit")
	}
	e.srv.mu.Lock()
	ev := e.srv.sessions[sid].event()
	e.srv.mu.Unlock()
	if len(ev.OptSQLIDs) != 2 {
		t.Errorf("session event: optSqlIds %v", ev.OptSQLIDs)
	}
	list := decode[struct{ Sessions []SessionInfo }](t, e.req("GET", "/engine/sessions", nil).body)
	if len(list.Sessions) != 1 || len(list.Sessions[0].OptSQLIDs) != 2 {
		t.Errorf("session list: %+v", list.Sessions)
	}

	r := e.req("GET", "/s/"+sid+"/api/doc", nil)
	if r.code != 200 {
		t.Fatalf("doc: %d %s", r.code, r.body)
	}
	if bytes.Contains(r.body, []byte("null")) {
		i := bytes.Index(r.body, []byte("null"))
		t.Errorf("a null in the document: ...%s...", r.body[max(0, i-80):i+10])
	}
	doc := decode[optDocShape](t, r.body)
	if doc.Opt == nil || doc.Opt.File.Name != "opt_two.trc" || len(doc.Opt.File.Dumps) != 2 || doc.Opt.Digest != nil {
		t.Fatalf("doc.opt: %+v", doc.Opt)
	}
	for _, n := range doc.Diag.Notes {
		if strings.Contains(n, "not shown as 10053") {
			t.Errorf("the 'not shown as 10053 yet' note is in the document of a 10053 file: %q", n)
		}
	}

	lines := fileLines(t, optTwo)
	for i, di := range doc.Opt.File.Dumps {
		d := decode[opt.Dump](t, e.req("GET", "/s/"+sid+"/api/opt/dump?i="+string(rune('0'+i)), nil).body)
		if d.SQLID != di.SQLID || d.Tree == nil || d.LineCount != di.LineCount {
			t.Errorf("dump %d: %s %v %d", i, d.SQLID, d.Tree != nil, d.LineCount)
		}
		r := e.req("GET", "/s/"+sid+"/api/opt/text?i="+string(rune('0'+i)), nil)
		if r.code != 200 || r.hdr.Get("Content-Type") != "text/plain; charset=utf-8" {
			t.Fatalf("text %d: %d %s", i, r.code, r.hdr.Get("Content-Type"))
		}
		got := strings.Split(string(r.body), "\n")
		if len(got) != di.LineCount {
			t.Fatalf("text %d: %d lines, lineCount %d", i, len(got), di.LineCount)
		}
		if got[0] != lines[di.ViewFrom-1] || got[len(got)-1] != lines[di.ViewTo-1] {
			t.Errorf("text %d: first/last line %q / %q, file %q / %q", i, got[0], got[len(got)-1], lines[di.ViewFrom-1], lines[di.ViewTo-1])
		}
		if strings.Contains(string(r.body), "\r") {
			t.Errorf("text %d has a CR", i)
		}
	}
	for _, q := range []string{"?i=2", "?i=-1", "?i=x", ""} {
		for _, route := range []string{"dump", "text"} {
			if r := e.req("GET", "/s/"+sid+"/api/opt/"+route+q, nil); r.code != http.StatusNotFound {
				t.Errorf("%s%s: %d, want 404", route, q, r.code)
			}
		}
	}
	if r := e.req("GET", "/s/"+sid+"/api/opt/dump?i=0", nil, "Authorization", ""); r.code != http.StatusUnauthorized {
		t.Errorf("without a token: %d", r.code)
	}

	// the same file again: from the cache, the routes still answer
	sid2 := e.openReady([]string{optTwo}, nil)
	si2 := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid2, nil).body)
	if !si2.Hit {
		t.Errorf("second open is not a cache hit")
	}
	if len(si2.OptSQLIDs) != 2 {
		t.Errorf("hit: optSqlIds %v", si2.OptSQLIDs)
	}
	if r := e.req("GET", "/s/"+sid2+"/api/opt/text?i=1", nil); r.code != 200 || len(strings.Split(string(r.body), "\n")) != doc.Opt.File.Dumps[1].LineCount {
		t.Errorf("hit: text: %d", r.code)
	}
	d2 := decode[optDocShape](t, e.req("GET", "/s/"+sid2+"/api/doc", nil).body)
	if d2.Opt == nil || len(d2.Opt.File.Dumps) != 2 {
		t.Errorf("hit: doc.opt %+v", d2.Opt)
	}

	// a 10046 session: no optSqlIds, no opt, both routes 404
	tid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	ti := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+tid, nil).body)
	if ti.OptSQLIDs != nil {
		t.Errorf("10046 session: optSqlIds %v", ti.OptSQLIDs)
	}
	if r := e.req("GET", "/s/"+tid+"/api/doc", nil); bytes.Contains(r.body, []byte(`"opt"`)) {
		t.Errorf("10046 document has an opt member")
	}
	for _, route := range []string{"dump", "text"} {
		if r := e.req("GET", "/s/"+tid+"/api/opt/"+route+"?i=0", nil); r.code != http.StatusNotFound {
			t.Errorf("10046 session %s: %d, want 404", route, r.code)
		}
	}
}

// TestOptInterleavedSession: an interleaved file is a 10046 session with the note.
func TestOptInterleavedSession(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{optInterleave}, nil)
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid, nil).body)
	if si.OptSQLIDs != nil {
		t.Errorf("optSqlIds %v on an interleaved file", si.OptSQLIDs)
	}
	r := e.req("GET", "/s/"+sid+"/api/doc", nil)
	doc := decode[optDocShape](t, r.body)
	if doc.Opt != nil {
		t.Errorf("an interleaved file has doc.opt")
	}
	found := false
	for _, n := range doc.Diag.Notes {
		found = found || strings.Contains(n, "optimizer (10053) dump")
	}
	if !found {
		t.Errorf("no dump note: %v", doc.Diag.Notes)
	}
	if r := e.req("GET", "/s/"+sid+"/api/opt/dump?i=0", nil); r.code != http.StatusNotFound {
		t.Errorf("dump route of an interleaved file: %d", r.code)
	}
}

// TestOptMixedSet: a 10053 file in a set of 10046 files is left out with a note, and the files of the
// session (the cache entry, the line indexes) are those that stay.
func TestOptMixedSet(t *testing.T) {
	e := newEnv(t)
	plain := e.openReady([]string{traces + "io_waits.trc"}, nil)
	mixed := e.open([]string{optTwo, traces + "io_waits.trc"}, nil)
	if got := e.wait(mixed.Session.ID); got.State != SessionReady {
		t.Fatalf("mixed: %s %s", got.State, got.Error)
	}
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+mixed.Session.ID, nil).body)
	if len(si.Files) != 1 || si.Files[0].Name != "io_waits.trc" {
		t.Errorf("files %+v", si.Files)
	}
	if !si.Hit {
		t.Errorf("the set of io_waits.trc and a 10053 file is not the cache entry of io_waits.trc alone")
	}
	if si.OptSQLIDs != nil {
		t.Errorf("optSqlIds %v", si.OptSQLIDs)
	}
	doc := decode[optDocShape](t, e.req("GET", "/s/"+mixed.Session.ID+"/api/doc", nil).body)
	if doc.Opt != nil {
		t.Errorf("doc.opt in a set of 10046 files")
	}
	note := false
	for _, n := range doc.Diag.Notes {
		note = note || n == "opt_two.trc is a 10053 file; open it on its own"
	}
	if !note {
		t.Errorf("notes %v", doc.Diag.Notes)
	}
	want := fileLines(t, traces+"io_waits.trc")
	for _, id := range []string{plain, mixed.Session.ID} {
		r := e.req("GET", "/s/"+id+"/api/lines?file=0&from=5&n=3", nil)
		if r.code != 200 {
			t.Fatalf("lines: %d %s", r.code, r.body)
		}
		got := strings.Split(strings.TrimSuffix(string(r.body), "\n"), "\n")
		if len(got) != 3 || got[0] != want[4] || got[2] != want[6] {
			t.Errorf("api/lines of the kept file: %q", got)
		}
		if r := e.req("GET", "/s/"+id+"/api/lines?file=1&from=1&n=1", nil); r.code != http.StatusNotFound {
			t.Errorf("a second file: %d", r.code)
		}
	}
}

// TestOptTwoFiles: a set of 10053 files opens the first and names the others.
func TestOptTwoFiles(t *testing.T) {
	e := newEnv(t)
	o := e.open([]string{optTwo, optDir + "opt_dml.trc"}, nil)
	if si := e.wait(o.Session.ID); si.State != SessionReady {
		t.Fatalf("%s %s", si.State, si.Error)
	}
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+o.Session.ID, nil).body)
	if len(si.Files) != 1 || si.Files[0].Name != "opt_two.trc" {
		t.Errorf("files %+v", si.Files)
	}
	doc := decode[optDocShape](t, e.req("GET", "/s/"+o.Session.ID+"/api/doc", nil).body)
	if doc.Opt == nil || doc.Opt.File.Name != "opt_two.trc" {
		t.Fatalf("doc.opt %+v", doc.Opt)
	}
	ok := false
	for _, n := range doc.Diag.Notes {
		ok = ok || n == "opt_dml.trc is a 10053 file; open it on its own"
	}
	if !ok {
		t.Errorf("notes %v", doc.Diag.Notes)
	}
}

// TestOptReports: the text, JSON and HTML reports of a 10053 session carry the digest, redacted as the
// session was opened.
func TestOptReports(t *testing.T) {
	binds := optDir + "opt_subq_binds.trc"
	e := newEnv(t)
	sid := e.openReady([]string{binds}, nil)
	txt := e.req("GET", "/s/"+sid+"/api/report", nil)
	if txt.code != 200 || !strings.Contains(string(txt.body), "OPTIMIZER DUMP 1") || !strings.Contains(string(txt.body), "= 11   (line") {
		t.Errorf("text: %d %.200s", txt.code, txt.body)
	}
	js := decode[optDocShape](t, e.req("GET", "/s/"+sid+"/api/report?format=json", nil).body)
	if js.Opt == nil || js.Opt.Digest == nil || len(js.Opt.Digest.Dumps) != len(js.Opt.File.Dumps) {
		t.Fatalf("json: %+v", js.Opt)
	}
	lines := fileLines(t, binds)
	for _, run := range js.Opt.Digest.Lines {
		for k, s := range run.Text {
			if s != lines[run.From+k-1] {
				t.Fatalf("digest line %d: %q, file %q", run.From+k, s, lines[run.From+k-1])
			}
		}
	}
	if ui.Built() {
		html := e.req("GET", "/s/"+sid+"/api/report?format=html", nil)
		if html.code != 200 || !bytes.Contains(html.body, []byte(`"digest":{"dumps"`)) {
			t.Errorf("html: %d", html.code)
		}
	}
	if r := e.req("GET", "/s/"+sid+"/api/report?format=csv", nil); r.code != 400 {
		t.Errorf("csv of a 10053 file: %d", r.code)
	}

	red := e.openReady([]string{binds}, map[string]any{"binds": "redact", "salt": "s"})
	txt = e.req("GET", "/s/"+red+"/api/report", nil)
	if strings.Contains(string(txt.body), "= 11   (line") || !strings.Contains(string(txt.body), "<NUMBER len=2 h=") {
		t.Errorf("redacted text: %.1500s", txt.body)
	}
	none := e.openReady([]string{binds}, map[string]any{"binds": "none"})
	txt = e.req("GET", "/s/"+none+"/api/report", nil)
	if strings.Contains(string(txt.body), "= 11   (line") || !strings.Contains(string(txt.body), "values left out") {
		t.Errorf("text without binds: %.1500s", txt.body)
	}
}

// TestOptRefusals: what a 10053 session does not do.
func TestOptRefusals(t *testing.T) {
	e := newEnv(t)
	r := e.req("POST", "/engine/sessions", map[string]any{"paths": []string{optTwo}, "options": map[string]any{"follow": true}})
	if r.code != http.StatusBadRequest || !strings.Contains(string(r.body), "10053 file") {
		t.Errorf("follow: %d %s", r.code, r.body)
	}
	sid := e.openReady([]string{optTwo}, nil)
	if r := e.req("POST", "/s/"+sid+"/api/brief", map[string]any{}); r.code != http.StatusBadRequest || !strings.Contains(string(r.body), "10053") {
		t.Errorf("brief: %d %s", r.code, r.body)
	}
	if r := e.req("POST", "/s/"+sid+"/api/assist/tools/show", nil); r.code != http.StatusBadRequest || !strings.Contains(string(r.body), "10053") {
		t.Errorf("assist tool: %d %s", r.code, r.body)
	}
	other := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	if r := e.req("GET", "/engine/compare?a="+sid+"&b="+other, nil); r.code != http.StatusBadRequest || !strings.Contains(string(r.body), "10053") {
		t.Errorf("compare: %d %s", r.code, r.body)
	}
}

// TestOptDocJSONStable: the document of an ordinary file has no opt member and is what it was.
func TestOptDocJSONUnchanged(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	var m map[string]json.RawMessage
	if err := json.Unmarshal(e.req("GET", "/s/"+sid+"/api/doc", nil).body, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["opt"]; ok {
		t.Errorf("opt in an ordinary document")
	}
}
