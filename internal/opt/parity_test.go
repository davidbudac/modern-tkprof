package opt

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The mock-up the user approved was built on the output of docs/mockups/10053-reader/tools/parse.mjs. Its
// model.json, read from data/two.trc, is the specification of the outline, landmarks, folds, runs, SQL
// versions, plan, legend, banners and roles; this test reads the same file with the Go scan and compares.
//
// Where the Go scan differs from parse.mjs on purpose, the test asserts the Go value and says why:
//   - Legend: the mock-up keeps the legend of the first dump only (it feeds one glossary). Every dump of the
//     file prints its own, so every Dump here has its own 47 terms.
//   - Iteration.RunIDs: the mock-up lists only the runs an iteration holds directly; model.go says the nested
//     iterations' runs are included (CVM iteration 2 holds the JPPD iterations' runs too).
//   - SQLStart is cut at 240 characters (model.go); the mock-up does not cut.
//   - Banners are listed in file order (the mock-up lists the banners between two rule lines first, then the
//     headings above an underline).
//   - Tables of a dump: parse.mjs reads the "Objects referenced in the statement" list; the Go scan reads it
//     too and adds the tables of the costing runs, so a dump without that list still has tables. On this
//     file both give the same names.

type mockNode struct {
	ID           string      `json:"id"`
	Kind         string      `json:"kind"`
	Label        string      `json:"label"`
	Crumb        string      `json:"crumb"`
	From         int         `json:"from"`
	To           int         `json:"to"`
	Lvl          int         `json:"lvl"`
	Children     []*mockNode `json:"children"`
	Result       string      `json:"result"`
	Best         any         `json:"best"`
	Runs         []string    `json:"runs"`
	Count        int         `json:"count"`
	N            int         `json:"n"`
	Of           int         `json:"of"`
	Method       string      `json:"method"`
	Cost         string      `json:"cost"`
	Final        bool        `json:"final"`
	SameAs       int         `json:"sameAs"`
	BestJo       int         `json:"bestJo"`
	Tables       []string    `json:"tables"`
	Table        string      `json:"table"`
	Prefix       string      `json:"prefix"`
	Space        string      `json:"space"`
	QB           string      `json:"qb"`
	QBN          string      `json:"qbn"`
	Verdict      *Verdict    `json:"verdict"`
	IterLabel    string      `json:"iterLabel"`
	Iter         string      `json:"iter"`
	BannerBottom int         `json:"bannerBottom"`
}

type mockModel struct {
	Dumps []struct {
		From, End, ViewFrom, ViewTo int
		SqlId, PlanHash, StmtText   string
		Tables                      []string
		Tree                        *mockNode
		StmtLine, StmtTo            int
		RunCount                    int
	} `json:"dumps"`
	Landmarks []struct {
		Dump, Line       int
		Kind, Tone, Text string
	} `json:"landmarks"`
	Folds []struct {
		Dump, From, To int
		Kind, Label    string
		Lines          int
	} `json:"folds"`
	Runs []map[string]any `json:"runs"`
	Sql  []struct {
		Dump, Head, Line, N int
		Label, Text         string
		SameAs, Prev        *int
	} `json:"sql"`
	Plans   []map[string]any `json:"plans"`
	Legend  []map[string]any `json:"legend"`
	Roles   map[string]string
	Banners []struct {
		Top, Title, Bottom int
		Text               string
	}
}

func loadMock(t *testing.T) *mockModel {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(mockDir, "model.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m mockModel
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return &m
}

func normJSON(v any) any {
	b, _ := json.Marshal(v)
	var o any
	json.Unmarshal(b, &o)
	return o
}

func TestParityCounts(t *testing.T) {
	sc, err := ScanFile(filepath.Join(mockDir, "two.trc"))
	if err != nil {
		t.Fatal(err)
	}
	if sc.File.Lines != 27780 || len(sc.Dumps) != 2 || sc.File.Version != "19.27.0.0.0" || !sc.File.Tested || !sc.File.Pure() {
		t.Fatalf("file: %+v", sc.File)
	}
	kinds, nodes := map[string]int{}, 0
	lm, folds := map[string]int{}, map[string]int{}
	var runs, finals, same, sqls, legend int
	var planRows []int
	var hashes []string
	for _, d := range sc.Dumps {
		walk(d.Tree, func(n, _ *Node) { kinds[n.Kind]++; nodes++ })
		for _, l := range d.Landmarks {
			lm[l.Kind]++
		}
		for _, f := range d.Folds {
			folds[f.Kind]++
		}
		runs += len(d.Runs)
		for _, r := range d.Runs {
			if r.Final {
				finals++
			}
			if r.SameAs != 0 {
				same++
			}
		}
		sqls += len(d.SQL)
		planRows = append(planRows, len(d.Plan.Rows))
		hashes = append(hashes, d.PlanHash)
	}
	legend = len(sc.Dumps[0].Legend)

	eq := func(what string, got, want any) {
		t.Helper()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: %v, want %v", what, got, want)
		}
	}
	eq("nodes", nodes, 527)
	eq("landmarks", lm, map[string]int{"best-ap": 40, "best-jm": 80, "final-cost": 21, "aborted": 76, "verdict": 12, "hint-error": 3, "refused": 190})
	total := 0
	for _, n := range folds {
		total += n
	}
	eq("folds", total, 63)
	eq("folds by kind", folds, map[string]int{"params": 2, "state": 2, "fix": 2, "ap": 3, "same-run": 4, "stmt-again": 16, "same-sql": 34})
	eq("runs", fmt.Sprint(len(sc.Dumps[0].Runs), "+", len(sc.Dumps[1].Runs)), "9+14")
	eq("final runs", finals, 3)
	eq("runs the same as an earlier one", same, 4)
	for i, want := range []int{1, 2, 7, 8} {
		if got := sc.Dumps[1].Runs[[]int{4, 5, 10, 11}[i]].SameAs; got != want {
			t.Errorf("run %d of dump 2 is the same as run %d, want %d", []int{5, 6, 11, 12}[i], got, want)
		}
	}
	eq("sql versions", sqls, 47)
	eq("plan rows", planRows, []int{22, 16})
	eq("plan hashes", hashes, []string{"2477488908", "498381677"})
	eq("legend terms (first dump)", legend, 47)
	// deliberate difference: the mock-up keeps the first dump's legend only; here every dump has its own
	eq("legend terms (second dump)", len(sc.Dumps[1].Legend), 47)
	if sc.Dumps[0].Nth != 1 || sc.Dumps[1].Nth != 1 {
		t.Errorf("Nth: %d %d", sc.Dumps[0].Nth, sc.Dumps[1].Nth)
	}
	checkInvariants(t, "two.trc", sc)

	// the node count per kind, against the mock-up's own model
	m := loadMock(t)
	mk := map[string]int{}
	for _, d := range m.Dumps {
		var rec func(n *mockNode)
		rec = func(n *mockNode) {
			mk[n.Kind]++
			for _, c := range n.Children {
				rec(c)
			}
		}
		rec(d.Tree)
	}
	eq("node kinds", kinds, mk)
}

func TestParityDetail(t *testing.T) {
	sc, err := ScanFile(filepath.Join(mockDir, "two.trc"))
	if err != nil {
		t.Fatal(err)
	}
	m := loadMock(t)
	bad := 0
	rep := func(f string, a ...any) {
		t.Helper()
		bad++
		if bad <= 25 {
			t.Errorf(f, a...)
		}
	}
	for k, md := range m.Dumps {
		d := sc.Dumps[k]
		if md.From != d.From || md.End != d.End || md.ViewFrom != d.ViewFrom || md.ViewTo != d.ViewTo || md.SqlId != d.SQLID ||
			md.PlanHash != d.PlanHash || md.StmtText != d.StmtText || md.StmtLine != d.StmtLine || md.StmtTo != d.StmtTo || md.RunCount != d.RunCount {
			rep("dump %d facts differ", k)
		}
		if fmt.Sprint(md.Tables) != fmt.Sprint(d.Tables) {
			rep("dump %d tables %v, want %v", k, d.Tables, md.Tables)
		}
		if len(d.SQLStart) > 240 || d.SQLStart == "" {
			rep("dump %d SQLStart is %d bytes", k, len(d.SQLStart))
		}
		var cmp func(a *mockNode, b *Node)
		cmp = func(a *mockNode, b *Node) {
			if a.ID != b.ID || a.Kind != b.Kind || a.From != b.From || a.To != b.To || a.Label != b.Label || a.Crumb != b.Crumb || a.Lvl != b.Lvl ||
				a.Result != b.Result || a.Count != b.Count || a.N != b.N || a.Of != b.Of || a.Method != b.Method || a.Final != b.Final ||
				a.SameAs != b.SameAs || a.BestJo != b.BestJo || a.Table != b.Table || a.Prefix != b.Prefix || a.Space != b.Space ||
				a.QB != b.QB || a.QBN != b.QBN || a.IterLabel != b.IterLabel || a.Iter != b.Iter || a.BannerBottom != b.BannerBottom || a.Cost != b.Cost ||
				fmt.Sprint(a.Verdict) != fmt.Sprint(b.Verdict) {
				rep("node %s %s %d-%d %q differs from %s %d-%d %q", a.ID, a.Kind, a.From, a.To, a.Label, b.Kind, b.From, b.To, b.Label)
			}
			isBest, _ := a.Best.(bool)
			bestS, _ := a.Best.(string)
			if isBest != b.IsBest || bestS != b.Best {
				rep("node %s %s best %v, want %v/%q", a.ID, a.Kind, b.IsBest, isBest, bestS)
			}
			if fmt.Sprint(a.Tables) != fmt.Sprint(b.Tables) && !(len(a.Tables) == 0 && len(b.Tables) == 0) {
				rep("node %s tables %v, want %v", a.ID, b.Tables, a.Tables)
			}
			if a.Kind == KindIteration {
				// deliberate difference: the iterations' run lists include the runs of the iterations nested in them
				own := map[string]bool{}
				for _, r := range b.RunIDs {
					own[r] = true
				}
				for _, r := range a.Runs {
					if !own[r] {
						rep("iteration %s misses its run %s", a.ID, r)
					}
				}
				if len(b.RunIDs) < len(a.Runs) {
					rep("iteration %s: %d runs, the mock-up has %d", a.ID, len(b.RunIDs), len(a.Runs))
				}
			}
			if len(a.Children) != len(b.Children) {
				rep("node %s %s has %d children, want %d", a.ID, a.Kind, len(b.Children), len(a.Children))
				return
			}
			for i := range a.Children {
				cmp(a.Children[i], b.Children[i])
			}
		}
		cmp(md.Tree, d.Tree)
	}
	// CVM iteration 2 holds the JPPD runs nested in it: 2 of its own and 4 nested
	for _, d := range sc.Dumps {
		walk(d.Tree, func(n, _ *Node) {
			if n.Kind == KindIteration && n.Prefix == "CVM" && n.N == 2 && d.Idx == 1 && len(n.RunIDs) != 6 {
				rep("CVM iteration 2 of dump 2 holds %d runs, want 6 (2 of its own and the 4 of the JPPD iterations nested in it)", len(n.RunIDs))
			}
		})
	}
	pos := map[int]int{}
	for _, l := range m.Landmarks {
		g := sc.Dumps[l.Dump].Landmarks[pos[l.Dump]]
		pos[l.Dump]++
		if g.Line != l.Line || g.Kind != l.Kind || g.Tone != l.Tone || g.Text != l.Text {
			rep("landmark %+v, want %+v", g, l)
		}
	}
	fp := map[int]int{}
	for _, f := range m.Folds {
		g := sc.Dumps[f.Dump].Folds[fp[f.Dump]]
		fp[f.Dump]++
		if g.From != f.From || g.To != f.To || g.Kind != f.Kind || g.Label != f.Label || g.Lines != f.Lines || !g.Closed {
			rep("fold %+v, want %+v", g, f)
		}
	}
	sp := map[int]int{}
	for _, s := range m.Sql {
		g := sc.Dumps[s.Dump].SQL[sp[s.Dump]]
		sp[s.Dump]++
		same, prev := 0, 0
		if s.SameAs != nil {
			same = *s.SameAs
		}
		if s.Prev != nil {
			prev = *s.Prev
		}
		if g.Head != s.Head || g.Line != s.Line || g.Label != s.Label || g.Text != s.Text || g.SameAs != same || g.Prev != prev || g.N != sp[s.Dump] {
			rep("sql %d: %+v, want %+v", s.N, g, s)
		}
	}
	for k, d := range sc.Dumps {
		p := normJSON(d.Plan).(map[string]any)
		w := m.Plans[k]
		delete(w, "dump")
		if fmt.Sprint(p) != fmt.Sprint(w) {
			rep("plan of dump %d differs:\n%v\n%v", k, p, w)
		}
	}
	if fmt.Sprint(normJSON(sc.Dumps[0].Legend)) != fmt.Sprint(normJSON(m.Legend)) {
		rep("legend differs")
	}
	ri := 0
	for _, d := range sc.Dumps {
		for _, r := range d.Runs {
			w := m.Runs[ri]
			ri++
			x := normJSON(r).(map[string]any)
			for _, k := range []string{"id", "n", "of", "qb", "qbn", "from", "to", "final"} {
				if fmt.Sprint(x[k]) != fmt.Sprint(w[k]) {
					rep("run %v %s: %v, want %v", x["n"], k, x[k], w[k])
				}
			}
			for _, k := range []string{"sameAs", "bestJo", "iter"} {
				if (w[k] == nil && x[k] != 0.0 && x[k] != "") || (w[k] != nil && fmt.Sprint(x[k]) != fmt.Sprint(w[k])) {
					rep("run %v %s: %v, want %v", x["n"], k, x[k], w[k])
				}
			}
			if fmt.Sprint(x["verdict"]) != fmt.Sprint(w["verdict"]) && !(x["verdict"] == nil && w["verdict"] == nil) {
				rep("run %v verdict: %v, want %v", x["n"], x["verdict"], w["verdict"])
			}
		}
	}
	// roles and banners (the banners in file order here; the mock-up lists them in two groups)
	nroles, nban := 0, 0
	for _, d := range sc.Dumps {
		nroles += len(d.Roles)
		nban += len(d.Banners)
		last := 0
		for _, b := range d.Banners {
			if b.Title < last {
				rep("banners not in file order at %d", b.Title)
			}
			last = b.Title
		}
	}
	if nroles != len(m.Roles) || nban != len(m.Banners) {
		rep("roles %d/%d banners %d/%d", nroles, len(m.Roles), nban, len(m.Banners))
	}
	for ks, r := range m.Roles {
		n, _ := strconv.Atoi(ks)
		got := ""
		for _, d := range sc.Dumps {
			if v, ok := d.Roles[n]; ok {
				got = v
			}
		}
		if got != r {
			rep("role of line %d: %q, want %q", n, got, r)
		}
	}
	mb := map[int]string{}
	for _, b := range m.Banners {
		mb[b.Title] = fmt.Sprint(b.Top, b.Bottom, b.Text)
	}
	for _, d := range sc.Dumps {
		for _, b := range d.Banners {
			if mb[b.Title] != fmt.Sprint(b.Top, b.Bottom, b.Text) {
				rep("banner at %d: %v, want %s", b.Title, b, mb[b.Title])
			}
		}
	}
}
