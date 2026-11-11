package main

import (
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
