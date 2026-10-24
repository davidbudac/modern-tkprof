package analyze

import (
	"hash/fnv"
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Metric is one number on both sides of a comparison.
type Metric struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Unit  string `json:"unit"` // "us" | "count"
	A     int64  `json:"a"`
	B     int64  `json:"b"`
	Delta int64  `json:"delta"` // B - A
}

func metric(key, label, unit string, a, b int64) Metric {
	return Metric{Key: key, Label: label, Unit: unit, A: a, B: b, Delta: b - a}
}

// PctChange is (b-a)/a in percent; ok is false when a is 0 (new or no base).
func PctChange(a, b int64) (pct float64, ok bool) {
	if a == 0 {
		return 0, false
	}
	return 100 * float64(b-a) / float64(a), true
}

// ProfileDelta is one resource-profile component on both sides.
type ProfileDelta struct {
	Component string  `json:"component"`
	Kind      string  `json:"kind"` // cpu | wait | idle | unaccounted
	Class     string  `json:"class,omitempty"`
	AUs       int64   `json:"aUs"`
	BUs       int64   `json:"bUs"`
	DeltaUs   int64   `json:"deltaUs"`
	APct      float64 `json:"aPct"`
	BPct      float64 `json:"bPct"`
}

// StmtSide is one trace's numbers for a (matched) statement.
type StmtSide struct {
	ID          model.ID `json:"id"` // statement id in that trace's model
	Elapsed     int64    `json:"elapsed"`
	SelfElapsed int64    `json:"selfElapsed"`
	CPU         int64    `json:"cpu"`
	Executions  int64    `json:"executions"`
	PerExecUs   int64    `json:"perExecUs"` // Elapsed / Executions (0 without executions)
	Parses      int64    `json:"parses"`
	HardParses  int64    `json:"hardParses"`
	Fetches     int64    `json:"fetches"`
	Rows        int64    `json:"rows"`
	Disk        int64    `json:"disk"`
	Query       int64    `json:"query"`
	Current     int64    `json:"current"`
	PlanHashes  []uint64 `json:"planHashes"`
}

// Statement status in a comparison.
const (
	StmtBoth  = "both"
	StmtOnlyA = "onlyA"
	StmtOnlyB = "onlyB"
)

// StmtDelta compares one statement across the traces. For statements present
// on one side only, the other side is nil and the deltas are against zero.
type StmtDelta struct {
	Key    string              `json:"key"` // "sqlid:<id>" or "<kind>:<hash of normalised text>"
	SQLID  string              `json:"sqlId"`
	Kind   model.StatementKind `json:"kind"`
	Text   string              `json:"text"` // preview
	Status string              `json:"status"`
	A      *StmtSide           `json:"a"`
	B      *StmtSide           `json:"b"`

	DElapsed    int64 `json:"dElapsed"`
	DPerExecUs  int64 `json:"dPerExecUs"` // only when both sides executed it
	DExecutions int64 `json:"dExecutions"`
	DCPU        int64 `json:"dCpu"`
	DDisk       int64 `json:"dDisk"`
	DQuery      int64 `json:"dQuery"`
	DRows       int64 `json:"dRows"`
	PlanChanged bool  `json:"planChanged"` // both sides know plan hashes and the sets differ
}

// EventSide is one trace's numbers for a wait event.
type EventSide struct {
	Count int64 `json:"count"`
	Us    int64 `json:"us"`
}

// EventDelta compares a wait event (matched by name).
type EventDelta struct {
	Name    string    `json:"name"`
	Class   string    `json:"class"`
	Idle    bool      `json:"idle"`
	A       EventSide `json:"a"`
	B       EventSide `json:"b"`
	DeltaUs int64     `json:"deltaUs"`
	DCount  int64     `json:"dCount"`
}

// SideInfo identifies one trace in a comparison.
type SideInfo struct {
	Path     string `json:"path"`
	Trace    string `json:"traceFile"`
	Version  string `json:"version"`
	Instance string `json:"instance"`
	SpanUs   int64  `json:"spanUs"`
	WallUs   int64  `json:"firstWallUs"`
}

// Comparison is trace B against trace A (deltas are B - A).
type Comparison struct {
	A          SideInfo       `json:"a"`
	B          SideInfo       `json:"b"`
	Totals     []Metric       `json:"totals"`
	Classes    []Metric       `json:"classes"`    // wait time by event class
	Profile    []ProfileDelta `json:"profile"`    // ranked by |delta|
	Statements []StmtDelta    `json:"statements"` // ranked by |delta elapsed|
	Events     []EventDelta   `json:"events"`     // ranked by |delta time|
}

// OnlyA returns the statements that exist only in trace A.
func (c *Comparison) OnlyA() []StmtDelta { return c.byStatus(StmtOnlyA) }

// OnlyB returns the statements that exist only in trace B.
func (c *Comparison) OnlyB() []StmtDelta { return c.byStatus(StmtOnlyB) }

// Matched returns the statements found in both traces.
func (c *Comparison) Matched() []StmtDelta { return c.byStatus(StmtBoth) }

func (c *Comparison) byStatus(s string) []StmtDelta {
	var out []StmtDelta
	for _, d := range c.Statements {
		if d.Status == s {
			out = append(out, d)
		}
	}
	return out
}

// Compare lines up two models: totals, resource profile, statements matched by
// sql_id (statements without one by kind + normalised SQL text) and wait events
// matched by name. Statement elapsed is the response time of the statement
// (inclusive of recursive children, without the think time between its calls);
// the call counters (disk, query, current, rows) are the inclusive tkprof
// columns, like the statement ranking of the text report.
func Compare(a, b *model.Model) Comparison {
	sa, sb := Statements(a), Statements(b)
	pa, pb := TraceProfile(a), TraceProfile(b)
	ea, eb := WaitsByEvent(a, nil), WaitsByEvent(b, nil)
	ta, tb := tally(sa), tally(sb)

	c := Comparison{A: sideInfo(a), B: sideInfo(b)}
	c.Totals = []Metric{
		metric("response", "Response time", "us", a.Span.Us(), b.Span.Us()),
		metric("cpu", "CPU", "us", pa.CPUUs, pb.CPUUs),
		metric("wait", "Wait time (in call)", "us", pa.WaitUs, pb.WaitUs),
		metric("idle", "Idle / think time", "us", pa.IdleUs, pb.IdleUs),
		metric("unaccounted", "Unaccounted-for", "us", pa.UnaccountedUs, pb.UnaccountedUs),
		metric("parses", "Parse calls", "count", ta.parses, tb.parses),
		metric("hardParses", "Hard parses", "count", ta.hardParses, tb.hardParses),
		metric("execs", "Execute calls", "count", ta.execs, tb.execs),
		metric("fetches", "Fetch calls", "count", ta.fetches, tb.fetches),
		metric("rows", "Rows processed", "count", ta.rows, tb.rows),
		metric("disk", "Disk reads (blocks)", "count", ta.disk, tb.disk),
		metric("query", "Consistent gets", "count", ta.query, tb.query),
		metric("current", "Current gets", "count", ta.current, tb.current),
		metric("statements", "Statements", "count", int64(len(a.Statements)), int64(len(b.Statements))),
		metric("errors", "Errors", "count", int64(len(a.Errors)), int64(len(b.Errors))),
	}
	c.Classes = classDeltas(ea, eb)
	c.Profile = profileDeltas(pa, pb)
	c.Statements = stmtDeltas(a, b, sa, sb)
	c.Events = eventDeltas(ea, eb)
	return c
}

func sideInfo(m *model.Model) SideInfo {
	return SideInfo{Path: m.File.Path, Trace: m.File.TraceFile, Version: m.File.Version, Instance: m.File.Instance, SpanUs: m.Span.Us(), WallUs: m.Span.FirstWallUs}
}

type totals struct{ parses, hardParses, execs, fetches, rows, disk, query, current int64 }

// tally sums the call counters with the exclusive (self) columns, so
// recursive children are not counted twice.
func tally(st []StmtStats) totals {
	var t totals
	for i := range st {
		s := &st[i]
		t.parses += s.Parse.Count
		t.hardParses += s.HardParses
		t.execs += s.Exec.Count
		t.fetches += s.Fetch.Count
		t.rows += s.AllCalls.Rows
		t.disk += s.AllCalls.SelfDisk
		t.query += s.AllCalls.SelfQuery
		t.current += s.AllCalls.SelfCurrent
	}
	return t
}

func classDeltas(ea, eb []EventAgg) []Metric {
	a, b := map[string]int64{}, map[string]int64{}
	for _, e := range ea {
		a[e.Class] += e.Us
	}
	for _, e := range eb {
		b[e.Class] += e.Us
	}
	names := map[string]bool{}
	for k := range a {
		names[k] = true
	}
	for k := range b {
		names[k] = true
	}
	var out []Metric
	for k := range names {
		label := k
		if label == "" {
			label = "(no class)"
		}
		out = append(out, metric(k, label, "us", a[k], b[k]))
	}
	sort.Slice(out, func(i, j int) bool {
		if x, y := abs64(out[i].Delta), abs64(out[j].Delta); x != y {
			return x > y
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func profileDeltas(pa, pb Profile) []ProfileDelta {
	type key struct{ component, kind string }
	idx := map[key]*ProfileDelta{}
	var out []*ProfileDelta
	get := func(r ProfileRow) *ProfileDelta {
		k := key{r.Component, r.Kind}
		d := idx[k]
		if d == nil {
			d = &ProfileDelta{Component: r.Component, Kind: r.Kind, Class: r.Class}
			idx[k] = d
			out = append(out, d)
		}
		return d
	}
	for _, r := range pa.Rows {
		d := get(r)
		d.AUs, d.APct = r.Us, r.Pct
	}
	for _, r := range pb.Rows {
		d := get(r)
		d.BUs, d.BPct = r.Us, r.Pct
	}
	res := make([]ProfileDelta, len(out))
	for i, d := range out {
		d.DeltaUs = d.BUs - d.AUs
		res[i] = *d
	}
	sort.SliceStable(res, func(i, j int) bool { return abs64(res[i].DeltaUs) > abs64(res[j].DeltaUs) })
	return res
}

func eventDeltas(ea, eb []EventAgg) []EventDelta {
	idx := map[string]*EventDelta{}
	var out []*EventDelta
	get := func(e EventAgg) *EventDelta {
		d := idx[e.Name]
		if d == nil {
			d = &EventDelta{Name: e.Name, Class: e.Class, Idle: e.Idle}
			idx[e.Name] = d
			out = append(out, d)
		}
		return d
	}
	for _, e := range ea {
		get(e).A = EventSide{Count: e.Count, Us: e.Us}
	}
	for _, e := range eb {
		get(e).B = EventSide{Count: e.Count, Us: e.Us}
	}
	res := make([]EventDelta, len(out))
	for i, d := range out {
		d.DeltaUs = d.B.Us - d.A.Us
		d.DCount = d.B.Count - d.A.Count
		res[i] = *d
	}
	sort.SliceStable(res, func(i, j int) bool {
		if x, y := abs64(res[i].DeltaUs), abs64(res[j].DeltaUs); x != y {
			return x > y
		}
		return res[i].Name < res[j].Name
	})
	return res
}

// StmtKey is the identity used to match a statement across traces: its sql_id,
// else its kind plus a hash of the whitespace/case-normalised text.
func StmtKey(s *model.Statement) string {
	if s.SQLID != "" {
		return "sqlid:" + s.SQLID
	}
	h := fnv.New64a()
	h.Write([]byte(strings.ToLower(strings.Join(strings.Fields(s.Text), " "))))
	return s.Kind.String() + ":" + strconv.FormatUint(h.Sum64(), 16)
}

type stmtAcc struct {
	key   string
	stmt  *model.Statement
	side  StmtSide
	plans map[uint64]bool
}

// sideStatements keys every statement that did something; statements that
// share a key (same sql_id parsed under two hash values, say) are summed.
func sideStatements(m *model.Model, st []StmtStats) (map[string]*stmtAcc, []string) {
	plans := execPlans(m)
	byKey := map[string]*stmtAcc{}
	var order []string
	for i := range st {
		s := &st[i]
		if s.AllCalls.Count == 0 && s.Errors == 0 {
			continue
		}
		ms := &m.Statements[i]
		k := StmtKey(ms)
		a := byKey[k]
		if a == nil {
			a = &stmtAcc{key: k, stmt: ms, plans: map[uint64]bool{}}
			a.side.ID = s.ID
			byKey[k] = a
			order = append(order, k)
		}
		x := &a.side
		x.Elapsed += s.Elapsed
		x.SelfElapsed += s.SelfElapsed
		x.CPU += s.CPU
		x.Executions += s.Executions
		x.Parses += s.Parse.Count
		x.HardParses += s.HardParses
		x.Fetches += s.Fetch.Count
		x.Rows += s.AllCalls.Rows
		x.Disk += s.AllCalls.Disk
		x.Query += s.AllCalls.Query
		x.Current += s.AllCalls.Current
		for _, h := range s.PlanHashes {
			if h != 0 {
				a.plans[h] = true
			}
		}
		for h := range plans[model.ID(i)] {
			a.plans[h] = true
		}
	}
	for _, a := range byKey {
		a.side.PlanHashes = sortedHashes(a.plans)
		if a.side.Executions > 0 {
			a.side.PerExecUs = a.side.Elapsed / a.side.Executions
		}
	}
	return byKey, order
}

// execPlans collects the plan hash values EXEC lines carry, per statement.
func execPlans(m *model.Model) map[model.ID]map[uint64]bool {
	out := map[model.ID]map[uint64]bool{}
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Kind != trace.CallExec || c.PLH == 0 {
			continue
		}
		s := out[c.Statement]
		if s == nil {
			s = map[uint64]bool{}
			out[c.Statement] = s
		}
		s[c.PLH] = true
	}
	return out
}

func sortedHashes(set map[uint64]bool) []uint64 {
	out := make([]uint64, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func sameHashes(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func stmtDeltas(a, b *model.Model, sa, sb []StmtStats) []StmtDelta {
	ma, orderA := sideStatements(a, sa)
	mb, orderB := sideStatements(b, sb)
	var out []StmtDelta
	add := func(x, y *stmtAcc) {
		d := StmtDelta{}
		var zero StmtSide
		pa, pb := &zero, &zero
		switch {
		case x != nil && y != nil:
			d.Status = StmtBoth
			d.A, d.B = &x.side, &y.side
			pa, pb = d.A, d.B
			d.Key, d.SQLID, d.Kind, d.Text = x.key, x.stmt.SQLID, x.stmt.Kind, x.stmt.Text
			if len(pa.PlanHashes) > 0 && len(pb.PlanHashes) > 0 && !sameHashes(pa.PlanHashes, pb.PlanHashes) {
				d.PlanChanged = true
			}
			if pa.Executions > 0 && pb.Executions > 0 {
				d.DPerExecUs = pb.PerExecUs - pa.PerExecUs
			}
		case x != nil:
			d.Status = StmtOnlyA
			d.A = &x.side
			pa = d.A
			d.Key, d.SQLID, d.Kind, d.Text = x.key, x.stmt.SQLID, x.stmt.Kind, x.stmt.Text
		default:
			d.Status = StmtOnlyB
			d.B = &y.side
			pb = d.B
			d.Key, d.SQLID, d.Kind, d.Text = y.key, y.stmt.SQLID, y.stmt.Kind, y.stmt.Text
		}
		d.Text = previewText(d.Text, 160)
		d.DElapsed = pb.Elapsed - pa.Elapsed
		d.DExecutions = pb.Executions - pa.Executions
		d.DCPU = pb.CPU - pa.CPU
		d.DDisk = pb.Disk - pa.Disk
		d.DQuery = pb.Query - pa.Query
		d.DRows = pb.Rows - pa.Rows
		out = append(out, d)
	}
	for _, k := range orderA {
		add(ma[k], mb[k])
	}
	for _, k := range orderB {
		if ma[k] == nil {
			add(nil, mb[k])
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if x, y := abs64(out[i].DElapsed), abs64(out[j].DElapsed); x != y {
			return x > y
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func previewText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	cut := max - 3
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut] + "..."
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
