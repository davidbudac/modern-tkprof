package analyze

import (
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

const workload = "../../testdata/sets/workload"

// A single-session trace's response time is its span: the base every
// percentage of a single file had before the session sum.
func TestResponseOfSingleSessionIsTheSpan(t *testing.T) {
	all, _ := filepath.Glob("../../testdata/traces/*/*.trc")
	if len(all) == 0 {
		t.Fatal("no fixtures")
	}
	for _, p := range all {
		m, err := model.Build(p, model.Options{})
		if err != nil {
			t.Fatal(err)
		}
		r := TraceResponse(m)
		if r.WallUs != m.Span.Us() {
			t.Errorf("%s: wall %d, span %d", p, r.WallUs, m.Span.Us())
		}
		if _, n := SessionsOf(m); n > 1 {
			continue // multisession.trc: trcsess output of two processes
		}
		if r.ResponseUs != m.Span.Us() || r.Sessions != 1 {
			t.Errorf("%s: response %d over %d sessions, span %d", p, r.ResponseUs, r.Sessions, m.Span.Us())
		}
		if p := TraceProfile(m); p.TotalUs != m.Span.Us() {
			t.Errorf("%s: profile total %d, span %d", p.Label, p.TotalUs, m.Span.Us())
		}
	}
}

// Two sessions, as two files or as the trcsess output of both: the sum of
// their spans, whatever the wall clock says.
func TestResponseOfConcurrentSessionsIsTheSum(t *testing.T) {
	dir := "../../testdata/traces/19c/"
	span := func(p string) int64 {
		m, err := model.Build(dir+p, model.Options{})
		if err != nil {
			t.Fatal(err)
		}
		return m.Span.Us()
	}
	a, b := span("multisession_a.trc"), span("multisession_b.trc")
	pair, err := model.BuildFiles([]string{dir + "multisession_a.trc", dir + "multisession_b.trc"}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	r := TraceResponse(pair)
	if r.Sessions != 2 || r.ResponseUs != a+b || r.WallUs != pair.Span.Us() {
		t.Errorf("a+b: %+v, want %d over 2 sessions, wall %d", r, a+b, pair.Span.Us())
	}
	checkLedger(t, "a+b", pair)
	one, err := model.Build(dir+"multisession.trc", model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	r = TraceResponse(one)
	if r.Sessions != 2 || r.ResponseUs <= one.Span.Us() {
		t.Errorf("multisession.trc: %+v, span %d", r, one.Span.Us())
	}
	checkLedger(t, "multisession.trc", one)
}

// checkLedger: no profile row and no statement exceeds the response time.
func checkLedger(t *testing.T, what string, m *model.Model) {
	t.Helper()
	p := TraceProfile(m)
	if p.TotalUs != p.ResponseUs || p.UnaccountedUs < 0 {
		t.Errorf("%s: total %d, response %d, unaccounted %d", what, p.TotalUs, p.ResponseUs, p.UnaccountedUs)
	}
	for _, r := range p.Rows {
		if r.Us > p.TotalUs || r.Pct > 100 {
			t.Errorf("%s: %s %d µs = %.1f %% of %d", what, r.Component, r.Us, r.Pct, p.TotalUs)
		}
	}
	sp := ProfileOf(m, Filter{IncludeIdle: true})
	if sp.ResponseUs != p.ResponseUs || sp.WallUs != p.WallUs || sp.Sessions != p.Sessions {
		t.Errorf("%s: scope profile %d/%d/%d, trace profile %d/%d/%d", what, sp.ResponseUs, sp.WallUs, sp.Sessions, p.ResponseUs, p.WallUs, p.Sessions)
	}
	for _, e := range sp.Events {
		if e.Us > sp.ResponseUs {
			t.Errorf("%s: scope ledger %s %d > %d", what, e.Name, e.Us, sp.ResponseUs)
		}
	}
	if sp.CPUUs > sp.ResponseUs {
		t.Errorf("%s: scope CPU %d > %d", what, sp.CPUUs, sp.ResponseUs)
	}
	// the scope's ledger is the text report's: attached PX slaves left out of both
	var waits int64
	for _, e := range sp.Events {
		waits += e.Us
	}
	if sp.CPUUs != p.CPUUs || waits != p.WaitUs+p.IdleUs {
		t.Errorf("%s: scope ledger cpu %d waits %d, trace profile cpu %d waits %d", what, sp.CPUUs, waits, p.CPUUs, p.WaitUs+p.IdleUs)
	}
	for _, s := range Statements(m) {
		if s.Elapsed+s.IdleUs > p.TotalUs {
			t.Errorf("%s: statement %d: %d > %d", what, s.ID, s.Elapsed+s.IdleUs, p.TotalUs)
		}
	}
}

// The workload set: four concurrent sessions (one of them a two-file chain),
// eight PX slaves attached to the report session.
func TestResponseOfWorkloadSet(t *testing.T) {
	m, err := model.BuildFiles([]string{workload}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	cs := Contexts(m)
	r := TraceResponse(m)
	if r.Sessions != 4 || r.WallUs != m.Span.Us() {
		t.Fatalf("%+v, want 4 sessions, wall %d", r, m.Span.Us())
	}
	// Σ over the sessions: by process and chain, each from its first to its last row, a context within its file's range
	of, _ := SessionsOf(m)
	lo, hi := map[int32]int64{}, map[int32]int64{}
	for i, c := range cs {
		if m.PXChild(model.ID(i)) || c.FirstTim == 0 {
			continue
		}
		f := m.File.Files[m.Contexts[i].FileIdx]
		from, to := max(c.FirstTim, f.FirstTim), min(c.LastTim, f.LastTim)
		s := of[i]
		if lo[s] == 0 || from < lo[s] {
			lo[s] = from
		}
		hi[s] = max(hi[s], to)
	}
	var sum int64
	for s := range lo {
		if hi[s] <= lo[s] {
			delete(lo, s) // the stub files of two PX slaves: one timed line each
			continue
		}
		sum += hi[s] - lo[s]
	}
	if len(lo) != 4 || r.ResponseUs != sum {
		t.Errorf("response %d over %d sessions, Σ sessions %d over %d", r.ResponseUs, r.Sessions, sum, len(lo))
	}
	if r.ResponseUs <= r.WallUs {
		t.Errorf("response %d not above the wall clock %d", r.ResponseUs, r.WallUs)
	}
	checkLedger(t, "workload", m)

	// per file: its own rows; the two parts of the batch chain add up to the session
	files := m.File.Files
	part := map[string]int64{}
	var sumFiles int64
	for fi := range files {
		var ctxs []model.ID
		for i := range m.Contexts {
			if m.Contexts[i].FileIdx == fi {
				ctxs = append(ctxs, model.ID(i))
			}
		}
		fr := ResponseOf(m, cs, Filter{Contexts: ctxs})
		part[files[fi].Name] = fr.ResponseUs
		if !files[fi].PX {
			sumFiles += fr.ResponseUs
		}
		if fr.ResponseUs > r.ResponseUs {
			t.Errorf("%s: %d > the set's %d", files[fi].Name, fr.ResponseUs, r.ResponseUs)
		}
	}
	b1, b2 := part["cdb1_ora_22608_mtk_wl_batch.trc"], part["cdb1_ora_22608_mtk_wl_batch_2.trc"]
	t.Logf("response %d µs over %d sessions, wall %d µs; batch chain %d + %d µs", r.ResponseUs, r.Sessions, r.WallUs, b1, b2)
	if b1 < 400000 || b2 <= 0 {
		t.Errorf("batch chain: part 1 %d µs (has a 0.4 s sleep), part 2 %d µs", b1, b2)
	}
	if sumFiles > r.ResponseUs || sumFiles < r.ResponseUs-5000 { // the chain loses the gap between its parts
		t.Errorf("Σ of the non-PX files %d, set %d", sumFiles, r.ResponseUs)
	}
	// a PX slave file alone counts (its coordinator is not in scope); with the coordinator it does not
	var slave, qc []model.ID
	for i := range m.Contexts {
		if m.PXChild(model.ID(i)) && slave == nil {
			slave = []model.ID{model.ID(i)}
			qc = []model.ID{m.Contexts[i].Parent, model.ID(i)}
		}
	}
	if s := ResponseOf(m, cs, Filter{Contexts: slave}); s.Sessions != 1 || s.ResponseUs <= 0 {
		t.Errorf("slave alone: %+v", s)
	}
	if s, c := ResponseOf(m, cs, Filter{Contexts: qc}), ResponseOf(m, cs, Filter{Contexts: qc[:1]}); s != c {
		t.Errorf("coordinator + slave %+v, coordinator alone %+v", s, c)
	}
	// a window clips every session: at most sessions × window
	mid := m.Span.FirstTim + m.Span.Us()/4
	end := mid + 100000
	w := ResponseOf(m, cs, Filter{StartTim: mid, EndTim: end})
	if w.WallUs != end-mid || w.ResponseUs > int64(w.Sessions)*(end-mid) || w.ResponseUs <= 0 {
		t.Errorf("window: %+v", w)
	}
	var clipped int64
	for s := range lo {
		clipped += max(min(hi[s], end)-max(lo[s], mid), 0)
	}
	if w.ResponseUs != clipped {
		t.Errorf("window: %d, Σ clipped sessions %d", w.ResponseUs, clipped)
	}
	if n := ResponseOf(m, cs, Filter{NoContexts: true}); n.ResponseUs != 0 || n.Sessions != 0 {
		t.Errorf("no contexts: %+v", n)
	}
	// the document's profile carries the same base
	p := TraceProfile(m)
	if p.TotalUs != r.ResponseUs || p.Sessions != 4 || p.WallUs != m.Span.Us() {
		t.Errorf("trace profile: total %d sessions %d wall %d", p.TotalUs, p.Sessions, p.WallUs)
	}
}
