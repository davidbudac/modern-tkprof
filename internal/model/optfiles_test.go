package model

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	optFx    = "../../testdata/opt/19c/"
	plainFx  = "../../testdata/traces/19c/basic_binds.trc"
	mixedFx  = "../../testdata/traces/19c/opt_interleaved.trc"
	optTwoFx = optFx + "opt_two.trc"
)

func TestOptOnly(t *testing.T) {
	for file, want := range map[string]bool{optTwoFx: true, plainFx: false, mixedFx: false} {
		m, err := BuildFiles([]string{file}, Options{})
		if err != nil {
			t.Fatal(err)
		}
		if got := m.OptOnly(); got != want {
			t.Errorf("%s: OptOnly %v, want %v", filepath.Base(file), got, want)
		}
		if got := len(m.DumpNotes()) > 0; got != (file != plainFx) {
			t.Errorf("%s: dump notes %v", filepath.Base(file), m.DumpNotes())
		}
	}
}

func TestOptInputs(t *testing.T) {
	two, dml := optTwoFx, optFx+"opt_dml.trc"
	for _, c := range []struct {
		in, kept, notes []string
	}{
		{[]string{plainFx}, []string{plainFx}, nil},
		{[]string{two}, []string{two}, nil},
		{[]string{plainFx, mixedFx}, []string{plainFx, mixedFx}, nil},
		{[]string{two, plainFx}, []string{plainFx}, []string{"opt_two.trc is a 10053 file; open it on its own"}},
		{[]string{plainFx, two, mixedFx}, []string{plainFx, mixedFx}, []string{"opt_two.trc is a 10053 file; open it on its own"}},
		{[]string{two, dml}, []string{two}, []string{"opt_dml.trc is a 10053 file; open it on its own"}},
	} {
		kept, notes := OptInputs(c.in)
		if !slices.Equal(kept, c.kept) || !slices.Equal(notes, c.notes) {
			t.Errorf("%v: kept %v notes %v", c.in, kept, notes)
		}
	}
	if name, ok := AllOpt([]string{two, dml}); !ok || name != "opt_two.trc" {
		t.Errorf("AllOpt: %q %v", name, ok)
	}
	for _, in := range [][]string{{plainFx}, {two, plainFx}, {mixedFx}, {"nosuch.trc"}} {
		if name, ok := AllOpt(in); ok {
			t.Errorf("AllOpt(%v) = %q", in, name)
		}
	}
}

// An aggregate or spill build of a 10053 file has no calls, waits or binds to
// aggregate: its mode's note is left out (the same build of a 10046 trace keeps it).
func TestOptOnlyNoModeNote(t *testing.T) {
	modeNote := func(m *Model) bool {
		for _, n := range m.Diag.Notes {
			if strings.HasPrefix(n, "aggregate mode:") || strings.HasPrefix(n, "spill mode:") {
				return true
			}
		}
		return false
	}
	for file, want := range map[string]bool{optTwoFx: false, plainFx: true, mixedFx: true} {
		m, err := BuildFiles([]string{file}, Options{Aggregate: true})
		if err != nil {
			t.Fatal(err)
		}
		if got := modeNote(m); got != want {
			t.Errorf("%s: mode note %v, want %v (notes %q)", filepath.Base(file), got, want, m.Diag.Notes)
		}
	}
}
