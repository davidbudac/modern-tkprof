package main

import (
	"flag"
	"testing"
)

func TestSpillFlag(t *testing.T) {
	for _, tc := range []struct {
		args []string
		on   bool
		dir  string
		rest []string
	}{
		{[]string{"-spill", "a.trc"}, true, "", []string{"a.trc"}},
		{[]string{"-spill=/big/tmp", "a.trc"}, true, "/big/tmp", []string{"a.trc"}},
		{[]string{"-spill=false", "a.trc"}, false, "", []string{"a.trc"}},
		{[]string{"a.trc"}, false, "", []string{"a.trc"}},
	} {
		var f spillFlag
		fs := flag.NewFlagSet("t", flag.ContinueOnError)
		fs.Var(&f, "spill", "")
		if err := fs.Parse(tc.args); err != nil {
			t.Fatal(err)
		}
		if f.on != tc.on || f.dir != tc.dir || len(fs.Args()) != 1 || fs.Arg(0) != tc.rest[0] {
			t.Errorf("%v: on=%v dir=%q args=%v", tc.args, f.on, f.dir, fs.Args())
		}
	}
}
