package slice

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// eagerThresholds make every rule fire on the small fixtures, so the parity
// test covers each of them (the defaults leave most fixtures without findings).
func eagerThresholds() analyze.Thresholds {
	th := analyze.DefaultThresholds()
	th.OutlierFactor, th.OutlierMinUs, th.OutlierMinExecs = 1.2, 0, 2
	th.HardParseRatio, th.HardParseMinExecs, th.HardParseMinTotal = 0.01, 0, 1
	th.ParseExecRatio, th.ParseExecMinExecs = 0.01, 0
	th.HardCloseShare, th.HardCloseMinParses, th.HardCloseMinCount = 0.01, 1, 0
	th.ThinkTimeShare, th.InCallIdleShare = 0.0001, 0.0001
	th.SmallFetchRows, th.SmallFetchMinFetchesPerExec, th.SmallFetchMinFetches, th.SmallFetchMinRows = 1e9, 1, 0, 0
	th.CommitPerDMLRatio, th.CommitMinCount = 0.0001, 0
	th.RoundTripsPerRow, th.RoundTripsMin = 0.0001, 0
	th.MaxEvidenceRows = 3
	th.NotableMinUs, th.NotableShare, th.SeriousCount, th.NotableCount = 1000, 0.01, 50, 5
	return th
}

func buildSpilledWith(t *testing.T, paths []string, dir string, th analyze.Thresholds) (*model.Model, *Spill) {
	t.Helper()
	sp, err := NewSpill(SpillOptions{Dir: dir, Key: SpillKey(paths)})
	if err != nil {
		t.Fatal(err)
	}
	m, err := model.BuildFiles(paths, model.Options{
		Aggregate: true, SpillBinds: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  func(m *model.Model) model.Sink { return sp.Attach(m) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return m, sp
}

func sameFindings(t *testing.T, what string, got, want []analyze.Finding) {
	t.Helper()
	if reflect.DeepEqual(got, want) {
		return
	}
	g, _ := json.MarshalIndent(got, "", " ")
	w, _ := json.MarshalIndent(want, "", " ")
	t.Errorf("%s: findings differ\n got %s\nwant %s", what, g, w)
}

// With no narrowing FindingsOn returns the document's findings, from the
// model's own rows and from the spill of an aggregation-only build, with the
// default thresholds and with thresholds that make every rule fire.
func TestFindingsOnWholeSetEqualsFindings(t *testing.T) {
	fired := map[string]int{}
	for name, paths := range stmtSets(t) {
		for _, tc := range []struct {
			name string
			th   analyze.Thresholds
		}{{"default", analyze.DefaultThresholds()}, {"eager", eagerThresholds()}} {
			t.Run(name+"/"+tc.name, func(t *testing.T) {
				full, err := model.BuildFiles(paths, model.Options{})
				if err != nil {
					t.Fatal(err)
				}
				want := analyze.FindingsWith(full, analyze.Statements(full), tc.th)
				got, err := analyze.FindingsOnWith(context.Background(), full, MemSource(full), analyze.Filter{}, tc.th)
				if err != nil {
					t.Fatal(err)
				}
				sameFindings(t, "memory", got, want)
				if tc.name == "eager" {
					for _, f := range want {
						fired[f.Rule]++
					}
				}

				agg, sp := buildSpilledWith(t, paths, t.TempDir(), tc.th)
				defer sp.Close()
				src, err := sp.Source()
				if err != nil {
					t.Fatal(err)
				}
				want = analyze.FindingsWith(agg, analyze.Statements(agg), tc.th)
				got, err = analyze.FindingsOnWith(context.Background(), agg, src, analyze.Filter{}, tc.th)
				if err != nil {
					t.Fatal(err)
				}
				sameFindings(t, "spill", got, want)
			})
		}
	}
	for _, r := range []string{analyze.RuleOutlierExecs, analyze.RulePlanChange, analyze.RuleHardParses, analyze.RuleParsePerExec, analyze.RuleHardCloses,
		analyze.RuleThinkTime, analyze.RuleInCallIdle, analyze.RuleSmallFetches, analyze.RuleCommitPerRow, analyze.RuleRoundTrips} {
		if fired[r] == 0 {
			t.Errorf("rule %s fired on no fixture: the parity test does not cover it", r)
		}
	}
}

// One file of a multi-file set: the findings of the file alone (same rules,
// same numbers), and the spill answers the subset like the model.
func TestFindingsOnFileSubsetMatchesFileAlone(t *testing.T) {
	th := eagerThresholds()
	sets := [][]string{
		{traces + "multisession_a.trc", traces + "multisession_b.trc"},
		{traces + "multisession_a.trc", traces + "multisession_b.trc", traces + "basic_binds.trc"},
	}
	for _, paths := range sets {
		m, err := model.BuildFiles(paths, model.Options{})
		if err != nil {
			t.Fatal(err)
		}
		agg, sp := buildSpilledWith(t, paths, t.TempDir(), th)
		defer sp.Close()
		disk, err := sp.Source()
		if err != nil {
			t.Fatal(err)
		}
		for fi, p := range paths {
			var ctxs []model.ID
			for i := range m.Contexts {
				if m.Contexts[i].FileIdx == fi {
					ctxs = append(ctxs, model.ID(i))
				}
			}
			f := analyze.Filter{Contexts: ctxs}
			part, err := analyze.FindingsOnWith(context.Background(), m, MemSource(m), f, th)
			if err != nil {
				t.Fatal(err)
			}
			alone, err := model.BuildFiles([]string{p}, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			want := analyze.FindingsWith(alone, analyze.Statements(alone), th)
			if g, w := findingKeys(m, part), findingKeys(alone, want); !reflect.DeepEqual(g, w) {
				t.Errorf("%s in the set: findings\n%v\nalone:\n%v", p, g, w)
			}
			fromDisk, err := analyze.FindingsOnWith(context.Background(), agg, disk, f, th)
			if err != nil {
				t.Fatal(err)
			}
			if g, w := findingKeys(agg, fromDisk), findingKeys(m, part); !reflect.DeepEqual(g, w) {
				t.Errorf("%s: spill subset\n%v\nmemory subset:\n%v", p, g, w)
			}
		}
		// a window (the second half of the set), alone and with the first file
		mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
		var first []model.ID
		for i := range m.Contexts {
			if m.Contexts[i].FileIdx == 0 {
				first = append(first, model.ID(i))
			}
		}
		for _, f := range []analyze.Filter{{StartTim: mid}, {EndTim: mid}, {StartTim: mid, Contexts: first}} {
			mem, err := analyze.FindingsOnWith(context.Background(), m, MemSource(m), f, th)
			if err != nil {
				t.Fatal(err)
			}
			fromDisk, err := analyze.FindingsOnWith(context.Background(), agg, disk, f, th)
			if err != nil {
				t.Fatal(err)
			}
			if g, w := findingKeys(agg, fromDisk), findingKeys(m, mem); !reflect.DeepEqual(g, w) {
				t.Errorf("%+v: spill\n%v\nmemory:\n%v", f, g, w)
			}
			if len(mem) == 0 {
				t.Errorf("%+v: no findings (the eager thresholds should fire)", f)
			}
		}
	}
}

// findingKeys is what must not depend on the statement ids or evidence ids
// of the build: rule, severity, statement sql_id, impact, summary.
func findingKeys(m *model.Model, fs []analyze.Finding) []string {
	out := make([]string, 0, len(fs))
	for _, f := range fs {
		sql := ""
		if f.Statement != model.None {
			sql = m.Statements[f.Statement].SQLID
		}
		out = append(out, fmt.Sprintf("%s %s %s %d %s", f.Rule, f.Severity, sql, f.ImpactUs, f.Summary))
	}
	sort.Strings(out)
	return out
}

func TestFindingsEndpoint(t *testing.T) {
	m, h := setup(t)
	var got struct {
		Findings []analyze.Finding `json:"findings"`
	}
	if code := get(t, h, "/api/findings", &got); code != 200 {
		t.Fatalf("status %d", code)
	}
	sameFindings(t, "endpoint", got.Findings, analyze.Findings(m, analyze.Statements(m)))
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	q := fmt.Sprintf("/api/findings?from=%d&contexts=0", mid)
	if code := get(t, h, q, &got); code != 200 {
		t.Fatalf("%s: status %d", q, code)
	}
	want, _ := analyze.FindingsOn(context.Background(), m, MemSource(m), analyze.Filter{StartTim: mid, Contexts: []model.ID{0}})
	sameFindings(t, q, got.Findings, want)
	if code := get(t, h, "/api/findings?contexts=-", &got); code != 200 || len(got.Findings) != 0 {
		t.Errorf("contexts=-: status %d, %d findings", code, len(got.Findings))
	}
	for _, p := range []string{"/api/findings?from=x", "/api/findings?contexts=999", "/api/findings?from=10&to=5", "/api/findings?stmt=0", "/api/findings?event=0"} {
		if code := get(t, h, p, nil); code != 400 {
			t.Errorf("%s: status %d, want 400", p, code)
		}
	}
}
