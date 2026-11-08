package analyze

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// An aggregation-only model must answer every analysis exactly like the full
// model: same statement tables, profiles, sessions, time buckets, events and
// findings. Only what needs per-call facts is different (see aggFixtureSets).

// eagerThresholds make every finding rule fire on the small fixtures.
func eagerThresholds() Thresholds {
	th := DefaultThresholds()
	th.OutlierMinUs, th.OutlierMinExecs, th.OutlierFactor = 0, 2, 1.2
	th.HardParseMinExecs, th.HardParseMinTotal, th.HardParseRatio = 1, 1, 0.1
	th.ParseExecMinExecs, th.ParseExecRatio = 1, 0.2
	th.HardCloseMinParses, th.HardCloseMinCount, th.HardCloseShare = 1, 0, 0.1
	th.ThinkTimeShare, th.InCallIdleShare = 0.001, 0.0001
	th.SmallFetchRows, th.SmallFetchMinFetchesPerExec, th.SmallFetchMinFetches, th.SmallFetchMinRows = 1000, 1, 0, 0
	th.CommitMinCount, th.CommitPerDMLRatio = 0, 0
	th.RoundTripsMin, th.RoundTripsPerRow = 0, 0
	return th
}

func fixtureSets(t *testing.T) map[string][]string {
	t.Helper()
	dir := "../../testdata/traces/19c"
	all, err := filepath.Glob(filepath.Join(dir, "*.trc"))
	if err != nil || len(all) == 0 {
		t.Fatalf("no fixtures: %v", err)
	}
	sets := map[string][]string{
		"parallel+slave":   {filepath.Join(dir, "parallel.trc"), filepath.Join(dir, "parallel_slave.trc")},
		"multisession-a+b": {filepath.Join(dir, "multisession_a.trc"), filepath.Join(dir, "multisession_b.trc")},
		"workload":         {"../../testdata/sets/workload"},
	}
	for _, f := range all {
		sets[strings.TrimSuffix(filepath.Base(f), ".trc")] = []string{f}
	}
	return sets
}

func buildPair(t *testing.T, files []string, th Thresholds) (full, agg *model.Model) {
	t.Helper()
	full, err := model.BuildFiles(files, model.Options{NoFacts: true})
	if err != nil {
		t.Fatal(err)
	}
	agg, err = model.BuildFiles(files, model.Options{Aggregate: true, NewSink: func(m *model.Model) model.Sink { return NewAccumulator(m, th) }})
	if err != nil {
		t.Fatal(err)
	}
	return full, agg
}

func j(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// noCalls clears the call ids of evidence rows: an aggregate model has no calls to point at.
func noCalls(fs []Finding) []Finding {
	for i := range fs {
		for k := range fs[i].Evidence {
			fs[i].Evidence[k].Call = model.None
		}
	}
	return fs
}

func TestAggregateMatchesFullModel(t *testing.T) {
	for name, files := range fixtureSets(t) {
		for _, thName := range []string{"default", "eager"} {
			th := DefaultThresholds()
			if thName == "eager" {
				th = eagerThresholds()
			}
			t.Run(name+"/"+thName, func(t *testing.T) {
				full, agg := buildPair(t, files, th)
				if AggOf(agg) == nil || AggOf(full) != nil {
					t.Fatal("AggOf: want the accumulator on the aggregate model only")
				}
				fs, as := Statements(full), Statements(agg)
				if a, b := j(t, fs), j(t, as); a != b {
					t.Errorf("Statements differ\nfull %s\nagg  %s", a, b)
				}
				if a, b := j(t, TraceProfile(full)), j(t, TraceProfile(agg)); a != b {
					t.Errorf("TraceProfile differ\nfull %s\nagg  %s", a, b)
				}
				if a, b := j(t, PX(full)), j(t, PX(agg)); a != b {
					t.Errorf("PX differ\nfull %s\nagg  %s", a, b)
				}
				if a, b := j(t, Contexts(full)), j(t, Contexts(agg)); a != b {
					t.Errorf("Contexts differ\nfull %s\nagg  %s", a, b)
				}
				if a, b := j(t, WaitsByEvent(full, nil)), j(t, WaitsByEvent(agg, nil)); a != b {
					t.Errorf("WaitsByEvent differ\nfull %s\nagg  %s", a, b)
				}
				if a, b := j(t, CallKinds(full)), j(t, CallKinds(agg)); a != b {
					t.Errorf("CallKinds differ\nfull %s\nagg  %s", a, b)
				}
				if full.CallCount() != agg.CallCount() || full.WaitCount() != agg.WaitCount() {
					t.Errorf("counts: full %d calls %d waits, agg %d calls %d waits", full.CallCount(), full.WaitCount(), agg.CallCount(), agg.WaitCount())
				}
				// the clock of independent files can differ: the buckets are approximate then (and say so)
				if approx := strings.Contains(strings.Join(agg.Diag.Notes, "\n"), "time buckets built from"); !approx {
					b := TimelineBucket(full)
					if x, y := j(t, Timeline(full, b)), j(t, Timeline(agg, b)); x != y {
						t.Errorf("Timeline differ\nfull %s\nagg  %s", x, y)
					}
				}
				for i := range fs {
					sid := model.ID(i)
					if a, b := j(t, StatementProfile(full, &fs[i])), j(t, StatementProfile(agg, &as[i])); a != b {
						t.Errorf("StatementProfile %d differ\nfull %s\nagg  %s", i, a, b)
					}
					evF, evA := WaitDetailEvents(full, sid), WaitDetailEvents(agg, sid)
					if a, b := j(t, evF), j(t, evA); a != b {
						t.Errorf("WaitDetailEvents %d differ\nfull %s\nagg  %s", i, a, b)
					}
					for _, e := range evF {
						if a, b := j(t, WaitDetailObjects(full, sid, e.Event)), j(t, WaitDetailObjects(agg, sid, e.Event)); a != b {
							t.Errorf("WaitDetailObjects %d/%d differ\nfull %s\nagg  %s", i, e.Event, a, b)
						}
					}
					ex := Executions(full, sid)
					es, ok := ExecSummaryOf(agg, sid)
					if !ok || es.N != int64(len(ex)) {
						t.Errorf("statement %d: %d executions, summary %+v", i, len(ex), es)
						continue
					}
					var sum, min, max int64
					var slow *Execution
					for k := range ex {
						e := ex[k].Stats.Elapsed
						sum += e
						if k == 0 || e < min {
							min = e
						}
						if e > max {
							max, slow = e, &ex[k]
						}
					}
					if es.N > 0 && (es.Sum != sum || es.Min != min || es.Max != max) {
						t.Errorf("statement %d executions: full sum/min/max %d/%d/%d, summary %+v", i, sum, min, max, es)
					}
					if slow != nil && (!es.HasSlowest || es.SlowestExecNo != slow.ExecNo || es.SlowestCursor != slow.Cursor ||
						es.SlowestElapsed != slow.Stats.Elapsed || es.SlowestRows != slow.Stats.Rows || es.SlowestDisk != slow.Stats.Disk) {
						t.Errorf("statement %d slowest execution: full %+v, summary %+v", i, slow, es)
					}
				}
				if a, b := j(t, noCalls(FindingsWith(full, fs, th))), j(t, noCalls(FindingsWith(agg, as, th))); a != b {
					t.Errorf("Findings differ\nfull %s\nagg  %s", a, b)
				}
			})
		}
	}
}

func TestEagerThresholdsFireRules(t *testing.T) {
	// the comparison above is only as good as the rules it exercises
	fired := map[string]bool{}
	for name, files := range fixtureSets(t) {
		full, _ := buildPair(t, files, eagerThresholds())
		for _, f := range FindingsWith(full, Statements(full), eagerThresholds()) {
			fired[f.Rule] = true
		}
		_ = name
	}
	for _, r := range []string{RuleOutlierExecs, RuleHardParses, RuleParsePerExec, RuleThinkTime, RuleSmallFetches, RuleCommitPerRow, RuleRoundTrips} {
		if !fired[r] {
			t.Errorf("rule %s never fired on the fixtures with eager thresholds", r)
		}
	}
}

// adoptTrace uses cursors before they are parsed (tracing started mid-session)
// and parses them later: the builder re-points the earlier calls to the
// statement, the aggregates have to follow.
const adoptTrace = `Trace file /u01/x.trc
Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
Instance name: cdb1

*** 2026-10-22T13:14:15.000000+02:00 (PDB1(3))
*** SESSION ID:(254.49185) 2026-10-22T13:14:15.000000+02:00
=====================
EXEC #7:c=10,e=20,p=0,cr=1,cu=0,mis=0,r=1,dep=1,og=1,plh=0,tim=1000100
WAIT #7: nam='db file sequential read' ela= 300 file#=4 block#=1 blocks=1 obj#=500 tim=1000300
FETCH #7:c=15,e=400,p=1,cr=2,cu=0,mis=0,r=1,dep=1,og=1,plh=0,tim=1000500
WAIT #7: nam='db file sequential read' ela= 250 file#=4 block#=2 blocks=1 obj#=500 tim=1000700
EXEC #8:c=100,e=5000,p=2,cr=9,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1001000
WAIT #8: nam='SQL*Net message from client' ela= 7000 driver id=1 #bytes=1 p3=0 obj#=-1 tim=1008000
EXEC #6:c=10,e=20,p=0,cr=1,cu=0,mis=0,r=1,dep=1,og=1,plh=0,tim=1008100
WAIT #6: nam='db file sequential read' ela= 111 file#=4 block#=3 blocks=1 obj#=501 tim=1008200
=====================
PARSING IN CURSOR #7 len=22 dep=1 uid=107 oct=3 lid=107 tim=1008300 hv=555 ad='a7' sqlid='adopt0000001'
SELECT NAME FROM MTK_X
END OF STMT
PARSE #7:c=5,e=6,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=77,tim=1008400
EXEC #7:c=10,e=900,p=0,cr=0,cu=0,mis=0,r=0,dep=1,og=1,plh=77,tim=1009400
FETCH #7:c=15,e=100,p=0,cr=2,cu=0,mis=0,r=3,dep=1,og=1,plh=77,tim=1009600
EXEC #8:c=100,e=5000,p=2,cr=9,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1015000
PARSING IN CURSOR #6 len=22 dep=1 uid=107 oct=3 lid=107 tim=1015100 hv=556 ad='a6' sqlid='adopt0000002'
SELECT NAME FROM MTK_Y
END OF STMT
PARSE #6:c=5,e=6,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=78,tim=1015200
EXEC #6:c=10,e=40,p=0,cr=0,cu=0,mis=0,r=0,dep=1,og=1,plh=78,tim=1015300
EXEC #9:c=100,e=5000,p=2,cr=9,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1021000
CLOSE #7:c=0,e=1,dep=1,type=0,tim=1021100
`

func TestAggregateFollowsAdoptedCursors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "adopt.trc")
	if err := os.WriteFile(path, []byte(adoptTrace), 0o644); err != nil {
		t.Fatal(err)
	}
	th := eagerThresholds()
	full, agg := buildPair(t, []string{path}, th)
	if full.Diag.ImplicitCursors != 2 || len(full.Diag.Notes) < 2 {
		t.Fatalf("the trace should adopt #7 and #6 and leave #8 and #9 implicit: %+v", full.Diag)
	}
	fs, as := Statements(full), Statements(agg)
	if a, b := j(t, fs), j(t, as); a != b {
		t.Errorf("Statements differ\nfull %s\nagg  %s", a, b)
	}
	b := TimelineBucket(full)
	for name, pair := range map[string][2]any{
		"profile":  {TraceProfile(full), TraceProfile(agg)},
		"contexts": {Contexts(full), Contexts(agg)},
		"events":   {WaitsByEvent(full, nil), WaitsByEvent(agg, nil)},
		"timeline": {Timeline(full, b), Timeline(agg, b)},
		"findings": {noCalls(FindingsWith(full, fs, th)), noCalls(FindingsWith(agg, as, th))},
	} {
		if x, y := j(t, pair[0]), j(t, pair[1]); x != y {
			t.Errorf("%s differ\nfull %s\nagg  %s", name, x, y)
		}
	}
	for i := range fs {
		if x, y := j(t, WaitDetailEvents(full, model.ID(i))), j(t, WaitDetailEvents(agg, model.ID(i))); x != y {
			t.Errorf("WaitDetailEvents %d differ\nfull %s\nagg  %s", i, x, y)
		}
		if x, y := j(t, StatementProfile(full, &fs[i])), j(t, StatementProfile(agg, &as[i])); x != y {
			t.Errorf("StatementProfile %d differ\nfull %s\nagg  %s", i, x, y)
		}
	}
	// the adopted statement owns the calls made before it was parsed
	for i := range as {
		if full.Statements[i].SQLID == "adopt0000001" && as[i].AllCalls.Count != 6 {
			t.Errorf("adopt0000001 has %d calls, want 6 (2 before its parse, PARSE EXEC FETCH CLOSE after)", as[i].AllCalls.Count)
		}
	}
}

// An aggregation-only model keeps no waits; its accumulator keeps the obj# and file# they named, so a reference bundle
// names the objects and datafiles of an engine session (not only the plans' objects) and the reference queries ask for them.
func TestAggregateKeepsTheWaitsRefIDs(t *testing.T) {
	files := []string{"../../testdata/traces/19c/io_waits.trc"}
	full, err := model.BuildFiles(files, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, agg := buildPair(t, files, DefaultThresholds())
	fo, ff := full.WaitRefIDs()
	ao, af := agg.WaitRefIDs()
	if j(t, fo) != j(t, ao) || j(t, ff) != j(t, af) {
		t.Fatalf("aggregate ids objs %v files %v, full model %v %v", ao, af, fo, ff)
	}
	if len(af) == 0 || len(ao) == 0 {
		t.Fatalf("no ids: objs %v files %v", ao, af)
	}
	b, err := ref.LoadBundle("../../testdata/reference/bundle")
	if err != nil {
		t.Fatal(err)
	}
	model.ApplyRef(full, b)
	model.ApplyRef(agg, b)
	if j(t, agg.Files) != j(t, full.Files) || j(t, agg.Objects) != j(t, full.Objects) {
		t.Fatalf("aggregate names files %v objects %v, full model %v %v", agg.Files, agg.Objects, full.Files, full.Objects)
	}
	if len(agg.Files) == 0 {
		t.Fatal("the bundle's datafiles were not applied to the aggregate model")
	}
	var buf bytes.Buffer
	if err := AggOf(agg).Encode(&buf); err != nil {
		t.Fatal(err)
	}
	back, err := DecodeAccumulator(&buf, agg)
	if err != nil {
		t.Fatal(err)
	}
	bo, bf := back.RefIDs()
	if j(t, bo) != j(t, ao) || j(t, bf) != j(t, af) {
		t.Fatalf("decoded ids %v %v, encoded %v %v", bo, bf, ao, af)
	}
}
