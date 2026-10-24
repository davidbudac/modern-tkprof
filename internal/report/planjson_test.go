package report

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

func buildFixture(t *testing.T, name string) *model.Model {
	t.Helper()
	m, err := model.Build("../../testdata/traces/19c/"+name, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// twoHashStmt finds the statement of plan_change.trc with several plan hashes.
func twoHashStmt(t *testing.T, m *model.Model) model.ID {
	t.Helper()
	for i := range m.Statements {
		if len(LatestPlans(m, model.ID(i))) > 1 {
			return model.ID(i)
		}
	}
	t.Fatal("no statement with more than one plan hash")
	return model.None
}

func TestPlanRowsPlanChange(t *testing.T) {
	m := buildFixture(t, "plan_change.trc")
	sid := twoHashStmt(t, m)
	st := m.Statements[sid]
	latest := LatestPlans(m, sid)
	all := PlansOf(m, sid)
	if len(all) <= len(latest) {
		t.Fatalf("expected repeated dumps: %d dumps, %d hashes", len(all), len(latest))
	}
	seen := map[uint64]bool{}
	for _, p := range latest {
		if seen[p.PLH] {
			t.Errorf("hash %d returned twice by LatestPlans", p.PLH)
		}
		seen[p.PLH] = true
		// latest = the last dump of that hash
		for _, q := range all {
			if q.PLH == p.PLH && q.Line > p.Line {
				t.Errorf("LatestPlans(%d) is line %d, but line %d is later", p.PLH, p.Line, q.Line)
			}
		}
		rows := PlanRows(m, p)
		if len(rows) != int(p.N) || len(rows) == 0 {
			t.Fatalf("rows %d, want %d", len(rows), p.N)
		}
		lines := m.PlanLines[p.First : p.First+p.N]
		for i, r := range rows {
			l := lines[i]
			if r.ID != l.ID || r.Operation != l.Op || r.Depth != l.Depth {
				t.Errorf("row %d: %+v does not match STAT line %+v", i, r, l)
			}
			if r.SQLID != st.SQLID || r.PlanHashValue != strconv.FormatUint(p.PLH, 10) {
				t.Errorf("row %d lacks sql_id/plan_hash_value: %q %q", i, r.SQLID, r.PlanHashValue)
			}
			if r.ActualRows == nil || *r.ActualRows != l.Cnt || *r.Starts != l.Str || *r.CRBufferGets != l.CR ||
				*r.ActualElapsedUs != l.TimeUs || *r.PhysicalReads != l.PR || *r.PhysicalWrites != l.PW {
				t.Errorf("row %d actuals differ from STAT line", i)
			}
			if (r.Cost == nil) != (l.Cost < 0) {
				t.Errorf("row %d cost presence %v vs STAT cost %d", i, r.Cost, l.Cost)
			}
			if i > 0 && (r.SQLText != "" || r.Execution != 0 || r.TraceLine != 0) {
				t.Errorf("row %d carries first-row-only fields", i)
			}
		}
		if rows[0].ParentID != nil {
			t.Errorf("root parent_id = %d, want null", *rows[0].ParentID)
		}
		for _, r := range rows[1:] {
			if r.ParentID == nil {
				t.Errorf("row %d has no parent_id", r.ID)
			}
		}
		if rows[0].SQLText != st.Text || rows[0].TraceLine != p.Line {
			t.Errorf("first row sql_text/trace_line wrong: %q %d", rows[0].SQLText, rows[0].TraceLine)
		}
		// 1-based ordinal among dumps of the same hash
		want := 0
		for _, q := range all {
			if q.PLH == p.PLH {
				want++
			}
		}
		if rows[0].Execution != want {
			t.Errorf("execution = %d, want %d (latest of the hash)", rows[0].Execution, want)
		}
		if first := PlanRows(m, firstOfHash(all, p.PLH)); first[0].Execution != 1 {
			t.Errorf("first dump execution = %d, want 1", first[0].Execution)
		}
	}

	// what the visualizer's canParse checks, plus the keys it reads
	js, err := PlanJSON(m, latest[0])
	if err != nil {
		t.Fatal(err)
	}
	var arr []map[string]any
	if err := json.Unmarshal(js, &arr); err != nil {
		t.Fatal(err)
	}
	if _, ok := arr[0]["id"]; !ok {
		t.Error("first element lacks id")
	}
	if _, ok := arr[0]["operation"]; !ok {
		t.Error("first element lacks operation")
	}
	if v, ok := arr[0]["parent_id"]; !ok || v != nil {
		t.Errorf("root parent_id = %v (present %v), want explicit null", v, ok)
	}
	if !bytes.HasPrefix(bytes.TrimSpace(js), []byte("[")) || !bytes.HasSuffix(bytes.TrimSpace(js), []byte("]")) {
		t.Error("not a bare JSON array")
	}
}

func firstOfHash(ps []*model.Plan, h uint64) *model.Plan {
	for _, p := range ps {
		if p.PLH == h {
			return p
		}
	}
	return nil
}

func TestPlanRowsObjectsAndEstimates(t *testing.T) {
	m := buildFixture(t, "io_waits.trc")
	var withObj, withCost bool
	for i := range m.Plans {
		for j, r := range PlanRows(m, &m.Plans[i]) {
			l := m.PlanLines[int(m.Plans[i].First)+j]
			if l.Obj > 0 {
				withObj = withObj || (r.ObjectID == l.Obj && r.ObjectName == l.Object)
			} else if r.ObjectID != 0 {
				t.Errorf("object_id set for obj=%d", l.Obj)
			}
			if r.Cost != nil && r.Cardinality != nil && r.Bytes != nil {
				withCost = true
			}
		}
	}
	if !withObj || !withCost {
		t.Errorf("fixture exercised object=%v estimates=%v", withObj, withCost)
	}
}

func TestPlanVizURLRoundTrip(t *testing.T) {
	m := buildFixture(t, "plan_change.trc")
	rows, err := PlanJSON(m, LatestPlans(m, twoHashStmt(t, m))[0])
	if err != nil {
		t.Fatal(err)
	}
	base := "https://example.test/viz/"
	u, err := PlanVizURL(base, rows)
	if err != nil {
		t.Fatal(err)
	}
	enc, ok := strings.CutPrefix(u, base+"#gz=")
	if !ok {
		t.Fatalf("url %.60s... lacks base#gz=", u)
	}
	if strings.ContainsAny(enc, "+/=") {
		t.Error("not base64url without padding")
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Plans []struct {
			RawInput string `json:"rawInput"`
		} `json:"plans"`
		ViewMode string `json:"viewMode"`
	}
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Plans) != 1 || got.Plans[0].RawInput != string(rows) || got.ViewMode != "hierarchical" {
		t.Errorf("payload does not round-trip: %+v", got.ViewMode)
	}
	if u2, _ := PlanVizURL("", rows); !strings.HasPrefix(u2, DefaultPlanVizURL+"#gz=") {
		t.Error("empty base should use the default")
	}
}

func TestPlanVizURLTooBig(t *testing.T) {
	// incompressible input to blow the limit
	b := make([]byte, 200000)
	x := uint32(1)
	for i := range b {
		x = x*1664525 + 1013904223
		b[i] = 'a' + byte(x>>24)%26
	}
	if _, err := PlanVizURL("", b); err == nil || !strings.Contains(err.Error(), "too big") {
		t.Errorf("err = %v, want too big", err)
	}
}
