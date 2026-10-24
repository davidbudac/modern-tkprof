package report

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// CompareOptions control the text comparison report.
type CompareOptions struct {
	Top   int // rows per table (changed statements, new/missing, events); 0 = 30
	Width int
}

// CompareText writes the comparison of two traces (B against A).
func CompareText(out io.Writer, a, b *model.Model, c analyze.Comparison, o CompareOptions) error {
	if o.Top <= 0 {
		o.Top = 30
	}
	if o.Width < 80 {
		o.Width = 120
	}
	t := &cmpWriter{w: bufio.NewWriter(out), o: o}
	t.header(a, b, c)
	t.totals(c)
	t.profile(c, o.Top)
	t.statements(c, o.Top)
	t.unmatched("NEW STATEMENTS (only in B)", c.OnlyB(), o.Top)
	t.unmatched("MISSING STATEMENTS (only in A)", c.OnlyA(), o.Top)
	t.events(c, o.Top)
	return t.w.Flush()
}

type cmpWriter struct {
	w *bufio.Writer
	o CompareOptions
}

func (t *cmpWriter) p(format string, a ...any) { fmt.Fprintf(t.w, format, a...) }
func (t *cmpWriter) nl()                       { t.w.WriteByte('\n') }
func (t *cmpWriter) rule(c byte) {
	t.w.WriteString(strings.Repeat(string(c), t.o.Width))
	t.nl()
}

// sdelta is a signed seconds value, "+1.234" / "-0.500" / "0.000".
func sdelta(us int64) string {
	if us > -500 && us < 500 {
		return "0.000"
	}
	return fmt.Sprintf("%+.3f", float64(us)/1e6)
}

// cdelta is a signed count with thousands separators.
func cdelta(n int64) string {
	if n > 0 {
		return "+" + commas(n)
	}
	return commas(n)
}

// pctDelta is the relative change, "new" when A is zero and B is not.
func pctDelta(a, b int64) string {
	if p, ok := analyze.PctChange(a, b); ok {
		if p == 0 {
			return "0.0%"
		}
		return fmt.Sprintf("%+.1f%%", p)
	}
	if b != 0 {
		return "new"
	}
	return "-"
}

func (t *cmpWriter) header(a, b *model.Model, c analyze.Comparison) {
	t.p("mtkprof %s - trace comparison (B against A)\n", Version)
	t.rule('=')
	for _, s := range []struct {
		tag string
		m   *model.Model
		i   analyze.SideInfo
	}{{"A", a, c.A}, {"B", b, c.B}} {
		t.p("%s: %s\n", s.tag, dash(s.m.File.TraceFile))
		t.p("   Oracle %s  instance %s  span %s s  %s lines  %s statements  %s calls  %s waits\n", dash(s.m.File.Version), dash(s.m.File.Instance), secs(s.i.SpanUs),
			commas(int64(s.m.Diag.Lines)), commas(int64(len(s.m.Statements))), commas(int64(len(s.m.Calls))), commas(int64(len(s.m.Waits))))
	}
	t.p("Statements are matched by sql_id (statements without one by kind and normalised text); wait events by name.\n")
	t.p("Δ = B - A; Δ%% is relative to A. Statement elapsed includes recursive children, not think time.\n")
	t.nl()
}

func (t *cmpWriter) totals(c analyze.Comparison) {
	t.p("TOTALS\n")
	t.rule('-')
	t.p("%-26s %16s %16s %16s %9s\n", "", "A", "B", "Δ", "Δ%")
	for _, m := range c.Totals {
		if m.Unit == "us" {
			t.p("%-26s %14s s %14s s %16s %9s\n", m.Label, secs(m.A), secs(m.B), sdelta(m.Delta), pctDelta(m.A, m.B))
		} else {
			t.p("%-26s %16s %16s %16s %9s\n", m.Label, commas(m.A), commas(m.B), cdelta(m.Delta), pctDelta(m.A, m.B))
		}
	}
	var classes []analyze.Metric
	for _, m := range c.Classes {
		if m.A != 0 || m.B != 0 {
			classes = append(classes, m)
		}
	}
	if len(classes) > 0 {
		t.nl()
		t.p("Wait time by class\n")
		for _, m := range classes {
			t.p("  %-24s %14s s %14s s %16s %9s\n", m.Label, secs(m.A), secs(m.B), sdelta(m.Delta), pctDelta(m.A, m.B))
		}
	}
	t.nl()
}

func (t *cmpWriter) profile(c analyze.Comparison, top int) {
	t.p("RESOURCE PROFILE - side by side (ranked by |Δ|)\n")
	t.rule('-')
	t.p("%-44s %11s %7s %11s %7s %11s %9s\n", "Component", "A s", "A %", "B s", "B %", "Δ s", "Δ%")
	n := 0
	for _, r := range c.Profile {
		if r.AUs == 0 && r.BUs == 0 {
			continue
		}
		if n == top {
			t.p("... %d more components\n", countProfile(c)-n)
			break
		}
		n++
		name := r.Component
		if r.Kind == "idle" {
			name += " (idle)"
		}
		if len(name) > 44 {
			name = name[:41] + "..."
		}
		t.p("%-44s %11s %6.1f%% %11s %6.1f%% %11s %9s\n", name, secs(r.AUs), r.APct, secs(r.BUs), r.BPct, sdelta(r.DeltaUs), pctDelta(r.AUs, r.BUs))
	}
	t.nl()
}

func countProfile(c analyze.Comparison) int {
	n := 0
	for _, r := range c.Profile {
		if r.AUs != 0 || r.BUs != 0 {
			n++
		}
	}
	return n
}

func sqlLabel(d analyze.StmtDelta) string {
	if d.SQLID != "" {
		return d.SQLID
	}
	return "(" + d.Kind.String() + ")"
}

func (t *cmpWriter) statements(c analyze.Comparison, top int) {
	matched := c.Matched()
	t.p("TOP CHANGED STATEMENTS - in both traces (%d), ranked by |Δ elapsed|\n", len(matched))
	t.rule('-')
	t.p("%4s %-13s %10s %10s %10s %8s %11s %11s %11s %11s  %-4s %s\n", "#", "SQL ID", "A ela s", "B ela s", "Δ s", "Δ%", "execs A", "execs B", "/exec A ms", "/exec B ms", "plan", "Statement")
	textW := t.o.Width - 125
	if textW < 20 {
		textW = 20
	}
	for i, d := range matched {
		if i == top {
			t.p("... %d more\n", len(matched)-i)
			break
		}
		plan := ""
		if d.PlanChanged {
			plan = "PLAN"
		}
		t.p("%4d %-13s %10s %10s %10s %8s %11s %11s %11s %11s  %-4s %s\n", i+1, sqlLabel(d), secs(d.A.Elapsed), secs(d.B.Elapsed), sdelta(d.DElapsed), pctDelta(d.A.Elapsed, d.B.Elapsed),
			commas(d.A.Executions), commas(d.B.Executions), perExec(d.A), perExec(d.B), plan, preview(d.Text, textW))
	}
	t.nl()
}

func perExec(s *analyze.StmtSide) string {
	if s == nil || s.Executions == 0 {
		return "-"
	}
	return ms(float64(s.PerExecUs))
}

func (t *cmpWriter) unmatched(title string, list []analyze.StmtDelta, top int) {
	t.p("%s: %d\n", title, len(list))
	if len(list) == 0 {
		t.nl()
		return
	}
	t.rule('-')
	t.p("%4s %-13s %10s %9s %11s %9s  %s\n", "#", "SQL ID", "Elapsed s", "Execs", "Rows", "Disk", "Statement")
	textW := t.o.Width - 62
	if textW < 20 {
		textW = 20
	}
	// ranked by size of the elapsed time, which is |Δ| for these
	for i, d := range list {
		if i == top {
			t.p("... %d more\n", len(list)-i)
			break
		}
		s := d.A
		if s == nil {
			s = d.B
		}
		t.p("%4d %-13s %10s %9s %11s %9s  %s\n", i+1, sqlLabel(d), secs(s.Elapsed), commas(s.Executions), commas(s.Rows), commas(s.Disk), preview(d.Text, textW))
	}
	t.nl()
}

func (t *cmpWriter) events(c analyze.Comparison, top int) {
	t.p("WAIT EVENTS - ranked by |Δ time|\n")
	t.rule('-')
	t.p("%-44s %11s %11s %11s %9s %10s %10s  %s\n", "Event", "A s", "B s", "Δ s", "Δ%", "A count", "B count", "Class")
	for i, e := range c.Events {
		if i == top {
			t.p("... %d more events\n", len(c.Events)-i)
			break
		}
		name := e.Name
		if e.Idle {
			name += " (idle)"
		}
		if len(name) > 44 {
			name = name[:41] + "..."
		}
		t.p("%-44s %11s %11s %11s %9s %10s %10s  %s\n", name, secs(e.A.Us), secs(e.B.Us), sdelta(e.DeltaUs), pctDelta(e.A.Us, e.B.Us), commas(e.A.Count), commas(e.B.Count), e.Class)
	}
	t.nl()
}
