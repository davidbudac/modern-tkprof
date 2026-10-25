package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsTraceArg(t *testing.T) {
	for a, want := range map[string]bool{
		"report": false, "serve": false, "nope": false, "-": false,
		"x.trc": true, "dir/": true, `C:\t\x`: true, "-top": true,
	} {
		if got := isTraceArg(a); got != want {
			t.Errorf("isTraceArg(%q) = %v", a, got)
		}
	}
}

func TestCmdDefault(t *testing.T) {
	src, err := os.ReadFile("../../testdata/traces/19c/basic_binds.trc")
	if err != nil {
		t.Fatal(err)
	}
	trc := filepath.Join(t.TempDir(), "basic_binds.trc")
	if err := os.WriteFile(trc, src, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cmdDefault([]string{trc, "-top", "3"}); err != nil {
		t.Fatal(err)
	}
	for _, ext := range []string{".txt", ".html"} {
		if fi, err := os.Stat(trc + ext); err != nil || fi.Size() == 0 {
			t.Errorf("%s: %v", ext, err)
		}
	}
}
