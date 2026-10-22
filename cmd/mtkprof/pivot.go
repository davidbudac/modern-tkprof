package main

import (
	"bufio"
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

const pivotHelp = `Usage: mtkprof pivot <trace.trc> [-fact calls|waits] [-by dim[,dim]] [-measure m[,m]]
                     [-sort m] [-top N] [-window start,end] [-context id,...] [-idle=false] [-csv] [-o file]

Groups the call or wait facts by one or more dimensions, like the UI Pivot view.
  -by '?'          list the dimensions and measures (quote the ? for the shell)
  -window a,b      keep facts whose [start, end] overlaps the window; each side is
                   either a wall-clock time HH:MM:SS[.fff] (or YYYY-MM-DDTHH:MM:SS[.fff])
                   in the trace's time zone, or seconds from the trace start (12.5);
                   either side may be empty: -window 10:15:00, or -window ,30
  -context ids     session context ids (the # column of the report's SESSIONS section)
Text output prints times in seconds (sums) or milliseconds (avg/min/max);
CSV output prints times in raw microseconds (columns *_us).

Flags:
`

func cmdPivot(args []string) error {
	fs := flag.NewFlagSet("pivot", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, pivotHelp)
		fs.PrintDefaults()
	}
	factS := fs.String("fact", "calls", "fact table: calls|waits")
	byS := fs.String("by", "", "dimensions, comma separated (default stmt for calls, event for waits; '?' lists them)")
	measS := fs.String("measure", "", "measures to print, comma separated (default all)")
	sortS := fs.String("sort", "", "measure to sort by, descending (default: first -measure, else e / ela)")
	top := fs.Int("top", 0, "print only the first N groups (0 = all)")
	window := fs.String("window", "", "time window start,end (wall clock HH:MM:SS[.fff] or seconds from trace start)")
	ctxS := fs.String("context", "", "session context ids, comma separated")
	idle := fs.Bool("idle", true, "waits: include events of the Idle wait class")
	asCSV := fs.Bool("csv", false, "write CSV instead of a text table")
	out := fs.String("o", "", "output file (default stdout)")
	if wantsDimList(args) {
		f, _ := analyze.ParseFact(flagValue(args, "fact"))
		printDims(os.Stdout, f, flagValue(args, "fact") == "")
		return nil
	}
	file := parseArgs(fs, args)
	fact, err := analyze.ParseFact(*factS)
	if err != nil {
		return err
	}
	by := splitList(*byS)
	if len(by) == 0 {
		by = []string{map[analyze.Fact]string{analyze.FactCalls: "stmt", analyze.FactWaits: "event"}[fact]}
	}
	measures := splitList(*measS)
	for _, ms := range measures {
		if analyze.MeasureIndex(fact, ms) < 0 {
			return fmt.Errorf("unknown %s measure %q (try -by '?')", fact, ms)
		}
	}
	sortM := *sortS
	if sortM == "" {
		sortM = analyze.DefaultMeasure(fact)
		if len(measures) > 0 {
			sortM = measures[0]
		}
	}
	m, err := buildModel(file)
	if err != nil {
		return err
	}
	f := analyze.Filter{IncludeIdle: *idle}
	if *window != "" {
		if f.StartTim, f.EndTim, err = parseWindow(m, *window); err != nil {
			return err
		}
	}
	for _, s := range splitList(*ctxS) {
		id, err := strconv.Atoi(s)
		if err != nil || id < 0 || id >= len(m.Contexts) {
			return fmt.Errorf("bad context id %q (the trace has contexts 0..%d)", s, len(m.Contexts)-1)
		}
		f.Contexts = append(f.Contexts, model.ID(id))
	}
	r, err := analyze.Pivot(m, fact, by, f)
	if err != nil {
		return err
	}
	if err := r.SortBy(sortM); err != nil {
		return err
	}
	cols := measureCols(fact, measures)
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	if *asCSV {
		return writePivotCSV(w, r, cols, *top)
	}
	return writePivotText(w, m, r, cols, *top, f, sortM)
}

// wantsDimList reports whether -by asks for the dimension list.
func wantsDimList(args []string) bool {
	v := flagValue(args, "by")
	return v == "?" || v == "list" || v == "help"
}

// flagValue finds -name v / -name=v (or --name) in args without parsing.
func flagValue(args []string, name string) string {
	for i, a := range args {
		if !strings.HasPrefix(a, "-") {
			continue
		}
		a = strings.TrimPrefix(strings.TrimPrefix(a, "-"), "-")
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(a, name+"=") {
			return a[len(name)+1:]
		}
	}
	return ""
}

func printDims(w io.Writer, f analyze.Fact, both bool) {
	facts := []analyze.Fact{f}
	if both {
		facts = []analyze.Fact{analyze.FactCalls, analyze.FactWaits}
	}
	for _, f := range facts {
		fmt.Fprintf(w, "-fact %s\n  dimensions (-by):\n", f)
		for _, d := range analyze.Dims(f) {
			fmt.Fprintf(w, "    %-10s %s\n", d.ID, d.Label)
		}
		fmt.Fprintf(w, "  measures (-measure, -sort):\n")
		for _, m := range analyze.Measures(f) {
			unit := map[string]string{"us": "time", "%": "percent", "": "count"}[m.Unit]
			t := ""
			if m.Title != "" {
				t = " - " + m.Title
			}
			fmt.Fprintf(w, "    %-10s %s (%s)%s\n", m.ID, m.Label, unit, t)
		}
	}
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseWindow turns "start,end" into a tim range (0 = unbounded).
func parseWindow(m *model.Model, s string) (int64, int64, error) {
	a, b, ok := strings.Cut(s, ",")
	if !ok {
		return 0, 0, fmt.Errorf("-window wants start,end (got %q)", s)
	}
	start, err := windowPoint(m, a)
	if err != nil {
		return 0, 0, err
	}
	end, err := windowPoint(m, b)
	if err != nil {
		return 0, 0, err
	}
	if start != 0 && end != 0 && end < start {
		return 0, 0, fmt.Errorf("-window: end is before start")
	}
	return start, end, nil
}

func windowPoint(m *model.Model, s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	if !strings.Contains(s, ":") {
		sec, err := strconv.ParseFloat(strings.TrimPrefix(s, "+"), 64)
		if err != nil {
			return 0, fmt.Errorf("-window: %q is neither HH:MM:SS nor seconds", s)
		}
		return m.Span.FirstTim + int64(sec*1e6), nil
	}
	if m.Span.FirstWallUs == 0 {
		return 0, fmt.Errorf("-window: the trace has no wall-clock marker; give seconds from the trace start")
	}
	loc := analyze.Zone(m)
	first := time.UnixMicro(m.Span.FirstWallUs).In(loc)
	var t time.Time
	var err error
	if strings.ContainsAny(s, "T ") && strings.Count(s, "-") >= 2 {
		t, err = time.ParseInLocation("2006-01-02T15:04:05.999999", strings.Replace(s, " ", "T", 1), loc)
	} else {
		var c time.Time
		c, err = time.Parse("15:04:05.999999", s)
		if err == nil {
			t = time.Date(first.Year(), first.Month(), first.Day(), c.Hour(), c.Minute(), c.Second(), c.Nanosecond(), loc)
			// a clock time well before the trace start belongs to the next day
			// when the trace runs past midnight
			last := time.UnixMicro(m.Span.LastWallUs).In(loc)
			if t.Before(first.Add(-time.Hour)) && !t.Add(24*time.Hour).After(last.Add(time.Hour)) {
				t = t.Add(24 * time.Hour)
			}
		}
	}
	if err != nil {
		return 0, fmt.Errorf("-window: bad time %q (HH:MM:SS[.fff])", s)
	}
	tim := m.Span.FirstTim + (t.UnixMicro() - m.Span.FirstWallUs)
	if tim == 0 {
		tim = 1
	}
	return tim, nil
}

type pivotCol struct {
	idx int
	m   analyze.Measure
}

func measureCols(f analyze.Fact, ids []string) []pivotCol {
	all := analyze.Measures(f)
	var out []pivotCol
	if len(ids) == 0 {
		for i, m := range all {
			out = append(out, pivotCol{i, m})
		}
		return out
	}
	for _, id := range ids {
		i := analyze.MeasureIndex(f, id)
		out = append(out, pivotCol{i, all[i]})
	}
	return out
}

func (c pivotCol) header() string {
	switch {
	case c.m.Unit == "%":
		return c.m.Label + " %"
	case c.m.Unit == "us" && smallTime(c.m.ID):
		return c.m.Label + " ms"
	case c.m.Unit == "us":
		return c.m.Label + " s"
	}
	return c.m.Label
}

// smallTime: per-event averages and extremes read better in milliseconds.
func smallTime(id string) bool {
	return id == "avg" || id == "min" || id == "max" || id == "avgE" || id == "maxE"
}

func (c pivotCol) format(v float64) string {
	switch {
	case c.m.Unit == "%":
		return fmt.Sprintf("%.1f", v)
	case c.m.Unit == "us" && smallTime(c.m.ID):
		return fmt.Sprintf("%.3f", v/1e3)
	case c.m.Unit == "us":
		return fmt.Sprintf("%.3f", v/1e6)
	}
	return commas(int64(v))
}

func commas(n int64) string {
	s := strconv.FormatInt(n, 10)
	if n < 0 || len(s) <= 3 {
		return s
	}
	var b strings.Builder
	pre := len(s) % 3
	b.WriteString(s[:pre])
	for i := pre; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

func writePivotText(out io.Writer, m *model.Model, r *analyze.PivotResult, cols []pivotCol, top int, f analyze.Filter, sortM string) error {
	w := bufio.NewWriter(out)
	rows := r.Rows
	if top > 0 && len(rows) > top {
		rows = rows[:top]
	}
	// header cells: per dimension the label (+ extra), then the measures
	var head []string
	var left []bool
	for _, d := range r.Dims {
		head, left = append(head, d.Label), append(left, true)
		if d.Extra != "" {
			head, left = append(head, d.Extra), append(left, true)
		}
	}
	nd := len(head)
	for _, c := range cols {
		head, left = append(head, c.header()), append(left, false)
	}
	cells := make([][]string, 0, len(rows)+1)
	for _, row := range rows {
		var line []string
		for j, d := range r.Dims {
			line = append(line, row.Labels[j])
			if d.Extra != "" {
				line = append(line, row.Extra[j])
			}
		}
		for _, c := range cols {
			line = append(line, c.format(row.Values[c.idx]))
		}
		cells = append(cells, line)
	}
	totals := make([]string, nd)
	totals[0] = "total"
	for _, c := range cols {
		totals = append(totals, c.format(r.Total[c.idx]))
	}
	width := make([]int, len(head))
	for _, line := range append(append([][]string{head}, cells...), totals) {
		for i, s := range line {
			if n := len([]rune(s)); n > width[i] {
				width[i] = n
			}
		}
	}
	put := func(line []string) {
		var b strings.Builder
		for i, s := range line {
			if i > 0 {
				b.WriteString("  ")
			}
			pad := strings.Repeat(" ", width[i]-len([]rune(s)))
			if left[i] {
				if i == len(line)-1 {
					pad = ""
				}
				b.WriteString(s + pad)
			} else {
				b.WriteString(pad + s)
			}
		}
		w.WriteString(strings.TrimRight(b.String(), " ") + "\n")
	}
	var scope []string
	if f.StartTim != 0 || f.EndTim != 0 {
		a, b := "start", "end"
		if f.StartTim != 0 {
			a = analyze.TimeLabel(m, f.StartTim)
		}
		if f.EndTim != 0 {
			b = analyze.TimeLabel(m, f.EndTim)
		}
		scope = append(scope, fmt.Sprintf("window %s - %s", a, b))
	}
	if len(f.Contexts) > 0 {
		scope = append(scope, fmt.Sprintf("%d session context(s)", len(f.Contexts)))
	}
	if r.Fact == analyze.FactWaits && !f.IncludeIdle {
		scope = append(scope, "idle events hidden")
	}
	shown := ""
	if len(rows) < len(r.Rows) {
		shown = fmt.Sprintf(", top %d shown", len(rows))
	}
	fmt.Fprintf(w, "%s %s in %s groups%s, sorted by %s", commas(int64(r.Facts)), r.Fact, commas(int64(len(r.Rows))), shown, sortM)
	if len(scope) > 0 {
		fmt.Fprintf(w, " (%s)", strings.Join(scope, ", "))
	}
	w.WriteString("\n\n")
	put(head)
	rule := make([]string, len(head))
	for i := range rule {
		rule[i] = strings.Repeat("-", width[i])
	}
	put(rule)
	for _, line := range cells {
		put(line)
	}
	put(rule)
	put(totals)
	return w.Flush()
}

func writePivotCSV(out io.Writer, r *analyze.PivotResult, cols []pivotCol, top int) error {
	w := csv.NewWriter(out)
	var head []string
	for _, d := range r.Dims {
		head = append(head, d.ID)
		if d.Extra != "" {
			head = append(head, d.ID+"_"+strings.ToLower(d.Extra))
		}
	}
	for _, c := range cols {
		h := c.m.ID
		if c.m.Unit == "us" {
			h += "_us"
		}
		head = append(head, h)
	}
	w.Write(head)
	rows := r.Rows
	if top > 0 && len(rows) > top {
		rows = rows[:top]
	}
	for _, row := range rows {
		var line []string
		for j, d := range r.Dims {
			line = append(line, row.Labels[j])
			if d.Extra != "" {
				line = append(line, row.Extra[j])
			}
		}
		for _, c := range cols {
			line = append(line, csvNum(row.Values[c.idx]))
		}
		w.Write(line)
	}
	w.Flush()
	return w.Error()
}

func csvNum(v float64) string {
	if v == float64(int64(v)) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', 3, 64)
}
