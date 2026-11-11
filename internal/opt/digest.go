package opt

import (
	"bufio"
	"fmt"
	"io"
	"sort"
	"strings"
)

// TextOptions shape the text digest.
type TextOptions struct {
	// DropBinds leaves the bind values and the bind sections out (-binds none).
	DropBinds bool
	// RedactBind, when set, replaces every bind value by its result (-redact-binds); nil keeps the values.
	// Literals inside the SQL text and the predicates stay.
	RedactBind func(typ, value string) string
}

// FileLines opens the file at path and returns a line function over it (line n, 1-based, without its
// terminator) and the function that closes it.
func FileLines(path string) (func(n int) (string, bool), func() error, error) {
	r, err := OpenLines(path)
	if err != nil {
		return nil, nil, err
	}
	return r.Line, r.Close, nil
}

const digestWidth = 120

// WriteDigest writes the text digest of a scanned file: the file header and every dump. line gives the text
// of a line by number (it may be nil: the plan table is then rebuilt from the model).
func WriteDigest(w io.Writer, s *Scan, line func(n int) (string, bool), o TextOptions) error {
	bw := bufio.NewWriter(w)
	f := &s.File
	p := func(format string, a ...any) { fmt.Fprintf(bw, format, a...) }
	p("mtkprof - Oracle optimizer trace (event 10053) digest\n")
	p("%s\n", strings.Repeat("=", digestWidth))
	p("Trace file : %s\n", dash(f.Name))
	p("Database   : %s  version %s\n", dash(f.Release), dash(f.Version))
	p("Volume     : %s lines  %d %s\n", commas(f.Lines), len(s.Dumps), map[bool]string{true: "dump", false: "dumps"}[len(s.Dumps) == 1])
	var notes []string
	if !f.Tested && len(s.Dumps) > 0 {
		v := f.Version
		if v == "" {
			v = "of an unknown version"
		}
		notes = append(notes, "read with the 19c rules; this file is "+v)
	}
	if f.Records10046 > 0 && len(s.Dumps) > 0 {
		notes = append(notes, fmt.Sprintf("%s 10046 records are interleaved with the dumps; they are left out of the dumps below", commas(f.Records10046)))
	}
	if len(s.Dumps) == 0 {
		notes = append(notes, "no optimizer dump in this file")
	}
	if o.DropBinds {
		notes = append(notes, "bind values dropped")
	} else if o.RedactBind != nil {
		notes = append(notes, "bind values redacted")
	}
	if len(notes) > 0 {
		p("Notes      : %s\n", strings.Join(notes, "; "))
	}
	if len(s.Dumps) > 0 {
		p("\nDumps\n")
		for _, d := range s.Dumps {
			tr := ""
			if d.Truncated {
				tr = "  (truncated)"
			}
			p("  %2d  %-14s  lines %s-%s  runs %d  %s%s\n", d.Idx+1, dash(d.SQLID), commas(d.From), commas(d.End), d.RunCount, strings.Join(d.Tables, ", "), tr)
		}
	}
	p("\n")
	if err := bw.Flush(); err != nil {
		return err
	}
	for _, d := range s.Dumps {
		if err := d.WriteText(w, line, o); err != nil {
			return err
		}
	}
	return nil
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func commas(n int) string {
	s := fmt.Sprint(n)
	if n < 0 || len(s) <= 3 {
		return s
	}
	var b strings.Builder
	pre := len(s) % 3
	if pre > 0 {
		b.WriteString(s[:pre])
	}
	for i := pre; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

var lmOrder = []struct{ kind, title string }{
	{LMBestAP, "Best:: AccessPath (the access path kept for a table)"},
	{LMBestJM, "Best:: JoinMethod (the join method kept for a join step)"},
	{LMFinalCost, "Final cost for query block (the end of a costing run)"},
	{LMAborted, "Join order aborted"},
	{LMVerdict, "Verdicts of the cost-based transformations"},
	{LMHintError, "Hints with an error"},
	{LMRefused, "Transformations and checks the trace says were bypassed or refused"},
}

// WriteText writes the text digest of the dump: what the trace says, without its noise and without
// computing anything from the costs. line gives the text of a line by number; with a nil line the plan table
// is rebuilt from the model.
func (d *Dump) WriteText(w io.Writer, line func(n int) (string, bool), o TextOptions) error {
	bw := bufio.NewWriter(w)
	p := func(format string, a ...any) { fmt.Fprintf(bw, format, a...) }
	rule := func(c string) { p("%s\n", strings.Repeat(c, digestWidth)) }
	section := func(title string) {
		p("\n%s\n", title)
		rule("-")
	}

	rule("=")
	tr := ""
	if d.Truncated {
		tr = "   TRUNCATED: the file ends before the END line"
	}
	p("OPTIMIZER DUMP %d   sql_id %s   dump %d of this sql_id   plan hash %s   lines %s-%s%s\n",
		d.Idx+1, dash(d.SQLID), d.Nth, dash(d.PlanHash), commas(d.From), commas(d.End), tr)
	p("view lines %s-%s (%s lines)   costing runs %d   tables %s\n", commas(d.ViewFrom), commas(d.ViewTo), commas(d.LineCount), d.RunCount, dash(strings.Join(d.Tables, ", ")))
	if d.Unplaced > 0 {
		p("%s lines of the dump are in no known section\n", commas(d.Unplaced))
	}
	rule("-")

	section(fmt.Sprintf("SQL as typed (lines %d-%d)", d.StmtLine, d.StmtTo))
	if strings.TrimSpace(d.StmtText) == "" {
		p("(not found)\n")
	} else {
		p("%s\n", strings.TrimRight(d.StmtText, "\n"))
	}

	section("Altered parameters and fix controls")
	var alt, optp []Param
	for _, a := range d.Altered {
		if a.From == "opt_param" {
			optp = append(optp, a)
		} else {
			alt = append(alt, a)
		}
	}
	if len(alt) == 0 && len(optp) == 0 {
		p("none\n")
	}
	for _, a := range alt {
		p("  %-40s = %-24s (line %d)\n", a.Name, a.Value, a.Line)
	}
	for _, a := range optp {
		p("  OPT_PARAM %-30s = %-24s (line %d)\n", a.Name, a.Value, a.Line)
	}

	section("Peeked binds")
	switch {
	case len(d.Binds) == 0:
		p("none\n")
	case o.DropBinds:
		p("%d binds; values left out (-binds none)\n", len(d.Binds))
	default:
		for _, b := range d.Binds {
			v := b.Value
			switch {
			case b.Dup != 0:
				p("  :%d %s = (the same bind as :%d)\n", b.Pos, dash(b.Type), b.Dup)
				continue
			case b.Line == 0:
				p("  :%d %s = (no value printed)\n", b.Pos, dash(b.Type))
				continue
			}
			if o.RedactBind != nil {
				v = o.RedactBind(b.Type, b.Value)
			}
			p("  :%d %s = %s   (line %d)\n", b.Pos, dash(b.Type), v, b.Line)
		}
	}

	section("Outline (lines from-to, line count)")
	p("%8s %8s %8s  %s\n", "from", "to", "lines", "section")
	var out func(n *Node, depth int)
	out = func(n *Node, depth int) {
		if n.Kind != KindDump {
			p("%8d %8d %8d  %s%s\n", n.From, n.To, n.To-n.From+1, strings.Repeat("  ", depth-1), nodeText(n))
		}
		for _, c := range n.Children {
			out(c, depth+1)
		}
	}
	if d.Tree != nil {
		out(d.Tree, 0)
	}

	section("Landmark lines (verbatim, with their line numbers)")
	byKind := map[string][]Landmark{}
	for _, l := range d.Landmarks {
		byKind[l.Kind] = append(byKind[l.Kind], l)
	}
	for _, k := range lmOrder {
		ls := byKind[k.kind]
		if len(ls) == 0 {
			continue
		}
		p("%s: %d\n", k.title, len(ls))
		for _, l := range ls {
			p("%8d  %s\n", l.Line, l.Text)
		}
		p("\n")
	}
	if len(d.Landmarks) == 0 {
		p("none\n")
	}

	section("Versions of the transformed SQL (UNPARSED QUERY IS)")
	if len(d.SQL) == 0 {
		p("none\n")
	}
	for _, v := range d.SQL {
		if v.SameAs != 0 {
			p("[%d] line %d  %s: the same statement as line %d\n\n", v.N, v.Line, v.Label, v.SameAs)
			continue
		}
		ch := ""
		if v.Prev != 0 {
			ch = fmt.Sprintf("   (previous statement: line %d)", v.Prev)
		}
		p("[%d] line %d  %s%s\n", v.N, v.Line, v.Label, ch)
		for _, l := range FormatSQLLines(v.Text) {
			p("    %s\n", l)
		}
		p("\n")
	}

	section("Final plan")
	d.writePlan(bw, line)

	section("Hints")
	var report []Hint
	n := 0
	for _, h := range d.Hints {
		if h.Src == "report" {
			report = append(report, h)
			continue
		}
		if n == 0 {
			p("Dumping Hints: line, err, used, hint\n")
		}
		n++
		p("%8d  err=%d used=%d  %s\n", h.Line, h.Err, h.Used, h.Text)
	}
	if len(report) > 0 {
		if n > 0 {
			p("\n")
		}
		p("Hint Report\n")
		for _, h := range report {
			// the line as the trace prints it, and the reason it gives under an Unused or Syntax Error line
			note := ""
			if _, reason, ok := strings.Cut(h.Note, ": "); ok {
				note = "   [reason: " + reason + "]"
			}
			p("%8d  %s%s\n", h.Line, h.Text, note)
		}
	}
	if n == 0 && len(report) == 0 {
		p("none\n")
	}
	p("\n")
	return bw.Flush()
}

// nodeText is a node's row of the text outline: its label, what it says, its verdict.
func nodeText(n *Node) string {
	var b strings.Builder
	b.WriteString(n.Label)
	switch n.Kind {
	case KindRun:
		if n.Final {
			b.WriteString("  [final plan]")
		}
		if n.SameAs != 0 {
			fmt.Fprintf(&b, "  [same as run %d]", n.SameAs)
		}
		if n.BestJo != 0 {
			fmt.Fprintf(&b, "  best join order %d", n.BestJo)
		}
		if n.Verdict != nil {
			fmt.Fprintf(&b, "  [%s]", n.Verdict.Text)
		}
		if n.IterLabel != "" {
			fmt.Fprintf(&b, "  in %s", n.IterLabel)
		}
		return b.String()
	case KindIteration:
		if n.Verdict != nil {
			fmt.Fprintf(&b, "  [%s]", n.Verdict.Text)
		}
		return b.String()
	}
	if n.Result != "" {
		b.WriteString("  -> " + n.Result)
	}
	if n.IsBest {
		b.WriteString("  [best join order]")
	}
	return b.String()
}

func (d *Dump) writePlan(bw *bufio.Writer, line func(n int) (string, bool)) {
	p := func(format string, a ...any) { fmt.Fprintf(bw, format, a...) }
	pl := d.Plan
	if pl == nil {
		p("none\n")
		return
	}
	p("lines %d-%d\n", pl.From, pl.To)
	if line != nil {
		ok := true
		var rows []string
		for i := pl.From; i <= pl.To; i++ {
			s, found := line(i)
			if !found {
				ok = false
				break
			}
			rows = append(rows, s)
		}
		if ok {
			for _, s := range rows {
				p("%s\n", s)
			}
			return
		}
	}
	// rebuilt from the model
	extra := func(vals []string) string {
		var b strings.Builder
		for _, v := range vals {
			fmt.Fprintf(&b, " %-10s", v)
		}
		return strings.TrimRight(b.String(), " ")
	}
	var xh []string
	if len(pl.Cols) > planStdCols {
		xh = pl.Cols[planStdCols:]
	}
	p("%4s  %-50s %-30s %8s %8s %8s %9s%s\n", "Id", "Operation", "Name", "Rows", "Bytes", "Cost", "Time", extra(xh))
	for _, r := range pl.Rows {
		p("%4d  %-50s %-30s %8s %8s %8s %9s%s\n", r.ID, strings.Repeat(" ", r.Depth)+r.Op, r.Name, r.Rows, r.Bytes, r.Cost, r.Time, extra(r.Extra))
	}
	ids := map[int]bool{}
	for id := range pl.QBs {
		ids[id] = true
	}
	for id := range pl.Preds {
		ids[id] = true
	}
	var order []int
	for id := range ids {
		order = append(order, id)
	}
	sort.Ints(order)
	if len(pl.QBs) > 0 {
		p("\nQuery Block Name / Object Alias (identified by operation id):\n")
		var qb []int
		for id := range pl.QBs {
			qb = append(qb, id)
		}
		sort.Ints(qb)
		for _, id := range qb {
			q := pl.QBs[id]
			a := ""
			if q.Alias != "" {
				a = " / " + q.Alias
			}
			p("%3d - %s%s\n", id, q.QB, a)
		}
	}
	if len(pl.Preds) > 0 {
		p("\nPredicate Information:\n")
		for _, id := range order {
			for _, pr := range pl.Preds[id] {
				p("%3d - %s\n", id, pr.Text)
			}
		}
	}
}
