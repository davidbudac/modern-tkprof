package report

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

func buildTrace(t *testing.T, name string) *model.Model {
	t.Helper()
	m, err := model.Build(filepath.Join("..", "..", "testdata", "traces", "19c", name), model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCompareTextSelf(t *testing.T) {
	m := buildTrace(t, "plan_change.trc")
	var buf bytes.Buffer
	if err := CompareText(&buf, m, m, analyze.Compare(m, m), CompareOptions{}); err != nil {
		t.Fatal(err)
	}
	s := buf.String()
	for _, want := range []string{"trace comparison", "TOTALS", "RESOURCE PROFILE", "TOP CHANGED STATEMENTS", "NEW STATEMENTS (only in B): 0", "MISSING STATEMENTS (only in A): 0", "WAIT EVENTS"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(s, "PLAN ") {
		t.Error("a trace compared with itself must not flag plan changes")
	}
	if strings.ContainsAny(s, "+") {
		t.Error("signed (non-zero) delta in a self comparison")
	}
}

func TestCompareTextFixtures(t *testing.T) {
	a, b := buildTrace(t, "io_waits.trc"), buildTrace(t, "level_8.trc")
	var buf bytes.Buffer
	if err := CompareText(&buf, a, b, analyze.Compare(a, b), CompareOptions{Top: 5}); err != nil {
		t.Fatal(err)
	}
	s := buf.String()
	if !strings.Contains(s, "NEW STATEMENTS (only in B): 10") || !strings.Contains(s, "MISSING STATEMENTS (only in A): 23") {
		t.Errorf("unmatched counts:\n%s", s)
	}
	if !strings.Contains(s, "... ") {
		t.Error("Top 5 should truncate a table")
	}
}
