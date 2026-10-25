package slice

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// /api/plan answers what `mtkprof plan` prints (report.SelectPlans): every
// statement of every fixture with plans, by stmt id and by sql_id, with and
// without plh/exec, on the model-backed and the spill-backed server.
func TestPlanEndpoint(t *testing.T) {
	var statements, multi, dumps2 int
	for _, fx := range []string{"plan_change.trc", "plan_stat_all.trc", "io_waits.trc", "basic_binds.trc"} {
		e := newLineEnv(t, []string{traces + fx})
		m := e.full
		for i := range m.Statements {
			id := model.ID(i)
			all := report.PlansOf(m, id)
			q := fmt.Sprintf("/api/plan?stmt=%d", i)
			if len(all) == 0 {
				if code, b := e.both(t, q); code != 404 {
					t.Errorf("%s %s: %d %s, want 404 (no STAT plan)", fx, q, code, b)
				}
				continue
			}
			statements++
			// default: what the CLI prints for every hash (latest dump of each)
			plans, err := report.SelectPlans(m, id, "", 0)
			if err != nil {
				t.Fatal(err)
			}
			want, _ := report.PlansJSON(m, plans)
			code, got := e.both(t, q)
			if code != 200 || !bytes.Equal(got, want) {
				t.Errorf("%s %s: %d %.200s\nwant %.200s", fx, q, code, got, want)
			}
			if len(plans) > 1 {
				multi++
				var obj map[string][]report.PlanRow
				if err := json.Unmarshal(got, &obj); err != nil || len(obj) != len(plans) {
					t.Errorf("%s: several hashes must be an object keyed by hash: %v %.100s", fx, err, got)
				}
			}
			sqlID := url.QueryEscape(m.Statements[i].SQLID)
			if code, b := e.both(t, "/api/plan?sql_id="+sqlID); code != 200 || !bytes.Equal(b, wantFirstWithSQLID(t, m, m.Statements[i].SQLID)) {
				t.Errorf("%s sql_id=%s: %d %.100s", fx, sqlID, code, b)
			}
			for _, p := range report.LatestPlans(m, id) {
				plh := strconv.FormatUint(p.PLH, 10)
				var n int
				for _, d := range all {
					if d.PLH == p.PLH {
						n++
					}
				}
				for ex := 0; ex <= n+1; ex++ {
					q := fmt.Sprintf("/api/plan?stmt=%d&plh=%s&exec=%d", i, plh, ex)
					code, b := e.both(t, q)
					if ex > n {
						if code != 404 {
							t.Errorf("%s %s: %d, want 404 (only %d dumps)", fx, q, code, n)
						}
						continue
					}
					sel := n
					if ex > 0 {
						sel = ex
					}
					var rows []report.PlanRow
					if code != 200 || json.Unmarshal(b, &rows) != nil || len(rows) == 0 {
						t.Fatalf("%s %s: %d %.200s", fx, q, code, b)
					}
					if rows[0].Execution != sel || rows[0].PlanHashValue != plh || rows[0].SQLID != m.Statements[i].SQLID {
						t.Errorf("%s %s: first row execution %d plan %s sql_id %s, want dump %d of %s", fx, q, rows[0].Execution, rows[0].PlanHashValue, rows[0].SQLID, sel, plh)
					}
					if n > 1 && ex == 1 {
						dumps2++
					}
				}
			}
		}
	}
	if statements == 0 || multi == 0 || dumps2 == 0 {
		t.Errorf("fixtures cover %d statements with plans, %d with several hashes, %d with several dumps", statements, multi, dumps2)
	}
}

func wantFirstWithSQLID(t *testing.T, m *model.Model, sqlID string) []byte {
	t.Helper()
	for i := range m.Statements {
		if m.Statements[i].SQLID == sqlID {
			plans, err := report.SelectPlans(m, model.ID(i), "", 0)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := report.PlansJSON(m, plans)
			return b
		}
	}
	t.Fatal("no such sql_id")
	return nil
}

func TestPlanEndpointErrors(t *testing.T) {
	e := newLineEnv(t, []string{traces + "plan_change.trc"})
	m := e.full
	var withPlan model.ID = model.None
	for i := range m.Statements {
		if len(report.PlansOf(m, model.ID(i))) > 0 {
			withPlan = model.ID(i)
			break
		}
	}
	if withPlan == model.None {
		t.Fatal("no plan")
	}
	for _, tc := range []struct {
		q    string
		code int
	}{
		{"/api/plan", 400},
		{"/api/plan?stmt=x", 400},
		{"/api/plan?stmt=-1", 400},
		{fmt.Sprintf("/api/plan?stmt=%d", len(m.Statements)), 400},
		{fmt.Sprintf("/api/plan?stmt=%d&sql_id=%s", withPlan, m.Statements[withPlan].SQLID), 400},
		{fmt.Sprintf("/api/plan?stmt=%d&plh=abc", withPlan), 400},
		{fmt.Sprintf("/api/plan?stmt=%d&plh=-1", withPlan), 400},
		{fmt.Sprintf("/api/plan?stmt=%d&exec=x", withPlan), 400},
		{fmt.Sprintf("/api/plan?stmt=%d&exec=-1", withPlan), 400},
		{"/api/plan?sql_id=nosuchsqlid", 404},
		{fmt.Sprintf("/api/plan?stmt=%d&plh=1", withPlan), 404},
		{fmt.Sprintf("/api/plan?stmt=%d&exec=999", withPlan), 404},
	} {
		if code, b := e.both(t, tc.q); code != tc.code {
			t.Errorf("%s: %d %s, want %d", tc.q, code, b, tc.code)
		}
	}
}
