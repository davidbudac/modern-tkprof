package diag

import (
	"bytes"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// memSource is a Source over bytes.
type memSource struct {
	lines [][]byte
	raw   []byte
	offs  []int
}

func newMemSource(data []byte) *memSource {
	m := &memSource{raw: data}
	start := 0
	for start < len(data) {
		m.offs = append(m.offs, start)
		i := bytes.IndexByte(data[start:], '\n')
		if i < 0 {
			break
		}
		start += i + 1
	}
	return m
}

func (m *memSource) Lines() int { return len(m.offs) }
func (m *memSource) Read(from, n int) ([]byte, error) {
	if from < 1 || from > len(m.offs) || n <= 0 {
		return nil, nil
	}
	last := min(len(m.offs), from+n-1)
	end := len(m.raw)
	if last < len(m.offs) {
		end = m.offs[last]
	}
	return m.raw[m.offs[from-1]:end], nil
}

func readerOfBytes(t testing.TB, data []byte) *Reader {
	t.Helper()
	sc, err := ScanReader(bytes.NewReader(data), "x.trc")
	if err != nil {
		t.Fatal(err)
	}
	return NewReader(sc, newMemSource(data))
}

func TestDigestSnapshots(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			var b bytes.Buffer
			if err := WriteDigest(&b, readerOf(t, fx)); err != nil {
				t.Fatal(err)
			}
			compareSnap(t, filepath.Join(snapDir, fixtureName(fx)+".digest.txt"), b.String())
		})
	}
}

// TestSectionsAgreeWithParser: the sections of the scan are the ones the parser finds.
func TestSectionsAgreeWithParser(t *testing.T) {
	for _, fx := range fixtures(t) {
		st, err := trace.ParseFile(fx, trace.NopHandler{})
		if err != nil {
			t.Fatal(err)
		}
		got := readerOf(t, fx).Scan.File.Sections
		if len(got) != len(st.Sections) {
			t.Errorf("%s: %d sections, the parser finds %d", fixtureName(fx), len(got), len(st.Sections))
			continue
		}
		for i, s := range st.Sections {
			if got[i].Kind != s.Kind.String() || got[i].First != s.First || got[i].Last != s.Last || got[i].Cut != s.Cut {
				t.Errorf("%s: section %d is %v, the parser finds %v", fixtureName(fx), i, got[i], s)
			}
		}
		if n := st.Count(trace.KindDiag); n == 0 && len(st.Sections) > 0 {
			t.Errorf("%s: no diagnostic lines", fixtureName(fx))
		}
	}
}

// TestIDsStable: two scans of a file give the same top level and the same children, and every id an
// answer holds is one Children takes back.
func TestIDsStable(t *testing.T) {
	for _, fx := range fixtures(t) {
		a, err := OpenFile(fx)
		if err != nil {
			t.Fatal(err)
		}
		b := readerOf(t, fx)
		if !reflect.DeepEqual(a.Scan.Top, b.Scan.Top) {
			t.Errorf("%s: two scans give different top levels", fixtureName(fx))
		}
		for _, n := range a.Scan.Top {
			if !n.HasChildren {
				continue
			}
			x, err1 := a.Children(n.ID, 0)
			y, err2 := b.Children(n.ID, 0)
			if err1 != nil || err2 != nil || !reflect.DeepEqual(x, y) {
				t.Errorf("%s: children of %s differ between scans (%v %v)", fixtureName(fx), n.ID, err1, err2)
			}
			for _, c := range x.Children {
				if _, err := a.Children(c.ID, 0); err != nil {
					t.Errorf("%s: %s does not resolve: %v", fixtureName(fx), c.ID, err)
				}
			}
		}
		a.Close()
	}
}

// TestPaging: with a small cap an answer lists that many children, says how many follow and where the
// next page starts, and the pages put together are the whole list.
func TestPaging(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_sub.trc"))
	var heap Node
	for _, n := range r.Scan.Top {
		if n.Kind == "heap" && n.HasChildren {
			heap = n
			break
		}
	}
	var ext Node
	for _, c := range allChildren(t, r, heap.ID, Cap) {
		if c.Kind == "extents" {
			ext = c
		}
	}
	whole := allChildren(t, r, ext.ID, Cap)
	if len(whole) < 20 {
		t.Fatalf("only %d extents to page", len(whole))
	}
	o, err := r.children(ext.ID, 0, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(o.Children) != 7 || o.More != len(whole)-7 || o.Next != 7 {
		t.Errorf("first page: %d children, more %d, next %d (of %d)", len(o.Children), o.More, o.Next, len(whole))
	}
	if paged := allChildren(t, r, ext.ID, 7); !reflect.DeepEqual(paged, whole) {
		t.Errorf("the pages of 7 are not the whole list")
	}
	last, _ := r.children(ext.ID, len(whole)-3, 7)
	if len(last.Children) != 3 || last.More != 0 || last.Next != 0 {
		t.Errorf("last page: %d children, more %d, next %d", len(last.Children), last.More, last.Next)
	}
	past, _ := r.children(ext.ID, len(whole)+50, 7)
	if len(past.Children) != 0 || past.More != 0 {
		t.Errorf("a page past the end: %d children, more %d", len(past.Children), past.More)
	}
	// the top level pages too
	root := allChildren(t, r, RootID, 5)
	if !reflect.DeepEqual(root, r.Scan.Top) {
		t.Errorf("the pages of the root are not the top level")
	}
	// a node with more than Cap children: a synthetic system state of 5,000 processes
	var b strings.Builder
	b.WriteString("Trace file x.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\n\n")
	b.WriteString("===================================================\nSYSTEM STATE (level=1)\n------------\n")
	for i := 1; i <= 5000; i++ {
		fmt.Fprintf(&b, "PROCESS %d: P%03d\n----------------------------------------\nSO: 0x%x, type: process (2), map: 0x1\n    state: LIVE\n", i, i%1000, 0x1000+i)
	}
	b.WriteString("END OF SYSTEM STATE\n")
	big := readerOfBytes(t, []byte(b.String()))
	var ss Node
	for _, n := range big.Scan.Top {
		if n.Kind == "sysstate" {
			ss = n
		}
	}
	o, err = big.Children(ss.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(o.Children) != Cap || o.More != 3000 || o.Next != Cap {
		t.Errorf("5,000 processes: %d listed, more %d, next %d", len(o.Children), o.More, o.Next)
	}
	o2, _ := big.Children(ss.ID, o.Next)
	if len(o2.Children) != Cap || o2.More != 1000 || o2.Children[0].N != Cap+1 {
		t.Errorf("second page: %d listed, more %d, first process %d", len(o2.Children), o2.More, o2.Children[0].N)
	}
	if all := allChildren(t, big, ss.ID, Cap); len(all) != 5000 || all[4999].N != 5000 {
		t.Errorf("all pages: %d children", len(all))
	}
}

// TestChildrenErrors: a node id that is not one is ErrNoNode.
func TestChildrenErrors(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_hang.trc"))
	for _, id := range []string{"", "x", "heap:1-2", "heap:1-2:1", "heap:0-5:1:100", "heap:5-2:1:100", "heap:a-b:1:100", "heap:1-99999999:1:100", ":1-2:1:100", "heap:1-2:-1:100", "heap:1-2:1:zz", "heap:1-2:1:100:7"} {
		if _, err := r.Children(id, 0); err == nil {
			t.Errorf("Children(%q) did not fail", id)
		}
	}
	if o, err := r.Children("header:1-31:1:0", 0); err != nil || len(o.Children) != 0 {
		t.Errorf("the header has no children: %v %v", o, err)
	}
	if o, err := r.Children("nonsense:1-31:1:0", 0); err != nil || len(o.Children) != 0 {
		t.Errorf("an unknown kind has no children: %v %v", o, err)
	}
}

// TestFileFacts: the facts of the header and of an incident file.
func TestFileFacts(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	f := r.Scan.File
	if f.Version != "19.27.0.0.0" || !f.Tested || !strings.HasPrefix(f.Release, "Oracle Database 19c") || f.Incident != nil || f.Records10046 != 0 {
		t.Errorf("heap_pga facts: %+v", f)
	}
	r = readerOf(t, filepath.Join(tracesDir, "diag_in_10046.trc"))
	if r.Scan.File.Records10046 != 99 {
		t.Errorf("diag_in_10046 has %d 10046 record lines, want 99", r.Scan.File.Records10046)
	}
	if f := r.Scan.Top[1]; f.Kind != "trace10046" || f.Records != 44 || f.Title != "SQL trace (10046) lines" {
		t.Errorf("diag_in_10046 second node: %+v", f)
	}
	// old releases: the version comes from the banner
	sc, _ := ScanReader(strings.NewReader("Trace file x\nOracle Database 11g Enterprise Edition Release 11.2.0.3.0 - 64bit Production\n\n"), "o.trc")
	if sc.File.Version != "11.2.0.3.0" || sc.File.Tested {
		t.Errorf("11.2 facts: %+v", sc.File)
	}
	for _, p := range bigFixtures() {
		if !strings.Contains(p, "incident") || strings.Contains(p, "oom_session") {
			continue
		}
		in := readerOf(t, p).Scan.File.Incident
		if in == nil || in.ID != "199651" || !strings.HasSuffix(in.DumpFile, "i199651.trc") || !strings.HasSuffix(in.ContinuedFrom, "mtk_diag_exp10.trc") || in.Problem != "ORA 6544 [pevm_peruws_callback-1]" {
			t.Errorf("incident facts: %+v", in)
		}
	}
}

// edge cases of the top level
func TestTopLevelEdges(t *testing.T) {
	for name, text := range map[string]string{
		"empty":           "",
		"one line":        "hello",
		"no newline end":  "HEAP DUMP heap name=\"pga heap\"  desc=0x1\n extent sz=0x1",
		"only blank":      "\n\n\n",
		"garbage":         "xx\n\nyy\n***\n---\n",
		"no prologue":     "*** 2026-11-17T21:34:26.343756+00:00 (PDB1(3))\n\nsome text\n",
		"star rule alone": strings.Repeat("*", 54) + "\n",
		"crlf":            "Trace file x\r\nVersion 19.1.0.0.0\r\n\r\nHEAP DUMP heap name=\"a\"  desc=0x1\r\n",
	} {
		r := readerOfBytes(t, []byte(text))
		checkTiling(t, name, r.Scan)
		checkNodes(t, name, r, 3)
		if name == "empty" && (len(r.Scan.Top) != 0 || r.Scan.File.Lines != 0) {
			t.Errorf("empty: %+v", r.Scan.File)
		}
	}
	r := readerOfBytes(t, []byte("xx\n\nyy\n"))
	if n := r.Scan.Top; len(n) != 1 || n[0].Kind != "other" || n[0].Title != "Other lines" || r.Scan.File.Unplaced != 2 {
		t.Errorf("garbage: %+v unplaced %d", n, r.Scan.File.Unplaced)
	}
}

// TestPrefixes: every prefix of a few fixtures (cut at lines, and in the middle of a line) scans and reads
// without a panic and agrees with itself.
func TestPrefixes(t *testing.T) {
	for _, name := range []string{"diag_hang.trc", "diag_heap_large.trc", "diag_pga_detail.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		step := max(1, len(data)/120)
		for cut := 0; cut <= len(data); cut += step {
			r := readerOfBytes(t, data[:cut])
			checkTiling(t, fmt.Sprintf("%s[:%d]", name, cut), r.Scan)
			checkNodes(t, fmt.Sprintf("%s[:%d]", name, cut), r, 3)
		}
	}
	// the heavier fixtures: cut at 40 places
	for _, name := range []string{"diag_errorstack_l2.trc", "diag_sysstate_l1.trc", "diag_procstate.trc", "diag_deadlock.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		for k := 0; k <= 40; k++ {
			cut := len(data) * k / 40
			r := readerOfBytes(t, data[:cut])
			checkTiling(t, fmt.Sprintf("%s[:%d]", name, cut), r.Scan)
			checkNodes(t, fmt.Sprintf("%s[:%d]", name, cut), r, 2)
		}
	}
}

// TestMutations damages fixtures at random (lines dropped, repeated, swapped, replaced by lines that mean
// something to the scan): nothing panics and what comes back still agrees with itself.
func TestMutations(t *testing.T) {
	junk := []string{
		"HEAP DUMP heap name=\"pga heap\"  desc=0x7f952ce9a220", strings.Repeat("*", 54), strings.Repeat("=", 20), strings.Repeat("-", 30),
		"PROCESS STATE", "-------------", "SYSTEM STATE (level=10, with short stacks)", "END OF SYSTEM STATE", "END OF PROCESS STATE",
		"HANG ANALYSIS:", "END OF HANG ANALYSIS", "HANG ANALYSIS DUMPS:", "HANG ANALYSIS DUMPS: END", "Chain 1:", "DEADLOCK DETECTED ( ORA-00060 )",
		"dbkedDefDump(): Starting a non-incident diagnostic dump (flags=0x0, level=2, mask=0x0)", "TOP 10 MEMORY USES FOR THIS PROCESS",
		"Begin PGA memory detail dump", "End PGA memory detail dump", "[TOC00000]", "[TOC00001]", "[TOC00001-END]", "x [TOC00002]", "TOC00001 - a title",
		"| | TOC00003 - nested", "----- A Title -----", "----- Dump Cursor sql_id=abc xsc=0x1 cur=0x2 -----", "========== FRAME [1] (a()+1 -> b()) ==========",
		"EXTENT 0 addr=0x1", "FREE LISTS:", " Bucket 0 size=56", "PERMANENT CHUNKS:", "UNPINNED RECREATABLE CHUNKS (lru first):", "3 LARGEST SUB HEAPS for heap name=\"x\"  desc=0x1",
		"PROCESS 3: PMON", "SO: 0x1, type: session (4), map: 0x2", "  SO: 0x1, type: process (2), map: 0x2", "      SO: 0x3, type: call (3), map: 0x2",
		"PARSING IN CURSOR #1 len=3", "END OF STMT", "EXEC #1:c=0", "WAIT #1: nam='x' ela= 1", "BINDS #1:", "*** 2026-11-17T21:34:26.343756+00:00", "",
		" ", "Dumping the Process Summary", "(session) sid: 22 ser: 14058 trans: 0x1", "(process) Oracle pid:6, ser:33,", " dsx heap size=4707160, dsx heap depth=0",
		"=====\nTITLE\n-----", "Registered qb: SEL$1 0x1 (PARSER)", "*** TRACE CONTINUES IN FILE x ***",
	}
	var sources [][]string
	for _, name := range []string{"diag_hang.trc", "diag_heap_pga.trc", "diag_procstate.trc", "diag_deadlock.trc", "diag_pga_summary.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		ls := strings.Split(string(data), "\n")
		sources = append(sources, ls[:min(len(ls), 1500)])
		sources = append(sources, ls[max(0, len(ls)-1500):])
	}
	rng := rand.New(rand.NewSource(1))
	for it := 0; it < 300; it++ {
		ls := append([]string(nil), sources[rng.Intn(len(sources))]...)
		for k := rng.Intn(40) + 1; k > 0; k-- {
			i := rng.Intn(len(ls))
			switch rng.Intn(5) {
			case 0:
				ls = append(ls[:i], ls[i+1:]...)
			case 1:
				ls = append(ls[:i], append([]string{ls[i]}, ls[i:]...)...)
			case 2:
				j := rng.Intn(len(ls))
				ls[i], ls[j] = ls[j], ls[i]
			case 3:
				ls[i] = junk[rng.Intn(len(junk))]
			case 4:
				ls = append(ls[:i], append([]string{junk[rng.Intn(len(junk))]}, ls[i:]...)...)
			}
		}
		data := []byte(strings.Join(ls, "\n"))
		name := fmt.Sprintf("mutation %d", it)
		r := readerOfBytes(t, data)
		checkTiling(t, name, r.Scan)
		checkNodes(t, name, r, 3)
		var b bytes.Buffer
		if err := WriteDigest(&b, r); err != nil {
			t.Fatalf("%s: digest: %v", name, err)
		}
	}
}
