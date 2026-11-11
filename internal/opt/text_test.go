package opt

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func inDigest(d *Dump, n int) bool {
	for _, r := range d.Digest {
		if n >= r.From && n <= r.To {
			return true
		}
	}
	return false
}

func digestText(t *testing.T, path string, o TextOptions) (string, *Scan) {
	t.Helper()
	sc := scanOf(t, path)
	line, closeFn, err := FileLines(path)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	var b bytes.Buffer
	if err := WriteDigest(&b, sc, line, o); err != nil {
		t.Fatal(err)
	}
	return b.String(), sc
}

func TestDigestRanges(t *testing.T) {
	path := filepath.Join(optDir, "opt_subq_binds.trc")
	sc := scanOf(t, path)
	d := sc.Dumps[0]
	line, closeFn, err := FileLines(path)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	has := func(prefix string, from, to int) []int {
		var out []int
		for i := from; i <= to; i++ {
			if s, _ := line(i); strings.HasPrefix(s, prefix) {
				out = append(out, i)
			}
		}
		return out
	}
	must := func(what string, ns []int) {
		t.Helper()
		if len(ns) == 0 {
			t.Errorf("%s: no such line", what)
		}
		for _, n := range ns {
			if !inDigest(d, n) {
				t.Errorf("%s: line %d is not in the digest", what, n)
			}
		}
	}
	mustNot := func(what string, ns []int) {
		t.Helper()
		for _, n := range ns {
			if inDigest(d, n) {
				s, _ := line(n)
				t.Errorf("%s: line %d is in the digest: %s", what, n, s)
			}
		}
	}
	// 1 the prologue and the marker lines
	must("prologue", []int{1, 2, 3, 31})
	must("markers", has("*** ", 1, d.From))
	// 2 the parser's blocks and every later Registered qb line
	must("parser blocks", has("Registered qb: ", d.From, d.From+30))
	must("registered qb", has("Registered qb: ", d.From, d.End))
	// 3 the preamble
	must("preamble", has("SPM:", d.From, d.End))
	must("autodop", has("Automatic degree of parallelism is disabled", d.From, d.End))
	// 4 the statement
	must("statement", []int{d.StmtLine - 1, d.StmtLine, d.StmtTo})
	// 5 6 7 8
	must("headings", has("  PARAMETERS WITH ALTERED VALUES", d.From, d.End))
	must("best", has("  Best:: AccessPath:", d.From, d.End))
	must("best cost line", func() []int {
		var out []int
		for _, l := range d.Landmarks {
			if l.Kind == LMBestAP {
				out = append(out, l.Line+1)
			}
		}
		return out
	}())
	must("final cost block", func() []int {
		var out []int
		for _, l := range d.Landmarks {
			if l.Kind == LMFinalCost {
				out = append(out, l.Line, l.Line+1, l.Line+4)
			}
		}
		return out
	}())
	must("join order", has("Join order[", d.From, d.End))
	must("permutations", has("Number of join permutations tried", d.From, d.End))
	must("iterations", has("GBP: Starting iteration", d.From, d.End))
	must("runs", append(has("kkoqbc: optimizing", d.From, d.End), has("kkoqbc: finish", d.From, d.End)...))
	// 9 the binds
	must("bind info", has(" Bind#0", d.From, d.End))
	must("peeked binds", has("    value=11", d.From, d.End))
	// 10 the statements after each transformation
	for _, v := range d.SQL {
		must("unparsed header", []int{v.Head})
		if v.SameAs == 0 {
			must("unparsed statement", []int{v.Line})
		} else {
			mustNot("repeated statement", []int{v.Line})
		}
	}
	// 11 the plan and other_xml, except the registry XML
	must("plan", []int{d.Plan.From, d.Plan.Head, d.Plan.TableTo, d.Plan.To})
	must("outline data", has("    BEGIN_OUTLINE_DATA", d.From, d.End))
	mustNot("registry xml", has("<qb_registry>", d.From, d.End))
	must("hint report or hints", has("Dumping Hints", d.From, d.End))
	// 12 the registry tree, the end line
	must("registry", has("Query Block Registry:", d.From, d.End))
	must("end", []int{d.End})
	// never
	mustNot("default parameters", has("optimizer_features_enable ", d.From, d.End))
	mustNot("fix controls", has("    fix ", d.From, d.End))
	mustNot("state dump parameters", has("hash_area_size", d.From, d.End))
	mustNot("costing detail", has("  Column (#", d.From, d.End))
	mustNot("costing detail", has("    Cost:  ", d.From, d.End))
	mustNot("adaptive re-costing", has("AP: Costing ", d.From, d.End))
	walk(d.Tree, func(n, _ *Node) {
		if n.Kind == KindAPSearch || n.Kind == KindParamsDef || n.Kind == KindStateParams || n.Kind == KindStateFix {
			for i := n.From; i <= n.To; i++ {
				if inDigest(d, i) && d.Roles[i] != "bh" && d.Roles[i] != "uh" && d.Roles[i] != "bt" && d.Roles[i] != "bb" {
					s, _ := line(i)
					t.Errorf("%s line %d is in the digest: %s", n.Kind, i, s)
					return
				}
			}
		}
	})
}

func TestWriteText(t *testing.T) {
	text, sc := digestText(t, filepath.Join(mockDir, "two.trc"), TextOptions{})
	for _, want := range []string{
		"OPTIMIZER DUMP 1   sql_id 4a6t4jr44yb2d   dump 1 of this sql_id   plan hash 2477488908   lines 32-18,278",
		"OPTIMIZER DUMP 2   sql_id 171f4k9c0yhrg",
		"SQL as typed (lines 81-86)",
		"none\n", // altered parameters
		"Run 1 of 14 · SEL$2 (#2)",
		"[final plan]",
		"[same as run 1]",
		"[GBP: Updated best state, Cost = 384.608830]",
		"Hints with an error: 3",
		"Query Block Name / Object Alias",
		"Predicate Information:",
		"err=9 used=1  INDEX (\"O\" \"NO_SUCH_INDEX\")",
		"Hint Report",
		"Unused: index(o no_such_index)   [reason: index specified in the hint doesn't exist]",
		"Syntax Error: p53",
		"[best join order]",
		"-> cost: ",
		"-> aborted",
		"2 dumps",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the digest does not contain %q", want)
		}
	}
	// the landmark lines come verbatim with their numbers, grouped by kind with counts
	d := sc.Dumps[0]
	kc := map[string]int{}
	for _, l := range d.Landmarks {
		kc[l.Kind]++
	}
	for _, k := range lmOrder {
		if kc[k.kind] > 0 && !strings.Contains(text, fmt.Sprintf("%s: %d\n", k.title, kc[k.kind])) {
			t.Errorf("no %q with its count %d", k.title, kc[k.kind])
		}
	}
	for _, l := range d.Landmarks[:5] {
		if want := strings.TrimSpace(strings.Join([]string{"", l.Text}, "")); !strings.Contains(text, " "+want) {
			t.Errorf("landmark %d not in the digest: %s", l.Line, want)
		}
	}
	// a pretty-printed version of the statement
	if !strings.Contains(text, "\n    SELECT ") || !strings.Contains(text, "\n    FROM ") {
		t.Errorf("no pretty-printed SQL")
	}
	// a line function is optional: without one the plan is rebuilt from the model
	var b bytes.Buffer
	if err := sc.Dumps[1].WriteText(&b, nil, TextOptions{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), "Operation") || !strings.Contains(b.String(), "Predicate Information:") {
		t.Errorf("the plan rebuilt from the model is missing")
	}
}

func TestWriteTextParams(t *testing.T) {
	text, _ := digestText(t, filepath.Join(optDir, "opt_altered.trc"), TextOptions{})
	for _, want := range []string{
		"optimizer_mode                           = first_rows_10",
		"optimizer_index_cost_adj                 = 50",
		"_optimizer_cost_based_transformation     = off",
		"OPT_PARAM optimizer_index_caching        = 40",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the digest does not contain %q", want)
		}
	}
	sc := scanOf(t, filepath.Join(optDir, "opt_altered.trc"))
	if got := len(sc.Dumps[0].Altered); got != 4 {
		t.Errorf("%d altered parameters", got)
	}
	// the first dump of two.trc has none
	two, _ := digestText(t, filepath.Join(mockDir, "two.trc"), TextOptions{})
	if !strings.Contains(two, "Altered parameters and fix controls\n"+strings.Repeat("-", digestWidth)+"\nnone\n") {
		t.Errorf("no 'none' under the altered parameters")
	}
}

func TestBinds(t *testing.T) {
	path := filepath.Join(optDir, "opt_subq_binds.trc")
	sc := scanOf(t, path)
	d := sc.Dumps[0]
	if len(d.Binds) != 2 || d.Binds[0].Pos != 1 || d.Binds[0].Type != "NUMBER" || d.Binds[0].Value != "11" || d.Binds[0].Line == 0 ||
		d.Binds[1].Pos != 2 || d.Binds[1].Dup != 1 || d.Binds[1].Value != "" || d.Binds[1].Line != 0 {
		t.Errorf("binds: %+v", d.Binds)
	}
	line, closeFn, _ := FileLines(path)
	defer closeFn()
	if len(d.BindLines) != 2 {
		t.Fatalf("bind lines %v", d.BindLines)
	}
	for _, n := range d.BindLines {
		if s, _ := line(n); !strings.Contains(s, "value=11") {
			t.Errorf("bind line %d: %s", n, s)
		}
	}
	keep, _ := digestText(t, path, TextOptions{})
	if !strings.Contains(keep, ":1 NUMBER = 11") || !strings.Contains(keep, ":2 NUMBER = (the same bind as :1)") {
		t.Errorf("binds not in the digest")
	}
	drop, _ := digestText(t, path, TextOptions{DropBinds: true})
	if strings.Contains(drop, ":1 NUMBER") || strings.Contains(drop, "= 11") || !strings.Contains(drop, "2 binds; values left out (-binds none)") {
		t.Errorf("-binds none: %s", between(drop, "Peeked binds", "Outline"))
	}
	red, _ := digestText(t, path, TextOptions{RedactBind: func(typ, v string) string { return "<" + typ + ":" + "redacted>" }})
	if strings.Contains(red, "= 11") || !strings.Contains(red, ":1 NUMBER = <NUMBER:redacted>") {
		t.Errorf("-redact-binds: %s", between(red, "Peeked binds", "Outline"))
	}
	// literals in the SQL text and the predicates stay
	dml, _ := digestText(t, filepath.Join(optDir, "opt_dml.trc"), TextOptions{DropBinds: true, RedactBind: func(string, string) string { return "x" }})
	if !strings.Contains(dml, "'NEW'") || !strings.Contains(dml, `filter("S"."STATUS"='NEW')`) {
		t.Errorf("the literal 'NEW' is gone from the digest")
	}
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	j := strings.Index(s[i:], b)
	if j < 0 {
		return s[i:]
	}
	return s[i : i+j]
}

func TestHintsAndParams(t *testing.T) {
	sc := scanOf(t, filepath.Join(optDir, "opt_unified.trc"))
	d := sc.Dumps[0]
	var dump, report []Hint
	for _, h := range d.Hints {
		if h.Src == "report" {
			report = append(report, h)
		} else {
			dump = append(dump, h)
		}
	}
	if len(dump) != 2 || dump[0].Text != `USE_HASH ("C")` || dump[0].Err != 0 || dump[0].Used != 1 || dump[1].Text != `INDEX ("O" "NO_SUCH_INDEX")` || dump[1].Err != 9 {
		t.Errorf("dumped hints: %+v", dump)
	}
	if len(report) != 2 || report[0].Text != "Unused: index(o no_such_index)" || report[0].Note != "Unused: index specified in the hint doesn't exist" ||
		report[1].Text != "use_hash(c)" || report[1].Used != 0 || report[1].Note != "" {
		t.Errorf("hint report: %+v", report)
	}
	hasErr := false
	for _, l := range d.Landmarks {
		if l.Kind == LMHintError && strings.Contains(l.Text, "err=9") {
			hasErr = true
		}
	}
	if !hasErr {
		t.Errorf("no hint-error landmark for err=9")
	}
	// the OPT_PARAM hint of opt_altered is a hint with no error
	alt := scanOf(t, filepath.Join(optDir, "opt_altered.trc")).Dumps[0]
	if len(alt.Hints) != 2 || alt.Hints[0].Src != "report" || alt.Hints[0].Text != "opt_param('optimizer_index_caching' 40)" ||
		alt.Hints[1].Src != "dump" || alt.Hints[1].Text != "OPT_PARAM ()" {
		t.Errorf("hints of opt_altered: %+v", alt.Hints)
	}
}

func TestLineReader(t *testing.T) {
	dir := t.TempDir()
	var sb strings.Builder
	var want []string
	for i := 1; i <= 1000; i++ {
		l := strings.Repeat("x", i%7)
		if i == 300 {
			l = strings.Repeat("long ", 400000) // longer than the read buffer
		}
		want = append(want, l)
		sb.WriteString(l)
		if i%10 == 0 {
			sb.WriteString("\r")
		}
		if i < 1000 {
			sb.WriteString("\n")
		}
	}
	p := filepath.Join(dir, "f.trc")
	os.WriteFile(p, []byte(sb.String()), 0o644)
	line, closeFn, err := FileLines(p)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	for _, n := range []int{1, 2, 255, 256, 257, 299, 300, 301, 511, 512, 513, 999, 1000, 5, 700, 1} {
		got, ok := line(n)
		if !ok || got != want[n-1] {
			t.Errorf("line %d: ok %v, %d bytes, want %d", n, ok, len(got), len(want[n-1]))
		}
	}
	if _, ok := line(0); ok {
		t.Error("line 0")
	}
	if _, ok := line(1001); ok {
		t.Error("line 1001")
	}
}
