package opt

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSnapshot pins the outline, the landmarks and the text digest of every fixture: a change of the scan
// that alters one shows in the diff of the snapshot files.
func TestSnapshot(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			sc := scanOf(t, fx)
			compareSnapshot(t, snapName(fx, "outline"), outlineText(sc))
			compareSnapshot(t, snapName(fx, "landmarks"), landmarksText(sc))
			line, closeFn, err := FileLines(fx)
			if err != nil {
				t.Fatal(err)
			}
			defer closeFn()
			var b bytes.Buffer
			if err := WriteDigest(&b, sc, line, TextOptions{}); err != nil {
				t.Fatal(err)
			}
			compareSnapshot(t, snapName(fx, "digest"), b.String())
		})
	}
}

// TestAgree: on every fixture the trace agrees with itself.
func TestAgree(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			sc := scanOf(t, fx)
			checkInvariants(t, fixtureName(fx), sc)
			if len(sc.Dumps) == 0 {
				t.Fatalf("no dump found")
			}
			for _, d := range sc.Dumps {
				if d.Truncated {
					t.Errorf("dump %d is truncated", d.Idx)
				}
				if d.Plan == nil || d.PlanHash == "" {
					t.Errorf("dump %d (%s) has plan %v and plan hash %q", d.Idx, d.SQLID, d.Plan != nil, d.PlanHash)
				}
				if d.SQLID == "" || d.StmtText == "" || len(d.Tables) == 0 {
					t.Errorf("dump %d: sql_id %q, statement %d bytes, tables %v", d.Idx, d.SQLID, len(d.StmtText), d.Tables)
				}
				if len(d.Digest) == 0 || len(d.Landmarks) == 0 || len(d.Runs) == 0 {
					t.Errorf("dump %d: digest %d, landmarks %d, runs %d", d.Idx, len(d.Digest), len(d.Landmarks), len(d.Runs))
				}
			}
			if !sc.File.Tested || sc.File.Version == "" || sc.File.Release == "" {
				t.Errorf("file facts: %+v", sc.File)
			}
		})
	}
}

// TestDigestShare logs how much of each dump the digest keeps.
func TestDigestShare(t *testing.T) {
	for _, fx := range fixtures(t) {
		sc := scanOf(t, fx)
		for _, d := range sc.Dumps {
			kept := 0
			for _, r := range d.Digest {
				kept += r.To - r.From + 1
			}
			size := d.End - d.From + 1
			t.Logf("%-18s dump %d  %s  digest %6d of %6d lines (%.1f%%), %d ranges", fixtureName(fx), d.Idx+1, d.SQLID, kept, size, 100*float64(kept)/float64(size), len(d.Digest))
			if kept > size/3 {
				t.Errorf("%s dump %d: the digest keeps %d of %d lines; it should be the trace without its noise", fixtureName(fx), d.Idx+1, kept, size)
			}
		}
	}
}

// TestPrefixes cuts every fixture at 200 evenly spaced lines: nothing panics, the last dump is marked
// truncated when the cut is inside it, and what was found still agrees with itself.
func TestPrefixes(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			data, err := os.ReadFile(fx)
			if err != nil {
				t.Fatal(err)
			}
			full := scanOf(t, fx)
			// offset of the end of line k
			var ends []int
			for i, c := range data {
				if c == '\n' {
					ends = append(ends, i+1)
				}
			}
			n := len(ends)
			for k := 1; k < 200; k++ {
				cut := n * k / 200
				if cut < 1 {
					continue
				}
				sc, err := ScanReader(bytes.NewReader(data[:ends[cut-1]]), "cut.trc")
				if err != nil {
					t.Fatalf("cut at %d: %v", cut, err)
				}
				if sc.File.Lines != cut {
					t.Fatalf("cut at %d: %d lines", cut, sc.File.Lines)
				}
				want := 0
				for _, d := range full.Dumps {
					if d.From <= cut {
						want++
					}
				}
				if len(sc.Dumps) != want {
					t.Fatalf("cut at %d: %d dumps, want %d", cut, len(sc.Dumps), want)
				}
				if want > 0 {
					fd := full.Dumps[want-1]
					last := sc.Dumps[want-1]
					if inside := cut < fd.End; last.Truncated != inside {
						t.Fatalf("cut at %d (dump %d is %d-%d): Truncated is %v", cut, want, fd.From, fd.End, last.Truncated)
					}
					if !last.Truncated && (last.End != fd.End || last.PlanHash != fd.PlanHash) {
						t.Fatalf("cut at %d: complete dump differs from the full scan", cut)
					}
				}
				checkInvariants(t, fixtureName(fx), sc)
				if t.Failed() {
					t.Fatalf("cut at %d", cut)
				}
				if err := WriteDigest(io.Discard, sc, nil, TextOptions{}); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

// TestNo10053In10046: the 10046 fixtures hold no dump, except the files named opt_*.
func TestNo10053In10046(t *testing.T) {
	n := 0
	err := filepath.Walk(tracesDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".trc") {
			return err
		}
		n++
		sc, err := ScanFile(path)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			return nil
		}
		isOpt := strings.HasPrefix(filepath.Base(path), "opt_")
		if (len(sc.Dumps) > 0) != isOpt {
			t.Errorf("%s: %d dumps found", path, len(sc.Dumps))
		}
		if !isOpt && (len(sc.File.Dumps) != 0 || sc.File.Pure()) {
			t.Errorf("%s: File.Dumps %d, Pure %v", path, len(sc.File.Dumps), sc.File.Pure())
		}
		if !isOpt && sc.File.Records10046 == 0 && sc.File.Lines > 20 {
			t.Errorf("%s: no 10046 record counted in %d lines", path, sc.File.Lines)
		}
		checkInvariants(t, path, sc)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n < 20 {
		t.Fatalf("only %d trace files under %s", n, tracesDir)
	}
}

// TestInterleaved: a 10046 trace with dumps inside is still scanned; the 10046 records are not part of them.
func TestInterleaved(t *testing.T) {
	path := filepath.Join(tracesDir, "19c", "opt_interleaved.trc")
	sc := scanOf(t, path)
	if sc.File.Pure() || sc.File.Records10046 == 0 {
		t.Fatalf("Pure %v, Records10046 %d", sc.File.Pure(), sc.File.Records10046)
	}
	if len(sc.Dumps) < 1 {
		t.Fatal("no dump found")
	}
	checkInvariants(t, "interleaved", sc)
	line, closeFn, err := FileLines(path)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	rec := func(n int) bool {
		s, _ := line(n)
		return recordKind([]byte(s)) != 0
	}
	records := 0
	for i := 1; i <= sc.File.Lines; i++ {
		if rec(i) {
			records++
		}
	}
	if records != sc.File.Records10046 {
		t.Errorf("Records10046 %d, a count of the lines gives %d", sc.File.Records10046, records)
	}
	for _, d := range sc.Dumps {
		for _, l := range d.Landmarks {
			if rec(l.Line) {
				t.Errorf("landmark %d is a 10046 record", l.Line)
			}
		}
		for _, r := range d.Digest {
			for i := r.From; i <= r.To; i++ {
				if s, _ := line(i); recordKind([]byte(s)) != 0 || strings.HasPrefix(s, "PARSING IN CURSOR") {
					t.Fatalf("digest line %d is a 10046 record: %s", i, s)
				}
			}
		}
		walk(d.Tree, func(n, _ *Node) {
			if n.Kind == KindJoinOrder || n.Kind == KindTable {
				if rec(n.From) {
					t.Errorf("node %s %d starts on a 10046 record", n.Kind, n.From)
				}
			}
		})
		for _, b := range d.Binds {
			if b.Line > d.End {
				t.Errorf("bind %+v is outside the dump", b)
			}
		}
	}
	// the recursive SQL inside the first dump left no trace in its model: every bind value it reads is in
	// the peeked-binds sections, not in a 10046 BINDS block
	for _, d := range sc.Dumps {
		var secs []*Node
		walk(d.Tree, func(n, _ *Node) {
			if n.Kind == KindPeekedBinds || n.Kind == KindPeeked {
				secs = append(secs, n)
			}
		})
		for _, n := range d.BindLines {
			ok := false
			for _, s := range secs {
				ok = ok || n >= s.From && n <= s.To
			}
			if !ok || rec(n) {
				t.Errorf("bind line %d of dump %d is not in a peeked-binds section", n, d.Idx+1)
			}
		}
	}
}

func TestIsStartIsEnd(t *testing.T) {
	for _, c := range []struct {
		s     string
		start bool
	}{
		{"Registered qb: SEL$1 0x63baa6c8 (PARSER)", true},
		{"Registered qb: INS$1 0x4d6e66f0 (PARSER)", true},
		{"Registered qb: SET$1 0x1 (PARSER)  ", true},
		{"Registered qb: SEL$58A6D7F6 0x64387718 (VIEW MERGE SEL$2; SEL$1; SEL$2)", false},
		{"Registered qb: SEL$1 0xZZ (PARSER)", false},
		{"Registered qb: SEL$1 (PARSER)", false},
		{"  Registered qb: SEL$1 0x63baa6c8 (PARSER)", false},
		{"", false},
	} {
		if got := IsStart([]byte(c.s)); got != c.start {
			t.Errorf("IsStart(%q) = %v", c.s, got)
		}
	}
	if !IsEnd([]byte("====================== END SQL Statement Dump ======================")) {
		t.Error("IsEnd of the end line")
	}
	for _, s := range []string{"", "END SQL Statement Dump", "==== Starting SQL statement dump ===="} {
		if IsEnd([]byte(s)) {
			t.Errorf("IsEnd(%q)", s)
		}
	}
}

// TestOddInputs: files that are not what the scan was written for come back without error and without panic.
func TestOddInputs(t *testing.T) {
	two, _ := os.ReadFile(filepath.Join(optDir, "opt_two.trc"))
	lines := strings.Split(string(two), "\n")
	cases := map[string]string{
		"empty":        "",
		"one newline":  "\n",
		"no newline":   "Registered qb: SEL$1 0x1 (PARSER)",
		"garbage":      strings.Repeat("\x00\xff\xfe binary \x01\n", 50),
		"only 10046":   "PARSING IN CURSOR #1 len=5 dep=0\nselect\nEND OF STMT\nPARSE #1:c=0\nEXEC #1:c=0\nCLOSE #1:c=0\n",
		"banner end":   "*****\ntitle\n",
		"crlf":         strings.ReplaceAll(strings.Join(lines[:200], "\n"), "\n", "\r\n"),
		"start only":   "Registered qb: SEL$1 0x1 (PARSER)\n",
		"end only":     "====================== END SQL Statement Dump ======================\n",
		"two starts":   "Registered qb: SEL$1 0x1 (PARSER)\nSPM: x\nRegistered qb: SEL$1 0x2 (PARSER)\nSPM: y\n",
		"long line":    "Registered qb: SEL$1 0x1 (PARSER)\n" + strings.Repeat("x", 3<<20) + "\nSPM: z\n",
		"no prologue":  strings.Join(lines[30:2000], "\n"),
		"other server": strings.Replace(strings.Join(lines[:400], "\n"), "Version 19.27.0.0.0", "Version 23.6.0.25.01", 1),
	}
	for name, in := range cases {
		sc, err := ScanReader(strings.NewReader(in), name)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		checkInvariants(t, name, sc)
		if err := WriteDigest(io.Discard, sc, nil, TextOptions{}); err != nil {
			t.Errorf("%s: digest: %v", name, err)
		}
		switch name {
		case "empty":
			if sc.File.Lines != 0 || len(sc.Dumps) != 0 {
				t.Errorf("empty: %+v", sc.File)
			}
		case "only 10046":
			if len(sc.Dumps) != 0 || sc.File.Records10046 != 4 && sc.File.Records10046 != 5 {
				t.Errorf("only 10046: %d dumps, %d records", len(sc.Dumps), sc.File.Records10046)
			}
		case "two starts":
			if len(sc.Dumps) != 2 || !sc.Dumps[0].Truncated || !sc.Dumps[1].Truncated {
				t.Errorf("two starts: %d dumps", len(sc.Dumps))
			}
		case "crlf":
			if sc.File.Lines != 200 || sc.File.Version != "19.27.0.0.0" || len(sc.Dumps) != 1 || sc.Dumps[0].SQLID == "" {
				t.Errorf("crlf: %+v", sc.File)
			}
		case "other server":
			if sc.File.Tested || sc.File.Version != "23.6.0.25.01" {
				t.Errorf("other server: %+v", sc.File)
			}
			var b bytes.Buffer
			WriteDigest(&b, sc, nil, TextOptions{})
			if !strings.Contains(b.String(), "read with the 19c rules; this file is 23.6.0.25.01") {
				t.Errorf("the digest does not say the version is untested")
			}
		case "long line":
			if sc.File.Lines != 3 {
				t.Errorf("long line: %d lines", sc.File.Lines)
			}
		}
	}
}

// TestNth: two dumps of one sql_id are two entries, numbered in file order.
func TestNth(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(optDir, "opt_subq_binds.trc"))
	if err != nil {
		t.Fatal(err)
	}
	sc, err := ScanReader(io.MultiReader(bytes.NewReader(data), bytes.NewReader(data), bytes.NewReader(data)), "x.trc")
	if err != nil {
		t.Fatal(err)
	}
	if len(sc.Dumps) != 3 {
		t.Fatalf("%d dumps", len(sc.Dumps))
	}
	for i, d := range sc.Dumps {
		if d.Nth != i+1 || d.SQLID != sc.Dumps[0].SQLID || sc.File.Dumps[i].Nth != i+1 {
			t.Errorf("dump %d: Nth %d", i, d.Nth)
		}
	}
	checkInvariants(t, "x3", sc)
	// the model of the second copy is the first one's, shifted by the lines before it
	a, b := sc.Dumps[0], sc.Dumps[1]
	shift := b.From - a.From
	if b.End-a.End != shift || b.PlanHash != a.PlanHash || len(b.Landmarks) != len(a.Landmarks) || b.RunCount != a.RunCount || len(b.Folds) != len(a.Folds) {
		t.Errorf("the copies differ: %d-%d / %d-%d", a.From, a.End, b.From, b.End)
	}
	for i := range a.Landmarks {
		if b.Landmarks[i].Line-a.Landmarks[i].Line != shift {
			t.Fatalf("landmark %d is not shifted by %d", i, shift)
		}
	}
}
