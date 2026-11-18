package diag

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// countSource counts the lines asked of a Source.
type countSource struct {
	Source
	asked int
}

func (c *countSource) Read(from, n int) ([]byte, error) {
	c.asked += n
	return c.Source.Read(from, n)
}

func checkChain(t *testing.T, what string, p *Path, line int) {
	t.Helper()
	if len(p.Nodes) == 0 || len(p.Nodes) > PathDepth {
		t.Fatalf("%s: %d nodes", what, len(p.Nodes))
	}
	for i, n := range p.Nodes {
		if line > 0 && (n.From > line || n.To < line) {
			t.Errorf("%s: node %d (%s %d-%d) does not hold line %d", what, i, n.Kind, n.From, n.To, line)
		}
		if i > 0 {
			up := p.Nodes[i-1]
			if n.From < up.From || n.To > up.To || n.ID == up.ID || !up.HasChildren {
				t.Errorf("%s: node %d (%s %d-%d) is not inside node %d (%s %d-%d, children %v)", what, i, n.Kind, n.From, n.To, i-1, up.Kind, up.From, up.To, up.HasChildren)
			}
		}
	}
}

// TestPathTwoLevels: every node of the two top levels of every fixture is found again by its first line (it is in the
// path of that line) and by its id (the path ends with it), and each path is a chain of nodes inside one another.
func TestPathTwoLevels(t *testing.T) {
	files := append(fixtures(t), bigFixtures()...)
	total := 0
	for _, fx := range files {
		r := readerOf(t, fx)
		name := fixtureName(fx)
		check := func(n Node, depth int) {
			p, err := r.Path(n.From)
			if err != nil {
				t.Fatalf("%s: Path(%d): %v", name, n.From, err)
			}
			checkChain(t, name+" line "+itoa(n.From), p, n.From)
			if len(p.Nodes) < depth {
				t.Errorf("%s: the path of line %d of %s %q has %d nodes, want at least %d", name, n.From, n.Kind, n.Title, len(p.Nodes), depth)
			}
			found := false
			for _, pn := range p.Nodes {
				found = found || pn.ID == n.ID
			}
			if !found {
				t.Errorf("%s: %s %q (%d-%d) is not in the path of its first line: %v", name, n.Kind, n.Title, n.From, n.To, ids(p))
			}
			q, err := r.PathTo(n.ID)
			if err != nil {
				t.Fatalf("%s: PathTo(%s): %v", name, n.ID, err)
			}
			checkChain(t, name+" node "+n.ID, q, n.From)
			if len(q.Nodes) != depth || q.Nodes[len(q.Nodes)-1].ID != n.ID || q.Nodes[0].ID != r.Scan.Top[topIndex(r, n.From)].ID {
				t.Errorf("%s: PathTo(%s) %v, want %d nodes ending with it", name, n.ID, ids(q), depth)
			}
			total++
		}
		for _, n := range r.Scan.Top {
			check(n, 1)
			if !n.HasChildren {
				continue
			}
			o, err := r.Children(n.ID, 0) // the first page, as a client loads it
			if err != nil {
				t.Fatal(err)
			}
			for _, c := range o.Children {
				check(c, 2)
			}
		}
	}
	t.Logf("%d nodes found again", total)
	if total < 500 {
		t.Errorf("only %d nodes checked", total)
	}
}

func ids(p *Path) []string {
	var out []string
	for _, n := range p.Nodes {
		out = append(out, n.ID)
	}
	return out
}

func topIndex(r *Reader, line int) int {
	for i, n := range r.Scan.Top {
		if n.From <= line && line <= n.To {
			return i
		}
	}
	return -1
}

// TestPathNested: a line in a part the client has not loaded resolves: the sampled heap in a PGA summary (a heap nested in
// a banner), a state object of a process of a system state, a frame of the stack in a deadlock's diagnostic dump.
func TestPathNested(t *testing.T) {
	// the heap nested in the PGA summary: top section, the banner it stands in, the heap
	r := readerOf(t, filepath.Join(diagDir, "diag_pga_summary.trc"))
	var heap Node
	var top Node
	for _, n := range r.Scan.Top {
		if n.Kind != "pga-summary" {
			continue
		}
		top = n
		for _, c := range allChildren(t, r, n.ID, Cap) {
			for _, g := range allChildren(t, r, c.ID, Cap) {
				if g.Kind == "heap" {
					heap = g
				}
			}
		}
	}
	if heap.ID == "" {
		t.Fatal("no heap nested in the PGA summary")
	}
	p, err := r.Path(heap.From + 5)
	if err != nil {
		t.Fatal(err)
	}
	checkChain(t, "nested heap", p, heap.From+5)
	if len(p.Nodes) < 3 || p.Nodes[0].ID != top.ID || p.Nodes[len(p.Nodes)-1].Kind != "heap" && p.Nodes[len(p.Nodes)-2].ID != heap.ID {
		t.Errorf("path of a line in the nested heap: %v", ids(p))
	}
	found := false
	for _, n := range p.Nodes {
		found = found || n.ID == heap.ID
	}
	if !found || p.Nodes[1].Kind != "banner" {
		t.Errorf("the nested heap %s is not in the path %v", heap.ID, ids(p))
	}
	// a process of a system state, deep inside it
	r = readerOf(t, filepath.Join(diagDir, "diag_sysstate_l1.trc"))
	p, err = r.Path(18559) // the session line of process 61
	if err != nil {
		t.Fatal(err)
	}
	checkChain(t, "process line", p, 18559)
	if len(p.Nodes) < 3 || p.Nodes[0].Kind != "sysstate" || p.Nodes[1].Kind != "process" || p.Nodes[1].N != 61 || p.Nodes[2].Kind != "so" {
		t.Errorf("path of a line of process 61: %v", ids(p))
	}
	// a frame of the diagnostic dump of a deadlock
	r = readerOf(t, filepath.Join(diagDir, "diag_deadlock.trc"))
	p, err = r.Path(300)
	if err != nil {
		t.Fatal(err)
	}
	checkChain(t, "deadlock frame", p, 300)
	if len(p.Nodes) < 3 || p.Nodes[0].Kind != "deadlock" || p.Nodes[1].Kind != "diagdump" {
		t.Errorf("path of line 300 of the deadlock: %v", ids(p))
	}
	// a line outside every part but the top one has a path of one node
	p, _ = r.Path(1)
	if len(p.Nodes) != 1 || p.Nodes[0].Kind != "header" {
		t.Errorf("path of line 1: %v", ids(p))
	}
}

// TestPathErrorsAndCache: lines outside the file, ids that are not nodes, the root, and the cache.
func TestPathErrorsAndCache(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_hang.trc"))
	for _, line := range []int{0, -3, r.src.Lines() + 1, 1 << 30} {
		if _, err := r.Path(line); !errors.Is(err, ErrNoLine) {
			t.Errorf("Path(%d): %v", line, err)
		}
	}
	if p, err := r.PathTo(RootID); err != nil || p == nil || len(p.Nodes) != 0 {
		t.Errorf("PathTo(root): %v %v", p, err)
	}
	hang := r.Scan.Top[2]
	for _, id := range []string{"", "nonsense", "hang:1-2", "hang:x-2:1:3", "hang:9-3:1:3", hang.ID + "9999", "title:60-70:1:40", "hang:1-" + itoa(r.src.Lines()+50) + ":1:40"} {
		if _, err := r.PathTo(id); !errors.Is(err, ErrNoNode) {
			t.Errorf("PathTo(%q): %v", id, err)
		}
	}
	// the same answer again, from the cache
	a, _ := r.Path(150)
	b, _ := r.Path(150)
	if a != b {
		t.Errorf("the second answer is not the cached one")
	}
	// more paths than the cache holds
	for i := 1; i <= pathCacheSize+10; i++ {
		if _, err := r.Path(i); err != nil {
			t.Fatal(err)
		}
	}
	r.pmu.Lock()
	n := len(r.paths)
	r.pmu.Unlock()
	if n > pathCacheSize {
		t.Errorf("%d paths cached", n)
	}
}

// TestPathReadsLittle: the path of a line near the start of a big system state reads a small part of its lines.
func TestPathReadsLittle(t *testing.T) {
	data := syntheticSysState(20000, 10, true)
	sc, err := ScanReader(strings.NewReader(string(data)), "x.trc")
	if err != nil {
		t.Fatal(err)
	}
	src := &countSource{Source: newMemSource(data)}
	r := NewReader(sc, src)
	var sys Node
	for _, n := range sc.Top {
		if n.Kind == "sysstate" {
			sys = n
		}
	}
	// a line of the 10th process's body
	var line int
	for _, c := range allChildren(t, r, sys.ID, Cap) {
		if c.Kind == "process" && c.N == 10 {
			line = c.From + 1
		}
	}
	src.asked = 0
	p, err := r.Path(line)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Nodes) < 2 || p.Nodes[1].Kind != "process" || p.Nodes[1].N != 10 {
		t.Fatalf("path %v", ids(p))
	}
	t.Logf("path of a line of process 10 in %d lines: %d lines read", sys.Lines, src.asked)
	// the summary of 20,000 lines comes first and is read; the 170,000 lines of the bodies after the 10th are not
	if src.asked > 20000+3*chunkLines {
		t.Errorf("%d lines read for a path in the first 10 processes of %d lines", src.asked, sys.Lines)
	}
	// a line near the end reads up to it
	src.asked = 0
	p, err = r.Path(sys.To - 30)
	if src.asked < sys.Lines*9/10 {
		t.Errorf("%d lines read for a path near the end of %d lines", src.asked, sys.Lines)
	}
	if err != nil || len(p.Nodes) < 2 || p.Nodes[1].Kind != "process" || p.Nodes[1].N < 19990 {
		t.Errorf("path of a line of the last processes: %v %v", ids(p), err)
	}
}
