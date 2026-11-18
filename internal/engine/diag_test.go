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
// member, the api/diag routes, and the file's lines and search.
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
	// a node without a reading: the file header
	r = e.req("GET", "/s/"+sid+"/api/diag/reading?node="+f.Outline[0].ID, nil)
	if code, msg := envError(t, r.body); r.code != 404 || code != "not_found" || msg != "no reading for this kind of section" {
		t.Errorf("reading of the file header: %d %s %q", r.code, code, msg)
	}
	// the diagnostic dump has one: the call stack
	if top.Reading != "callstack" {
		t.Errorf("node %s has reading %q", top.ID, top.Reading)
	}
	r = e.req("GET", "/s/"+sid+"/api/diag/reading?node="+top.ID, nil)
	if r.code != 200 {
		t.Fatalf("reading of a diagnostic dump: %d %s", r.code, r.body)
	}
	cs := decode[diag.CallStack](t, r.body)
	if cs.Kind != "callstack" || cs.Node != top.ID || cs.Statement == nil || cs.Statement.SQLID != "86trfcf9m9n9f" || len(cs.Frames) != 44 || cs.Own != 10 || cs.CursorsTotal != 15 || len(cs.Links) != 1 {
		t.Errorf("call stack reading: %.300s", r.body)
	}
	if !bytes.HasPrefix(r.body, []byte(`{"kind":"callstack"`)) {
		t.Errorf("the first field of the reading is not kind: %.60s", r.body)
	}
	// ... and so has the process state nested in it, by the link
	r = e.req("GET", "/s/"+sid+"/api/diag/reading?node="+cs.Links[0].Node, nil)
	ps := decode[diag.ProcState](t, r.body)
	if r.code != 200 || ps.Kind != "procstate" || len(ps.Sessions) != 1 || ps.Sessions[0].Key != "22.14058" || ps.Sessions[0].SqlID != "f3j90cdzgg7d2" {
		t.Errorf("process state reading: %d %.300s", r.code, r.body)
	}
	// the nodes that fold, and why
	folds := map[string]string{}
	for _, c := range o.Children {
		if c.Fold != "" {
			folds[c.Title] = c.Fold
		}
	}
	wantFolds := map[string]string{"Binary Stack Dump": "frame data: registers and memory of each frame", "Process Map Dump": "the process's memory map: address ranges of the binary and its libraries",
		"Argument/Register Address Dump": "memory around the arguments' and registers' addresses", "Pinned Buffer History": "block dumps of recently pinned buffers",
		"end of branch block dump": "block dump lines", "end of leaf block dump": "block dump lines", "end of leaf block Logical dump": "block dump lines"}
	if len(folds) != len(wantFolds) {
		t.Errorf("folds %v", folds)
	}
	for k, v := range wantFolds {
		if folds[k] != v {
			t.Errorf("node %q folds %q, want %q", k, folds[k], v)
		}
	}
	if top.Fold != "" {
		t.Errorf("a section has a fold: %q", top.Fold)
	}
	for q, want := range map[string]int{"": 400, "?node=heap:1-99999999:1:200": 404, "?node=nonsense": 404, "?node=root": 404} {
		r := e.req("GET", "/s/"+sid+"/api/diag/reading"+q, nil)
		if r.code != want {
			t.Errorf("reading%s: %d, want %d (%s)", q, r.code, want, r.body)
		}
		envError(t, r.body)
	}
	if r := e.req("GET", "/s/"+sid+"/api/diag/section?i=0", nil); r.code != 404 {
		t.Errorf("the old section route: %d", r.code)
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
	for _, route := range []string{"file", "outline?node=root", "reading?node=root", "reading/lines?node=root&comment=x"} {
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

// TestDiagReadings: a heap dump's reading by node, the lines of a comment, the errors, and the readings in
// the document made for a client without a server.
func TestDiagReadings(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{diagDir + "diag_heap_pga.trc"}, nil)
	f := decode[diag.File](t, e.req("GET", "/s/"+sid+"/api/diag/file", nil).body)
	heap := f.Outline[1]
	if heap.Kind != "heap" || heap.Reading != "heap" {
		t.Fatalf("second top node: %+v", heap)
	}
	if f.Outline[0].Reading != "" {
		t.Errorf("the header has a reading: %+v", f.Outline[0])
	}
	r := e.req("GET", "/s/"+sid+"/api/diag/reading?node="+heap.ID, nil)
	if r.code != 200 || !strings.HasPrefix(string(r.body), `{"kind":"heap","node":"`+heap.ID+`"`) {
		t.Fatalf("reading: %d %.200s", r.code, r.body)
	}
	if bytes.Contains(r.body, []byte("null")) {
		t.Errorf("a null in the reading")
	}
	h := decode[diag.HeapReading](t, r.body)
	if h.Name != "pga heap" || h.Chunks != 321 || len(h.Checks) != 3 {
		t.Fatalf("reading: %+v", h)
	}
	for _, c := range h.Checks {
		if c.State != diag.CheckMatch {
			t.Errorf("check %+v", c)
		}
	}
	c0 := h.ByComment[0]
	r = e.req("GET", "/s/"+sid+"/api/diag/reading/lines?node="+heap.ID+"&comment="+strings.ReplaceAll(c0.Comment, " ", "+"), nil)
	hl := decode[diag.HeapLines](t, r.body)
	if r.code != 200 || len(hl.Lines) != c0.Chunks || hl.Lines[0] != c0.Line || hl.More != 0 || hl.Total != c0.Chunks {
		t.Errorf("reading/lines: %d %d lines, first %v, more %d; the comment has %d chunks, first at %d", r.code, len(hl.Lines), hl.Lines, hl.More, c0.Chunks, c0.Line)
	}
	r = e.req("GET", "/s/"+sid+"/api/diag/reading/lines?node="+heap.ID+"&comment=perm&type=perm&after=300", nil)
	hl = decode[diag.HeapLines](t, r.body)
	if r.code != 200 || len(hl.Lines) == 0 || hl.Lines[0] <= 300 || hl.Total < len(hl.Lines) {
		t.Errorf("after: %d %+v", r.code, hl)
	}
	if r := e.req("GET", "/s/"+sid+"/api/diag/reading/lines?node="+heap.ID+"&type=free", nil); decode[diag.HeapLines](t, r.body).Total != 10 {
		t.Errorf("by type alone: %d %s", r.code, r.body)
	}
	for q, want := range map[string]int{"": 400, "?node=" + heap.ID: 400, "?node=nonsense&comment=x": 404, "?node=" + f.Outline[0].ID + "&comment=x": 404,
		"?node=" + heap.ID + "&comment=x&after=-1": 400, "?node=" + heap.ID + "&comment=x&after=z": 400} {
		r := e.req("GET", "/s/"+sid+"/api/diag/reading/lines"+q, nil)
		if r.code != want {
			t.Errorf("reading/lines%s: %d, want %d (%s)", q, r.code, want, r.body)
		}
		envError(t, r.body)
	}
	// the digest: the document made for a client without a server carries the readings of its nodes
	js := decode[diagDocShape](t, e.req("GET", "/s/"+sid+"/api/report?format=json", nil).body)
	if js.Dump == nil || js.Dump.Digest == nil || len(js.Dump.Digest.Readings) != 3 {
		t.Fatalf("digest readings: %+v", js.Dump)
	}
	var viaDoc diag.HeapReading
	if err := json.Unmarshal(js.Dump.Digest.Readings[heap.ID], &viaDoc); err != nil || viaDoc.Chunks != h.Chunks || len(viaDoc.ByComment) != len(h.ByComment) {
		t.Errorf("the reading in the document: %v %+v", err, viaDoc.Chunks)
	}
	// and the text report
	txt := e.req("GET", "/s/"+sid+"/api/report?format=text", nil)
	if !strings.Contains(string(txt.body), "Reading: heap \"pga heap\"") || !strings.Contains(string(txt.body), "match   chunks of the extents against Total heap size: 4,707,160 = 4,707,160 (line 679)") {
		t.Errorf("text report: %.600s", txt.body)
	}
	// a PGA summary and a nested heap are read by their nodes
	psid := e.openReady([]string{diagDir + "diag_pga_summary.trc"}, nil)
	pf := decode[diag.File](t, e.req("GET", "/s/"+psid+"/api/diag/file", nil).body)
	var pn diag.Node
	for _, n := range pf.Outline {
		if n.Reading == "pga-summary" {
			pn = n
		}
	}
	r = e.req("GET", "/s/"+psid+"/api/diag/reading?node="+pn.ID, nil)
	if r.code != 200 || !strings.HasPrefix(string(r.body), `{"kind":"pga-summary"`) {
		t.Fatalf("pga-summary: %d %.100s", r.code, r.body)
	}
	banner := decode[diag.Outline](t, e.req("GET", "/s/"+psid+"/api/diag/outline?node="+pn.ID, nil).body).Children[0]
	nested := decode[diag.Outline](t, e.req("GET", "/s/"+psid+"/api/diag/outline?node="+banner.ID, nil).body).Children
	if len(nested) != 1 || nested[0].Kind != "heap" || nested[0].Reading != "heap" {
		t.Fatalf("the sampled heap under the banner: %+v", nested)
	}
	nh := decode[diag.HeapReading](t, e.req("GET", "/s/"+psid+"/api/diag/reading?node="+nested[0].ID, nil).body)
	if !nh.Flags.Sampled || nh.Checks[0].State != diag.CheckNone || len(nh.Run) != 1 {
		t.Errorf("sampled heap: %+v", nh.Flags)
	}
}

// TestDiagMarks: the session object of a diag session names the statements and the sessions its file names
// (what a client marks when another tab holds the same), once it is ready, parallel to optSqlIds; a 10046
// session has neither.
func TestDiagMarks(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{diagErrorstack}, nil)
	si := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+sid, nil).body)
	if len(si.DiagSQLIDs) < 15 || si.DiagSQLIDs[0] != "86trfcf9m9n9f" || !contains(si.DiagSQLIDs, "f3j90cdzgg7d2") || !contains(si.DiagSQLIDs, "9zg9qd9bm4spu") {
		t.Errorf("diagSqlIds %v", si.DiagSQLIDs)
	}
	if len(si.DiagSessions) == 0 || si.DiagSessions[0] != "22.14058" || len(si.DiagSessions) != len(uniq(si.DiagSessions)) {
		t.Errorf("diagSessions %v", si.DiagSessions)
	}
	if si.OptSQLIDs != nil {
		t.Errorf("optSqlIds %v on a diag session", si.OptSQLIDs)
	}
	e.srv.mu.Lock()
	ev := e.srv.sessions[sid].event()
	e.srv.mu.Unlock()
	if len(ev.DiagSQLIDs) != len(si.DiagSQLIDs) || len(ev.DiagSessions) != len(si.DiagSessions) {
		t.Errorf("session event: %v %v", ev.DiagSQLIDs, ev.DiagSessions)
	}
	list := decode[struct{ Sessions []SessionInfo }](t, e.req("GET", "/engine/sessions", nil).body)
	if len(list.Sessions) != 1 || len(list.Sessions[0].DiagSQLIDs) != len(si.DiagSQLIDs) {
		t.Errorf("session list: %+v", list.Sessions)
	}
	raw := string(e.req("GET", "/engine/sessions/"+sid, nil).body)
	if !strings.Contains(raw, `"diagSqlIds":["86trfcf9m9n9f"`) || !strings.Contains(raw, `"diagSessions":["22.14058"`) {
		t.Errorf("the JSON names: %.400s", raw)
	}
	// a system state names the chain's sessions
	ss := e.openReady([]string{diagDir + "diag_sysstate_l1.trc"}, nil)
	sx := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+ss, nil).body)
	for _, k := range []string{"52.41898", "45.12004", "255.62769"} {
		if !contains(sx.DiagSessions, k) {
			t.Errorf("system state: diagSessions lacks %s", k)
		}
	}
	// a 10046 session
	ts := e.openReady([]string{"../../testdata/traces/19c/diag_in_10046.trc"}, map[string]any{"view": "10046"})
	ti := decode[SessionInfo](t, e.req("GET", "/engine/sessions/"+ts, nil).body)
	if ti.DiagSQLIDs != nil || ti.DiagSessions != nil || ti.View != "10046" {
		t.Errorf("a 10046 session names %v %v", ti.DiagSQLIDs, ti.DiagSessions)
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func uniq(l []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range l {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}
