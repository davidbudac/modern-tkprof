package trace

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSniffExistingTraces(t *testing.T) {
	files, _ := filepath.Glob("../../testdata/traces/*/*.trc")
	n := 0
	for _, f := range files {
		if strings.HasSuffix(f, "opt_interleaved.trc") {
			continue
		}
		n++
		for _, o := range []SniffOptions{{}, {StopAtRecord: true}} {
			sn, err := SniffFile(f, o)
			if err != nil {
				t.Fatal(err)
			}
			if sn.Kind != FileKind10046 || len(sn.Dumps) != 0 {
				t.Errorf("%s %+v: kind %s, dumps %v", f, o, sn.Kind, sn.Dumps)
			}
			if !o.StopAtRecord && !sn.Complete {
				t.Errorf("%s: read not complete", f)
			}
		}
		// the parser's statistics say the same
		st, err := ParseFile(f, NopHandler{})
		if err != nil {
			t.Fatal(err)
		}
		if st.FileKind() != FileKind10046 || len(st.Dumps) != 0 || st.Kinds[KindOpt] != 0 {
			t.Errorf("%s: stats kind %s, dumps %v, %d optimizer lines", f, st.FileKind(), st.Dumps, st.Kinds[KindOpt])
		}
	}
	if n == 0 {
		t.Skip("no fixtures")
	}
}

func TestSniffOptFiles(t *testing.T) {
	files, _ := filepath.Glob("../../testdata/opt/*/*.trc")
	if len(files) == 0 {
		t.Skip("no fixtures")
	}
	for _, f := range files {
		st, err := ParseFile(f, NopHandler{})
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range []SniffOptions{{}, {StopAtRecord: true}} {
			sn, err := SniffFile(f, o)
			if err != nil {
				t.Fatal(err)
			}
			if sn.Kind != FileKind10053 || !sn.Complete {
				t.Errorf("%s %+v: kind %s complete %v", f, o, sn.Kind, sn.Complete)
			}
			// the sniff and the parser find the same dumps
			if len(sn.Dumps) != len(st.Dumps) {
				t.Fatalf("%s: sniff %v, parser %v", f, sn.Dumps, st.Dumps)
			}
			for i := range sn.Dumps {
				if sn.Dumps[i] != st.Dumps[i] {
					t.Errorf("%s: dump %d: sniff %+v, parser %+v", f, i, sn.Dumps[i], st.Dumps[i])
				}
			}
		}
	}
}

func TestSniffInterleaved(t *testing.T) {
	f := "../../testdata/traces/19c/opt_interleaved.trc"
	sn, err := SniffFile(f, SniffOptions{})
	if err != nil {
		t.Skip(err)
	}
	st, _ := ParseFile(f, NopHandler{})
	if sn.Kind != FileKindBoth || !sn.Complete || len(sn.Dumps) != len(st.Dumps) || st.FileKind() != FileKindBoth {
		t.Errorf("full read: %+v, parser %v %v", sn, st.FileKind(), st.Dumps)
	}
	// the first record of this file comes before its first dump: a read that
	// stops at the first record takes it for a 10046 trace
	sn, _ = SniffFile(f, SniffOptions{StopAtRecord: true})
	if sn.Kind != FileKind10046 || sn.Complete {
		t.Errorf("stop at record: %+v", sn)
	}
}

func TestSniffSynthetic(t *testing.T) {
	for _, c := range []struct {
		name string
		text string
		o    SniffOptions
		want FileKind
	}{
		{"empty", "", SniffOptions{}, FileKindNone},
		{"prologue only", "Trace file x.trc\nVersion 19.27.0.0.0\n\n*** 2026-11-10T20:45:32.749920+00:00 (PDB1(3))\n", SniffOptions{}, FileKindNone},
		{"dump before the first record", dStart + "\n" + dEnd + "\n" + dPIC + "\n" + dText + "\nEND OF STMT\n", SniffOptions{StopAtRecord: true}, FileKindBoth},
		{"dump only", dStart + "\n" + dSQLID + "\n" + dEnd, SniffOptions{StopAtRecord: true}, FileKind10053},
		{"cut dump", dStart + "\n" + dSQLID + "\n", SniffOptions{}, FileKind10053},
		{"record inside a dump", dStart + "\n" + dSep + "\n" + dPIC + "\n" + dText + "\nEND OF STMT\n" + dEnd + "\n", SniffOptions{StopAtRecord: true}, FileKindBoth},
		{"10046 only", dPIC + "\n" + dText + "\nEND OF STMT\n", SniffOptions{}, FileKind10046},
		{"limit", dStart + "\n" + strings.Repeat("x\n", 1000) + dEnd + "\n" + dPIC + "\n", SniffOptions{MaxBytes: 100}, FileKind10053},
		{"CRLF", strings.ReplaceAll(dStart+"\n"+dEnd+"\n", "\n", "\r\n"), SniffOptions{}, FileKind10053},
		{"a very long line", dStart + "\n" + strings.Repeat("y", 600<<10) + "\n" + dEnd + "\n", SniffOptions{}, FileKind10053},
	} {
		sn, err := SniffReader(strings.NewReader(c.text), c.o)
		if err != nil {
			t.Fatal(err)
		}
		if sn.Kind != c.want {
			t.Errorf("%s: kind %s, want %s (%+v)", c.name, sn.Kind, c.want, sn)
		}
	}
	sn, _ := SniffReader(strings.NewReader(dStart+"\n"+dSQLID+"\n"), SniffOptions{})
	if len(sn.Dumps) != 1 || !sn.Dumps[0].Cut || sn.Dumps[0].SQLID != "7jqt2tmvuc9hn" {
		t.Errorf("cut dump: %+v", sn.Dumps)
	}
	sn, _ = SniffReader(strings.NewReader(dStart+"\n"+strings.Repeat("y", 600<<10)+"\n"+dEnd+"\n"), SniffOptions{})
	if len(sn.Dumps) != 1 || sn.Dumps[0].Last != 3 || sn.Lines != 3 {
		t.Errorf("long line: %+v", sn)
	}
}
