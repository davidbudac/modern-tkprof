package opt

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// searchMapFixtures are every 10053 fixture present locally: 19c, the opt_* traces of testdata/traces and
// the 11g and 12c ones (some are kept out of the repository; a missing file is not an error).
func searchMapFixtures(t *testing.T) []string {
	t.Helper()
	all := fixtures(t)
	a, _ := filepath.Glob("../../testdata/opt/11g/*.trc")
	b, _ := filepath.Glob("../../testdata/opt/12c/*.trc")
	return append(append(all, a...), b...)
}

// finalCostOf reads the cost printed under a run's "Final cost for query block" line.
func finalCostOf(lines []string, fc *Node) string {
	for i := fc.From; i <= fc.To && i <= len(lines); i++ {
		l := strings.TrimSpace(lines[i-1])
		if strings.HasPrefix(l, "Cost:") {
			f := strings.Fields(strings.TrimPrefix(l, "Cost:"))
			if len(f) > 0 {
				return f[0]
			}
		}
	}
	return ""
}

// differs lists the costing runs whose "Final cost" differs from the last "Best so far" cost of their best join
// order, by "fixture dN rM" (dump N, run M), with what the trace shows (for the licensed antognini_* traces,
// gitignored, only that they differ). The test fails on a run that differs and is
// not listed, and on a listed run that no longer differs. 19c query fixtures are exact except opt_dml; 11.2 and
// 12.1 add the cost of a sort after the search, and print 0.0000 for a block whose join was removed.
var differs = map[string]string{
	"opt_dml d2 r2":                            "10.066206 (the best order's last cost), final 3010.066206",
	"antognini_distinct_elimination d2 r1":     "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_elimination d3 r1":     "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d1 r1":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d1 r2":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d1 r3":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d1 r4":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d1 r5":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d2 r1":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d2 r2":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d2 r3":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d3 r1":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d3 r2":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d3 r3":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d3 r4":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d4 r1":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d4 r2":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d4 r3":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_distinct_placement d4 r4":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_filter_push_down d1 r1":         "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_filter_push_down d1 r2":         "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_filter_push_down d2 r1":         "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_filter_push_down d2 r2":         "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_full_outer_join d6 r2":          "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_or_expansion d1 r1":             "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_or_expansion d2 r1":             "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_or_expansion d3 r1":             "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_predicate_move_around d1 r1":    "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_predicate_move_around d1 r2":    "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_predicate_move_around d2 r1":    "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_predicate_move_around d2 r2":    "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_set_to_join d1 r1":              "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_set_to_join d3 r1":              "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_set_to_join d3 r2":              "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_subquery_coalescing d2 r18":     "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_subquery_coalescing d2 r24":     "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_subquery_removal d2 r5":         "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_subquery_removal d2 r7":         "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_subquery_unnesting d2 r4":       "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d1 r1": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d1 r2": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d1 r5": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d1 r6": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d2 r1": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d2 r2": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d3 r1": "differs (a licensed trace kept out of git: its numbers are not copied here)",
	"antognini_join_predicate_push_down d3 r2": "differs (a licensed trace kept out of git: its numbers are not copied here)",
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

// TestSearchMapBestOrderCost: for every costing run with a best join order, the last cost of the best
// order's "Best so far" block is the run's final cost, as the trace prints both. Fixtures in addedAfterSearch
// may differ; they are counted and logged.
func TestSearchMapBestOrderCost(t *testing.T) {
	checked, extra := 0, 0
	seen := map[string]bool{}
	scanned := map[string]bool{} // the Antognini traces are not in git: a listed run is checked only when its file is here
	for _, path := range searchMapFixtures(t) {
		name := fixtureName(path)
		scanned[name] = true
		t.Run(name, func(t *testing.T) {
			sc := scanOf(t, path)
			lines := fileLinesOf(t, path)
			for _, d := range sc.Dumps {
				walk(d.Tree, func(run, _ *Node) {
					if run.Kind != KindRun || run.BestJo == 0 {
						return
					}
					var best []*Node
					var fc *Node
					walk(run, func(n, _ *Node) {
						switch {
						case n.Kind == KindJoinOrder && n.IsBest:
							best = append(best, n)
						case n.Kind == KindFinalCost:
							fc = n
						}
					})
					if len(best) == 0 || fc == nil {
						t.Logf("%s dump %d run %d: best join order %d, %d such orders, final cost node %v", name, d.Idx+1, run.N, run.BestJo, len(best), fc != nil)
						return
					}
					want := finalCostOf(lines, fc)
					if run.FinalCost != want {
						t.Errorf("%s dump %d run %d: FinalCost %q, the lines under %d say %q", name, d.Idx+1, run.N, run.FinalCost, fc.From, want)
					}
					// a run may hold the search twice (join order numbers restart); the last order marked best
					// is the one the final cost belongs to
					jo := best[len(best)-1]
					if len(best) > 1 {
						t.Logf("%s dump %d run %d: %d join orders are marked best", name, d.Idx+1, run.N, len(best))
					}
					checked++
					if len(jo.PosCosts) == 0 {
						t.Errorf("%s dump %d run %d (%s): best order %d has no per-position costs (lines %d-%d)", name, d.Idx+1, run.N, run.QB, jo.N, jo.From, jo.To)
						return
					}
					got := jo.PosCosts[len(jo.PosCosts)-1]
					if jo.Cost != got {
						t.Errorf("%s dump %d run %d: Cost %s differs from the last position cost %s", name, d.Idx+1, run.N, jo.Cost, got)
					}
					if got != want && differs[fmt.Sprintf("%s d%d r%d", name, d.Idx+1, run.N)] != "" {
						extra++
						seen[fmt.Sprintf("%s d%d r%d", name, d.Idx+1, run.N)] = true
						return
					}
					if got != want {
						t.Logf("MISMATCH %s d%d r%d %s best=%s", name, d.Idx+1, run.N, run.QB, got+" vs "+want)
					}
					if got != want {
						t.Errorf("%s dump %d run %d (%s): best order %d ends at %s, the final cost is %s", name, d.Idx+1, run.N, run.QB, jo.N, got, want)
					}
					if jo.Cost != want {
						t.Errorf("%s dump %d run %d (%s): best order %d Cost %s, the final cost is %s", name, d.Idx+1, run.N, run.QB, jo.N, jo.Cost, want)
					}
				})
			}
		})
	}
	for k := range differs {
		if name, _, _ := strings.Cut(k, " "); scanned[name] && !seen[k] {
			t.Errorf("%s is listed in differs and does not differ (or was not scanned)", k)
		}
	}
	if checked == 0 {
		t.Fatal("no run with a best join order was checked")
	}
	t.Logf("%d runs with a best join order checked, %d with a different final cost (older releases, opt_dml)", checked, extra)
}

// TestSearchMapShapes: the numbers the Search map plots, on the first statement's query block of opt_two:
// order 1 completes with a cost at every position, orders 16 to 18 abort before any join step, and order 2
// (which starts like order 1 and so prints no step for its first two positions) aborts in its last step,
// which printed no cost.
func TestSearchMapShapes(t *testing.T) {
	sc := scanOf(t, filepath.Join(optDir, "opt_two.trc"))
	d := sc.Dumps[0]
	var run *Node
	walk(d.Tree, func(n, _ *Node) {
		if n.Kind == KindRun && run == nil && n.QB == "SEL$1BA63A14" {
			run = n
		}
	})
	if run == nil {
		t.Fatal("no run of SEL$1BA63A14")
	}
	orders := map[int]*Node{}
	tables := map[string]*Node{}
	walk(run, func(n, _ *Node) {
		switch n.Kind {
		case KindJoinOrder:
			orders[n.N] = n
		case KindTable:
			if n.Ref != "" {
				tables[n.Ref] = n
			}
		}
	})
	if len(orders) != 18 {
		t.Fatalf("%d join orders, want 18", len(orders))
	}
	// the first table's access cost, found by the alias the join order prints
	for ref, want := range map[string]string{"MTK_CUST[C]": "6.002106", "MTK_ORDERS[O]": "137.032307", "MTK_AUDIT[A]": "204.180413", "MTK_ORDERS[MTK_ORDERS]": "137.063704"} {
		if n := tables[ref]; n == nil || n.AccCost != want {
			t.Errorf("table %s: %+v, want access cost %s", ref, n, want)
		}
	}
	o1 := orders[1]
	if got := strings.Join(o1.PosCosts, " "); got != "6.002106 110.031654 314.232856 453.647906" {
		t.Errorf("order 1 position costs %q", got)
	}
	var steps []string
	for _, c := range o1.Children {
		if c.Kind == KindJoinStep {
			steps = append(steps, c.Table+"="+c.StepCost)
		}
	}
	if got := strings.Join(steps, " "); got != "MTK_ORDERS[O]#1=110.031654 MTK_AUDIT[A]#2=314.232856 MTK_ORDERS[MTK_ORDERS]#3=453.647906" {
		t.Errorf("order 1 steps %q", got)
	}
	if o13 := orders[13]; !o13.IsBest || o13.PosCosts[len(o13.PosCosts)-1] != "384.608830" {
		t.Errorf("order 13: %+v", o13)
	}
	for _, n := range []int{16, 17, 18} {
		o := orders[n]
		if o.Result != "aborted" || len(o.PosCosts) != 0 {
			t.Errorf("order %d: result %q, costs %v", n, o.Result, o.PosCosts)
		}
		for _, c := range o.Children {
			if c.Kind == KindJoinStep {
				t.Errorf("order %d has a join step %s", n, c.Label)
			}
		}
	}
	o2 := orders[2]
	var last *Node
	nsteps := 0
	for _, c := range o2.Children {
		if c.Kind == KindJoinStep {
			last = c
			nsteps++
		}
	}
	if o2.Result != "aborted" || last == nil || nsteps != 2 || last.StepCost != "" || o2.Children[0].StepCost != "247.446962" {
		t.Errorf("order 2: result %q, %d steps, last %+v", o2.Result, nsteps, last)
	}
}

// smFixture is what web/src/lib/data/searchmap.fixture.json holds for the Search map's tests: a dump's runs and
// the part of its outline the map reads (runs, their tables, join searches, join orders and join steps).
type smFixture struct {
	Runs []Run `json:"runs"`
	Tree *Node `json:"tree"`
}

func pruneForMap(n *Node) *Node {
	keep := map[string]bool{KindRun: true, KindTable: true, KindJoinSearch: true, KindJoinOrder: true, KindJoinStep: true}
	c := *n
	c.Children = nil
	for _, k := range n.Children {
		if keep[k.Kind] || k.Kind != KindFinalCost && hasKept(k, keep) {
			c.Children = append(c.Children, pruneForMap(k))
		}
	}
	return &c
}

func hasKept(n *Node, keep map[string]bool) bool {
	for _, k := range n.Children {
		if keep[k.Kind] || hasKept(k, keep) {
			return true
		}
	}
	return false
}

// TestSearchMapFixture keeps the TypeScript tests' fixture in step with the scan: `go test ./internal/opt -run
// SearchMapFixture -update` rewrites it.
func TestSearchMapFixture(t *testing.T) {
	out := map[string]smFixture{}
	// opt_two's second dump holds a one-table block (run 1) whose table is costed twice, before and after its
	// join search; its first dump has the 4-table block of the concept picture
	for _, c := range []struct {
		key, file string
		dump      int
	}{{"opt_two", "opt_two", 0}, {"opt_two_2", "opt_two", 1}, {"opt_join8", "opt_join8", 0}} {
		d := scanOf(t, filepath.Join(optDir, c.file+".trc")).Dumps[c.dump]
		out[c.key] = smFixture{Runs: d.Runs, Tree: pruneForMap(d.Tree)}
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	path := "../../web/src/lib/data/searchmap.fixture.json"
	if *update {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	old, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no %s: run `go test ./internal/opt -run SearchMapFixture -update`", path)
	}
	if string(old) != string(b) {
		t.Errorf("%s is out of date: run `go test ./internal/opt -run SearchMapFixture -update`", path)
	}
}

// TestSearchMapCostsPresent: a table whose access path is named has its cost, a join step whose method is named
// has its cost, on every fixture; and a join order that completed has one cost per table.
func TestSearchMapCostsPresent(t *testing.T) {
	tables, steps, orders := 0, 0, 0
	for _, path := range searchMapFixtures(t) {
		name := fixtureName(path)
		for _, d := range scanOf(t, path).Dumps {
			walk(d.Tree, func(n, _ *Node) {
				switch {
				case n.Kind == KindTable && n.Best != "":
					tables++
					if n.AccCost == "" {
						t.Errorf("%s dump %d: table %s (lines %d-%d) has %s and no cost", name, d.Idx+1, n.Label, n.From, n.To, n.Best)
					}
				case n.Kind == KindJoinStep && n.Method != "":
					steps++
					if n.StepCost == "" {
						t.Errorf("%s dump %d: join step %s (lines %d-%d) has %s and no cost", name, d.Idx+1, n.Label, n.From, n.To, n.Method)
					}
				case n.Kind == KindJoinOrder && n.Cost != "":
					orders++
					if len(n.PosCosts) != len(n.Tables) {
						t.Errorf("%s dump %d: join order %d has %d tables and %d position costs", name, d.Idx+1, n.N, len(n.Tables), len(n.PosCosts))
					}
				}
			})
		}
	}
	t.Logf("%d tables, %d join steps, %d completed join orders", tables, steps, orders)
}
