package diag

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

var update = flag.Bool("update", false, "rewrite the snapshots under testdata/snap")

const (
	diagDir   = "../../testdata/diag/19c"
	tracesDir = "../../testdata/traces/19c"
	bigDir    = "../../testdata/big/diag"
	snapDir   = "testdata/snap"
)

// fixtures are the committed diagnostic dump traces: every one of testdata/diag/19c and diag_in_10046.
func fixtures(t testing.TB) []string {
	t.Helper()
	all, err := filepath.Glob(filepath.Join(diagDir, "*.trc"))
	if err != nil || len(all) == 0 {
		t.Fatalf("no fixtures under %s (%v)", diagDir, err)
	}
	all = append(all, filepath.Join(tracesDir, "diag_in_10046.trc"))
	sort.Strings(all)
	return all
}

// bigFixtures are the traces of testdata/big/diag that are not in git (nil when absent).
func bigFixtures() []string {
	all, _ := filepath.Glob(filepath.Join(bigDir, "*.trc"))
	sort.Strings(all)
	return all
}

func fixtureName(path string) string { return strings.TrimSuffix(filepath.Base(path), ".trc") }

var (
	readerMu    sync.Mutex
	readerCache = map[string]*Reader{}
)

// readerOf scans a file once for the whole test run and opens its line index.
func readerOf(t testing.TB, path string) *Reader {
	t.Helper()
	readerMu.Lock()
	defer readerMu.Unlock()
	if r, ok := readerCache[path]; ok {
		return r
	}
	r, err := OpenFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	readerCache[path] = r
	return r
}

// allChildren gives every child of a node, page by page.
func allChildren(t testing.TB, r *Reader, id string, capN int) []Node {
	t.Helper()
	var out []Node
	after := 0
	for {
		o, err := r.children(id, after, capN)
		if err != nil {
			t.Fatalf("children(%s, %d): %v", id, after, err)
		}
		out = append(out, o.Children...)
		if o.More == 0 {
			return out
		}
		if o.Next != after+len(o.Children) || len(o.Children) == 0 {
			t.Fatalf("children(%s, %d): next %d after %d children", id, after, o.Next, len(o.Children))
		}
		after = o.Next
	}
}

// checkTiling: the top-level nodes tile the file.
func checkTiling(t *testing.T, name string, sc *Scan) {
	t.Helper()
	next := 1
	for i, n := range sc.Top {
		if n.From != next {
			t.Errorf("%s: top node %d (%s %q) starts at %d, want %d", name, i, n.Kind, n.Title, n.From, next)
		}
		if n.To < n.From {
			t.Errorf("%s: top node %d (%s %q) is empty: %d-%d", name, i, n.Kind, n.Title, n.From, n.To)
		}
		if n.Lines != n.To-n.From+1 {
			t.Errorf("%s: top node %d has Lines %d for %d-%d", name, i, n.Lines, n.From, n.To)
		}
		next = n.To + 1
	}
	if next != sc.File.Lines+1 {
		t.Errorf("%s: the top level ends at line %d, the file has %d lines", name, next-1, sc.File.Lines)
	}
	if len(sc.File.Outline) != min(len(sc.Top), Cap) || sc.File.OutlineTotal != len(sc.Top) {
		t.Errorf("%s: File.Outline has %d of %d nodes, Top %d", name, len(sc.File.Outline), sc.File.OutlineTotal, len(sc.Top))
	}
}

// checkNodes: children lie inside their parent, in file order, without overlap; ids are unique among
// siblings and resolve; one level down for every node that has children.
func checkNodes(t *testing.T, name string, r *Reader, depth int) {
	t.Helper()
	var walk func(parent Node, d int)
	walk = func(parent Node, d int) {
		kids := allChildren(t, r, parent.ID, Cap)
		if len(kids) > 0 && !parent.HasChildren {
			t.Errorf("%s: %s %q has children but HasChildren is false", name, parent.ID, parent.Title)
		}
		if len(kids) == 0 && parent.HasChildren {
			t.Errorf("%s: %s %q says HasChildren, but Children is empty", name, parent.ID, parent.Title)
		}
		prevTo := parent.From - 1
		ids := map[string]bool{}
		for _, c := range kids {
			if c.From < parent.From || c.To > parent.To {
				t.Errorf("%s: child %s %q (%d-%d) is outside its parent %s %q (%d-%d)", name, c.ID, c.Title, c.From, c.To, parent.ID, parent.Title, parent.From, parent.To)
			}
			if c.From <= prevTo {
				t.Errorf("%s: child %s %q (%d-%d) overlaps or precedes the sibling before it (ends %d)", name, c.ID, c.Title, c.From, c.To, prevTo)
			}
			if c.To < c.From || c.Lines != c.To-c.From+1 {
				t.Errorf("%s: child %s %q has range %d-%d, Lines %d", name, c.ID, c.Title, c.From, c.To, c.Lines)
			}
			if c.Title == "" {
				t.Errorf("%s: child %s has no title", name, c.ID)
			}
			if ids[c.ID] {
				t.Errorf("%s: two children of %s have the id %s", name, parent.ID, c.ID)
			}
			ids[c.ID] = true
			if c.ID == parent.ID {
				t.Errorf("%s: child has its parent's id %s", name, c.ID)
			}
			prevTo = c.To
			if d < depth && c.HasChildren {
				walk(c, d+1)
			}
		}
	}
	for _, n := range r.Scan.Top {
		if n.HasChildren {
			walk(n, 1)
		} else if o, err := r.Children(n.ID, 0); err != nil || len(o.Children) != 0 {
			t.Errorf("%s: %s %q has no HasChildren but Children gives %v (%v)", name, n.ID, n.Title, o, err)
		}
	}
}

// outlineText is the snapshot of the outline: the file facts, the top level, and one level of children.
func outlineText(t testing.TB, r *Reader) string {
	t.Helper()
	sc := r.Scan
	f := &sc.File
	var b strings.Builder
	fmt.Fprintf(&b, "file %s: %d lines, version %q tested=%v, %d 10046 record lines, %d unplaced\n", f.Name, f.Lines, f.Version, f.Tested, f.Records10046, f.Unplaced)
	if in := f.Incident; in != nil {
		fmt.Fprintf(&b, "incident: dump file %q, continued from %q, id %q, problem %q\n", in.DumpFile, in.ContinuedFrom, in.ID, in.Problem)
	}
	for _, s := range f.Sections {
		cut := ""
		if s.Cut {
			cut = " cut"
		}
		fmt.Fprintf(&b, "section %s %d-%d%s\n", s.Kind, s.First, s.Last, cut)
	}
	b.WriteString("outline:\n")
	line := func(indent int, n Node) {
		mark := " "
		if n.HasChildren {
			mark = "+"
		}
		extra := ""
		if n.Depth != nil {
			extra += fmt.Sprintf(" depth=%d", *n.Depth)
		}
		if n.Size > 0 {
			extra += fmt.Sprintf(" size=%d", n.Size)
		}
		if n.Cut {
			extra += " cut"
		}
		sub := ""
		if n.Sub != "" {
			sub = "  [" + n.Sub + "]"
		}
		fmt.Fprintf(&b, "%s%s %d-%d (%d) %s: %s%s%s\n", strings.Repeat("  ", indent), mark, n.From, n.To, n.Lines, n.Kind, n.Title, sub, extra)
	}
	for _, n := range sc.Top {
		line(0, n)
		if !n.HasChildren {
			continue
		}
		o, err := r.Children(n.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		const head, tail = 24, 10
		for i, c := range o.Children {
			if len(o.Children) > head+tail && i >= head && i < len(o.Children)-tail {
				if i == head {
					fmt.Fprintf(&b, "    ... %d more children\n", len(o.Children)-head-tail)
				}
				continue
			}
			line(2, c)
		}
		if o.More > 0 {
			fmt.Fprintf(&b, "    ... and %d more on the next page\n", o.More)
		}
	}
	return b.String()
}

func readFile(t testing.TB, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// compareSnap checks got against the snapshot file (or writes it with -update).
func compareSnap(t *testing.T, path, got string) {
	t.Helper()
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run the test with -update to write the snapshots)", err)
	}
	if string(want) != got {
		t.Errorf("%s differs from the snapshot (run with -update to rewrite it)\n--- first difference:\n%s", path, firstDiff(string(want), got))
	}
}

func firstDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var a, b string
		if i < len(w) {
			a = w[i]
		}
		if i < len(g) {
			b = g[i]
		}
		if a != b {
			return fmt.Sprintf("line %d\n  want: %s\n  got:  %s", i+1, a, b)
		}
	}
	return "(none)"
}

// sectionKindOf is the trace kind of a node kind name.
func sectionKindOf(kind string) trace.SectionKind { return trace.ParseSectionKind(kind) }

func filepathJoin(a, b string) string { return filepath.Join(a, b) }
