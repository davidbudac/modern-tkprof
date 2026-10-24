package report

import (
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// findings prints the FINDINGS section. It must run after ranking(), which
// fills t.rank.
func (t *textWriter) findings() {
	th := analyze.DefaultThresholds()
	if t.o.Thresholds != nil {
		th = *t.o.Thresholds
	}
	var ex [][]analyze.Execution
	if !t.m.Aggregate {
		ex = t.allExecs()
	}
	fs := analyze.FindingsExec(t.m, t.stats, th, ex)
	t.p("FINDINGS  (thresholds, see docs/ARCHITECTURE.md; serious > notable > info)\n")
	t.rule('-')
	if len(fs) == 0 {
		t.p("none: no rule reached its threshold\n\n")
		return
	}
	for i, f := range fs {
		if i > 0 {
			t.nl()
		}
		t.p("%2d. %-8s %s", i+1, strings.ToUpper(f.Severity), f.Title)
		if f.Statement != model.None {
			t.p("   %s", t.stmtRef(f.Statement))
		}
		t.nl()
		t.p("    %s\n", f.Summary)
		for _, r := range f.Evidence {
			label := r.Label
			if r.Statement != model.None && r.Statement != f.Statement {
				label = t.stmtRef(r.Statement)
				if r.Label != "" && r.Label != t.sqlID(&t.m.Statements[r.Statement]) {
					label += " " + r.Label
				}
			}
			t.p("      %-34s %s\n", label, r.Value)
		}
	}
	t.nl()
}

// stmtRef is "#rank sql_id" ("#-" when the statement is not in the listing).
func (t *textWriter) stmtRef(sid model.ID) string {
	return "#" + rankStr(t.rank[sid]) + " " + t.sqlID(&t.m.Statements[sid])
}
