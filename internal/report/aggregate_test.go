package report

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

func buildAggregate(t *testing.T, files ...string) *model.Model {
	t.Helper()
	m, err := model.BuildFiles(files, model.Options{Aggregate: true, NewSink: func(m *model.Model) model.Sink {
		return analyze.NewAccumulator(m, analyze.DefaultThresholds())
	}})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// The text report of an aggregation-only model is the report of the full
// model (without bind values: both build with NoFacts) minus the executions
// tables, which it says it leaves out. Statement call tables, profiles,
// findings, sessions and time buckets agree to the last digit.
func TestAggregateTextReportEqualsFull(t *testing.T) {
	dir := "../../testdata/traces/19c/"
	for _, fx := range []string{"basic_binds.trc", "io_waits.trc", "plsql_recursive.trc", "multisession.trc", "plan_change.trc", "midtrace_start.trc", "errors.trc", "cursor_cache.trc"} {
		full, err := model.BuildFiles([]string{dir + fx}, model.Options{NoFacts: true})
		if err != nil {
			t.Fatal(err)
		}
		agg := buildAggregate(t, dir+fx)
		o := TextOptions{Sort: "elapsed", Execs: 0, Binds: 0, Sys: true, Width: 120}
		var a, b bytes.Buffer
		if err := Text(&a, full, o); err != nil {
			t.Fatal(err)
		}
		if err := Text(&b, agg, o); err != nil {
			t.Fatal(err)
		}
		la, lb := strings.Split(a.String(), "\n"), strings.Split(b.String(), "\n")
		if len(la) != len(lb) {
			t.Fatalf("%s: report has %d lines, aggregate report %d", fx, len(la), len(lb))
		}
		for i := range la {
			if la[i] != lb[i] && !strings.HasPrefix(la[i], "Notes") {
				t.Errorf("%s: line %d differs:\n  full %s\n  agg  %s", fx, i+1, la[i], lb[i])
			}
		}
		if !strings.Contains(b.String(), "aggregate mode: calls/waits not retained") {
			t.Errorf("%s: the aggregate report does not say what it leaves out", fx)
		}
		if len(agg.Calls) != 0 || len(agg.Waits) != 0 {
			t.Errorf("%s: aggregate model retained %d calls %d waits", fx, len(agg.Calls), len(agg.Waits))
		}
	}
}

// The document of an aggregation-only model carries the same pre-computed
// statistics and no fact tables.
func TestAggregateDocumentStats(t *testing.T) {
	f := "../../testdata/traces/19c/plsql_recursive.trc"
	full, err := model.BuildFiles([]string{f}, model.Options{NoFacts: true})
	if err != nil {
		t.Fatal(err)
	}
	agg := buildAggregate(t, f)
	df, da := BuildDocument(full, DocOptions{}), BuildDocument(agg, DocOptions{Facts: true})
	if da.Facts != nil || df.Facts != nil {
		t.Fatal("the fact tables are not part of this comparison")
	}
	norm := func(d *Document) string {
		d.Stats.Minimap = nil // cell grid vs exact: compared within a tolerance in analyze.TestMinimapFixtures
		for i := range d.Stats.Findings {
			for k := range d.Stats.Findings[i].Evidence {
				d.Stats.Findings[i].Evidence[k].Call = model.None
			}
		}
		b, err := json.Marshal(d.Stats)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	if x, y := norm(df), norm(da); x != y {
		t.Errorf("document statistics differ\nfull %s\nagg  %s", x, y)
	}
	if len(da.Transactions) != len(df.Transactions) || len(da.Statements) != len(df.Statements) {
		t.Errorf("dimensions: %d/%d transactions, %d/%d statements", len(da.Transactions), len(df.Transactions), len(da.Statements), len(df.Statements))
	}
}
