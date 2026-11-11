package opt

import (
	"bytes"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMutations damages fixtures at random (lines dropped, repeated, swapped, replaced by lines that mean
// something to the scan): the scan never panics and what it returns still agrees with itself.
func TestMutations(t *testing.T) {
	junk := []string{
		"kkoqbc: finish optimizing query block SEL$1 (#0)",
		"kkoqbc: optimizing query block SEL$1 (#0)",
		"====================== END SQL Statement Dump ======================",
		"Registered qb: SEL$1 0x1 (PARSER)",
		"Registered qb: SEL$7 0xabc (VIEW MERGE SEL$2; SEL$1; SEL$2)",
		"*****************", "-----------------", "=====", "QUERY BLOCK TEXT",
		"Join order[3]:  A[A]#0  B[B]#1", "Now joining: A[A]#0", "(newjo-stop-1) k:0, spcnt:0, perm:18, maxperm:2000",
		"Best:: AccessPath: TableScan", "Best:: JoinMethod: Hash", "Best join order: 4", "Join order aborted: cost > best plan cost",
		"GBP: Starting iteration 1, state space = (1,2) : (0,0)", "GBP: Updated best state, Cost = 1.5", "CVM: Not update best state, Cost = 2",
		"Final cost for query block SEL$1 (#0) - All Rows Plan:", "Final query after transformations:******* UNPARSED QUERY IS *******",
		"******* UNPARSED QUERY IS *******", "Starting SQL statement dump", "----- Explain Plan Dump -----", "Plan Table",
		"| Id  | Operation | Name |", "| 0   | SELECT STATEMENT |", "----+----+", "Predicate Information:", "Query Block Name / Object Alias",
		"Peeked Binds", "  Bind variable information", "    value=\"abc", "Dumping Hints", "  atom_hint=(@=0x1 err=3 used=0 txt=X ) ", "  Hint Report:",
		"Optimizer state dump:", "Bug Fix Control Environment", "    fix 1 = enabled", "Legend", " Bind#3", "  value=1", "BINDS #1:", "PARSING IN CURSOR #1 len=3",
		"END OF STMT", "EXEC #1:c=0", "", " ", "Searching for inflection point (join #1)", "AP: Found point of inflection", "Considering Query Transformations on query block SEL$1 (#0)",
		"CBQT: Considering cost-based transformation on query block SEL$1 (#0)", "Cost-Based Join Predicate Push-down", "Peeked values of the binds in SQL statement",
		"SPD: BEGIN context at statement level", "OPTIMIZER STATISTICS AND COMPUTATIONS", "BASE STATISTICAL INFORMATION", "Access path analysis for X", "SINGLE TABLE ACCESS PATH",
	}
	var sources [][]string
	for _, name := range []string{filepath.Join(optDir, "opt_two.trc"), filepath.Join(optDir, "opt_dml.trc"), filepath.Join(tracesDir, "19c", "opt_interleaved.trc")} {
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		ls := strings.Split(string(data), "\n")
		sources = append(sources, ls[:9000])
		sources = append(sources, ls[len(ls)-9000:])
	}
	relaxBestJo = true
	defer func() { relaxBestJo = false }()
	rng := rand.New(rand.NewSource(1))
	for it := 0; it < 300; it++ {
		src := sources[rng.Intn(len(sources))]
		ls := append([]string(nil), src...)
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
		sc, err := ScanReader(strings.NewReader(strings.Join(ls, "\n")), "mut.trc")
		if err != nil {
			t.Fatal(err)
		}
		checkInvariants(t, "mutation", sc)
		if t.Failed() {
			os.WriteFile(filepath.Join(t.TempDir(), "mut.trc"), []byte(strings.Join(ls, "\n")), 0o644)
			t.Fatalf("iteration %d", it)
		}
		if err := WriteDigest(&bytes.Buffer{}, sc, nil, TextOptions{DropBinds: it%2 == 0}); err != nil {
			t.Fatal(err)
		}
	}
}

// TestFormatSQLRandom: the pretty-printer never panics and keeps every token it was given.
func TestFormatSQLRandom(t *testing.T) {
	frag := []string{"select", "from", "where", "and", "or", "group by", "order by", "union all", "(", ")", ",", "'", "''", "\"", "/*", "*/", "--", "\n", " ", ":b1", "x", "1.5e+3", "é", "(select", "start with", "connect by"}
	rng := rand.New(rand.NewSource(2))
	for i := 0; i < 3000; i++ {
		var sb strings.Builder
		for k := rng.Intn(60); k >= 0; k-- {
			sb.WriteString(frag[rng.Intn(len(frag))])
			if rng.Intn(2) == 0 {
				sb.WriteByte(' ')
			}
		}
		in := sb.String()
		out := FormatSQL(in)
		strip := func(s string) string { return strings.Join(strings.Fields(s), "") }
		if strip(strings.ToUpper(out)) != strip(strings.ToUpper(in)) {
			t.Fatalf("tokens changed:\n in: %q\nout: %q", in, out)
		}
	}
}
