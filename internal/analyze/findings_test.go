package analyze

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

const fixtures = "../../testdata/traces/19c"

func load(t *testing.T, name string) (*model.Model, []Finding) {
	t.Helper()
	m, err := model.Build(filepath.Join(fixtures, name), model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m, Findings(m, Statements(m))
}

func byRule(fs []Finding, rule string) []Finding {
	var out []Finding
	for _, f := range fs {
		if f.Rule == rule {
			out = append(out, f)
		}
	}
	return out
}

func sqlID(m *model.Model, id model.ID) string {
	if id == model.None {
		return ""
	}
	return m.Statements[id].SQLID
}

// Every rule runs on every fixture without panicking, the output is sorted
// and well formed, and the one-pass executions match Executions.
func TestFindingsAllFixtures(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(fixtures, "*.trc"))
	if len(files) == 0 {
		t.Skip("no fixtures")
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			m, fs := load(t, filepath.Base(f))
			if fs == nil {
				t.Fatal("Findings returned nil, want empty slice")
			}
			for i, x := range fs {
				if severityRank[x.Severity] == 0 && x.Severity != SeveritySerious {
					t.Errorf("finding %d: bad severity %q", i, x.Severity)
				}
				if x.Summary == "" || x.Title == "" || x.Evidence == nil {
					t.Errorf("finding %d (%s): empty summary/title/evidence", i, x.Rule)
				}
				if len(x.Evidence) > MaxEvidenceRows+5 {
					t.Errorf("finding %d (%s): %d evidence rows", i, x.Rule, len(x.Evidence))
				}
				if i > 0 && severityRank[fs[i-1].Severity] > severityRank[x.Severity] {
					t.Errorf("findings not sorted by severity at %d", i)
				}
				if x.Statement != model.None && int(x.Statement) >= len(m.Statements) {
					t.Errorf("finding %d: statement %d out of range", i, x.Statement)
				}
			}
			all := allExecutions(m)
			for sid := range m.Statements {
				want := Executions(m, model.ID(sid))
				if len(want) == 0 && len(all[sid]) == 0 {
					continue
				}
				if !reflect.DeepEqual(all[sid], want) {
					t.Fatalf("allExecutions differs from Executions for statement %d", sid)
				}
			}
		})
	}
}

func TestFindingsCursorCacheChurn(t *testing.T) {
	m, fs := load(t, "cursor_cache.trc")
	pe := byRule(fs, RuleParsePerExec)
	if len(pe) != 1 {
		t.Fatalf("parse-per-exec findings = %d, want 1: %+v", len(pe), fs)
	}
	got := map[string]bool{}
	for _, r := range pe[0].Evidence {
		got[sqlID(m, r.Statement)] = true
	}
	for _, id := range []string{"b1v4pxf9jszu1", "cj8rvwsf0srvp"} {
		if !got[id] {
			t.Errorf("parse-per-exec evidence lacks %s: %+v", id, pe[0].Evidence)
		}
	}
	// the session cursor cache absorbs the re-parses (type=3 closes): no hard-close finding
	if n := len(byRule(fs, RuleHardCloses)); n != 0 {
		t.Errorf("hard-closes fired %d times", n)
	}
	if n := len(byRule(fs, RulePlanChange)); n != 0 {
		t.Errorf("plan-change fired %d times", n)
	}
}

func TestFindingsBasicBindsClientTime(t *testing.T) {
	m, fs := load(t, "basic_binds.trc")
	tt := byRule(fs, RuleThinkTime)
	if len(tt) != 1 || tt[0].Severity == SeverityInfo {
		t.Fatalf("think-time = %+v, want one notable/serious finding", tt)
	}
	sf := byRule(fs, RuleSmallFetches)
	if len(sf) != 1 || sqlID(m, sf[0].Statement) != "f6jyzt7462kx2" {
		t.Fatalf("small-fetches = %+v, want one for f6jyzt7462kx2", sf)
	}
	// the 5 runs with arraysize 15, not the 5 with arraysize 500
	if !strings.Contains(sf[0].Summary, "in 5 of 10 executions") {
		t.Errorf("small-fetches summary %q", sf[0].Summary)
	}
	if n := len(byRule(fs, RuleRoundTrips)); n != 0 {
		t.Errorf("round-trips fired (10,000 rows in 370 round trips)")
	}
}

func TestFindingsIOWaits(t *testing.T) {
	_, fs := load(t, "io_waits.trc")
	// no statement with >= 3 executions has one above 100 ms
	if n := len(byRule(fs, RuleOutlierExecs)); n != 0 {
		t.Errorf("outliers fired %d times", n)
	}
	if n := len(byRule(fs, RuleSmallFetches)); n != 1 {
		t.Errorf("small-fetches = %d, want 1 (the 1,505-row select at arraysize 15)", n)
	}
}

func TestFindingsPlanChangeFixture(t *testing.T) {
	m, fs := load(t, "plan_change.trc")
	pc := byRule(fs, RulePlanChange)
	if len(pc) != 1 {
		t.Fatalf("plan-change findings = %d, want 1", len(pc))
	}
	f := pc[0]
	if sqlID(m, f.Statement) != "70qh8zxg4kk69" {
		t.Errorf("plan-change statement = %s", sqlID(m, f.Statement))
	}
	labels := map[string]string{}
	for _, r := range f.Evidence {
		labels[r.Label] = r.Value
	}
	for _, h := range []string{"plan 254283197", "plan 3570327658"} {
		v, ok := labels[h]
		if !ok {
			t.Errorf("evidence lacks %s: %+v", h, f.Evidence)
			continue
		}
		// 5 runs per plan, 3 of them with STAT blocks
		if !strings.Contains(v, "5 executions") || !strings.Contains(v, "3 STAT dumps") {
			t.Errorf("%s: %q", h, v)
		}
	}
}

func TestFindingsPlanStatAllNoPlanChange(t *testing.T) {
	_, fs := load(t, "plan_stat_all.trc")
	if n := len(byRule(fs, RulePlanChange)); n != 0 {
		t.Errorf("plan-change fired %d times on a single-plan trace", n)
	}
}

func TestFindingsTruncatedLiterals(t *testing.T) {
	_, fs := load(t, "truncated.trc")
	hp := byRule(fs, RuleHardParses)
	if len(hp) != 1 || !strings.Contains(hp[0].Summary, "ran only once") {
		t.Fatalf("hard-parses = %+v", hp)
	}
}

// ---- hand-built models ------------------------------------------------------

type mb struct{ m *model.Model }

func newModel(nStmts int) *mb {
	m := &model.Model{Span: model.Span{FirstTim: 1, LastTim: 100_000_000}}
	for i := 0; i < nStmts; i++ {
		m.Statements = append(m.Statements, model.Statement{ID: model.ID(i), Kind: model.StmtSQL, SQLID: "sql" + string(rune('a'+i)), OCT: 3})
		m.Cursors = append(m.Cursors, model.Cursor{ID: model.ID(i), Statement: model.ID(i), Line: 1})
		m.Statements[i].Cursors = []model.ID{model.ID(i)}
	}
	return &mb{m}
}

func (b *mb) call(sid model.ID, kind trace.CallKind, e, r int64, plh uint64, execNo int32) {
	id := model.ID(len(b.m.Calls))
	b.m.Calls = append(b.m.Calls, model.Call{ID: id, Line: int32(id) + 10, Kind: kind, Cursor: sid, Statement: sid, E: e, SelfE: e, R: r, PLH: uint32(plh),
		Tim: int64(id+1) * 1000, Parent: model.None, ExecNo: execNo, BindSet: model.None, Context: 0})
}

func (b *mb) exec(sid model.ID, e int64, plh uint64, n int32) {
	b.call(sid, trace.CallExec, e, 0, plh, n)
}

func TestFindingsPlanChangeTable(t *testing.T) {
	cases := []struct {
		name     string
		plans    []uint64 // STAT dumps
		execPLH  []uint64 // plh of each EXEC
		execE    []int64
		want     bool
		severity string
	}{
		{"one plan", []uint64{11, 11}, []uint64{11, 11}, []int64{100, 100}, false, ""},
		{"two STAT plans", []uint64{11, 22}, nil, nil, true, SeverityNotable},
		{"two plans from EXEC plh only", nil, []uint64{11, 11, 22}, []int64{100, 100, 120}, true, SeverityNotable},
		{"slow second plan", []uint64{11, 22}, []uint64{11, 11, 22, 22}, []int64{100_000, 100_000, 900_000, 1_000_000}, true, SeveritySerious},
		{"slow second plan, tiny statement", []uint64{11, 22}, []uint64{11, 11, 22, 22}, []int64{100, 100, 900, 1000}, true, SeverityNotable},
		{"plh 0 ignored", []uint64{11}, []uint64{0, 11}, []int64{100, 100}, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := newModel(1)
			for i, h := range c.execPLH {
				b.exec(0, c.execE[i], h, int32(i+1))
			}
			for i, h := range c.plans {
				b.m.Plans = append(b.m.Plans, model.Plan{ID: model.ID(i), Line: 1000 + i, Cursor: 0, Statement: 0, PLH: h})
			}
			fs := byRule(Findings(b.m, Statements(b.m)), RulePlanChange)
			if (len(fs) == 1) != c.want {
				t.Fatalf("got %d plan-change findings, want %v", len(fs), c.want)
			}
			if c.want {
				if fs[0].Severity != c.severity || fs[0].Statement != 0 || len(fs[0].Evidence) != 2 {
					t.Errorf("finding %+v", fs[0])
				}
			}
		})
	}
}

func TestFindingsOutliers(t *testing.T) {
	b := newModel(1)
	els := []int64{10_000, 11_000, 9_000, 10_000, 500_000, 12_000, 25_000}
	for i, e := range els {
		b.exec(0, e, 0, int32(i+1))
		b.call(0, trace.CallFetch, 1000, 5, 0, int32(i+1))
	}
	fs := byRule(Findings(b.m, Statements(b.m)), RuleOutlierExecs)
	if len(fs) != 1 {
		t.Fatalf("outliers = %d, want 1", len(fs))
	}
	ev := fs[0].Evidence
	// 25 ms is above 3x the median (11 ms) but below the 100 ms floor
	if len(ev) != 1 || ev[0].ExecNo != 5 || ev[0].Us != 501_000 {
		t.Errorf("evidence %+v", ev)
	}

	// fewer than OutlierMinExecs executions: no median, no finding
	b = newModel(1)
	b.exec(0, 1_000, 0, 1)
	b.exec(0, 900_000, 0, 2)
	if n := len(byRule(Findings(b.m, Statements(b.m)), RuleOutlierExecs)); n != 0 {
		t.Errorf("outliers with 2 executions: %d", n)
	}
}

func TestFindingsCommitPerRow(t *testing.T) {
	b := newModel(1)
	b.m.Statements[0].OCT = 2 // INSERT
	for i := 0; i < 20; i++ {
		b.exec(0, 100, 0, int32(i+1))
		b.m.Transactions = append(b.m.Transactions, model.Transaction{ID: model.ID(i), Call: model.None})
	}
	fs := byRule(Findings(b.m, Statements(b.m)), RuleCommitPerRow)
	if len(fs) != 1 || fs[0].Severity != SeverityNotable {
		t.Fatalf("commit-per-row = %+v", fs)
	}
	// read-only commits do not count
	for i := range b.m.Transactions {
		b.m.Transactions[i].RdOnly = 1
	}
	if n := len(byRule(Findings(b.m, Statements(b.m)), RuleCommitPerRow)); n != 0 {
		t.Errorf("read-only commits fired commit-per-row")
	}
}

func TestFindingsHardClosesAndParses(t *testing.T) {
	b := newModel(1)
	for i := 0; i < 15; i++ {
		b.call(0, trace.CallParse, 50, 0, 0, 0)
		b.m.Calls[len(b.m.Calls)-1].Mis = 1
		b.exec(0, 100, 0, int32(i+1))
		b.call(0, trace.CallClose, 1, 0, 0, int32(i+1)) // type 0
	}
	fs := Findings(b.m, Statements(b.m))
	for _, rule := range []string{RuleHardCloses, RuleHardParses, RuleParsePerExec} {
		if n := len(byRule(fs, rule)); n != 1 {
			t.Errorf("%s = %d, want 1", rule, n)
		}
	}
	if hp := byRule(fs, RuleHardParses); len(hp) == 1 && (hp[0].Statement != 0 || hp[0].Severity == SeverityInfo) {
		t.Errorf("hard-parses %+v: want statement 0, at least notable", hp[0])
	}
}

func TestSeverityMapping(t *testing.T) {
	cases := []struct {
		impact, total int64
		want          string
	}{
		{2_000_000, 4_000_000, SeveritySerious},
		{500_000, 4_000_000, SeverityNotable}, // 12.5 %
		{900_000, 1_000_000, SeverityNotable}, // 90 % but < 1 s
		{50_000, 100_000, SeverityInfo},       // 50 % but < 100 ms
		{150_000, 100_000_000, SeverityInfo},  // 0.15 %
		{0, 0, SeverityInfo},
	}
	for _, c := range cases {
		if got := timeSeverity(c.impact, c.total); got != c.want {
			t.Errorf("timeSeverity(%d, %d) = %s, want %s", c.impact, c.total, got, c.want)
		}
	}
	if atLeast(SeverityInfo, SeverityNotable) != SeverityNotable || atLeast(SeveritySerious, SeverityNotable) != SeveritySerious {
		t.Error("atLeast")
	}
}

// hard-parses needs HardParseMinTotal missed parses trace-wide: short traces
// where every statement runs (and misses) once stay quiet.
func TestFindingsHardParsesTraceWideThreshold(t *testing.T) {
	for _, c := range []struct {
		n    int
		want bool
	}{{HardParseMinTotal - 1, false}, {HardParseMinTotal, true}} {
		b := newModel(c.n)
		for i := 0; i < c.n; i++ {
			b.call(model.ID(i), trace.CallParse, 50, 0, 0, 0)
			b.m.Calls[len(b.m.Calls)-1].Mis = 1
			b.exec(model.ID(i), 100, 0, 1)
		}
		got := len(byRule(Findings(b.m, Statements(b.m)), RuleHardParses)) == 1
		if got != c.want {
			t.Errorf("%d once-run statements, all hard parsed: hard-parses fired = %v, want %v", c.n, got, c.want)
		}
	}
	for _, name := range []string{"plan_stat_all.trc", "parallel.trc"} { // 13 and 17 once-run statements
		if _, fs := load(t, name); len(byRule(fs, RuleHardParses)) != 0 {
			t.Errorf("%s: hard-parses fired on a short trace", name)
		}
	}
}

// dbms_session.sleep waits (PL/SQL lock timer) happen inside the EXEC: they are
// in-call idle time, not think time.
func TestFindingsInCallIdleNotThinkTime(t *testing.T) {
	for _, name := range []string{"multisession.trc", "multisession_b.trc"} {
		m, fs := load(t, name)
		if n := len(byRule(fs, RuleThinkTime)); n != 0 {
			t.Errorf("%s: think-time fired %d times for in-call sleeps", name, n)
		}
		ic := byRule(fs, RuleInCallIdle)
		if len(ic) != 1 || ic[0].Severity != SeverityInfo {
			t.Fatalf("%s: in-call-idle = %+v, want one info finding", name, ic)
		}
		if len(ic[0].Evidence) == 0 || ic[0].Evidence[0].Label != "PL/SQL lock timer" {
			t.Errorf("%s: in-call-idle evidence = %+v", name, ic[0].Evidence)
		}
		var sleep int64
		for i := range m.Waits {
			if m.Events[m.Waits[i].Event].Name == "PL/SQL lock timer" {
				sleep += m.Waits[i].Ela
			}
		}
		if ic[0].ImpactUs < sleep {
			t.Errorf("%s: in-call-idle impact %d < PL/SQL lock timer total %d", name, ic[0].ImpactUs, sleep)
		}
	}
	// between-call idle (SQL*Net message from client) is still think time and
	// is not reported as in-call idle
	_, fs := load(t, "basic_binds.trc")
	if len(byRule(fs, RuleThinkTime)) != 1 || len(byRule(fs, RuleInCallIdle)) != 0 {
		t.Errorf("basic_binds: think-time/in-call-idle = %d/%d, want 1/0", len(byRule(fs, RuleThinkTime)), len(byRule(fs, RuleInCallIdle)))
	}
}
