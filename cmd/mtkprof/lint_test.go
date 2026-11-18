package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

// captureStdout runs f and returns what it printed.
func captureStdout(t *testing.T, f func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	f()
	os.Stdout = old
	w.Close()
	return <-done
}

func TestLintDumps(t *testing.T) {
	for _, c := range []struct {
		file, kind string
		dumps      int
	}{
		{"../../testdata/traces/19c/opt_interleaved.trc", "10046+10053", 2},
		{"../../testdata/opt/19c/opt_two.trc", "10053", 2},
		{"../../testdata/traces/19c/basic_binds.trc", "10046", 0},
	} {
		if _, err := os.Stat(c.file); err != nil {
			t.Skip(err)
		}
		var err error
		out := captureStdout(t, func() { err = lintFile(c.file) })
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "file kind: "+c.kind+"\n") {
			t.Errorf("%s: no file kind %s in\n%s", c.file, c.kind, out)
		}
		if strings.Contains(out, "UNKNOWN LINES") {
			t.Errorf("%s: unknown lines\n%s", c.file, out)
		}
		n := strings.Count(out, "  lines ") // the dumps' ranges
		hasDumps := strings.Contains(out, "\ndumps: ")
		if n != c.dumps || hasDumps != (c.dumps > 0) {
			t.Errorf("%s: %d dump ranges, dumps list %v, want %d:\n%s", c.file, n, hasDumps, c.dumps, out)
		}
		if c.dumps > 0 && (!strings.Contains(out, "  optimizer ") || !strings.Contains(out, "sql_id ")) {
			t.Errorf("%s: no optimizer line kind or sql_id:\n%s", c.file, out)
		}
	}
}

// lint lists the diagnostic dump sections as it lists optimizer dumps: kind
// and lines, "cut" for a section that stopped before its end line; their lines
// are "diagnostic", not unknown.
func TestLintSections(t *testing.T) {
	sysstate, err := os.ReadFile("../../testdata/diag/19c/diag_sysstate_l1.trc")
	if err != nil {
		t.Skip(err)
	}
	cut := t.TempDir() + "/cut.trc"
	if err := os.WriteFile(cut, []byte(strings.Join(strings.SplitAfter(string(sysstate), "\n")[:1000], "")), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		file, kind string
		want       []string
		unknown    bool
	}{
		{"../../testdata/traces/19c/diag_in_10046.trc", "10046", []string{"  lines 114-29753  diagdump\n"}, false},
		{"../../testdata/diag/19c/diag_heap_pga.trc", "diag", []string{"  lines 32-923  heap\n", "  lines 924-1034  heap\n", "  lines 1035-1486  heap\n"}, false},
		{"../../testdata/diag/19c/diag_hang.trc", "diag", []string{"  lines 42-275  hang\n"}, true},
		{cut, "diag", []string{"  lines 40-1000  sysstate  cut\n"}, true},
		{"../../testdata/traces/19c/basic_binds.trc", "10046", nil, false},
	} {
		var err error
		out := captureStdout(t, func() { err = lintFile(c.file) })
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "file kind: "+c.kind+"\n") {
			t.Errorf("%s: no file kind %s in\n%s", c.file, c.kind, out)
		}
		if strings.Contains(out, "UNKNOWN LINES") != c.unknown {
			t.Errorf("%s: unknown lines listed: %v\n%s", c.file, !c.unknown, out)
		}
		if c.want == nil {
			if strings.Contains(out, "sections:") || strings.Contains(out, "diagnostic ") {
				t.Errorf("%s: sections in a file without any:\n%s", c.file, out)
			}
			continue
		}
		if !strings.Contains(out, fmt.Sprintf("sections: %d (diagnostic dumps)\n", len(c.want))) || !strings.Contains(out, "  diagnostic ") {
			t.Errorf("%s: no section list or diagnostic line kind:\n%s", c.file, out)
		}
		for _, w := range c.want {
			if !strings.Contains(out, w) {
				t.Errorf("%s: no %q in\n%s", c.file, w, out)
			}
		}
	}
}
