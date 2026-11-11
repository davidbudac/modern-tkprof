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

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/opt"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

const (
	optFixtures    = "../../testdata/opt/19c/"
	optInterleaved = "../../testdata/traces/19c/opt_interleaved.trc"
)

type optDoc struct {
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

func fileLinesOf(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
}

// runTo runs a command writing to a file of its own (-o) and returns it.
func runTo(t *testing.T, run func([]string) error, args ...string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out")
	if err := run(append(args, "-o", out)); err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestOptReportEveryFixture: mtkprof report of each 10053 fixture prints the digest.
func TestOptReportEveryFixture(t *testing.T) {
	files, _ := filepath.Glob(optFixtures + "*.trc")
	if len(files) < 10 {
		t.Fatalf("%d fixtures", len(files))
	}
	for _, f := range files {
		out := runTo(t, cmdReport, f)
		sc, err := opt.ScanFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(out, "mtkprof - Oracle optimizer trace (event 10053) digest\n") || !strings.Contains(out, "Trace file : "+filepath.Base(f)) {
			t.Errorf("%s: title lines: %.200s", f, out)
		}
		for _, d := range sc.Dumps {
			if !strings.Contains(out, "sql_id "+d.SQLID) {
				t.Errorf("%s: no sql_id %s", f, d.SQLID)
			}
		}
		// it is the digest opt.WriteDigest writes
		var b bytes.Buffer
		line, closeFn, _ := opt.FileLines(f)
		if err := opt.WriteDigest(&b, sc, line, opt.TextOptions{}); err != nil {
			t.Fatal(err)
		}
		closeFn()
		if out != b.String() {
			t.Errorf("%s: the report is not the digest (%d, %d bytes)", f, len(out), b.Len())
		}
	}
}

// TestOptRedaction: -redact-binds and -binds none act on the peeked binds, in the text digest and in
// the document's digest; literals in the SQL stay.
func TestOptRedaction(t *testing.T) {
	f := optFixtures + "opt_subq_binds.trc"
	lines := fileLinesOf(t, f)
	bindLines := []int{}
	sc, err := opt.ScanFile(f)
	if err != nil {
		t.Fatal(err)
	}
	bindLines = sc.Dumps[0].BindLines
	if len(bindLines) < 2 {
		t.Fatalf("bind lines %v", bindLines)
	}
	token := model.RedactToken("NUMBER", "11", 2, "")
	if bd := (model.Bind{Dty: 2, Value: "11"}); model.RedactedValue(&bd) != token {
		t.Fatalf("the 10046 token %q is not %q", model.RedactedValue(&bd), token)
	}
	salted := model.RedactToken("NUMBER", "11", 2, "pepper")
	if salted == token {
		t.Fatal("salt makes no difference")
	}
	for _, c := range []struct {
		name string
		args []string
		want func(line string) bool
		text string // in the text digest
	}{
		{"redact", []string{"-redact-binds"}, func(s string) bool { return strings.HasSuffix(s, "value="+token) }, token},
		{"salted", []string{"-redact-binds", "-redact-salt", "pepper"}, func(s string) bool { return strings.HasSuffix(s, "value="+salted) }, salted},
		{"none", []string{"-binds", "none"}, func(s string) bool { return strings.HasSuffix(s, "value=") }, "values left out"},
	} {
		t.Run(c.name, func(t *testing.T) {
			txt := runTo(t, cmdReport, append([]string{f}, c.args...)...)
			if strings.Contains(txt, "= 11   (line") || !strings.Contains(txt, c.text) {
				t.Errorf("text digest: %.1500s", txt)
			}
			if !strings.Contains(txt, "amount > 100") {
				t.Errorf("a literal of the SQL is gone from the text digest")
			}
			var doc optDoc
			if err := json.Unmarshal([]byte(runTo(t, cmdJSON, append([]string{f}, c.args...)...)), &doc); err != nil {
				t.Fatal(err)
			}
			dg := doc.Opt.Digest
			if dg == nil || len(dg.Dumps) != 1 {
				t.Fatalf("digest %+v", dg)
			}
			for _, b := range dg.Dumps[0].Binds {
				if b.Value == "11" {
					t.Errorf("bind %+v keeps its value", b)
				}
			}
			got := map[int]string{}
			for _, run := range dg.Lines {
				for k, s := range run.Text {
					got[run.From+k] = s
				}
			}
			for _, n := range bindLines {
				s, ok := got[n]
				if !ok {
					t.Errorf("bind line %d is not in the digest lines", n)
				} else if !c.want(s) {
					t.Errorf("line %d: %q", n, s)
				}
			}
			for n, s := range got { // every other line is the file's
				isBind := false
				for _, b := range bindLines {
					isBind = isBind || b == n
				}
				if !isBind && s != lines[n-1] {
					t.Fatalf("line %d: %q, file %q", n, s, lines[n-1])
				}
				if strings.Contains(s, "value=11") {
					t.Errorf("line %d still has the value: %q", n, s)
				}
			}
			lit := false
			for _, sq := range dg.Dumps[0].SQL {
				lit = lit || strings.Contains(sq.Text, "100")
			}
			if !lit || !strings.Contains(dg.Dumps[0].StmtText, "amount > 100") {
				t.Errorf("the SQL lost a literal")
			}
		})
	}
	// kept: the lines are the file's
	var doc optDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, f)), &doc); err != nil {
		t.Fatal(err)
	}
	for _, run := range doc.Opt.Digest.Lines {
		for k, s := range run.Text {
			if s != lines[run.From+k-1] {
				t.Fatalf("kept: line %d: %q, file %q", run.From+k, s, lines[run.From+k-1])
			}
		}
	}
}

// TestOptInterleavedReport: the text report of an interleaved file is the 10046 report with the dump note.
func TestOptInterleavedReport(t *testing.T) {
	out := runTo(t, cmdReport, optInterleaved)
	if !strings.HasPrefix(out, "mtkprof ") || !strings.Contains(out, "Oracle SQL trace profile") {
		t.Fatalf("not the 10046 report: %.200s", out)
	}
	if !strings.Contains(out, "Notes      : ") || !strings.Contains(out, "optimizer (10053) dumps in this file, lines ") || !strings.Contains(out, "not shown as 10053 yet") {
		i := strings.Index(out, "Volume")
		t.Errorf("no dump note:\n%s", out[i:i+400])
	}
	// the note is the model's
	var doc optDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, optInterleaved)), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Opt != nil {
		t.Errorf("doc.opt for an interleaved file")
	}
	if len(doc.Diag.Notes) != 1 || !strings.Contains(out, doc.Diag.Notes[0]) {
		t.Errorf("notes %v", doc.Diag.Notes)
	}
}

// TestOptHTML: the standalone HTML of a 10053 file holds the document with opt.digest, whose lines are the file's.
func TestOptHTML(t *testing.T) {
	if !ui.Built() {
		t.Skip("no web UI built")
	}
	f := optFixtures + "opt_two.trc"
	lines := fileLinesOf(t, f)
	html := runTo(t, cmdHTML, f)
	const open = `<script id="mtkprof-data" type="application/json">`
	i := strings.Index(html, open)
	j := strings.Index(html[i:], "</script>")
	if i < 0 || j < 0 {
		t.Fatal("no data in the page")
	}
	data := html[i+len(open) : i+j]
	if k := strings.Index(data, "null"); k >= 0 {
		t.Errorf("a null in the document: ...%s...", data[max(0, k-60):k+10])
	}
	var doc optDoc
	if err := json.Unmarshal([]byte(data), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Opt == nil || doc.Opt.Digest == nil || len(doc.Opt.Digest.Dumps) != 2 || len(doc.Opt.File.Dumps) != 2 {
		t.Fatalf("doc.opt %+v", doc.Opt)
	}
	n := 0
	for _, run := range doc.Opt.Digest.Lines {
		for k, s := range run.Text {
			if s != lines[run.From+k-1] {
				t.Fatalf("line %d: %q, file %q", run.From+k, s, lines[run.From+k-1])
			}
			n++
		}
	}
	want := 0
	for _, d := range doc.Opt.Digest.Dumps {
		for _, r := range d.Digest {
			want += r.To - r.From + 1
		}
	}
	if n != want || n == 0 {
		t.Errorf("%d digest lines in the document, the dumps' ranges hold %d", n, want)
	}
}

// TestOptDefault: the default command writes the digest as .txt and the standalone HTML.
func TestOptDefault(t *testing.T) {
	src, err := os.ReadFile(optFixtures + "opt_two.trc")
	if err != nil {
		t.Fatal(err)
	}
	trc := filepath.Join(t.TempDir(), "opt_two.trc")
	if err := os.WriteFile(trc, src, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cmdDefault([]string{trc}); err != nil {
		t.Fatal(err)
	}
	txt, err := os.ReadFile(trc + ".txt")
	if err != nil || !strings.Contains(string(txt), "OPTIMIZER DUMP 2") {
		t.Errorf("%s.txt: %v %.100s", trc, err, txt)
	}
	if ui.Built() {
		html, err := os.ReadFile(trc + ".html")
		if err != nil || !bytes.Contains(html, []byte(`"digest":{"dumps"`)) {
			t.Errorf("%s.html: %v", trc, err)
		}
	}
}

// TestOptRefusals: the commands that have nothing to show for a 10053 file say so, in one line.
func TestOptRefusals(t *testing.T) {
	f := optFixtures + "opt_two.trc"
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
		if err == nil || !strings.Contains(err.Error(), "opt_two.trc") || !strings.Contains(err.Error(), "10053") || strings.Contains(err.Error(), "\n") {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := cmdPivot([]string{f}); err == nil || !strings.HasSuffix(err.Error(), "opt_two.trc is a 10053 file: nothing to pivot; mtkprof report prints its digest") {
		t.Errorf("pivot: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "csv")); err == nil {
		t.Errorf("export wrote something")
	}
}

// TestOptSets: a 10053 file in a set of 10046 files is left out with a note; of 10053 files the first is read.
func TestOptSets(t *testing.T) {
	var doc optDoc
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, optFixtures+"opt_two.trc", "../../testdata/traces/19c/basic_binds.trc")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Opt != nil || len(doc.Diag.Notes) != 1 || doc.Diag.Notes[0] != "opt_two.trc is a 10053 file; open it on its own" {
		t.Errorf("mixed: %+v %v", doc.Opt, doc.Diag.Notes)
	}
	doc = optDoc{}
	if err := json.Unmarshal([]byte(runTo(t, cmdJSON, optFixtures+"opt_two.trc", optFixtures+"opt_dml.trc")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Opt == nil || doc.Opt.File.Name != "opt_two.trc" || len(doc.Diag.Notes) != 1 || doc.Diag.Notes[0] != "opt_dml.trc is a 10053 file; open it on its own" {
		t.Errorf("only 10053: %+v %v", doc.Opt, doc.Diag.Notes)
	}
}

// TestHelperMain runs main() with the arguments in MTKPROF_TEST_MAIN: the tests that need a command in a
// process of its own (serve, which does not return) start the test binary on it.
func TestHelperMain(t *testing.T) {
	args := os.Getenv("MTKPROF_TEST_MAIN")
	if args == "" {
		return
	}
	os.Args = append([]string{"mtkprof"}, strings.Split(args, "\x1f")...)
	main()
	os.Exit(0)
}

// TestOptServe: serve answers the document (opt.file, no digest) and the two routes in each of its modes.
func TestOptServe(t *testing.T) {
	f, err := filepath.Abs(optFixtures + "opt_two.trc")
	if err != nil {
		t.Fatal(err)
	}
	lines := fileLinesOf(t, f)
	for _, mode := range [][]string{nil, {"-slice"}, {"-facts=false"}, {"-aggregate"}, {"-spill"}} {
		name := strings.Join(mode, " ")
		t.Run(name, func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			addr := ln.Addr().String()
			ln.Close()
			cmd := exec.Command(os.Args[0], "-test.run=^TestHelperMain$")
			cmd.Env = append(os.Environ(), "MTKPROF_TEST_MAIN="+strings.Join(append([]string{"serve", f, "-addr", addr}, mode...), "\x1f"))
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
			var doc optDoc
			if err := json.Unmarshal(body, &doc); code != 200 || err != nil || doc.Opt == nil || doc.Opt.Digest != nil || len(doc.Opt.File.Dumps) != 2 {
				t.Fatalf("doc: %d %v %+v", code, err, doc.Opt)
			}
			di := doc.Opt.File.Dumps[1]
			code, h, body := get("/api/opt/dump?i=1")
			var d opt.Dump
			if err := json.Unmarshal(body, &d); code != 200 || err != nil || d.SQLID != di.SQLID || h.Get("Content-Type") != "application/json" {
				t.Fatalf("dump: %d %v %s", code, err, h.Get("Content-Type"))
			}
			code, h, body = get("/api/opt/text?i=1")
			got := strings.Split(string(body), "\n")
			if code != 200 || !strings.HasPrefix(h.Get("Content-Type"), "text/plain") || len(got) != di.LineCount || got[0] != lines[di.ViewFrom-1] || got[len(got)-1] != lines[di.ViewTo-1] {
				t.Fatalf("text: %d %s %d lines (want %d)", code, h.Get("Content-Type"), len(got), di.LineCount)
			}
			if h.Get("Access-Control-Allow-Origin") != "*" {
				t.Errorf("no CORS header")
			}
			for _, p := range []string{"/api/opt/dump?i=2", "/api/opt/text?i=-1", "/api/opt/text?i=x"} {
				if code, _, _ := get(p); code != 404 {
					t.Errorf("%s: %d", p, code)
				}
			}
		})
	}
}
