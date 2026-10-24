package analyze

import (
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

func buildSet(t *testing.T, names ...string) *model.Model {
	t.Helper()
	var paths []string
	for _, n := range names {
		paths = append(paths, filepath.Join(fixtures, n))
	}
	m, err := model.BuildFiles(paths, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// Attached slaves must not change the coordinator's statement numbers; their
// work is reported separately as PXElapsed.
func TestPXDoesNotDoubleCount(t *testing.T) {
	qc := buildSet(t, "parallel.trc")
	both := buildSet(t, "parallel.trc", "parallel_slave.trc")
	alone := buildSet(t, "parallel_slave.trc")
	sq, sb, sa := Statements(qc), Statements(both), Statements(alone)

	// qc statement ids are a prefix of the set's (the first file is parsed first)
	var withPX int
	for i := range sq {
		a, b := sq[i], sb[i]
		if a.Total != b.Total || a.Elapsed != b.Elapsed || a.SelfElapsed != b.SelfElapsed || a.CPU != b.CPU || a.WaitUs != b.WaitUs || a.IdleUs != b.IdleUs || a.Executions != b.Executions {
			t.Errorf("statement %d (%s): coordinator-only %+v, with slaves %+v", i, qc.Statements[i].SQLID, a.Total, b.Total)
		}
		if b.PXSessions > 0 {
			withPX++
			if b.PXElapsed <= 0 || b.PXSessions != 1 {
				t.Errorf("statement %d: pxEla %d sessions %d", i, b.PXElapsed, b.PXSessions)
			}
		}
	}
	if withPX < 2 {
		t.Errorf("statements with slave work: %d, want at least the two PX queries", withPX)
	}
	// pxEla of a statement = what the slave file shows for that sql_id when parsed alone
	for i := range sa {
		sqlid := alone.Statements[i].SQLID
		if sqlid == "" || sa[i].SelfElapsed == 0 {
			continue
		}
		for j := range both.Statements {
			if both.Statements[j].SQLID == sqlid && sb[j].PXElapsed != sa[i].SelfElapsed {
				t.Errorf("%s: pxEla %d, slave alone self elapsed %d", sqlid, sb[j].PXElapsed, sa[i].SelfElapsed)
			}
		}
	}
	// the whole-trace profile leaves the slaves out
	if got, want := TraceProfile(both).CPUUs, TraceProfile(qc).CPUUs; got != want {
		t.Errorf("trace profile cpu %d, coordinator alone %d", got, want)
	}
	px := PX(both)
	if px.Sessions != 1 || px.CPUUs == 0 {
		t.Errorf("PX totals: %+v", px)
	}
	// without a coordinator the slave file is analysed as it is (tkprof parity)
	if PX(alone).Sessions != 0 {
		t.Errorf("slave alone: %+v", PX(alone))
	}
}
