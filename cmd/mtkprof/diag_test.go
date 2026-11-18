package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/diag"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

const (
	diagFixtures    = "../../testdata/diag/19c/"
	diagIn10046Path = "../../testdata/traces/19c/diag_in_10046.trc"
)

type diagDoc struct {
	Dump *struct {
		File   diag.File    `json:"file"`
		Digest *diag.Digest `json:"digest"`
	} `json:"dump"`
	Opt        json.RawMessage   `json:"opt"`
	Statements []json.RawMessage `json:"statements"`
	Diag       struct {
		Notes []string `json:"notes"`
	} `json:"diag"`
}

// TestDiagReportEveryFixture: mtkprof report of each diag fixture prints the digest.
func TestDiagReportEveryFixture(t *testing.T) {
	files, err := filepath.Glob(diagFixtures + "*.trc")
	if err != nil || len(files) == 0 {
		t.Fatal(err, "no fixtures")
	}
	for _, f := range files {
		out := runTo(t, cmdReport, f)
		name := filepath.Base(f)
		if !strings.HasPrefix(out, "Diagnostic dump file "+name+"\n") || !strings.Contains(out, "Outline: first-last line") {
			t.Errorf("%s: %.200s", name, out)
		}
		if strings.Contains(out, "Oracle SQL trace profile") {
			t.Errorf("%s: the 10046 report", name)
		}
	}
}

// TestDiagDocument: json and html carry dump.file and dump.digest; the document is that of an empty model.
func TestDiagDocument(t *testing.T) {
	f := diagFixtures + "diag_hang.trc"
	var doc diagDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, f)), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Dump == nil || doc.Dump.File.Name != "diag_hang.trc" || doc.Dump.Digest == nil || len(doc.Dump.Digest.Outline) != doc.Dump.File.OutlineTotal || len(doc.Statements) != 0 || doc.Opt != nil {
		t.Fatalf("doc: %+v", doc.Dump)
	}
	for _, n := range doc.Diag.Notes {
		if strings.Contains(n, "hang analysis") {
			t.Errorf("section note in a diag document: %q", n)
		}
	}
	// the digest has the children of the hang analysis
	found := false
	for _, n := range doc.Dump.Digest.Outline {
		if n.Kind == "hang" && len(n.Children) == 4 {
			found = true
		}
	}
	if !found {
		t.Errorf("digest: %+v", doc.Dump.Digest.Outline)
	}
	if !ui.Built() {
		t.Skip("no web UI built")
	}
	out := filepath.Join(t.TempDir(), "x.html")
	if err := cmdHTML([]string{f, "-o", out}); err != nil {
		t.Fatal(err)
	}
	html, err := os.ReadFile(out)
	if err != nil || !bytes.Contains(html, []byte(`"digest":{"outline"`)) {
		t.Errorf("html: %v", err)
	}
}

// TestDiagDefault: the default command writes <trace>.txt (the digest) and <trace>.html.
func TestDiagDefault(t *testing.T) {
	dir := t.TempDir()
	trc := filepath.Join(dir, "d.trc")
	data, err := os.ReadFile(diagFixtures + "diag_heap_large.trc")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(trc, data, 0o644)
	if err := cmdDefault([]string{trc}); err != nil {
		t.Fatal(err)
	}
	txt, _ := os.ReadFile(trc + ".txt")
	if !strings.Contains(string(txt), "Diagnostic dump file d.trc") {
		t.Errorf("txt: %.200s", txt)
	}
	if ui.Built() {
		html, err := os.ReadFile(trc + ".html")
		if err != nil || !bytes.Contains(html, []byte(`"digest":{"outline"`)) {
			t.Errorf("html: %v", err)
		}
	}
}

// TestViewFlag: -view opens a single file another way.
func TestViewFlag(t *testing.T) {
	var doc diagDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, diagIn10046Path, "-view", "diag")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Dump == nil || len(doc.Statements) != 0 || doc.Dump.File.Outline[1].Kind != "trace10046" {
		t.Fatalf("view diag on a 10046 trace: %+v", doc.Dump)
	}
	out := runTo(t, cmdReport, diagIn10046Path, "-view", "diag")
	if !strings.Contains(out, "SQL trace (10046) lines") {
		t.Errorf("report -view diag: %.300s", out)
	}
	// the default for the same file is the 10046 report
	if out := runTo(t, cmdReport, diagIn10046Path); !strings.Contains(out, "Oracle SQL trace profile") {
		t.Errorf("default: %.200s", out)
	}
	// 10053 on the interleaved file
	var od optDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, optInterleaved, "-view", "10053")), &od); err != nil {
		t.Fatal(err)
	}
	if od.Opt == nil || od.Opt.File.Records10046 == 0 || len(od.Opt.File.Dumps) == 0 {
		t.Errorf("interleaved with -view 10053: %+v", od.Opt)
	}
	if out := runTo(t, cmdReport, optInterleaved, "-view", "10053"); !strings.Contains(out, "OPTIMIZER DUMP 1") {
		t.Errorf("report -view 10053: %.200s", out)
	}
	// the refusals (with -o: a command that fails after opening its output must not close stdout)
	o := filepath.Join(t.TempDir(), "o")
	for _, tc := range []struct {
		run  func() error
		want string
	}{
		{func() error { return cmdReport([]string{diagFixtures + "diag_hang.trc", "-view", "10053", "-o", o}) }, "diag_hang.trc holds no optimizer (10053) dump; it cannot be opened with view 10053"},
		{func() error {
			return cmdReport([]string{diagFixtures + "diag_hang.trc", diagFixtures + "diag_heap_pga.trc", "-view", "diag", "-o", o})
		}, "view diag opens one file, not a set of 2"},
		{func() error {
			return cmdJSON([]string{optInterleaved, optFixtures + "opt_two.trc", "-view", "10053", "-o", o})
		}, "view 10053 opens one file, not a set of 2"},
	} {
		err := tc.run()
		if err == nil || err.Error() != tc.want {
			t.Errorf("want %q, got %v", tc.want, err)
		}
	}
	viewReq = ""
}

// TestDiagRefusals: the commands that have nothing to show for a diag file say so, in one line.
func TestDiagRefusals(t *testing.T) {
	f := diagFixtures + "diag_hang.trc"
	dir := t.TempDir()
	for name, run := range map[string]func() error{
		"pivot":     func() error { return cmdPivot([]string{f}) },
		"export":    func() error { return cmdExport([]string{f, "-o", filepath.Join(dir, "csv")}) },
		"plan":      func() error { return cmdPlan([]string{f, "-list"}) },
		"refscript": func() error { return cmdRefScript([]string{f}) },
		"brief":     func() error { return cmdBrief([]string{f}) },
		"compare":   func() error { return cmdCompare([]string{f, f}) },
		"mcp":       func() error { return cmdMCP([]string{f}) },
	} {
		err := run()
		if err == nil || !strings.Contains(err.Error(), "diag_hang.trc") || !strings.Contains(err.Error(), "diag") || strings.Contains(err.Error(), "\n") {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := cmdPivot([]string{f}); err == nil || err.Error() != "diag_hang.trc is a diag file (diagnostic dumps, no SQL trace records): nothing to pivot; mtkprof report prints its digest" {
		t.Errorf("pivot: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "csv")); err == nil {
		t.Errorf("export wrote something")
	}
}

// TestDiagSets: a diag file in a set of 10046 files is left out with a note; of diag files the first is read.
func TestDiagSets(t *testing.T) {
	var doc diagDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, diagFixtures+"diag_hang.trc", "../../testdata/traces/19c/basic_binds.trc")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Dump != nil || len(doc.Diag.Notes) != 1 || doc.Diag.Notes[0] != "diag_hang.trc holds diagnostic dumps only; open it on its own" {
		t.Errorf("mixed: %v", doc.Diag.Notes)
	}
	doc = diagDoc{}
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, diagFixtures+"diag_hang.trc", diagFixtures+"diag_heap_pga.trc")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Dump == nil || doc.Dump.File.Name != "diag_hang.trc" || len(doc.Diag.Notes) != 1 || doc.Diag.Notes[0] != "diag_heap_pga.trc holds diagnostic dumps only; open it on its own" {
		t.Errorf("only diag: %v", doc.Diag.Notes)
	}
}

// TestDiagServe: serve answers the document (dump.file, no digest), the routes, lines and search.
func TestDiagServe(t *testing.T) {
	f, err := filepath.Abs(diagFixtures + "diag_hang.trc")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperMain$")
	cmd.Env = append(os.Environ(), "MTKPROF_TEST_MAIN="+strings.Join([]string{"serve", f, "-addr", addr}, "\x1f"))
	var logb bytes.Buffer
	cmd.Stderr = &logb
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	get := func(path string) (int, http.Header, []byte) {
		for i := 0; ; i++ {
			r, err := http.Get("http://" + addr + path)
			if err == nil {
				defer r.Body.Close()
				b, _ := io.ReadAll(r.Body)
				return r.StatusCode, r.Header, b
			}
			if i > 200 {
				t.Fatalf("%v\n%s", err, logb.String())
			}
			time.Sleep(25 * time.Millisecond)
		}
	}
	code, _, body := get("/api/doc")
	var doc diagDoc
	if err := json.Unmarshal(body, &doc); code != 200 || err != nil || doc.Dump == nil || doc.Dump.Digest != nil {
		t.Fatalf("doc: %d %v", code, err)
	}
	code, h, body := get("/api/diag/file")
	var file diag.File
	if err := json.Unmarshal(body, &file); code != 200 || err != nil || h.Get("Content-Type") != "application/json" || file.Name != "diag_hang.trc" {
		t.Fatalf("file: %d %v", code, err)
	}
	hang := file.Outline[2]
	code, _, body = get("/api/diag/outline?node=" + hang.ID)
	var o diag.Outline
	if err := json.Unmarshal(body, &o); code != 200 || err != nil || len(o.Children) != 4 {
		t.Fatalf("outline: %d %v %s", code, err, body)
	}
	code, _, body = get("/api/diag/reading?node=" + hang.ID)
	if code != 200 || !strings.HasPrefix(string(body), `{"kind":"hang","node":`) {
		t.Errorf("reading of a hang analysis: %d %.100s", code, body)
	}
	// a part of the analysis has none
	code, _, body = get("/api/diag/reading?node=" + o.Children[0].ID)
	if code != 404 || !strings.Contains(string(body), "no reading for this kind of section") {
		t.Errorf("reading of a part of a hang analysis: %d %s", code, body)
	}
	// the path of a line inside the second chain: the hang analysis, the group it is in, the chain
	code, _, body = get("/api/diag/path?line=200")
	var pth diag.Path
	if err := json.Unmarshal(body, &pth); code != 200 || err != nil || len(pth.Nodes) < 2 || pth.Nodes[0].ID != hang.ID || pth.Nodes[len(pth.Nodes)-1].Kind != "chain" {
		t.Errorf("path: %d %v %s", code, err, body)
	}
	if code, _, _ := get("/api/diag/path"); code != 400 {
		t.Errorf("path without a line: %d", code)
	}
	if code, _, _ := get("/api/diag/path?line=999999"); code != 404 {
		t.Errorf("path of a line past the end: %d", code)
	}
	if code, _, _ := get("/api/diag/reading"); code != 400 {
		t.Errorf("reading without a node: %d", code)
	}
	if code, _, _ := get("/api/diag/reading/lines?node=" + hang.ID); code != 400 {
		t.Errorf("reading/lines without a comment: %d", code)
	}
	if code, _, _ := get("/api/diag/section?i=0"); code != 404 {
		t.Errorf("the old section route: %d", code)
	}
	if code, _, _ := get("/api/diag/outline?node=heap:1-9999999:1:200"); code != 404 {
		t.Errorf("outline of a node past the end: %d", code)
	}
	code, _, body = get("/api/lines?file=0&from=42&n=2&annot=1")
	if code != 200 || !strings.Contains(string(body), `"diagnostic"`) {
		t.Errorf("lines: %d %.200s", code, body)
	}
	code, _, body = get("/api/search?file=0&q=END+OF+HANG+ANALYSIS")
	if code != 200 || !strings.Contains(string(body), `"line":254`) {
		t.Errorf("search: %d %.200s", code, body)
	}
}

// TestDiagReportHeap: the text report of a heap dump has the reading under its node: the checks against the
// totals, the types and comments.
func TestDiagReportHeap(t *testing.T) {
	out := runTo(t, cmdReport, diagFixtures+"diag_heap_pga.trc")
	for _, want := range []string{
		`Reading: heap "pga heap", desc 0x7f952ce9a220, depth 0, pdb id 0`,
		"match   chunks of the extents against Total heap size: 4,707,160 = 4,707,160 (line 679)",
		"match   chunks of the free lists against Total free space: 49,560 = 49,560 (line 716)",
		"match   perm chunks under PERMANENT CHUNKS against Permanent space: 392,464 = 392,464 (line 921)",
		"By type:", "By comment (15 of 58, most bytes first):", "koh-kghu call", "Sub-heaps: 14",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the report of diag_heap_pga lacks %q", want)
		}
	}
	// the document carries the same readings
	var doc diagDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, diagFixtures+"diag_heap_pga.trc")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Dump == nil || doc.Dump.Digest == nil || len(doc.Dump.Digest.Readings) != 3 {
		t.Fatalf("document: %+v", doc.Dump)
	}
	pd := runTo(t, cmdReport, diagFixtures+"diag_pga_detail.trc")
	if !strings.Contains(pd, "Reading: PGA memory detail for pid 6, OS pid 14085") || !strings.Contains(pd, "3,512,312") {
		t.Errorf("the report of diag_pga_detail: %.400s", pd)
	}
}

// TestDiagRedaction: -redact-binds and -binds none act on the bind values of the cursor dumps in the text
// digest and in the document's readings, with the token the 10046 redaction makes of the same value; the
// default keeps them.
func TestDiagRedaction(t *testing.T) {
	data, err := os.ReadFile(diagFixtures + "diag_errorstack_l2.trc")
	if err != nil {
		t.Fatal(err)
	}
	const secret = "Pa55w0rd-S3cr3t-9981"
	old := `value="alter session set events 'immediate trace name errorstack level 2'"`
	if bytes.Count(data, []byte(old)) != 1 {
		t.Fatal("the bind value line moved")
	}
	trc := filepath.Join(t.TempDir(), "secret.trc")
	if err := os.WriteFile(trc, bytes.Replace(data, []byte(old), []byte(`value="`+secret+`"`), 1), 0o644); err != nil {
		t.Fatal(err)
	}
	// the 10046 token for the same value: a VARCHAR2 bind of the same actual length (66)
	token := model.RedactToken("VARCHAR2", secret, 66, "")
	salted := model.RedactToken("VARCHAR2", secret, 66, "pepper")
	b := &model.Bind{Dty: 1, Avl: 66, Value: secret}
	if got := model.RedactedValueSalt(b, ""); got != token {
		t.Fatalf("the 10046 token %s is not %s", got, token)
	}
	// the document writes the angle brackets of a token as they are or escaped, by the encoder it was made with
	has := func(doc, tok string) bool {
		return strings.Contains(doc, tok) || strings.Contains(doc, strings.NewReplacer("<", `\u003c`, ">", `\u003e`).Replace(tok))
	}

	for _, c := range []struct {
		name string
		args []string
		text func(s string) bool
		doc  func(s string) bool
	}{
		{"keep", nil, func(s string) bool { return strings.Contains(s, `"`+secret+`"`) }, func(s string) bool { return strings.Contains(s, secret) }},
		{"redact", []string{"-redact-binds"}, func(s string) bool {
			return strings.Contains(s, token) && !strings.Contains(s, secret) && strings.Contains(s, "bind values redacted")
		},
			func(s string) bool { return has(s, token) && !strings.Contains(s, secret) }},
		{"salted", []string{"-redact-binds", "-redact-salt", "pepper"}, func(s string) bool {
			return strings.Contains(s, salted) && !strings.Contains(s, token) && !strings.Contains(s, secret)
		},
			func(s string) bool { return has(s, salted) && !strings.Contains(s, secret) }},
		{"none", []string{"-binds", "none"}, func(s string) bool {
			return !strings.Contains(s, secret) && strings.Contains(s, "bind values dropped") && !strings.Contains(s, "binds: #")
		},
			func(s string) bool { return !strings.Contains(s, secret) && !strings.Contains(s, `"value":"11"`) }},
	} {
		text := runTo(t, cmdReport, append(append([]string{}, c.args...), trc)...)
		if !c.text(text) {
			t.Errorf("%s: text digest:\n%.1500s", c.name, text[strings.Index(text, "cursors:"):])
		}
		doc := runTo(t, cmdJSON, append(append([]string{}, c.args...), trc)...)
		if !c.doc(doc) {
			t.Errorf("%s: the document", c.name)
		}
		var d diagDoc
		if err := json.Unmarshal([]byte(doc), &d); err != nil || d.Dump == nil || d.Dump.Digest == nil || len(d.Dump.Digest.Readings) == 0 {
			t.Errorf("%s: the document has no readings: %v", c.name, err)
		}
	}
}
