package model

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

const optFixtures = "../../testdata/opt/19c/"

func TestDumpNote(t *testing.T) {
	r := func(first, last int) DumpRange { return DumpRange{First: first, Last: last} }
	for _, c := range []struct {
		name string
		file string
		ds   []DumpRange
		want string
	}{
		{"none", "", nil, ""},
		{"one", "", []DumpRange{r(54, 18358)}, "1 optimizer (10053) dump in this file, lines 54-18358; not shown as 10053 yet"},
		{"two", "", []DumpRange{r(54, 18358), r(18734, 27979)}, "2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet"},
		{"three", "", []DumpRange{r(1, 2), r(3, 4), r(5, 6)}, "3 optimizer (10053) dumps in this file, lines 1-2, 3-4 and 5-6; not shown as 10053 yet"},
		{"five", "", []DumpRange{r(1, 2), r(3, 4), r(5, 6), r(7, 8), r(9, 10)}, "5 optimizer (10053) dumps in this file, lines 1-2, 3-4, 5-6, 7-8 and 9-10; not shown as 10053 yet"},
		{"six", "", []DumpRange{r(1, 2), r(3, 4), r(5, 6), r(7, 8), r(9, 10), r(11, 12)}, "6 optimizer (10053) dumps in this file, lines 1-2, 3-4, 5-6, 7-8, 9-10 and 1 more; not shown as 10053 yet"},
		{"eight", "", []DumpRange{r(1, 2), r(3, 4), r(5, 6), r(7, 8), r(9, 10), r(11, 12), r(13, 14), r(15, 16)}, "8 optimizer (10053) dumps in this file, lines 1-2, 3-4, 5-6, 7-8, 9-10 and 3 more; not shown as 10053 yet"},
		{"cut", "", []DumpRange{{First: 5, Last: 90, Cut: true}}, "1 optimizer (10053) dump in this file, lines 5-90 (cut short); not shown as 10053 yet"},
		{"set", "a.trc", []DumpRange{r(5, 90), r(100, 200)}, "a.trc has 2 optimizer (10053) dumps, lines 5-90 and 100-200; not shown as 10053 yet"},
	} {
		if got := DumpNote(c.file, c.ds); got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
}

func dumpNotes(m *Model) []string {
	var out []string
	for _, n := range m.Diag.Notes {
		if strings.Contains(n, "(10053)") {
			out = append(out, n)
		}
	}
	return out
}

// An interleaved file opens as a 10046 trace: no unknown lines, the dumps
// as a note and as ranges of the file.
func TestInterleavedFile(t *testing.T) {
	m := buildFiles(t, Options{}, "opt_interleaved.trc")
	if m.Diag.UnknownLines != 0 || len(m.Unknown) != 0 {
		t.Errorf("%d unknown lines", m.Diag.UnknownLines)
	}
	if m.Diag.LineKinds["optimizer"] < 26000 || m.Diag.LineKinds["parsing-in-cursor"] != 6 {
		t.Errorf("line kinds %v", m.Diag.LineKinds)
	}
	ds := m.File.Files[0].Dumps
	if len(ds) != 2 || ds[0].SQLID == "" || ds[1].SQLID == "" || ds[0].Last >= ds[1].First {
		t.Fatalf("dumps %+v", ds)
	}
	want := DumpNote("", ds)
	if got := dumpNotes(m); !reflect.DeepEqual(got, []string{want}) {
		t.Errorf("notes %q, want %q", got, want)
	}
	if !strings.HasPrefix(want, "2 optimizer (10053) dumps in this file, lines 54-") || !strings.HasSuffix(want, "; not shown as 10053 yet") {
		t.Errorf("note %q", want)
	}
	// the dumps' sql_ids are statements of the 10046 model
	ids := map[string]bool{}
	for _, s := range m.Statements {
		ids[s.SQLID] = true
	}
	for _, d := range ds {
		if !ids[d.SQLID] {
			t.Errorf("dump %+v: no statement with that sql_id", d)
		}
	}
}

// The aggregate model (what an engine session holds) carries the same note,
// and the ranges survive the index cache (Encode / Decode).
func TestInterleavedAggregate(t *testing.T) {
	m := buildFiles(t, Options{Aggregate: true}, "opt_interleaved.trc")
	full := buildFiles(t, Options{}, "opt_interleaved.trc")
	if got, want := dumpNotes(m), dumpNotes(full); len(want) != 1 || !reflect.DeepEqual(got, want) {
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
	if !reflect.DeepEqual(back.File.Files[0].Dumps, m.File.Files[0].Dumps) {
		t.Errorf("dumps after a round trip: %+v, want %+v", back.File.Files[0].Dumps, m.File.Files[0].Dumps)
	}
	if got := dumpNotes(back); !reflect.DeepEqual(got, dumpNotes(m)) {
		t.Errorf("notes after a round trip: %q", got)
	}
}

// A file without dumps has no note and no ranges.
func TestNoDumpsNoNote(t *testing.T) {
	m := buildFiles(t, Options{}, "basic_binds.trc")
	if len(dumpNotes(m)) != 0 || len(m.File.Files[0].Dumps) != 0 || m.Diag.LineKinds["optimizer"] != 0 {
		t.Errorf("notes %q dumps %v kinds %v", dumpNotes(m), m.File.Files[0].Dumps, m.Diag.LineKinds)
	}
}

// 10053-only files are left out of a set that has 10046 traces.
func TestSetLeavesOutOptFiles(t *testing.T) {
	two, sub, basic, inter := optFixtures+"opt_two.trc", optFixtures+"opt_subq_binds.trc", fixtures+"basic_binds.trc", fixtures+"opt_interleaved.trc"
	kept, notes := DropOptFiles([]string{basic, two, inter, sub})
	if !reflect.DeepEqual(kept, []string{basic, inter}) {
		t.Errorf("kept %v", kept)
	}
	if !reflect.DeepEqual(notes, []string{"opt_two.trc is a 10053 file; open it on its own", "opt_subq_binds.trc is a 10053 file; open it on its own"}) {
		t.Errorf("notes %q", notes)
	}
	// alone, or only with 10053 files, nothing is left out
	for _, in := range [][]string{{two}, {two, sub}, {basic, inter}, {basic}} {
		if kept, notes := DropOptFiles(in); !reflect.DeepEqual(kept, in) || len(notes) != 0 {
			t.Errorf("%v: kept %v notes %q", in, kept, notes)
		}
	}
	// a file that cannot be read stays: the build reports it
	if kept, _ := DropOptFiles([]string{basic, "nope.trc"}); len(kept) != 2 {
		t.Errorf("kept %v", kept)
	}

	// through the build
	m, err := BuildFiles([]string{two, basic, fixtures + "bind_types.trc"}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.File.Files) != 2 || m.File.Files[0].Name != "basic_binds.trc" || m.File.Files[1].Name != "bind_types.trc" {
		t.Errorf("files %+v", m.File.Files)
	}
	found := false
	for _, n := range m.Diag.Notes {
		found = found || n == "opt_two.trc is a 10053 file; open it on its own"
	}
	if !found {
		t.Errorf("notes %q", m.Diag.Notes)
	}
	// the same set in the aggregate path
	ma, err := BuildFiles([]string{two, basic, fixtures + "bind_types.trc"}, Options{Aggregate: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(ma.File.Files) != 2 {
		t.Errorf("aggregate: files %d", len(ma.File.Files))
	}
	// opened alone, a 10053 file is built as before: no cursors, no unknown lines
	m, err = BuildFiles([]string{two}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Cursors) != 0 || m.Diag.UnknownLines != 0 || len(m.File.Files) != 1 || len(m.File.Files[0].Dumps) != 2 {
		t.Errorf("opt_two alone: %d cursors, %d unknown, files %+v", len(m.Cursors), m.Diag.UnknownLines, m.File.Files)
	}
	if got := dumpNotes(m); len(got) != 1 {
		t.Errorf("opt_two alone: notes %q", got)
	}
}
