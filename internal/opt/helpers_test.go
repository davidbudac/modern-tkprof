package opt

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the snapshots under testdata/snap")

const (
	optDir    = "../../testdata/opt/19c"
	tracesDir = "../../testdata/traces"
	mockDir   = "../../docs/mockups/10053-reader/data"
	snapDir   = "testdata/snap"
)

// fixtures are the 10053 traces: every one of testdata/opt/19c and the opt_* files of testdata/traces.
func fixtures(t testing.TB) []string {
	t.Helper()
	a, err := filepath.Glob(filepath.Join(optDir, "*.trc"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := filepath.Glob(filepath.Join(tracesDir, "*", "opt_*.trc"))
	all := append(a, b...)
	if len(all) == 0 {
		t.Fatalf("no fixtures under %s", optDir)
	}
	sort.Strings(all)
	return all
}

func fixtureName(path string) string { return strings.TrimSuffix(filepath.Base(path), ".trc") }

var (
	scanMu    sync.Mutex
	scanCache = map[string]*Scan{}
)

// scanOf scans a fixture once for the whole test run.
func scanOf(t testing.TB, path string) *Scan {
	t.Helper()
	scanMu.Lock()
	defer scanMu.Unlock()
	if s, ok := scanCache[path]; ok {
		return s
	}
	s, err := ScanFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	scanCache[path] = s
	return s
}

// checkInvariants is "the trace agrees with itself": the views tile the file, the outline nests, the
// landmarks, folds, banners and digest lie inside the view of their dump, the digest ascends.
func checkInvariants(t *testing.T, name string, sc *Scan) {
	t.Helper()
	f := &sc.File
	if len(f.Dumps) != len(sc.Dumps) {
		t.Errorf("%s: File.Dumps has %d entries, Dumps %d", name, len(f.Dumps), len(sc.Dumps))
	}
	next := 1
	for k, d := range sc.Dumps {
		if d.Idx != k {
			t.Errorf("%s: dump %d has Idx %d", name, k, d.Idx)
		}
		if d.ViewFrom != next {
			t.Errorf("%s: dump %d view starts at %d, want %d (the views must tile the file)", name, k, d.ViewFrom, next)
		}
		next = d.ViewTo + 1
		if d.From < d.ViewFrom || d.End < d.From || d.End > d.ViewTo {
			t.Errorf("%s: dump %d From %d End %d View %d-%d", name, k, d.From, d.End, d.ViewFrom, d.ViewTo)
		}
		if d.LineCount != d.ViewTo-d.ViewFrom+1 {
			t.Errorf("%s: dump %d LineCount %d", name, k, d.LineCount)
		}
		if d.DumpInfo.Idx != f.Dumps[k].Idx || d.From != f.Dumps[k].From || d.ViewTo != f.Dumps[k].ViewTo {
			t.Errorf("%s: dump %d differs from File.Dumps", name, k)
		}
		checkNode(t, name, d, d.Tree, nil)
		if d.Tree.From != d.ViewFrom || d.Tree.To != d.ViewTo || d.Tree.Kind != KindDump {
			t.Errorf("%s: dump %d root is %s %d-%d", name, k, d.Tree.Kind, d.Tree.From, d.Tree.To)
		}
		in := func(what string, a, b int) {
			if a < d.ViewFrom || b > d.ViewTo || a > b {
				t.Errorf("%s: dump %d %s %d-%d outside the view %d-%d", name, k, what, a, b, d.ViewFrom, d.ViewTo)
			}
		}
		prev := 0
		for _, l := range d.Landmarks {
			in("landmark", l.Line, l.Line)
			if l.Line <= prev {
				t.Errorf("%s: dump %d landmarks not ascending at %d", name, k, l.Line)
			}
			prev = l.Line
		}
		for _, fo := range d.Folds {
			in("fold "+fo.Kind, fo.From, fo.To)
			if fo.Lines != fo.To-fo.From+1 {
				t.Errorf("%s: fold %s lines %d", name, fo.ID, fo.Lines)
			}
		}
		for _, b := range d.Banners {
			in("banner", b.Top, b.Bottom)
		}
		for n := range d.Roles {
			in("role", n, n)
		}
		last := 0
		for _, r := range d.Digest {
			in("digest range", r.From, r.To)
			if r.From <= last {
				t.Errorf("%s: dump %d digest ranges overlap or descend at %d-%d (after %d)", name, k, r.From, r.To, last)
			}
			last = r.To
		}
		for _, v := range d.SQL {
			in("sql", v.Head, v.Line)
		}
		if d.Plan != nil {
			in("plan", d.Plan.From, d.Plan.To)
		}
		for _, h := range d.Hints {
			in("hint", h.Line, h.Line)
		}
		for _, b := range d.BindLines {
			in("bind line", b, b)
		}
		// runs: the Run list is the run nodes in order
		var runs []*Node
		walk(d.Tree, func(n, _ *Node) {
			if n.Kind == KindRun {
				runs = append(runs, n)
			}
		})
		if len(runs) != len(d.Runs) || d.RunCount != len(runs) {
			t.Errorf("%s: dump %d has %d run nodes, %d Runs, RunCount %d", name, k, len(runs), len(d.Runs), d.RunCount)
		}
		for i, r := range runs {
			if i < len(d.Runs) && (d.Runs[i].ID != r.ID || d.Runs[i].N != i+1 || d.Runs[i].Of != len(runs)) {
				t.Errorf("%s: dump %d run %d: %+v", name, k, i+1, d.Runs[i])
			}
		}
	}
	if len(sc.Dumps) > 0 && next != f.Lines+1 {
		t.Errorf("%s: the views end at line %d, the file has %d lines", name, next-1, f.Lines)
	}
}

func checkNode(t *testing.T, name string, d *Dump, n, parent *Node) {
	t.Helper()
	if n.From < 1 || n.To < n.From {
		t.Errorf("%s: node %s %s has range %d-%d", name, n.ID, n.Kind, n.From, n.To)
	}
	if parent != nil && (n.From < parent.From || n.To > parent.To) {
		t.Errorf("%s: node %s %s %d-%d is not inside its parent %s %d-%d", name, n.ID, n.Kind, n.From, n.To, parent.Kind, parent.From, parent.To)
	}
	prev := 0
	for _, c := range n.Children {
		if c.From <= prev {
			t.Errorf("%s: node %s %s %d-%d overlaps or precedes its sibling ending at %d", name, c.ID, c.Kind, c.From, c.To, prev)
		}
		prev = c.To
		checkNode(t, name, d, c, n)
	}
	if n.Kind == KindRun {
		// a run with a join search has a join order numbered BestJo
		var hasSearch bool
		var orders []int
		walk(n, func(m, _ *Node) {
			switch m.Kind {
			case KindJoinSearch:
				hasSearch = true
			case KindJoinOrder:
				orders = append(orders, m.N)
			}
		})
		if hasSearch && !(d.Truncated && n.To == d.End) && !relaxBestJo {
			ok := false
			for _, o := range orders {
				ok = ok || o == n.BestJo
			}
			if n.BestJo == 0 || !ok {
				t.Errorf("%s: run %s (%d-%d) has a join search and BestJo %d, join orders %v", name, n.ID, n.From, n.To, n.BestJo, orders)
			}
		}
	}
}

// relaxBestJo is set by the tests that damage a trace: a lost line may be the one that names the best join order.
var relaxBestJo bool

func snapName(fixture, what string) string {
	return filepath.Join(snapDir, fixtureName(fixture)+"."+what+".txt")
}

// compareSnapshot checks got against the committed snapshot, or rewrites it under -update.
func compareSnapshot(t *testing.T, path, got string) {
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
		t.Fatalf("no snapshot %s: run `go test ./internal/opt -run Snapshot -update` and review the new files", path)
	}
	if string(want) == got {
		return
	}
	w, g := strings.Split(string(want), "\n"), strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var a, b string
		if i < len(w) {
			a = w[i]
		}
		if i < len(g) {
			b = g[i]
		}
		if a != b {
			t.Fatalf("%s differs from the snapshot at line %d (%d lines in the snapshot, %d now)\n  snapshot: %s\n  now:      %s\nif the change is intended: go test ./internal/opt -run Snapshot -update", path, i+1, len(w), len(g), a, b)
		}
	}
}

func outlineText(sc *Scan) string {
	var b strings.Builder
	for _, d := range sc.Dumps {
		fmt.Fprintf(&b, "dump %d %s nth %d  lines %d-%d  view %d-%d  plan_hash %s  runs %d  truncated %v  unplaced %d\n",
			d.Idx+1, d.SQLID, d.Nth, d.From, d.End, d.ViewFrom, d.ViewTo, d.PlanHash, d.RunCount, d.Truncated, d.Unplaced)
		var rec func(n *Node, depth int)
		rec = func(n *Node, depth int) {
			if n.Kind != KindDump {
				fmt.Fprintf(&b, "%s%d-%d %s  %s", strings.Repeat("  ", depth-1), n.From, n.To, n.Kind, n.Label)
				if n.Result != "" {
					fmt.Fprintf(&b, "  -> %s", n.Result)
				}
				if n.Kind == KindRun || n.Kind == KindIteration {
					if n.Final {
						b.WriteString("  [final]")
					}
					if n.SameAs != 0 {
						fmt.Fprintf(&b, "  [same as run %d]", n.SameAs)
					}
					if n.BestJo != 0 {
						fmt.Fprintf(&b, "  [best join order %d]", n.BestJo)
					}
					if n.Verdict != nil {
						fmt.Fprintf(&b, "  [%d: %s]", n.Verdict.Line, n.Verdict.Text)
					}
				}
				if n.IsBest {
					b.WriteString("  [best]")
				}
				b.WriteByte('\n')
			}
			for _, c := range n.Children {
				rec(c, depth+1)
			}
		}
		rec(d.Tree, 0)
	}
	return b.String()
}

func landmarksText(sc *Scan) string {
	var b strings.Builder
	for _, d := range sc.Dumps {
		fmt.Fprintf(&b, "dump %d %s: %d landmarks\n", d.Idx+1, d.SQLID, len(d.Landmarks))
		for _, l := range d.Landmarks {
			fmt.Fprintf(&b, "%d %s %s  %s\n", l.Line, l.Kind, l.Tone, l.Text)
		}
	}
	return b.String()
}
