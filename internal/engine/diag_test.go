package engine

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/diag"
	"github.com/davidbudac/modern-tkprof/internal/opt"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

const (
	diagDir        = "../../testdata/diag/19c/"
	diagErrorstack = diagDir + "diag_errorstack_l2.trc"
	diagIn10046    = "../../testdata/traces/19c/diag_in_10046.trc"
)

type diagDocShape struct {
	Dump *struct {
		File   diag.File    `json:"file"`
		Digest *diag.Digest `json:"digest"`
	} `json:"dump"`
	Opt  json.RawMessage `json:"opt"`
	Diag struct {
		Notes []string `json:"notes"`
	} `json:"diag"`
	Statements []json.RawMessage `json:"statements"`
}

func envError(t *testing.T, body []byte) (code, msg string) {
	t.Helper()
	var v struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("not an envelope: %s", body)
	}
	return v.Error.Code, v.Error.Message
}

// TestDiagSession: a file of diagnostic dumps opens as a diag session by default, with the document's dump
// member, the three api/diag routes, and the file's lines and search.
func TestDiagSession(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{diagErrorstack}, nil)
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid, nil).body)
	if si.View != "diag" || si.OptSQLIDs != nil {
		t.Errorf("session view %q, optSqlIds %v", si.View, si.OptSQLIDs)
	}
	e.srv.mu.Lock()
	ev := e.srv.sessions[sid].event()
	e.srv.mu.Unlock()
	if ev.View != "diag" {
		t.Errorf("session event view %q", ev.View)
	}
	list := decode[struct{ Sessions []SessionInfo }](t, e.req("GET", "/engine/sessions", nil).body)
	if len(list.Sessions) != 1 || list.Sessions[0].View != "diag" {
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
	doc := decode[diagDocShape](t, r.body)
	if doc.Dump == nil || doc.Dump.File.Name != "diag_errorstack_l2.trc" || doc.Dump.Digest != nil || doc.Opt != nil || len(doc.Statements) != 0 {
		t.Fatalf("doc.dump: %+v", doc.Dump)
	}
	for _, n := range doc.Diag.Notes {
		if strings.Contains(n, "diagnostic dump") {
			t.Errorf("the section note is in the document of a diag file: %q", n)
		}
	}

	f := decode[diag.File](t, e.req("GET", "/s/"+sid+"/api/diag/file", nil).body)
	if f.Lines != doc.Dump.File.Lines || f.OutlineTotal != len(f.Outline) || len(f.Sections) != 1 || f.Sections[0].Kind != "diagdump" {
		t.Errorf("api/diag/file: %+v", f)
	}
	top := f.Outline[1]
	if top.Kind != "diagdump" || !top.HasChildren || top.Title != "Diagnostic dump (level 2)" {
		t.Fatalf("second top node: %+v", top)
	}
	o := decode[diag.Outline](t, e.req("GET", "/s/"+sid+"/api/diag/outline?node="+top.ID, nil).body)
	if o.Node != top.ID || len(o.Children) < 10 || o.More != 0 {
		t.Fatalf("outline of %s: %d children, more %d", top.ID, len(o.Children), o.More)
	}
	for _, c := range o.Children {
		if c.From < top.From || c.To > top.To {
			t.Errorf("child %s outside its parent", c.ID)
		}
	}
	root := decode[diag.Outline](t, e.req("GET", "/s/"+sid+"/api/diag/outline?node=root", nil).body)
	if len(root.Children) != len(f.Outline) {
		t.Errorf("root: %d children, outline %d", len(root.Children), len(f.Outline))
	}
	if r := e.req("GET", "/s/"+sid+"/api/diag/outline?node="+top.ID+"&after=5", nil); decode[diag.Outline](t, r.body).Children[0].ID != o.Children[5].ID {
		t.Errorf("after=5 does not skip 5 children")
	}
	for q, want := range map[string]int{"": 400, "?node=heap:1-99999999:1:200": 404, "?node=nonsense": 404, "?node=root&after=-1": 400, "?node=root&after=x": 400} {
		r := e.req("GET", "/s/"+sid+"/api/diag/outline"+q, nil)
		if r.code != want {
			t.Errorf("outline%s: %d, want %d (%s)", q, r.code, want, r.body)
		}
		envError(t, r.body)
	}
	r = e.req("GET", "/s/"+sid+"/api/diag/section?i=0", nil)
	if code, msg := envError(t, r.body); r.code != 404 || code != "not_found" || msg != "no reading for this kind of section" {
		t.Errorf("section: %d %s %q", r.code, code, msg)
	}
	if r := e.req("GET", "/s/"+sid+"/api/diag/section?i=9", nil); r.code != 404 {
		t.Errorf("section 9: %d", r.code)
	}
	if r := e.req("GET", "/s/"+sid+"/api/diag/section?i=x", nil); r.code != 400 {
		t.Errorf("section x: %d", r.code)
	}
	if r := e.req("GET", "/s/"+sid+"/api/diag/file", nil, "Authorization", ""); r.code != http.StatusUnauthorized {
		t.Errorf("without a token: %d", r.code)
	}

	// the text and search of the file
	lines := fileLines(t, diagErrorstack)
	r = e.req("GET", "/s/"+sid+"/api/lines?file=0&from=30&n=6&annot=1", nil)
	var al struct {
		Total int
		Lines []struct {
			T string
			K string
		}
	}
	if r.code != 200 || json.Unmarshal(r.body, &al) != nil || len(al.Lines) != 6 || al.Total != len(lines) {
		t.Fatalf("lines annot: %d %.200s", r.code, r.body)
	}
	if al.Lines[0].T != lines[29] || al.Lines[0].K == "diagnostic" || al.Lines[3].K != "diagnostic" {
		t.Errorf("kinds around the section start: %+v", al.Lines)
	}
	r = e.req("GET", "/s/"+sid+"/api/search?file=0&q=Binary+Stack+Dump", nil)
	if r.code != 200 || !strings.Contains(string(r.body), `"line":188`) || !strings.Contains(string(r.body), `"done":true`) {
		t.Errorf("search: %d %.200s", r.code, r.body)
	}

	// a 10046 session has none of it
	tid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	if v := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+tid, nil).body).View; v != "10046" {
		t.Errorf("10046 session view %q", v)
	}
	if r := e.req("GET", "/s/"+tid+"/api/doc", nil); bytes.Contains(r.body, []byte(`"dump":`)) {
		t.Errorf("10046 document has a dump member")
	}
	for _, route := range []string{"file", "outline?node=root", "section?i=0"} {
		r := e.req("GET", "/s/"+tid+"/api/diag/"+route, nil)
		if code, _ := envError(t, r.body); r.code != 404 || code != "not_found" {
			t.Errorf("10046 session %s: %d", route, r.code)
		}
	}
}

// TestDiagSessionHit: the same file again opens from the cache and serves the routes.
func TestDiagSessionHit(t *testing.T) {
	e := newEnv(t)
	e.openReady([]string{diagDir + "diag_hang.trc"}, nil)
	sid := e.openReady([]string{diagDir + "diag_hang.trc"}, nil)
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid, nil).body)
	if !si.Hit || si.View != "diag" {
		t.Errorf("hit %v view %q", si.Hit, si.View)
	}
	f := decode[diag.File](t, e.req("GET", "/s/"+sid+"/api/diag/file", nil).body)
	if f.Sections[0].Kind != "hang" {
		t.Errorf("sections %+v", f.Sections)
	}
}

// TestViewOption: view opens a single file another way.
func TestViewOption(t *testing.T) {
	e := newEnv(t)
	// diag on a 10046 trace with a dump inside: the records are runs of "SQL trace (10046) lines"
	sid := e.openReady([]string{diagIn10046}, map[string]any{"view": "diag"})
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid, nil).body)
	if si.View != "diag" {
		t.Errorf("view %q", si.View)
	}
	doc := decode[diagDocShape](t, e.req("GET", "/s/"+sid+"/api/doc", nil).body)
	if doc.Dump == nil || len(doc.Statements) != 0 {
		t.Fatalf("doc: %+v, %d statements", doc.Dump, len(doc.Statements))
	}
	if n := doc.Dump.File.Outline[1]; n.Kind != "trace10046" || n.Title != "SQL trace (10046) lines" {
		t.Errorf("second node %+v", n)
	}
	// the default for the same file: a 10046 session with a note, as before
	def := e.openReady([]string{diagIn10046}, nil)
	if v := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+def, nil).body).View; v != "10046" {
		t.Errorf("default view of a 10046 trace with a dump: %q", v)
	}
	if v := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+e.openReady([]string{diagErrorstack}, map[string]any{"view": "10046"}), nil).body).View; v != "10046" {
		t.Errorf("view 10046 of a dump file: %q", v)
	}

	// 10053 on the interleaved file: an optimizer session, the 10046 records skipped
	oid := e.openReady([]string{optInterleave}, map[string]any{"view": "10053"})
	oi := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+oid, nil).body)
	if oi.View != "10053" || len(oi.OptSQLIDs) == 0 {
		t.Errorf("interleaved with view 10053: view %q, optSqlIds %v", oi.View, oi.OptSQLIDs)
	}
	od := decode[optDocShape](t, e.req("GET", "/s/"+oid+"/api/doc", nil).body)
	if od.Opt == nil || od.Opt.File.Records10046 == 0 || len(od.Opt.File.Dumps) == 0 {
		t.Fatalf("doc.opt: %+v", od.Opt)
	}
	for _, n := range od.Diag.Notes {
		if strings.Contains(n, "not shown as 10053") {
			t.Errorf("dump note in a 10053 document: %q", n)
		}
	}
	if r := e.req("GET", "/s/"+oid+"/api/opt/dump?i=0", nil); r.code != 200 || decode[opt.Dump](t, r.body).Tree == nil {
		t.Errorf("opt dump: %d", r.code)
	}
	// and the default of the interleaved file is untouched
	if v := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+e.openReady([]string{optInterleave}, nil), nil).body).View; v != "10046" {
		t.Errorf("default view of the interleaved file: %q", v)
	}
	// an optimizer file by default is 10053
	if v := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+e.openReady([]string{optTwo}, nil), nil).body).View; v != "10053" {
		t.Errorf("default view of a 10053 file: %q", v)
	}
	// a file with nothing recognised: an outline of its header and "Other lines"
	did := e.openReady([]string{traces + "basic_binds.trc"}, map[string]any{"view": "diag"})
	if decode[diagDocShape](t, e.req("GET", "/s/"+did+"/api/doc", nil).body).Dump == nil {
		t.Errorf("diag view of a 10046 trace has no dump member")
	}
}

// TestViewRefusals: the combinations that cannot be, each in one line.
func TestViewRefusals(t *testing.T) {
	e := newEnv(t)
	open := func(paths []string, opts map[string]any) resp {
		return e.req("POST", "/engine/sessions", map[string]any{"paths": paths, "options": opts})
	}
	for _, tc := range []struct {
		paths []string
		opts  map[string]any
		want  string
	}{
		{[]string{diagErrorstack}, map[string]any{"view": "xml"}, `view: want 10046, 10053 or diag, not "xml"`},
		{[]string{diagErrorstack, diagDir + "diag_hang.trc"}, map[string]any{"view": "diag"}, "view diag opens one file, not a set of 2"},
		{[]string{optTwo, optInterleave}, map[string]any{"view": "10053"}, "view 10053 opens one file, not a set of 2"},
		{[]string{diagErrorstack}, map[string]any{"view": "diag", "follow": true}, "follow: view diag reads the file whole; it cannot be followed live: open it without follow"},
		{[]string{optTwo}, map[string]any{"view": "10053", "follow": true}, "follow: view 10053 reads the file whole"},
		{[]string{diagErrorstack}, map[string]any{"follow": true}, "follow: diag_errorstack_l2.trc holds diagnostic dumps only; it cannot be followed live: open it without follow"},
	} {
		r := open(tc.paths, tc.opts)
		_, msg := envError(t, r.body)
		if r.code != http.StatusBadRequest || !strings.Contains(msg, tc.want) {
			t.Errorf("%v %v: %d %s, want %q", tc.paths, tc.opts, r.code, r.body, tc.want)
		}
	}
	// view 10053 on a file with no dump: the session fails with one line
	o := e.open([]string{diagErrorstack}, map[string]any{"view": "10053"})
	si := e.wait(o.Session.ID)
	if si.State != SessionFailed || si.Error != "diag_errorstack_l2.trc holds no optimizer (10053) dump; it cannot be opened with view 10053" {
		t.Errorf("view 10053 without a dump: %s %q", si.State, si.Error)
	}
	// what a diag session does not do
	sid := e.openReady([]string{diagErrorstack}, nil)
	if r := e.req("POST", "/s/"+sid+"/api/brief", map[string]any{}); r.code != 400 || !strings.Contains(string(r.body), "diag file") {
		t.Errorf("brief: %d %s", r.code, r.body)
	}
	if r := e.req("POST", "/s/"+sid+"/api/assist/tools/show", nil); r.code != 400 || !strings.Contains(string(r.body), "diag file") {
		t.Errorf("assist tool: %d %s", r.code, r.body)
	}
	other := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	if r := e.req("GET", "/engine/compare?a="+sid+"&b="+other, nil); r.code != 400 || !strings.Contains(string(r.body), "diag file") {
		t.Errorf("compare: %d %s", r.code, r.body)
	}
	if r := e.req("GET", "/s/"+sid+"/api/report?format=csv", nil); r.code != 400 || !strings.Contains(string(r.body), "diag file") {
		t.Errorf("csv: %d %s", r.code, r.body)
	}
	// a view-10046 trace with a diag view opened explicitly is refused the same way
	d2 := e.openReady([]string{diagIn10046}, map[string]any{"view": "diag"})
	if r := e.req("POST", "/s/"+d2+"/api/brief", map[string]any{}); r.code != 400 {
		t.Errorf("brief of view diag on a 10046 trace: %d", r.code)
	}
}

// TestDiagReports: the text, JSON and HTML reports of a diag session carry the digest.
func TestDiagReports(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{diagDir + "diag_hang.trc"}, nil)
	txt := e.req("GET", "/s/"+sid+"/api/report", nil)
	if txt.code != 200 || !strings.Contains(string(txt.body), "Diagnostic dump file diag_hang.trc") || !strings.Contains(string(txt.body), "Hang analysis") {
		t.Errorf("text: %d %.300s", txt.code, txt.body)
	}
	js := decode[diagDocShape](t, e.req("GET", "/s/"+sid+"/api/report?format=json", nil).body)
	if js.Dump == nil || js.Dump.Digest == nil || len(js.Dump.Digest.Outline) != len(js.Dump.File.Outline) {
		t.Fatalf("json: %+v", js.Dump)
	}
	if ui.Built() {
		html := e.req("GET", "/s/"+sid+"/api/report?format=html", nil)
		if html.code != 200 || !bytes.Contains(html.body, []byte(`"digest":{"outline"`)) {
			t.Errorf("html: %d", html.code)
		}
	}
}

// TestDiagSets: a diag file in a set of 10046 files is left out with a note; a set of diag files opens as a
// diag session of the first.
func TestDiagSets(t *testing.T) {
	e := newEnv(t)
	o := e.open([]string{diagDir + "diag_hang.trc", diagDir + "diag_heap_pga.trc"}, nil)
	if si := e.wait(o.Session.ID); si.State != SessionReady {
		t.Fatalf("%s %s", si.State, si.Error)
	}
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+o.Session.ID, nil).body)
	doc := decode[diagDocShape](t, e.req("GET", "/s/"+o.Session.ID+"/api/doc", nil).body)
	if si.View != "diag" || len(si.Files) != 1 || doc.Dump == nil || doc.Dump.File.Name != "diag_hang.trc" {
		t.Fatalf("view %q files %+v", si.View, si.Files)
	}
	found := false
	for _, n := range doc.Diag.Notes {
		found = found || n == "diag_heap_pga.trc holds diagnostic dumps only; open it on its own"
		if strings.Contains(n, "diagnostic dump in this file") || strings.Contains(n, "hang analysis in this file") {
			t.Errorf("section note %q in a diag document", n)
		}
	}
	if !found {
		t.Errorf("notes %v", doc.Diag.Notes)
	}
	m := e.open([]string{diagDir + "diag_hang.trc", traces + "io_waits.trc"}, nil)
	if got := e.wait(m.Session.ID); got.State != SessionReady {
		t.Fatalf("mixed: %s", got.Error)
	}
	if v := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+m.Session.ID, nil).body).View; v != "10046" {
		t.Errorf("mixed set view %q", v)
	}
}
