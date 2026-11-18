package diag

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---- finding the nodes that have a reading

// readingNodes walks the outline of a file and lists every node that has a reading, nested ones too. The
// parts of a heap dump, a process and a state object hold none and are not entered.
func readingNodes(t testing.TB, r *Reader) []Node {
	t.Helper()
	var out []Node
	var walk func(n Node)
	walk = func(n Node) {
		if n.Reading != "" {
			out = append(out, n)
		}
		switch n.Kind {
		case "heap", "extents", "extent", "freelists", "bucket", "unpinned", "permanent", "subheaps", "process", "so", "title", "frame", "chain":
			return
		}
		if !n.HasChildren {
			return
		}
		for _, c := range allChildren(t, r, n.ID, Cap) {
			walk(c)
		}
	}
	for _, n := range r.Scan.Top {
		walk(n)
	}
	return out
}

// heapNodes are the nodes of kind heap.
func heapNodes(t testing.TB, r *Reader) []Node {
	var out []Node
	for _, n := range readingNodes(t, r) {
		if n.Kind == "heap" {
			out = append(out, n)
		}
	}
	return out
}

func heapOf(t testing.TB, r *Reader, n Node) *HeapReading {
	t.Helper()
	rd, err := r.Reading(n.ID)
	if err != nil {
		t.Fatalf("Reading(%s): %v", n.ID, err)
	}
	h, ok := rd.(*HeapReading)
	if !ok {
		t.Fatalf("Reading(%s) is %T", n.ID, rd)
	}
	return h
}

// reasonClass sorts the reasons a check could not be made into a few classes.
func reasonClass(reason string) string {
	switch {
	case strings.Contains(reason, "inside a PDB"):
		return "pdb"
	case strings.Contains(reason, "sampled"):
		return "sampled"
	case strings.Contains(reason, "no extents"):
		return "no extents"
	case strings.Contains(reason, "is cut"):
		return "cut"
	case strings.Contains(reason, "prints no"):
		return "no line"
	}
	return "other: " + reason
}

// ---- the totals test: the parity test of this reader

// totalsFiles are the files whose heaps the totals test reads: the committed fixtures and the big ones that
// hold heap dumps (not in git; skipped when absent).
func totalsFiles(t testing.TB) (committed, big []string) {
	committed = fixtures(t)
	for _, p := range bigFixtures() {
		switch fixtureName(p) {
		case "diag_heap_shared", "diag_errorstack", "diag_in_10046_l3":
			big = append(big, p)
		}
	}
	return
}

type totals struct {
	heaps, checks       int
	match, differ, none int
	reasons             map[string]int
}

func tally(t *testing.T, files []string) totals {
	tot := totals{reasons: map[string]int{}}
	for _, fx := range files {
		r := readerOf(t, fx)
		for _, n := range heapNodes(t, r) {
			h := heapOf(t, r, n)
			tot.heaps++
			for _, c := range h.Checks {
				tot.checks++
				switch c.State {
				case CheckMatch:
					tot.match++
					if c.Printed == nil || *c.Printed != c.Computed || c.Line == 0 || c.Diff != 0 || c.Reason != "" {
						t.Errorf("%s %s %s: a match is %+v", fixtureName(fx), h.Name, c.Name, c)
					}
				case CheckDiffer:
					tot.differ++
					t.Errorf("%s: heap %q (%d-%d) check %s DIFFERS: computed %d, printed %v (line %d)", fixtureName(fx), h.Name, h.From, h.To, c.Name, c.Computed, c.Printed, c.Line)
				case CheckNone:
					tot.none++
					if c.Reason == "" {
						t.Errorf("%s %s %s: a check that is none says nothing why", fixtureName(fx), h.Name, c.Name)
					}
					tot.reasons[reasonClass(c.Reason)]++
				default:
					t.Errorf("%s %s %s: state %q", fixtureName(fx), h.Name, c.Name, c.State)
				}
			}
		}
	}
	return tot
}

// TestHeapTotals: on every heap of every fixture (the committed ones, the two heaps inside diag_in_10046, the
// sampled heap of the PGA summary, and the shared pool dump when it is present) each check that can be made
// is a match; the ones that cannot say why; no fixture has a differ.
func TestHeapTotals(t *testing.T) {
	committed, big := totalsFiles(t)
	tot := tally(t, committed)
	t.Logf("committed fixtures: %d heaps, %d checks: %d match, %d none %v, %d differ", tot.heaps, tot.checks, tot.match, tot.none, tot.reasons, tot.differ)
	// the count is pinned: a fixture that gains or loses a heap changes it on purpose
	if tot.heaps != 100 {
		t.Errorf("the committed fixtures hold %d heaps, want 100", tot.heaps)
	}
	if tot.checks != 300 || tot.match != 288 || tot.none != 12 || tot.differ != 0 {
		t.Errorf("checks: %d, match %d, none %d, differ %d; want 300, 288, 12, 0", tot.checks, tot.match, tot.none, tot.differ)
	}
	want := map[string]int{"no extents": 6, "pdb": 3, "sampled": 3}
	for k, v := range want {
		if tot.reasons[k] != v {
			t.Errorf("reason %q: %d checks, want %d (%v)", k, tot.reasons[k], v, tot.reasons)
		}
	}
	if len(tot.reasons) != len(want) {
		t.Errorf("reasons: %v, want %v", tot.reasons, want)
	}
	if len(big) == 0 {
		t.Skip("testdata/big/diag is absent: the shared pool dump and the other big files were not read")
	}
	bt := tally(t, big)
	t.Logf("big files: %d heaps, %d checks: %d match, %d none %v, %d differ", bt.heaps, bt.checks, bt.match, bt.none, bt.reasons, bt.differ)
	for _, p := range big {
		if fixtureName(p) != "diag_heap_shared" {
			continue
		}
		st := tally(t, []string{p})
		// sga heap (header only), sga heap(1,0) and (1,3) with a reserved check each, IMCA_RO and IMCA_RW (header only)
		if st.heaps != 5 || st.checks != 17 || st.match != 8 || st.none != 9 || st.differ != 0 || st.reasons["no extents"] != 9 {
			t.Errorf("diag_heap_shared: %+v, want 5 heaps, 17 checks, 8 match, 9 none (all no extents), no differ", st)
		}
	}
}

// ---- the second reference: heapdump_analyzer

// hdaRow is a line of the output of heapdump_analyzer: chunks of one size of one heap, type and comment.
type hdaRow struct {
	total, count, size int64
	heap, typ, comment string
}

// parseHDA reads the output of heapdump_analyzer v1.03 (testdata/diag/README.md).
func parseHDA(t testing.TB, path string) []hdaRow {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []hdaRow
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		i := strings.Index(line, " ,")
		if i < 0 {
			continue
		}
		left := strings.Fields(line[:i])
		if len(left) != 3 {
			continue
		}
		var row hdaRow
		var e1, e2, e3 error
		row.total, e1 = strconv.ParseInt(left[0], 10, 64)
		row.count, e2 = strconv.ParseInt(left[1], 10, 64)
		row.size, e3 = strconv.ParseInt(left[2], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		rest := line[i+2:]
		// the heap field is printed with %16s and may hold a comma ("sga heap(1,0)"): split at a comma outside
		// parentheses; the comment, the last field, may hold commas too
		var fields []string
		depth, start := 0, 0
		for k := 0; k < len(rest) && len(fields) < 2; k++ {
			switch rest[k] {
			case '(':
				depth++
			case ')':
				depth--
			case ',':
				if depth == 0 {
					fields = append(fields, rest[start:k])
					start = k + 1
				}
			}
		}
		fields = append(fields, rest[start:])
		if len(fields) != 3 {
			t.Fatalf("%s: cannot split %q", path, line)
		}
		row.heap, row.typ, row.comment = strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1]), strings.TrimSpace(strings.TrimPrefix(fields[2], " "))
		out = append(out, row)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

type agg struct {
	chunks int64
	bytes  int64
}

type aggKey struct{ heap, typ, comment string }

// ourAgg is the aggregate of the extent chunks by (heap name, type, comment) over the heap dumps of a file,
// at the granularity of the reading (type group, comment group), before the bound on comments.
func ourAgg(t testing.TB, r *Reader) map[aggKey]agg {
	out := map[aggKey]agg{}
	for _, n := range heapNodes(t, r) {
		p := newHeapParser()
		if err := scanLines(r.src, n.From, n.To, func(i int, _, line, _ []byte) { p.feed(i, line) }); err != nil {
			t.Fatal(err)
		}
		for _, ca := range p.cmts {
			for _, ts := range ca.types {
				k := aggKey{p.name, ts.Type, ca.key}
				a := out[k]
				a.chunks += int64(ts.Chunks)
				a.bytes += ts.Bytes
				out[k] = a
			}
		}
	}
	return out
}

// hdaAgg is the same aggregate of heapdump_analyzer's output.
func hdaAgg(rows []hdaRow) map[aggKey]agg {
	out := map[aggKey]agg{}
	for _, row := range rows {
		key, _ := splitComment([]byte(row.comment))
		k := aggKey{row.heap, groupType([]byte(row.typ)), string(key)}
		a := out[k]
		a.chunks += row.count
		a.bytes += row.total
		out[k] = a
	}
	return out
}

// diffAgg lists the keys where two aggregates differ.
func diffAgg(ours, theirs map[aggKey]agg) []string {
	var out []string
	for k, a := range ours {
		if b, ok := theirs[k]; !ok || a != b {
			out = append(out, fmt.Sprintf("%v: reading %+v, heapdump_analyzer %+v (found %v)", k, a, b, ok))
		}
	}
	for k, b := range theirs {
		if _, ok := ours[k]; !ok {
			out = append(out, fmt.Sprintf("%v: only in heapdump_analyzer: %+v", k, b))
		}
	}
	sort.Strings(out)
	return out
}

// TestHeapdumpAnalyzer compares the aggregate of the reading by (heap, type, comment) with the output of
// heapdump_analyzer v1.03 (Tanel Poder, Apache 2.0, tanelpoder/tpt-oracle commit 45f0a4e), committed beside
// each fixture as <fixture>.hda.txt (testdata/diag/README.md says how it was made). The two agree on every
// group of every fixture. Where the script and the reading work differently, the comparison is made so that
// the difference does not show, and each of those is asserted here:
//
//   - The script merges the heaps of one name (it has no notion of one heap dump): diag_heap_sub holds 80
//     heap dumps of fewer names, diag_heap_uga two "session heap" dumps. The comparison sums the reading
//     by heap name. (Asserted below: the number of names is smaller than the number of dumps.)
//   - The script counts by the size of a chunk too (one row per size); the comparison sums the rows of a
//     group. It takes the comment as the 15 characters between the quotes: the comparison trims them and
//     groups by the part before "^" and the recr family as the reading does (the reading's rule, not the
//     script's).
//   - The script stops at "Total heap size", so a heap that prints none (a sampled heap, a header without
//     extents) is counted up to the next HEAP DUMP line: for the one sampled heap of the fixtures
//     (diag_pga_summary) the lines it adds are the heap's own five chunk lines, the same as the reading's,
//     and no other line with "Chunk" follows it (asserted: the group counts are equal).
//   - A PDB-filtered heap (diag_heap_large_pdb) lists no chunks: the script prints no row and the reading
//     has none (asserted: both empty).
//
// What the script does not do, and the reading does and is checked by TestHeapTotals instead: the free lists
// and the permanent chunks (counted by the script not at all, it stops at "Total heap size") and the totals.
func TestHeapdumpAnalyzer(t *testing.T) {
	type fx struct{ trc, hda string }
	var files []fx
	for _, name := range []string{"diag_heap_pga", "diag_heap_uga", "diag_heap_sub", "diag_heap_contents", "diag_heap_large", "diag_heap_large_pdb", "diag_deadlock", "diag_pga_summary"} {
		files = append(files, fx{filepath.Join(diagDir, name+".trc"), filepath.Join(diagDir, name+".hda.txt")})
	}
	files = append(files, fx{filepath.Join(tracesDir, "diag_in_10046.trc"), filepath.Join(tracesDir, "diag_in_10046.hda.txt")})
	for _, p := range bigFixtures() {
		if fixtureName(p) == "diag_heap_shared" {
			if _, err := os.Stat(strings.TrimSuffix(p, ".trc") + ".hda.txt"); err == nil {
				files = append(files, fx{p, strings.TrimSuffix(p, ".trc") + ".hda.txt"})
			}
		}
	}
	for _, f := range files {
		f := f
		t.Run(fixtureName(f.trc), func(t *testing.T) {
			r := readerOf(t, f.trc)
			ours := ourAgg(t, r)
			rows := parseHDA(t, f.hda)
			theirs := hdaAgg(rows)
			if d := diffAgg(ours, theirs); len(d) > 0 {
				t.Errorf("%d differences, the first: %s", len(d), strings.Join(d[:min(5, len(d))], "\n    "))
			}
			// the rows add up too: the total of the script's rows is the bytes of the reading's chunks
			var scriptBytes, ourBytes int64
			for _, row := range rows {
				scriptBytes += row.total
			}
			for _, n := range heapNodes(t, r) {
				ourBytes += heapOf(t, r, n).Bytes
			}
			if scriptBytes != ourBytes {
				t.Errorf("the script's rows hold %d bytes, the reading's heaps %d", scriptBytes, ourBytes)
			}
			var chunks int64
			for _, a := range ours {
				chunks += a.chunks
			}
			t.Logf("%s: %d groups, %d chunks, %d bytes agree with heapdump_analyzer", fixtureName(f.trc), len(ours), chunks, ourBytes)
			switch fixtureName(f.trc) {
			case "diag_heap_sub", "diag_heap_uga":
				names := map[string]bool{}
				nodes := heapNodes(t, r)
				for _, n := range nodes {
					names[n.Name] = true
				}
				if len(names) >= len(nodes) {
					t.Errorf("%d names in %d heap dumps: no heap is merged by name here", len(names), len(nodes))
				}
			case "diag_heap_large_pdb":
				if len(rows) != 0 || len(ours) != 0 {
					t.Errorf("a PDB-filtered dump lists chunks: script %d rows, reading %d groups", len(rows), len(ours))
				}
			case "diag_pga_summary":
				if len(rows) != 5 || chunks != 5 {
					t.Errorf("the sampled heap: script %d rows, reading %d chunks, want 5", len(rows), chunks)
				}
			}
		})
	}
}

// TestHeapdumpAnalyzerNegative: the comparison finds a difference when there is one.
func TestHeapdumpAnalyzerNegative(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	ours := ourAgg(t, r)
	theirs := hdaAgg(parseHDA(t, filepath.Join(diagDir, "diag_heap_pga.hda.txt")))
	if d := diffAgg(ours, theirs); len(d) != 0 {
		t.Fatalf("differences on the real output: %v", d)
	}
	for k, a := range theirs { // one chunk more in one group
		theirs[k] = agg{a.chunks + 1, a.bytes}
		break
	}
	if d := diffAgg(ours, theirs); len(d) != 1 {
		t.Errorf("a changed group: %d differences", len(d))
	}
	delete(theirs, aggKey{"pga heap", "perm", "perm"})
	if d := diffAgg(ours, theirs); len(d) < 1 {
		t.Errorf("a missing group is not found")
	}
}

// ---- invariants

// TestHeapInvariants holds on every heap of every fixture.
func TestHeapInvariants(t *testing.T) {
	committed, big := totalsFiles(t)
	for _, fx := range append(committed, big...) {
		r := readerOf(t, fx)
		name := fixtureName(fx)
		var nodes []Node
		byID := map[string]Node{}
		for _, n := range heapNodes(t, r) {
			nodes = append(nodes, n)
			byID[n.ID] = n
		}
		for _, n := range nodes {
			h := heapOf(t, r, n)
			// by type: the sum is the chunk total
			var tc int
			var tb int64
			for _, ty := range h.ByType {
				tc += ty.Chunks
				tb += ty.Bytes
				if len(ty.Variants) > 0 {
					var vc int
					var vb int64
					for _, v := range ty.Variants {
						vc += v.Chunks
						vb += v.Bytes
					}
					if vc != ty.Chunks || vb != ty.Bytes {
						t.Errorf("%s %s: variants of %s sum to %d/%d, the type holds %d/%d", name, h.Name, ty.Type, vc, vb, ty.Chunks, ty.Bytes)
					}
				}
			}
			if tc != h.Chunks || tb != h.Bytes {
				t.Errorf("%s %s (%d): by type %d chunks %d bytes, the heap %d chunks %d bytes", name, h.Name, h.From, tc, tb, h.Chunks, h.Bytes)
			}
			// by comment (and the rest): the same
			var cc int
			var cb int64
			count := len(h.ByComment)
			for _, c := range h.ByComment {
				cc += c.Chunks
				cb += c.Bytes
				var sc int
				var sb int64
				for _, ts := range c.Types {
					sc += ts.Chunks
					sb += ts.Bytes
				}
				if sc != c.Chunks || sb != c.Bytes {
					t.Errorf("%s %s: comment %q types sum to %d/%d, it holds %d/%d", name, h.Name, c.Comment, sc, sb, c.Chunks, c.Bytes)
				}
			}
			if o := h.OtherComments; o != nil {
				cc += o.Chunks
				cb += o.Bytes
				count += o.Count
				if len(h.ByComment) != CommentCap {
					t.Errorf("%s %s: other comments with %d listed, want %d", name, h.Name, len(h.ByComment), CommentCap)
				}
			}
			if cc != h.Chunks || cb != h.Bytes || count != h.Comments {
				t.Errorf("%s %s: by comment %d chunks %d bytes %d comments; the heap %d, %d, %d", name, h.Name, cc, cb, count, h.Chunks, h.Bytes, h.Comments)
			}
			if !sort.SliceIsSorted(h.ByComment, func(i, j int) bool { return h.ByComment[i].Bytes > h.ByComment[j].Bytes }) {
				t.Errorf("%s %s: comments are not sorted by bytes", name, h.Name)
			}
			// free lists: buckets sum to the chunks
			var fc int
			var fb int64
			for _, b := range h.FreeLists.Buckets {
				fc += b.Chunks
				fb += b.Bytes
			}
			if fc != h.FreeLists.Chunks || fb != h.FreeLists.Bytes {
				t.Errorf("%s %s: buckets sum to %d/%d, the lists hold %d/%d", name, h.Name, fc, fb, h.FreeLists.Chunks, h.FreeLists.Bytes)
			}
			// sub-heaps: links resolve to heap nodes of the file, the parent too, the run lists this heap
			resolve := func(what, id string) {
				if id == "" {
					return
				}
				if _, err := r.Reading(id); err != nil {
					t.Errorf("%s %s: %s %s does not resolve: %v", name, h.Name, what, id, err)
				}
				if _, ok := byID[id]; !ok {
					t.Errorf("%s %s: %s %s is not a heap node of the file", name, h.Name, what, id)
				}
			}
			resolve("parentNode", h.ParentNode)
			var subHeld int64
			for _, s := range h.Subheaps {
				resolve("subheap "+s.Desc, s.Node)
				subHeld += s.Held
				if s.Node != "" {
					if sh := heapOf(t, r, byID[s.Node]); sh.Desc != s.Desc {
						t.Errorf("%s %s: sub-heap %s links to a heap with desc %s", name, h.Name, s.Desc, sh.Desc)
					}
				}
			}
			if o := h.SubOther; o != nil {
				subHeld += o.Bytes
				if len(h.Subheaps) != SubheapCap || h.SubTotal != SubheapCap+o.Count {
					t.Errorf("%s %s: sub-heaps %d listed, %d other, %d in all", name, h.Name, len(h.Subheaps), o.Count, h.SubTotal)
				}
			} else if h.SubTotal != len(h.Subheaps) {
				t.Errorf("%s %s: %d sub-heaps listed of %d", name, h.Name, len(h.Subheaps), h.SubTotal)
			}
			if subHeld > h.Bytes {
				t.Errorf("%s %s: sub-heaps hold %d bytes of a heap of %d", name, h.Name, subHeld, h.Bytes)
			}
			for _, l := range h.Largest {
				resolve("largest "+l.Desc, l.Node)
			}
			self := false
			for _, e := range h.Run {
				resolve("run", e.Node)
				resolve("run parent", e.Parent)
				self = self || e.Node == n.ID
			}
			if !self {
				t.Errorf("%s %s: the run does not list the heap itself", name, h.Name)
			}
			if h.Lines != n.Lines || h.From != n.From || h.To != n.To {
				t.Errorf("%s %s: range %d-%d (%d), node %d-%d (%d)", name, h.Name, h.From, h.To, h.Lines, n.From, n.To, n.Lines)
			}
			if h.Kind != "heap" || h.Node != n.ID {
				t.Errorf("%s %s: kind %q node %q", name, h.Name, h.Kind, h.Node)
			}
		}
	}
}

// TestHeapLines: reading/lines returns exactly the chunk lines the count says, ascending, and pages.
func TestHeapLines(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	n := heapNodes(t, r)[0] // pga heap
	h := heapOf(t, r, n)
	raw := readFile(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	lines := strings.Split(raw, "\n")
	checked := 0
	for _, c := range h.ByComment {
		hl, err := r.HeapLines(n.ID, c.Comment, true, "", 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(hl.Lines) != c.Chunks || hl.Total != c.Chunks || hl.More != 0 || hl.Next != 0 {
			t.Errorf("comment %q: %d lines (total %d, more %d), the count says %d", c.Comment, len(hl.Lines), hl.Total, hl.More, c.Chunks)
		}
		if hl.Lines[0] != c.Line {
			t.Errorf("comment %q: the first line is %d, the reading says %d", c.Comment, hl.Lines[0], c.Line)
		}
		var sum int64
		for i, ln := range hl.Lines {
			if i > 0 && ln <= hl.Lines[i-1] {
				t.Errorf("comment %q: lines not ascending at %d", c.Comment, i)
			}
			l := lines[ln-1]
			if !strings.HasPrefix(l, "  Chunk ") || ln < n.From || ln > n.To {
				t.Errorf("line %d is %q, not a chunk line of the heap", ln, l)
				continue
			}
			ck, _ := parseChunk([]byte(l))
			key, _ := splitComment(ck.comment)
			if string(key) != c.Comment {
				t.Errorf("line %d has the comment %q, asked for %q", ln, key, c.Comment)
			}
			sum += ck.size
		}
		if sum != c.Bytes {
			t.Errorf("comment %q: the lines hold %d bytes, the reading says %d", c.Comment, sum, c.Bytes)
		}
		for _, ts := range c.Types {
			ht, err := r.HeapLines(n.ID, c.Comment, true, ts.Type, 0)
			if err != nil || len(ht.Lines) != ts.Chunks {
				t.Errorf("comment %q type %s: %v lines, want %d (%v)", c.Comment, ts.Type, ht, ts.Chunks, err)
			}
		}
		checked++
	}
	if checked < 10 {
		t.Fatalf("only %d comments checked", checked)
	}
	// by type alone, and a type of the family
	for _, ty := range h.ByType {
		ht, err := r.HeapLines(n.ID, "", false, ty.Type, 0)
		if err != nil || len(ht.Lines) != ty.Chunks {
			t.Errorf("type %s: %v, want %d lines (%v)", ty.Type, ht, ty.Chunks, err)
		}
	}
	// paging: the pages of the biggest comment, with a small page, are the whole list
	c := h.ByComment[0]
	whole, _ := r.HeapLines(n.ID, c.Comment, true, "", 0)
	after := 0
	var paged []int
	for {
		hl, err := r.HeapLines(n.ID, c.Comment, true, "", after)
		if err != nil {
			t.Fatal(err)
		}
		paged = append(paged, hl.Lines...)
		if hl.More == 0 {
			break
		}
		after = hl.Next
	}
	if fmt.Sprint(paged) != fmt.Sprint(whole.Lines) {
		t.Errorf("paged lines differ from the whole")
	}
	// the bound of an answer: the big shared pool holds a comment with more chunks than LinesCap
	for _, p := range bigFixtures() {
		if fixtureName(p) != "diag_heap_shared" {
			continue
		}
		br := readerOf(t, p)
		for _, bn := range heapNodes(t, br) {
			bh := heapOf(t, br, bn)
			for _, bc := range bh.ByComment {
				if bc.Chunks <= LinesCap+10 {
					continue
				}
				hl, err := br.HeapLines(bn.ID, bc.Comment, true, "", 0)
				if err != nil {
					t.Fatal(err)
				}
				if len(hl.Lines) != LinesCap || hl.More != bc.Chunks-LinesCap || hl.Next != hl.Lines[LinesCap-1] || hl.Total != bc.Chunks {
					t.Errorf("%s: %d lines, more %d, next %d, total %d; the comment holds %d", bc.Comment, len(hl.Lines), hl.More, hl.Next, hl.Total, bc.Chunks)
				}
				all, got := 0, 0
				for after := 0; ; {
					pg, _ := br.HeapLines(bn.ID, bc.Comment, true, "", after)
					got += len(pg.Lines)
					all++
					if pg.More == 0 {
						break
					}
					after = pg.Next
				}
				if got != bc.Chunks {
					t.Errorf("%s: the pages hold %d lines, the comment %d", bc.Comment, got, bc.Chunks)
				}
				return
			}
		}
	}
}

// TestHeapLinesErrors: a node that is no heap, and ids that are no node.
func TestHeapLinesErrors(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	if _, err := r.HeapLines("header:1-31:1:0", "perm", true, "", 0); err != ErrNoReading {
		t.Errorf("a header: %v", err)
	}
	if _, err := r.HeapLines("x", "perm", true, "", 0); err == nil {
		t.Errorf("a bad id did not fail")
	}
	if _, err := r.HeapLines("heap:5-40:1:100", "perm", true, "", 0); err == nil {
		t.Errorf("a range that starts no heap did not fail")
	}
	if _, err := r.Reading("heap:1-99999999:1:100"); err == nil {
		t.Errorf("a range past the file did not fail")
	}
	if _, err := r.Reading("header:1-31:1:0"); err != ErrNoReading {
		t.Errorf("header: %v", err)
	}
	if _, err := r.Reading("root"); err == nil || err == ErrNoReading {
		t.Errorf("root: %v", err)
	}
	if _, err := r.Reading("pga-summary:1-9:1:0"); err == nil {
		t.Errorf("a range that starts no PGA summary did not fail")
	}
}

// ---- the bounds, on a synthetic heap

// syntheticHeap makes a heap dump of n distinct comments, each with chunks of a few types.
func syntheticHeap(n int) []byte {
	var b bytes.Buffer
	b.WriteString("Trace file x.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\n\n")
	b.WriteString(strings.Repeat("*", 54) + "\n")
	b.WriteString("HEAP DUMP heap name=\"sga heap(1,0)\"  desc=0x601783c0\n")
	b.WriteString(" parent=(nil) owner=(nil) nex=(nil) xsz=0x0 heap=(nil) lru=(nil)\n dsx heap size=0, dsx heap depth=0\n pdb id=1, src pdb id=1\n")
	var total int64
	b.WriteString("EXTENT 0 addr=0x76000000\n")
	for i := 0; i < n; i++ {
		sz := int64(100 + i)
		typ := []string{"freeable", "recrPC001", "recrUT003", "freeableU"}[i%4]
		fmt.Fprintf(&b, "  Chunk        0%08x sz= %8d    %-9s \"%-15s\"\n", 0x76000000+i*64, sz, typ, fmt.Sprintf("CM%d^%x", i/2, i))
		total += sz
	}
	fmt.Fprintf(&b, "Total heap size    =%9d\nFREE LISTS:\n Bucket 0 size=32\nTotal free space   =        0\nUNPINNED RECREATABLE CHUNKS (lru first):\nPERMANENT CHUNKS:\nPermanent space    =        0\n", total)
	b.WriteString(strings.Repeat("*", 54) + "\n")
	return b.Bytes()
}

// TestHeapBounds: the comments are bounded to CommentCap, the rest is summed and says how many it holds.
func TestHeapBounds(t *testing.T) {
	const n = 1000
	r := readerOfBytes(t, syntheticHeap(n))
	nodes := heapNodes(t, r)
	if len(nodes) != 1 {
		t.Fatalf("%d heap nodes", len(nodes))
	}
	h := heapOf(t, r, nodes[0])
	// the chunks of CM<k>^.. share a comment: CM0 has chunks 0 and 1, so there are n/2 comments
	if h.Comments != n/2 || len(h.ByComment) != CommentCap || h.OtherComments == nil || h.OtherComments.Count != n/2-CommentCap {
		t.Fatalf("comments %d, listed %d, other %+v", h.Comments, len(h.ByComment), h.OtherComments)
	}
	if h.Chunks != n || h.OtherComments.Chunks != n-2*CommentCap {
		t.Errorf("chunks %d, in other %d", h.Chunks, h.OtherComments.Chunks)
	}
	if h.Checks[0].State != CheckMatch {
		t.Errorf("the check of the synthetic heap: %+v", h.Checks[0])
	}
	for _, c := range h.ByComment {
		if c.Suffixes != 2 {
			t.Errorf("comment %q folds %d suffixes, want 2", c.Comment, c.Suffixes)
			break
		}
	}
	// the type family: recr is one type with two variants
	var recr *HeapType
	for i := range h.ByType {
		if h.ByType[i].Type == "recr" {
			recr = &h.ByType[i]
		}
	}
	if recr == nil || len(recr.Variants) != 2 || recr.Chunks != n/2 {
		t.Errorf("recr: %+v", recr)
	}
	// the most bytes first: the biggest comment is the last pair (chunks n-2 and n-1)
	if h.ByComment[0].Comment != fmt.Sprintf("CM%d", n/2-1) {
		t.Errorf("the first comment is %q", h.ByComment[0].Comment)
	}
	// sub-heaps are bounded the same way
	var b bytes.Buffer
	b.Write(syntheticHeap(10))
	data := bytes.Replace(b.Bytes(), []byte("Total heap size"), []byte("     ds        0a000001 sz=  4096 ct=        1\nTotal heap size"), 1)
	_ = data
	var sb strings.Builder
	sb.WriteString("Trace file x.trc\n\n" + strings.Repeat("*", 54) + "\nHEAP DUMP heap name=\"x\"  desc=0x1\n pdb id=1, src pdb id=1\nEXTENT 0 addr=0x1\n")
	for i := 0; i < 250; i++ {
		fmt.Fprintf(&sb, "  Chunk        0%08x sz=     4096    recreate  \"SUB%d\"   \n     ds        0%08x sz= %8d ct=        2\n", 0x1000+i, i, 0x2000+i, 1000+i)
	}
	sb.WriteString("Total heap size    =    1024000\nFREE LISTS:\nTotal free space   =        0\nPERMANENT CHUNKS:\nPermanent space    =        0\n" + strings.Repeat("*", 54) + "\n")
	r = readerOfBytes(t, []byte(sb.String()))
	h = heapOf(t, r, heapNodes(t, r)[0])
	if h.SubTotal != 250 || len(h.Subheaps) != SubheapCap || h.SubOther == nil || h.SubOther.Count != 150 {
		t.Fatalf("sub-heaps: total %d, listed %d, other %+v", h.SubTotal, len(h.Subheaps), h.SubOther)
	}
	if h.Subheaps[0].Size != 1249 || h.Subheaps[0].Name != "SUB249" || h.Subheaps[0].Extents != 2 {
		t.Errorf("the largest sub-heap: %+v", h.Subheaps[0])
	}
}

// TestHeapMutationsOfTotals: a mutated dump either still matches or says differ; a damaged total is a differ
// with the difference, never a match.
func TestHeapMutationsOfTotals(t *testing.T) {
	data := readFile(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	bad := strings.Replace(data, "Total heap size    =  4707160", "Total heap size    =  4707161", 1)
	if bad == data {
		t.Fatal("the total was not found")
	}
	r := readerOfBytes(t, []byte(bad))
	h := heapOf(t, r, heapNodes(t, r)[0])
	c := h.Checks[0]
	if c.State != CheckDiffer || c.Diff != -1 || c.Computed != 4707160 || c.Printed == nil || *c.Printed != 4707161 {
		t.Errorf("a damaged total: %+v", c)
	}
	if h.Checks[1].State != CheckMatch || h.Checks[2].State != CheckMatch {
		t.Errorf("the other checks: %+v", h.Checks)
	}
	// a chunk line dropped
	lines := strings.Split(data, "\n")
	for i, l := range lines {
		if strings.HasPrefix(l, "  Chunk     7f952ae9b8f8 sz=") {
			lines = append(lines[:i], lines[i+1:]...)
			break
		}
	}
	r = readerOfBytes(t, []byte(strings.Join(lines, "\n")))
	h = heapOf(t, r, heapNodes(t, r)[0])
	if c := h.Checks[0]; c.State != CheckDiffer || c.Diff != -55048 {
		t.Errorf("a dropped chunk: %+v", c)
	}
}

// ---- prefixes and mutations of heap dumps

// TestHeapPrefixes: every prefix of a heap fixture reads without a panic; a heap that is cut says so, and
// the checks whose total is past the cut are none; no check of a prefix is a differ.
func TestHeapPrefixes(t *testing.T) {
	for _, name := range []string{"diag_heap_pga.trc", "diag_heap_large.trc", "diag_heap_large_pdb.trc", "diag_pga_summary.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		step := max(1, len(data)/150)
		cuts := 0
		for cut := 0; cut <= len(data); cut += step {
			r := readerOfBytes(t, data[:cut])
			for _, n := range readingNodes(t, r) {
				rd, err := r.Reading(n.ID)
				if err != nil {
					t.Fatalf("%s[:%d] %s: %v", name, cut, n.ID, err)
				}
				var b bytes.Buffer
				writeReading(&b, "", rd, textOpts{})
				if _, err := json.Marshal(rd); err != nil {
					t.Fatal(err)
				}
				h, ok := rd.(*HeapReading)
				if !ok {
					continue
				}
				if h.Flags.Cut {
					cuts++
					if !n.Cut {
						t.Errorf("%s[:%d]: the reading is cut, the node is not", name, cut)
					}
				}
				for _, c := range h.Checks {
					if c.State == CheckDiffer {
						t.Errorf("%s[:%d] heap %q: check %s differs on a prefix: %+v", name, cut, h.Name, c.Name, c)
					}
					if c.State == CheckNone && c.Reason == "" {
						t.Errorf("%s[:%d]: none without a reason", name, cut)
					}
					// a check whose printed line lies past the end of the data cannot be made
					if h.Flags.Cut && c.Printed == nil && c.State != CheckNone {
						t.Errorf("%s[:%d]: a cut heap with a made check %+v", name, cut, c)
					}
				}
				if h.Flags.Cut && h.Checks[0].State != CheckNone && h.Checks[0].Printed == nil {
					t.Errorf("%s[:%d]: first check of a cut heap: %+v", name, cut, h.Checks[0])
				}
			}
		}
		if name == "diag_heap_pga.trc" && cuts == 0 {
			t.Errorf("no prefix of %s gave a cut heap", name)
		}
	}
}

// TestCutHeap: a heap cut in the middle of its extents says cut and every check is none, and one cut after
// the totals keeps the checks that can be made.
func TestCutHeap(t *testing.T) {
	data := readFile(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	lines := strings.Split(data, "\n")
	cutAt := func(n int) *HeapReading {
		r := readerOfBytes(t, []byte(strings.Join(lines[:n], "\n")))
		return heapOf(t, r, heapNodes(t, r)[0])
	}
	h := cutAt(300) // in the extents
	if !h.Flags.Cut {
		t.Errorf("not cut: %+v", h.Flags)
	}
	for _, c := range h.Checks {
		if c.State != CheckNone || !strings.Contains(c.Reason, "cut") {
			t.Errorf("a heap cut in its extents: %+v", c)
		}
	}
	h = cutAt(690) // after Total heap size, in the free lists
	if !h.Flags.Cut || h.Checks[0].State != CheckMatch || h.Checks[1].State != CheckNone || h.Checks[2].State != CheckNone {
		t.Errorf("cut in the free lists: cut %v, checks %+v", h.Flags.Cut, h.Checks)
	}
}

// TestHeapMutations: damaged heap dumps read without a panic; the readings stay self-consistent.
func TestHeapMutations(t *testing.T) {
	junk := []string{"Total heap size    =  12", "FREE LISTS:", " Bucket 3 size=9", "  Chunk     7f952ae99020 sz=     4328    free      \"               \"", "  Chunk     7f sz= 12", "  Chunk",
		"  Chunk  1 sz=   -5   x", "EXTENT 3 addr=0x1", "PERMANENT CHUNKS:", "Permanent space    =  7", "     ds     7f952bcd11e8 sz=  35 ct=  1", "     ds", "     ds zz sz=1",
		"5 LARGEST SUB HEAPS for heap name=\"x\"  desc=0x1", "  Subheap ds=0x1  heap name=  a   size=    10", "  Subheap ds=0x", "Dump of memory from 0x1 to 0x2", "7F311C358020 000010E9 C0B38F00 00000000 00000000  [................]",
		"        Repeat 266 times", strings.Repeat("*", 54), "HEAP DUMP heap name=\"x\"  desc=0x1", " parent=0x7f952ce9a220 owner=(nil)", " dsx heap size=99999999999999999999, dsx heap depth=", " pdb id=",
		"(only chunks clearly belonging to pdb id 3 will be dumped)", " Heap has significant amount of free memory (76 percent)", " Dumping sample extents to show fragmentation pattern:",
		"RESERVED FREE LISTS:", " Reserved bucket 1 size=4", "Total of this reserved free space   = 5", "Total of all reserved free space   = 5", "Unpinned space     =12  rcr= trn=", "SUBHEAP 1: desc=0x1", ""}
	rng := newRand(7)
	for _, name := range []string{"diag_heap_pga.trc", "diag_heap_sub.trc", "diag_heap_large.trc", "diag_pga_summary.trc", "diag_pga_detail.trc", "diag_heap_contents.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		src := strings.Split(string(data), "\n")
		for it := 0; it < 40; it++ {
			ls := append([]string(nil), src[:min(len(src), 3000)]...)
			for k := rng.Intn(30) + 1; k > 0; k-- {
				i := rng.Intn(len(ls))
				switch rng.Intn(4) {
				case 0:
					ls = append(ls[:i], ls[i+1:]...)
				case 1:
					j := rng.Intn(len(ls))
					ls[i], ls[j] = ls[j], ls[i]
				case 2:
					ls[i] = junk[rng.Intn(len(junk))]
				case 3:
					ls = append(ls[:i], append([]string{junk[rng.Intn(len(junk))]}, ls[i:]...)...)
				}
			}
			r := readerOfBytes(t, []byte(strings.Join(ls, "\n")))
			for _, n := range readingNodes(t, r) {
				rd, err := r.Reading(n.ID)
				if err != nil {
					continue // a mutation may take the first line of a node away
				}
				if _, err := json.Marshal(rd); err != nil {
					t.Fatal(err)
				}
				if h, ok := rd.(*HeapReading); ok {
					var tc int
					for _, ty := range h.ByType {
						tc += ty.Chunks
					}
					if tc != h.Chunks {
						t.Fatalf("%s mutation %d: by type %d chunks, heap %d", name, it, tc, h.Chunks)
					}
					for _, c := range h.Checks {
						if c.State == "" || (c.State == CheckNone && c.Reason == "") {
							t.Fatalf("%s mutation %d: check %+v", name, it, c)
						}
					}
					r.HeapLines(n.ID, "perm", true, "", 0)
				}
			}
			var b bytes.Buffer
			if err := WriteDigest(&b, r); err != nil {
				t.Fatalf("%s mutation %d: digest: %v", name, it, err)
			}
		}
	}
}

// ---- snapshots of the readings

// truncateJSON keeps the first k elements of every list of a decoded JSON value and says how many were left.
func truncateJSON(v any, k int) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, 0, k+1)
		for i, e := range x {
			if i == k {
				out = append(out, fmt.Sprintf("... %d more", len(x)-k))
				break
			}
			out = append(out, truncateJSON(e, k))
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for kk, e := range x {
			out[kk] = truncateJSON(e, k)
		}
		return out
	}
	return v
}

// readingsSnapshot is the JSON of the readings of a file, lists cut to their first rows.
func readingsSnapshot(t testing.TB, r *Reader) string {
	var b strings.Builder
	nodes := readingNodes(t, r)
	for i, n := range nodes {
		if i >= 12 { // a file with many heaps: the first dozen
			fmt.Fprintf(&b, "... and %d more readings\n", len(nodes)-i)
			break
		}
		rd, err := r.Reading(n.ID)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(rd)
		var v any
		json.Unmarshal(raw, &v)
		out, _ := json.MarshalIndent(truncateJSON(v, 4), "", "  ")
		fmt.Fprintf(&b, "== %s %d-%d\n%s\n", n.Kind, n.From, n.To, out)
	}
	return b.String()
}

func TestReadingSnapshots(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		r := readerOf(t, fx)
		if len(readingNodes(t, r)) == 0 {
			continue
		}
		t.Run(fixtureName(fx), func(t *testing.T) {
			compareSnap(t, filepath.Join(snapDir, fixtureName(fx)+".readings.json.txt"), readingsSnapshot(t, r))
		})
	}
}

// TestReadingJSONShape pins the names of the fields of the readings.
func TestReadingJSONShape(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	h := heapOf(t, r, heapNodes(t, r)[0])
	raw, _ := json.Marshal(h)
	if !strings.HasPrefix(string(raw), `{"kind":"heap","node":`) {
		t.Errorf("a heap reading does not start with its kind: %.60s", raw)
	}
	var m map[string]any
	json.Unmarshal(raw, &m)
	for _, k := range []string{"kind", "node", "name", "desc", "from", "to", "lines", "extents", "chunks", "bytes", "heapSize", "flags", "checks", "byType", "byComment", "comments", "freeLists", "subheaps", "subheapsTotal", "largest", "run"} {
		if _, ok := m[k]; !ok {
			t.Errorf("a heap reading has no %q", k)
		}
	}
	for _, k := range []string{"parent", "parentNode", "otherComments", "otherSubheaps", "runMore"} {
		if _, ok := m[k]; ok {
			t.Errorf("a top heap reading has %q: %v", k, m[k])
		}
	}
	chk := m["checks"].([]any)[0].(map[string]any)
	for _, k := range []string{"name", "what", "state", "computed", "printed", "line"} {
		if _, ok := chk[k]; !ok {
			t.Errorf("a check has no %q: %v", k, chk)
		}
	}
	cm := m["byComment"].([]any)[0].(map[string]any)
	for _, k := range []string{"comment", "types", "chunks", "bytes", "line"} {
		if _, ok := cm[k]; !ok {
			t.Errorf("a comment has no %q: %v", k, cm)
		}
	}
	// lists are lists, never null
	if strings.Contains(string(raw), "null") {
		i := strings.Index(string(raw), "null")
		t.Errorf("a null in a heap reading: ...%s", raw[max(0, i-50):i+10])
	}
	for _, kind := range []string{"pga-summary", "pga-detail"} {
		var rr Reading
		for _, fx := range []string{"diag_pga_summary.trc", "diag_pga_detail.trc"} {
			rd := readerOf(t, filepath.Join(diagDir, fx))
			for _, n := range readingNodes(t, rd) {
				if n.Reading == kind {
					rr, _ = rd.Reading(n.ID)
				}
			}
		}
		raw, _ := json.Marshal(rr)
		if !strings.HasPrefix(string(raw), `{"kind":"`+kind+`","node":`) {
			t.Errorf("%s: %.60s", kind, raw)
		}
		if strings.Contains(string(raw), "null") {
			i := strings.Index(string(raw), "null")
			t.Errorf("a null in a %s reading: ...%s", kind, raw[max(0, i-50):i+10])
		}
	}
	// the node's kind
	for _, n := range readingNodes(t, r) {
		if n.Reading != "heap" {
			t.Errorf("node %s has reading %q", n.Kind, n.Reading)
		}
	}
	nr, _ := json.Marshal(r.Scan.Top[1])
	if !strings.Contains(string(nr), `"reading":"heap"`) {
		t.Errorf("a heap node has no reading: %s", nr)
	}
	hr, _ := json.Marshal(r.Scan.Top[0])
	if strings.Contains(string(hr), "reading") {
		t.Errorf("the header node has a reading: %s", hr)
	}
}

// ---- the digest

// TestDigestReadings: the digest holds the readings of its nodes, the text says the same numbers, and the
// bounds hold.
func TestDigestReadings(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	d, err := r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Readings) != 3 || d.ReadingsOmitted != 0 {
		t.Fatalf("%d readings in the digest, %d omitted", len(d.Readings), d.ReadingsOmitted)
	}
	var b bytes.Buffer
	if err := WriteDigest(&b, r); err != nil {
		t.Fatal(err)
	}
	text := b.String()
	for id, rd := range d.rd {
		h := rd.(*HeapReading)
		// every number of the checks, the types and the top comments is in the text
		for _, c := range h.Checks {
			for _, n := range []int64{c.Computed, *c.Printed} {
				if !strings.Contains(text, th64(n)) {
					t.Errorf("%s: %s = %d is not in the text", id, c.Name, n)
				}
			}
		}
		for _, ty := range h.ByType {
			if !strings.Contains(text, th64(ty.Bytes)) {
				t.Errorf("%s: type %s bytes %d not in the text", id, ty.Type, ty.Bytes)
			}
		}
		for _, c := range h.ByComment[:min(DigestComments, len(h.ByComment))] {
			if !strings.Contains(text, th64(c.Bytes)) || !strings.Contains(text, commentText(c.Comment)) {
				t.Errorf("%s: comment %q (%d bytes) is not in the text", id, c.Comment, c.Bytes)
			}
		}
		for _, s := range h.Subheaps[:min(DigestSubheaps, len(h.Subheaps))] {
			if !strings.Contains(text, s.Desc) || !strings.Contains(text, th64(s.Held)) {
				t.Errorf("%s: sub-heap %s is not in the text", id, s.Desc)
			}
		}
	}
	// the JSON of the digest carries them
	raw, _ := json.Marshal(d)
	if !bytes.Contains(raw, []byte(`"readings":{"heap:`)) {
		t.Errorf("the JSON of the digest has no readings")
	}
	// nested readings are not in the digest: the heaps of a deadlock, the sampled heap of a PGA summary
	for _, fx := range []string{"diag_deadlock.trc", "diag_pga_summary.trc"} {
		dr := readerOf(t, filepath.Join(diagDir, fx))
		dd, _ := dr.Digest()
		for id := range dd.Readings {
			if strings.HasPrefix(id, "heap:") {
				t.Errorf("%s: the digest holds the nested heap %s", fx, id)
			}
		}
	}
	// the bound on the number of readings: a file of 250 heaps keeps DigestReadings of them
	var big bytes.Buffer
	big.WriteString("Trace file x.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\n\n")
	for i := 0; i < DigestReadings+50; i++ {
		big.WriteString(strings.Repeat("*", 54) + fmt.Sprintf("\nHEAP DUMP heap name=\"h%d\"  desc=0x%x\n pdb id=1, src pdb id=1\nEXTENT 0 addr=0x1\n  Chunk 1 sz= 64 free \"\"\nTotal heap size    =       64\n", i, i+1))
	}
	big.WriteString(strings.Repeat("*", 54) + "\n")
	br := readerOfBytes(t, big.Bytes())
	bd, err := br.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if len(bd.Readings) != DigestReadings || bd.ReadingsOmitted != 50 {
		t.Errorf("%d readings, %d omitted", len(bd.Readings), bd.ReadingsOmitted)
	}
	var tb bytes.Buffer
	WriteDigest(&tb, br)
	if !strings.Contains(tb.String(), "50 of the parts that have a reading are shown without it") {
		t.Errorf("the text does not say 50 readings are left out")
	}
}

// ---- speed

func timeReading(t testing.TB, r *Reader, n Node) time.Duration {
	// a fresh reader state so that the cache does not answer
	rr := NewReader(r.Scan, r.src)
	start := time.Now()
	if _, err := rr.Reading(n.ID); err != nil {
		t.Fatal(err)
	}
	return time.Since(start)
}

// TestReadingSpeed: the reading of the largest heap of the big fixture and of the largest committed one.
func TestReadingSpeed(t *testing.T) {
	var best Node
	var bestR *Reader
	committed, big := totalsFiles(t)
	for _, fx := range committed {
		r := readerOf(t, fx)
		for _, n := range heapNodes(t, r) {
			if n.Lines > best.Lines {
				best, bestR = n, r
			}
		}
	}
	d := timeReading(t, bestR, best)
	t.Logf("largest committed heap: %d lines, reading in %v", best.Lines, d)
	if d > 500*time.Millisecond {
		t.Errorf("the reading of a heap of %d lines took %v", best.Lines, d)
	}
	for _, p := range big {
		if fixtureName(p) != "diag_heap_shared" {
			continue
		}
		r := readerOf(t, p)
		var largest Node
		for _, n := range heapNodes(t, r) {
			if n.Lines > largest.Lines {
				largest = n
			}
		}
		d := timeReading(t, r, largest)
		t.Logf("largest heap of the shared pool dump: %d lines, reading in %v", largest.Lines, d)
		if d > 2*time.Second {
			t.Errorf("the reading of a heap of %d lines took %v (the target is well under a second)", largest.Lines, d)
		}
		start := time.Now()
		hl, err := r.HeapLines(largest.ID, "KGLH0", true, "", 0)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("reading/lines for KGLH0: %d lines (%d in all) in %v", len(hl.Lines), hl.Total, time.Since(start))
	}
}

func BenchmarkHeapReading(b *testing.B) {
	for _, p := range bigFixtures() {
		if fixtureName(p) != "diag_heap_shared" {
			continue
		}
		r := readerOf(b, p)
		var largest Node
		for _, n := range heapNodes(b, r) {
			if n.Lines > largest.Lines {
				largest = n
			}
		}
		b.SetBytes(int64(largest.Lines) * 70)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			rr := NewReader(r.Scan, r.src)
			if _, err := rr.Reading(largest.ID); err != nil {
				b.Fatal(err)
			}
		}
	}
}
