package analyze

import (
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// An idle-class wait inside a call (PL/SQL lock timer of dbms_session.sleep)
// is part of the call's e: it counts as an in-call wait, not as idle, so the
// statement's response time (elapsed + idle between calls) is the wall time
// of its calls once, and its profile adds up to it. Two sleep(1) of
// multisession_b.trc used to read 4.001 s (159 % of the file's span).
func TestInCallIdleWaitsBelongToTheCall(t *testing.T) {
	files := []string{filepath.Join(fixtures, "multisession_b.trc")}
	full, agg := buildPair(t, files, DefaultThresholds())
	facts := buildSet(t, "multisession_b.trc")
	for name, m := range map[string]*model.Model{"facts": facts, "nofacts": full, "aggregate": agg} {
		var st *StmtStats
		stats := Statements(m)
		for i := range stats {
			if m.Statements[stats[i].ID].SQLID == "4nfvy63y9varm" {
				st = &stats[i]
			}
		}
		if st == nil {
			t.Fatalf("%s: statement 4nfvy63y9varm not found", name)
		}
		// two EXECs of 1.000161 s and 1.000xxx s: the sleeps once
		if st.Elapsed < 2_000_000 || st.Elapsed > 2_001_000 {
			t.Errorf("%s: elapsed %d, want the two sleeps (~2.0 s)", name, st.Elapsed)
		}
		if st.WaitUs < 2_000_000 {
			t.Errorf("%s: in-call waits %d, want the PL/SQL lock timer waits (~2.0 s)", name, st.WaitUs)
		}
		// what is left as idle is the SQL*Net message from client between its calls
		if st.IdleUs > 1_000 {
			t.Errorf("%s: idle %d, want only the between-call think time (< 1 ms)", name, st.IdleUs)
		}
		resp := st.Elapsed + st.IdleUs
		if resp > m.Span.Us() {
			t.Errorf("%s: response time %d > the file's span %d", name, resp, m.Span.Us())
		}
		p := StatementProfile(m, st)
		if p.TotalUs != resp {
			t.Errorf("%s: profile total %d, want response time %d", name, p.TotalUs, resp)
		}
		var sum int64
		var timer *ProfileRow
		for i := range p.Rows {
			r := &p.Rows[i]
			sum += r.Us
			if r.Pct > 100 {
				t.Errorf("%s: %s is %.1f %% of the statement", name, r.Component, r.Pct)
			}
			if r.Component == "PL/SQL lock timer" {
				timer = r
			}
		}
		if sum != p.TotalUs {
			t.Errorf("%s: profile rows sum to %d, want %d", name, sum, p.TotalUs)
		}
		if p.UnaccountedUs < -1_000 || p.UnaccountedUs > 1_000 {
			t.Errorf("%s: unaccounted %d, want ~0 (the sleeps were counted twice)", name, p.UnaccountedUs)
		}
		if timer == nil || timer.Class != "Idle" || timer.Kind != "idle" || timer.Us < 2_000_000 {
			t.Errorf("%s: PL/SQL lock timer row %+v, want the Idle-class ledger row of the sleeps", name, timer)
		}
	}
	for i := range facts.Waits {
		w := &facts.Waits[i]
		if facts.Events[w.Event].Name == "PL/SQL lock timer" && w.Between {
			t.Errorf("PL/SQL lock timer at line %d marked between calls", w.Line)
		}
	}
}
