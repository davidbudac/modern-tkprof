package model

import (
	"bytes"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const diagFx = "../../testdata/diag/19c/"

func TestSectionNote(t *testing.T) {
	r := func(kind string, first, last int) SectionRange {
		return SectionRange{Kind: kind, First: first, Last: last}
	}
	for _, c := range []struct {
		name string
		file string
		ss   []SectionRange
		want string
	}{
		{"none", "", nil, ""},
		{"one", "", []SectionRange{r("diagdump", 114, 29753)}, "1 diagnostic dump in this file, lines 114-29753"},
		{"one heap", "", []SectionRange{r("heap", 32, 923)}, "1 heap dump in this file, lines 32-923"},
		{"three heaps", "", []SectionRange{r("heap", 32, 923), r("heap", 924, 1034), r("heap", 1035, 1486)}, "3 heap dumps in this file, lines 32-923, 924-1034 and 1035-1486"},
		{"two kinds", "", []SectionRange{r("diagdump", 5, 90), r("heap", 91, 200), r("heap", 201, 300)}, "3 diagnostic dumps (1 diagnostic dump and 2 heap dumps) in this file, lines 5-90, 91-200 and 201-300"},
		{"three kinds", "", []SectionRange{r("procstate", 1, 2), r("hang", 3, 4), r("sysstate", 5, 6), r("hang", 7, 8)}, "4 diagnostic dumps (1 process state, 2 hang analyses and 1 system state) in this file, lines 1-2, 3-4, 5-6 and 7-8"},
		{"five", "", []SectionRange{r("heap", 1, 2), r("heap", 3, 4), r("heap", 5, 6), r("heap", 7, 8), r("heap", 9, 10)}, "5 heap dumps in this file, lines 1-2, 3-4, 5-6, 7-8 and 9-10"},
		{"six", "", []SectionRange{r("heap", 1, 2), r("heap", 3, 4), r("heap", 5, 6), r("heap", 7, 8), r("heap", 9, 10), r("heap", 11, 12)}, "6 heap dumps in this file, lines 1-2, 3-4, 5-6, 7-8, 9-10 and 1 more"},
		{"eighty", "", append(make([]SectionRange, 79), r("heap", 18603, 18635)), "80 heap dumps in this file, lines 0-0, 0-0, 0-0, 0-0, 0-0 and 75 more"},
		{"cut", "", []SectionRange{{Kind: "sysstate", First: 5, Last: 90, Cut: true}}, "1 system state in this file, lines 5-90 (cut short)"},
		{"set", "a.trc", []SectionRange{r("hang", 5, 90), r("deadlock", 100, 200)}, "a.trc has 2 diagnostic dumps (1 hang analysis and 1 deadlock graph), lines 5-90 and 100-200"},
		{"unknown kind", "", []SectionRange{r("x", 1, 2)}, "1 diagnostic dump in this file, lines 1-2"},
		{"pga", "", []SectionRange{r("pga-summary", 1, 2), r("pga-detail", 3, 4), r("incident", 5, 6)}, "3 diagnostic dumps (1 PGA memory summary, 1 PGA memory detail dump and 1 incident dump) in this file, lines 1-2, 3-4 and 5-6"},
	} {
		if c.name == "eighty" {
			for i := range c.ss[:79] {
				c.ss[i] = r("heap", 0, 0)
			}
		}
		if got := SectionNote(c.file, c.ss); got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
}

func sectionNotes(m *Model) []string {
	var out []string
	for _, n := range m.Diag.Notes {
		if strings.Contains(n, "diagnostic dump") || strings.Contains(n, "heap dump") {
			out = append(out, n)
		}
	}
	return out
}

// A 10046 trace that holds an errorstack: no unknown lines, the dump as a note and as a range of the file.
func TestSectionsInTrace(t *testing.T) {
	m := buildFiles(t, Options{}, "diag_in_10046.trc")
	if m.Diag.UnknownLines != 0 || len(m.Unknown) != 0 {
		t.Errorf("%d unknown lines", m.Diag.UnknownLines)
	}
	if m.Diag.LineKinds["diagnostic"] < 29000 || m.Diag.LineKinds["parsing-in-cursor"] != 12 {
		t.Errorf("line kinds %v", m.Diag.LineKinds)
	}
	want := []SectionRange{{Kind: "diagdump", First: 114, Last: 29753}}
	if got := m.File.Files[0].Sections; !reflect.DeepEqual(got, want) {
		t.Errorf("sections %+v, want %+v", got, want)
	}
	wantNote := "1 diagnostic dump in this file, lines 114-29753"
	if got := sectionNotes(m); !reflect.DeepEqual(got, []string{wantNote}) {
		t.Errorf("notes %q, want %q", got, wantNote)
	}
	if got := m.SectionNotes(); !reflect.DeepEqual(got, []string{wantNote}) {
		t.Errorf("SectionNotes %q", got)
	}
	// the dump is not a 10053 one
	if len(m.File.Files[0].Dumps) != 0 || len(dumpNotes(m)) != 0 {
		t.Errorf("dumps %v", m.File.Files[0].Dumps)
	}
}

// The aggregate model (what an engine session holds) carries the same note and ranges, and they
// survive the index cache (Encode / Decode).
func TestSectionsAggregate(t *testing.T) {
	m := buildFiles(t, Options{Aggregate: true}, "diag_in_10046.trc")
	full := buildFiles(t, Options{}, "diag_in_10046.trc")
	if got, want := sectionNotes(m), sectionNotes(full); len(want) != 1 || !reflect.DeepEqual(got, want) {
		t.Errorf("aggregate notes %q, want %q", got, want)
	}
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	back, err := Decode(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back.File.Files[0].Sections, m.File.Files[0].Sections) || len(back.File.Files[0].Sections) != 1 {
		t.Errorf("sections after a round trip: %+v, want %+v", back.File.Files[0].Sections, m.File.Files[0].Sections)
	}
	if got := sectionNotes(back); !reflect.DeepEqual(got, sectionNotes(m)) {
		t.Errorf("notes after a round trip: %q", got)
	}
	// several sections, one of them cut, round trip
	m.File.Files[0].Sections = []SectionRange{{Kind: "heap", First: 3, Last: 9}, {Kind: "hang", First: 10, Last: 20, Cut: true}}
	buf.Reset()
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	if back, err = Decode(&buf); err != nil || !reflect.DeepEqual(back.File.Files[0].Sections, m.File.Files[0].Sections) {
		t.Errorf("round trip: %v %+v", err, back.File.Files[0].Sections)
	}
}

// A file without sections has no note and no ranges.
func TestNoSectionsNoNote(t *testing.T) {
	m := buildFiles(t, Options{}, "basic_binds.trc")
	if len(sectionNotes(m)) != 0 || len(m.File.Files[0].Sections) != 0 || m.Diag.LineKinds["diagnostic"] != 0 {
		t.Errorf("notes %q sections %v kinds %v", sectionNotes(m), m.File.Files[0].Sections, m.Diag.LineKinds)
	}
}

// A diag-only file still opens as it did (an empty 10046 model), with its lines diagnostic ones.
func TestDiagOnlyFileOpensAsBefore(t *testing.T) {
	m, err := BuildFiles([]string{diagFx + "diag_heap_pga.trc"}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Cursors) != 0 || len(m.Statements) != 0 || len(m.File.Files) != 1 || m.Diag.UnknownLines != 0 {
		t.Errorf("%d cursors, %d statements, %d unknown, files %d", len(m.Cursors), len(m.Statements), m.Diag.UnknownLines, len(m.File.Files))
	}
	if m.Diag.LineKinds["diagnostic"] < 1400 || m.Diag.LineKinds["unknown"] != 0 {
		t.Errorf("line kinds %v", m.Diag.LineKinds)
	}
	if got := sectionNotes(m); !reflect.DeepEqual(got, []string{"3 heap dumps in this file, lines 32-923, 924-1034 and 1035-1486"}) {
		t.Errorf("notes %q", got)
	}
	if m.OptOnly() {
		t.Error("a diag file is not a 10053 one")
	}
}

// Diag-only files are left out of a set that has 10046 traces; a 10046 trace with a dump in it is not one.
func TestSetLeavesOutDiagFiles(t *testing.T) {
	heap, hang, withDump := diagFx+"diag_heap_pga.trc", diagFx+"diag_hang.trc", fixtures+"diag_in_10046.trc"
	basic, inter, two := fixtures+"basic_binds.trc", fixtures+"opt_interleaved.trc", optFixtures+"opt_two.trc"
	kept, notes := DropOptFiles([]string{basic, heap, withDump, hang, two})
	if !reflect.DeepEqual(kept, []string{basic, withDump}) {
		t.Errorf("kept %v", kept)
	}
	wantNotes := []string{"diag_heap_pga.trc holds diagnostic dumps only; open it on its own", "diag_hang.trc holds diagnostic dumps only; open it on its own", "opt_two.trc is a 10053 file; open it on its own"}
	if !slices.Equal(notes, wantNotes) {
		t.Errorf("notes %q", notes)
	}
	// alone, with others like it, nothing is left out
	for _, in := range [][]string{{heap}, {heap, hang}, {heap, two}, {withDump}, {basic, inter, withDump}} {
		if kept, notes := DropOptFiles(in); !slices.Equal(kept, in) || len(notes) != 0 {
			t.Errorf("%v: kept %v notes %q", in, kept, notes)
		}
	}
	// OptInputs: a set of files that are not 10046 traces is cut to its first
	for _, c := range []struct{ in, kept, notes []string }{
		{[]string{heap, basic}, []string{basic}, []string{"diag_heap_pga.trc holds diagnostic dumps only; open it on its own"}},
		{[]string{heap, hang}, []string{heap}, []string{"diag_hang.trc holds diagnostic dumps only; open it on its own"}},
		{[]string{two, heap}, []string{two}, []string{"diag_heap_pga.trc holds diagnostic dumps only; open it on its own"}},
		{[]string{heap, two}, []string{heap}, []string{"opt_two.trc is a 10053 file; open it on its own"}},
		{[]string{basic, withDump}, []string{basic, withDump}, nil},
		{[]string{heap}, []string{heap}, nil},
	} {
		kept, notes := OptInputs(c.in)
		if !slices.Equal(kept, c.kept) || !slices.Equal(notes, c.notes) {
			t.Errorf("%v: kept %v notes %v", c.in, kept, notes)
		}
	}
	// through the build
	for _, o := range []Options{{}, {Aggregate: true}} {
		m, err := BuildFiles([]string{heap, basic, fixtures + "bind_types.trc"}, o)
		if err != nil {
			t.Fatal(err)
		}
		if len(m.File.Files) != 2 || m.File.Files[0].Name != "basic_binds.trc" {
			t.Errorf("files %+v", m.File.Files)
		}
		if !slices.Contains(m.Diag.Notes, "diag_heap_pga.trc holds diagnostic dumps only; open it on its own") {
			t.Errorf("notes %q", m.Diag.Notes)
		}
	}
}

// A set of several files names the file in the note of each that has sections.
func TestSectionNotesOfASet(t *testing.T) {
	m, err := BuildFiles([]string{fixtures + "basic_binds.trc", fixtures + "diag_in_10046.trc"}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := m.SectionNotes(); !reflect.DeepEqual(got, []string{"diag_in_10046.trc has 1 diagnostic dump, lines 114-29753"}) {
		t.Errorf("notes %q", got)
	}
}
