package report

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// The low-memory build (Options.NoFacts) drops bind values and nothing else:
// aggregations, findings and the text report agree with the full build except
// on the lines that show binds.
func TestNoFactsKeepsNumbers(t *testing.T) {
	for _, fx := range []string{"basic_binds.trc", "io_waits.trc", "plsql_recursive.trc"} {
		full := buildFixture(t, fx)
		low, err := model.Build("../../testdata/traces/19c/"+fx, model.Options{NoFacts: true})
		if err != nil {
			t.Fatal(err)
		}
		if len(low.Binds) != 0 || len(low.BindSets) != 0 || low.Diag.BindMode != "none" {
			t.Errorf("%s: binds retained: %d binds, %d sets, mode %q", fx, len(low.Binds), len(low.BindSets), low.Diag.BindMode)
		}
		sf, sl := analyze.Statements(full), analyze.Statements(low)
		for i := range sf { // bind sets are not part of the statistics
			if !reflect.DeepEqual(sf[i], sl[i]) {
				t.Errorf("%s: statement %d stats differ", fx, i)
			}
		}
		if !reflect.DeepEqual(analyze.TraceProfile(full), analyze.TraceProfile(low)) {
			t.Errorf("%s: profile differs", fx)
		}
		var a, b bytes.Buffer
		if err := Text(&a, full, TextOptions{Execs: 20, Binds: 0, Sys: true}); err != nil {
			t.Fatal(err)
		}
		if err := Text(&b, low, TextOptions{Execs: 20, Binds: 0, Sys: true}); err != nil {
			t.Fatal(err)
		}
		la, lb := strings.Split(a.String(), "\n"), strings.Split(b.String(), "\n")
		if len(la) != len(lb) {
			t.Fatalf("%s: report has %d lines, low-memory report %d", fx, len(la), len(lb))
		}
		for i := range la {
			if la[i] != lb[i] && !strings.Contains(lb[i], "bind") && !strings.Contains(la[i], "bind") && !isExecRow(la[i]) {
				t.Errorf("%s: line %d differs:\n  %s\n  %s", fx, i, la[i], lb[i])
			}
		}
	}
}

// isExecRow: executions table rows end in the bind preview, which low-memory mode empties.
func isExecRow(l string) bool { return strings.Contains(l, " :0=") || strings.Contains(l, " :1=") }
