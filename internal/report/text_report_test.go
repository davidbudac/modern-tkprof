package report

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

func renderText(t *testing.T, path string, o TextOptions) string {
	t.Helper()
	m, err := model.Build(path, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := Text(&b, m, o); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestTextReportSections(t *testing.T) {
	out := renderText(t, "../../testdata/traces/19c/basic_binds.trc", TextOptions{Sort: "elapsed", Binds: 5, Execs: 20, Sys: true, Width: 120})
	for _, h := range []string{"\nSTATEMENTS BY ELAPSED", "\nExecutions: 10 ", "\n exec#  cursor start", "\nSESSIONS  (", "\nTIME BUCKETS  ("} {
		if !strings.Contains(out, h) {
			t.Errorf("report lacks %q", strings.TrimSpace(h))
		}
	}
	// an executions row: exec#, cursor line, wall clock start, ..., binds
	row := regexp.MustCompile(`(?m)^\s+1\s+75 11:35:03\.513\s+[0-9.]+\s+[0-9.]+\s+1,000\s+0\s+194\s+68  :0=1 :1="Customer 42"`)
	if !row.MatchString(out) {
		t.Error("executions row for exec 1 of cursor line 75 not found")
	}
	// session rows carry the module / action of each context
	if !regexp.MustCompile(`(?m)^\s+1\s+41 51\.4357 .* mtk_basic_binds / arraysize15 /`).MatchString(out) {
		t.Error("SESSIONS row for context 1 not found")
	}

	capped := renderText(t, "../../testdata/traces/19c/basic_binds.trc", TextOptions{Sort: "elapsed", Execs: 4, Sys: true, Width: 120})
	if !strings.Contains(capped, "4 of 10 executions: the first 2 in file order and the 2 slowest of the rest (marked *)") {
		t.Error("capped executions header missing")
	}
	none := renderText(t, "../../testdata/traces/19c/basic_binds.trc", TextOptions{Sort: "elapsed", Execs: 0, Sys: true, Width: 120})
	if strings.Contains(none, " exec#  cursor") || !strings.Contains(none, "Executions: 10 ") {
		t.Error("-execs 0 should keep the summary line and drop the table")
	}
}

func TestPickExecs(t *testing.T) {
	ela := []int64{5, 1, 9, 2, 8, 3, 7}
	ex := make([]analyze.Execution, len(ela))
	for i, e := range ela {
		ex[i].Stats.Elapsed = e
	}
	idx, slow := pickExecs(ex, 4)
	if fmt.Sprint(idx) != "[0 1 2 4]" || len(slow) != 2 || !slow[2] || !slow[4] {
		t.Fatalf("got %v %v", idx, slow)
	}
	if idx, slow := pickExecs(ex, -1); len(idx) != len(ex) || slow != nil {
		t.Fatalf("all: got %v %v", idx, slow)
	}
}

func TestTextReportPX(t *testing.T) {
	fx := "../../testdata/traces/19c/"
	m, err := model.BuildFiles([]string{fx + "parallel.trc", fx + "parallel_slave.trc"}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := Text(&b, m, TextOptions{Sort: "elapsed", Binds: 5, Execs: 20, Sys: true, Width: 120}); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	for _, want := range []string{"\nFILES  (", "parallel_slave.trc", "PX slave", "\nPX slaves: 1 sessions, ", "\\ PX slaves: 1 sessions", "(PX slaves, run in parallel; not in the total)"} {
		if !strings.Contains(out, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	// slave sessions are nested under their coordinator context
	if !regexp.MustCompile(`(?m)^\s+3\s+1:30\s+\\ 50\.29851 .*PX slave`).MatchString(out) {
		t.Error("nested slave row not found in SESSIONS")
	}
	// JSON carries the new fields
	var j bytes.Buffer
	if err := JSON(&j, m, DocOptions{Facts: false}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"pxEla":`, `"pxSessions":1`, `"px":true`, `"fileIdx":1`, `"files":[`} {
		if !strings.Contains(j.String(), want) {
			t.Errorf("json lacks %s", want)
		}
	}
}
