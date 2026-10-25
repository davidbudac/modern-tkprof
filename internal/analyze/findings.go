package analyze

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Findings are trace-level observations produced by fixed rules with
// documented thresholds (docs/DESIGN.md § Findings). The thresholds default to
// DefaultThresholds and can be overridden (Thresholds, FindingsWith).

// Severities, most important first.
const (
	SeveritySerious = "serious"
	SeverityNotable = "notable"
	SeverityInfo    = "info"
)

// Rule ids (stable, used by the UI and in JSON).
const (
	RuleOutlierExecs = "outlier-executions"
	RulePlanChange   = "plan-change"
	RuleHardParses   = "hard-parses"
	RuleParsePerExec = "parse-per-exec"
	RuleHardCloses   = "hard-closes"
	RuleThinkTime    = "think-time"
	RuleInCallIdle   = "in-call-idle"
	RuleSmallFetches = "small-fetches"
	RuleCommitPerRow = "commit-per-row"
	RuleRoundTrips   = "round-trips"
)

// ---- thresholds -------------------------------------------------------------

// Thresholds are the tunable numbers of the finding rules. The JSON keys
// (snake_case) are the keys of a -findings-config file; see
// docs/ARCHITECTURE.md for which rule uses which. Severity mapping: time-based
// rules use timeSeverity on their impact relative to the trace response time
// (serious: >= SeriousShare and >= SeriousMinUs; notable: >= NotableShare and
// >= NotableMinUs; else info); count-based rules (hard closes, round trips)
// use countSeverity (serious from SeriousCount, notable from NotableCount).
type Thresholds struct {
	// OutlierFactor: execution is an outlier above this x the statement's median ....
	OutlierFactor float64 `json:"outlier_factor"`
	// OutlierMinUs: ... and above this absolute floor (us).
	OutlierMinUs int64 `json:"outlier_min_us"`
	// OutlierMinExecs: a median needs at least this many executions.
	OutlierMinExecs int64 `json:"outlier_min_execs"`
	// HardParseRatio: hard parses per execution above this ratio ....
	HardParseRatio float64 `json:"hard_parse_ratio"`
	// HardParseMinExecs: ... for a statement with more executions than this, or.
	HardParseMinExecs int64 `json:"hard_parse_min_execs"`
	// HardParseMinTotal: trace-wide, at least this many hard parses at the same ratio (catches literal SQL; a handful of once-run statements is just a short trace).
	HardParseMinTotal int64 `json:"hard_parse_min_total"`
	// ParseExecRatio: PARSE calls per execution above this ratio ....
	ParseExecRatio float64 `json:"parse_exec_ratio"`
	// ParseExecMinExecs: ... with more executions than this.
	ParseExecMinExecs int64 `json:"parse_exec_min_execs"`
	// HardCloseShare: CLOSE type=0 above this share of a statement's closes ....
	HardCloseShare float64 `json:"hard_close_share"`
	// HardCloseMinParses: ... counted only for statements parsed at least this often (the session cursor cache needs 3).
	HardCloseMinParses int64 `json:"hard_close_min_parses"`
	// HardCloseMinCount: ... with more such hard closes than this, trace-wide.
	HardCloseMinCount int64 `json:"hard_close_min_count"`
	// ThinkTimeShare: idle time between calls above this share of response time.
	ThinkTimeShare float64 `json:"think_time_share"`
	// InCallIdleShare: idle waits inside a call's own window above this share of response time.
	InCallIdleShare float64 `json:"in_call_idle_share"`
	// SmallFetchRows: average rows per FETCH below this is a small-fetch execution ....
	SmallFetchRows float64 `json:"small_fetch_rows"`
	// SmallFetchMinFetchesPerExec: ... that made at least this many fetches.
	SmallFetchMinFetchesPerExec int64 `json:"small_fetch_min_fetches_per_exec"`
	// SmallFetchMinFetches: the statement's small-fetch executions together made more fetches than this ....
	SmallFetchMinFetches int64 `json:"small_fetch_min_fetches"`
	// SmallFetchMinRows: ... and returned more rows than this.
	SmallFetchMinRows int64 `json:"small_fetch_min_rows"`
	// CommitPerDMLRatio: read-write commits per INSERT/UPDATE/DELETE/MERGE execution above this ....
	CommitPerDMLRatio float64 `json:"commit_per_dml_ratio"`
	// CommitMinCount: ... with more commits than this.
	CommitMinCount int64 `json:"commit_min_count"`
	// RoundTripsPerRow: SQL*Net message to client waits per row above this ratio ....
	RoundTripsPerRow float64 `json:"round_trips_per_row"`
	// RoundTripsMin: ... with more round trips than this.
	RoundTripsMin int64 `json:"round_trips_min"`
	// MaxEvidenceRows: caps the evidence rows of one finding.
	MaxEvidenceRows int `json:"max_evidence_rows"`
	// BindPreviewMax: caps the bind preview of an outlier execution (bytes).
	BindPreviewMax int `json:"bind_preview_max"`
	// SeriousShare: time-based severity: serious from this share of response time ....
	SeriousShare float64 `json:"serious_share"`
	// SeriousMinUs: ... and this absolute impact (us).
	SeriousMinUs int64 `json:"serious_min_us"`
	// NotableShare: notable from this share of response time ....
	NotableShare float64 `json:"notable_share"`
	// NotableMinUs: ... and this absolute impact (us).
	NotableMinUs int64 `json:"notable_min_us"`
	// SeriousCount: count-based severity: serious from this many occurrences.
	SeriousCount int64 `json:"serious_count"`
	// NotableCount: notable from this many occurrences.
	NotableCount int64 `json:"notable_count"`
}

// DefaultThresholds returns the built-in thresholds.
func DefaultThresholds() Thresholds {
	return Thresholds{
		OutlierFactor:               3.0,
		OutlierMinUs:                100_000,
		OutlierMinExecs:             3,
		HardParseRatio:              0.5,
		HardParseMinExecs:           10,
		HardParseMinTotal:           20,
		ParseExecRatio:              0.9,
		ParseExecMinExecs:           10,
		HardCloseShare:              0.5,
		HardCloseMinParses:          3,
		HardCloseMinCount:           10,
		ThinkTimeShare:              0.30,
		InCallIdleShare:             0.10,
		SmallFetchRows:              20,
		SmallFetchMinFetchesPerExec: 3,
		SmallFetchMinFetches:        100,
		SmallFetchMinRows:           1000,
		CommitPerDMLRatio:           0.5,
		CommitMinCount:              10,
		RoundTripsPerRow:            0.5,
		RoundTripsMin:               100,
		MaxEvidenceRows:             10,
		BindPreviewMax:              80,
		SeriousShare:                0.25,
		SeriousMinUs:                1_000_000,
		NotableShare:                0.05,
		NotableMinUs:                100_000,
		SeriousCount:                10_000,
		NotableCount:                1_000,
	}
}

// ThresholdKeys lists the valid JSON keys in struct order.
func ThresholdKeys() []string {
	return []string{"outlier_factor", "outlier_min_us", "outlier_min_execs", "hard_parse_ratio", "hard_parse_min_execs", "hard_parse_min_total", "parse_exec_ratio", "parse_exec_min_execs", "hard_close_share", "hard_close_min_parses", "hard_close_min_count", "think_time_share", "in_call_idle_share", "small_fetch_rows", "small_fetch_min_fetches_per_exec", "small_fetch_min_fetches", "small_fetch_min_rows", "commit_per_dml_ratio", "commit_min_count", "round_trips_per_row", "round_trips_min", "max_evidence_rows", "bind_preview_max", "serious_share", "serious_min_us", "notable_share", "notable_min_us", "serious_count", "notable_count"}
}

// ParseThresholds overlays a JSON object onto the defaults. Keys that are not
// thresholds are an error that lists the valid ones.
func ParseThresholds(data []byte) (Thresholds, error) {
	th := DefaultThresholds()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&th); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return th, fmt.Errorf("findings config: %v; valid keys: %s", err, strings.Join(ThresholdKeys(), ", "))
		}
		return th, fmt.Errorf("findings config: %w", err)
	}
	if dec.More() {
		return th, fmt.Errorf("findings config: trailing data after the JSON object")
	}
	return th, nil
}

// ---- types ------------------------------------------------------------------

// Finding is one rule hit.
type Finding struct {
	Rule      string        `json:"rule"`      // stable id (Rule* constants)
	Title     string        `json:"title"`     // human rule name
	Severity  string        `json:"severity"`  // info | notable | serious
	Summary   string        `json:"summary"`   // one sentence
	Statement model.ID      `json:"statement"` // None for trace-level findings
	ImpactUs  int64         `json:"impactUs"`  // time the finding accounts for (sort key)
	Evidence  []EvidenceRow `json:"evidence"`
	// Scope is ScopeSet for a finding FindingsOn could not narrow to the
	// scope (it is about the whole trace set); "" otherwise.
	Scope string `json:"scope,omitempty"`
}

// ScopeSet marks a finding that is about the whole trace set (Finding.Scope).
const ScopeSet = "set"

// EvidenceRow is one supporting fact. Label and Value are ready to print;
// the ids let the UI link to the statement / execution / call.
type EvidenceRow struct {
	Label     string   `json:"label"`
	Value     string   `json:"value"`
	Statement model.ID `json:"statement"` // None when not about one statement
	Cursor    model.ID `json:"cursor"`    // with ExecNo: one execution
	ExecNo    int32    `json:"execNo,omitempty"`
	Call      model.ID `json:"call"`
	Line      int      `json:"line,omitempty"` // trace file line
	Us        int64    `json:"us,omitempty"`   // the row's time
}

func row(label, value string) EvidenceRow {
	return EvidenceRow{Label: label, Value: value, Statement: model.None, Cursor: model.None, Call: model.None}
}

func stmtRow(sid model.ID, label, value string) EvidenceRow {
	r := row(label, value)
	r.Statement = sid
	return r
}

var severityRank = map[string]int{SeveritySerious: 0, SeverityNotable: 1, SeverityInfo: 2}

func (f *finder) timeSeverity(impact, total int64) string {
	share := 0.0
	if total > 0 {
		share = float64(impact) / float64(total)
	}
	switch {
	case share >= f.th.SeriousShare && impact >= f.th.SeriousMinUs:
		return SeveritySerious
	case share >= f.th.NotableShare && impact >= f.th.NotableMinUs:
		return SeverityNotable
	}
	return SeverityInfo
}

func (f *finder) countSeverity(n int64) string {
	switch {
	case n >= f.th.SeriousCount:
		return SeveritySerious
	case n >= f.th.NotableCount:
		return SeverityNotable
	}
	return SeverityInfo
}

// atLeast raises s to the floor severity.
func atLeast(s, floor string) string {
	if severityRank[s] > severityRank[floor] {
		return floor
	}
	return s
}

// ---- entry point ------------------------------------------------------------

// Findings runs every rule over the model and returns the hits, most severe
// first, then by impact. stats must be Statements(m).
func Findings(m *model.Model, stats []StmtStats) []Finding {
	return FindingsWith(m, stats, DefaultThresholds())
}

// FindingsWith is Findings with explicit thresholds.
func FindingsWith(m *model.Model, stats []StmtStats, th Thresholds) []Finding {
	return FindingsExec(m, stats, th, nil)
}

// FindingsExec is FindingsWith with the executions of every statement already
// computed (AllExecutions); nil computes them. A caller that needs the
// executions itself (the text report) shares one copy instead of building
// two.
func FindingsExec(m *model.Model, stats []StmtStats, th Thresholds, ex [][]Execution) []Finding {
	f := &finder{m: m, stats: stats, th: th, byStmt: ex, acc: AggOf(m)}
	if f.acc != nil {
		// an aggregation-only model decided the per-execution rules while it
		// was built: those thresholds are the ones it was built with
		b := f.acc.th
		f.th.MaxEvidenceRows, f.th.SmallFetchRows, f.th.SmallFetchMinFetchesPerExec = b.MaxEvidenceRows, b.SmallFetchRows, b.SmallFetchMinFetchesPerExec
	}
	p := TraceProfile(m)
	// response time: Σ session spans (TraceResponse), or the ledger's sum when
	// larger (a call that started before the trace)
	f.total = p.TotalUs
	if s := p.CPUUs + p.WaitUs + p.IdleUs; s > f.total {
		f.total = s
	}
	return f.run()
}

// run applies every rule and sorts the hits.
func (f *finder) run() []Finding {
	f.outliers()
	f.planChanges()
	f.hardParses()
	f.parsePerExec()
	f.hardCloses()
	f.thinkTime()
	f.inCallIdle()
	f.smallFetches()
	f.commitPerRow()
	f.roundTrips()
	out := f.out
	if out == nil {
		out = []Finding{}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := &out[i], &out[j]
		if severityRank[a.Severity] != severityRank[b.Severity] {
			return severityRank[a.Severity] < severityRank[b.Severity]
		}
		if a.ImpactUs != b.ImpactUs {
			return a.ImpactUs > b.ImpactUs
		}
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
		}
		return a.Statement < b.Statement
	})
	return out
}

type finder struct {
	th     Thresholds
	m      *model.Model
	stats  []StmtStats
	total  int64
	out    []Finding
	byStmt [][]Execution // lazily built by execs
	acc    *Accumulator  // aggregation-only model: the rules read the aggregates, not the facts
	sc     *scopeIn      // FindingsOn: the rules read the scope's inputs, not the model's tables or aggregates
}

// execAgg is the execution aggregate of a statement (aggregation-only model).
func (f *finder) execAgg(sid model.ID) *execAgg {
	if f.sc != nil {
		return f.sc.ex[sid]
	}
	return f.acc.execAggOf(sid)
}

// execs returns Executions(m, sid), computed for all statements in one pass
// over the calls (calling Executions per statement is O(statements x calls)).
func (f *finder) execs(sid model.ID) []Execution {
	if f.byStmt == nil {
		f.byStmt = AllExecutions(f.m)
	}
	return f.byStmt[sid]
}

// AllExecutions is Executions for every statement (indexed by statement id) at once. Two passes so that
// every per-statement slice and every Fetches list is allocated once at its
// final size (a trace with millions of fetches would otherwise spend more
// memory on append garbage than on the executions themselves).
func AllExecutions(m *model.Model) [][]Execution {
	out := make([][]Execution, len(m.Statements))
	type key struct {
		cursor model.ID
		execNo int32
	}
	// pass 1: count executions per statement and fetches per execution
	nExec := make([]int, len(m.Statements))
	fetches := map[key]int32{}
	for i := range m.Calls {
		c := &m.Calls[i]
		if m.PXChild(c.Context) {
			continue
		}
		switch c.Kind {
		case trace.CallExec:
			nExec[c.Statement]++
			fetches[key{c.Cursor, c.ExecNo}] = 0
		case trace.CallFetch:
			k := key{c.Cursor, c.ExecNo}
			if n, ok := fetches[k]; ok {
				fetches[k] = n + 1
			}
		}
	}
	total := 0
	for sid, n := range nExec {
		if n > 0 {
			out[sid] = make([]Execution, 0, n)
		}
	}
	for _, n := range fetches {
		total += int(n)
	}
	backing := make([]model.ID, 0, total)
	idx := map[key]int{} // cursor,execNo -> index in out[statement]
	for i := range m.Calls {
		c := &m.Calls[i]
		if m.PXChild(c.Context) {
			continue
		}
		switch c.Kind {
		case trace.CallExec:
			k := key{c.Cursor, c.ExecNo}
			e := Execution{Cursor: c.Cursor, Statement: c.Statement, ExecNo: c.ExecNo, Exec: c.ID, BindSet: c.BindSet, StartTim: c.Tim - c.E, EndTim: c.Tim, WallUs: m.CallWall(c) - c.E, Context: c.Context, Line: c.Line}
			if n := int(fetches[k]); n > 0 && len(backing)+n <= cap(backing) {
				e.Fetches = backing[len(backing) : len(backing) : len(backing)+n]
				backing = backing[:len(backing)+n]
			}
			e.Stats.add(c)
			idx[k] = len(out[c.Statement])
			out[c.Statement] = append(out[c.Statement], e)
		case trace.CallFetch:
			if j, ok := idx[key{c.Cursor, c.ExecNo}]; ok && j < len(out[c.Statement]) && out[c.Statement][j].Cursor == c.Cursor {
				e := &out[c.Statement][j]
				e.Fetches = append(e.Fetches, c.ID)
				e.Stats.add(c)
				if c.Tim > e.EndTim {
					e.EndTim = c.Tim
				}
			}
		}
	}
	return out
}

func (f *finder) add(x Finding) {
	if x.Evidence == nil {
		x.Evidence = []EvidenceRow{}
	}
	f.out = append(f.out, x)
}

func (f *finder) label(sid model.ID) string {
	st := &f.m.Statements[sid]
	if st.SQLID != "" {
		return st.SQLID
	}
	return "(" + st.Kind.String() + ")"
}

// isSQL: statements the parse/fetch rules apply to (not commit, LOB, ...).
func (f *finder) isSQL(sid model.ID) bool {
	k := f.m.Statements[sid].Kind
	return k == model.StmtSQL || k == model.StmtUnknown
}

// ---- outlier executions -----------------------------------------------------

func median(xs []int64) int64 {
	s := append([]int64(nil), xs...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func (f *finder) outliers() {
	if f.acc != nil {
		f.outliersAgg()
		return
	}
	for i := range f.stats {
		s := &f.stats[i]
		if s.Executions < f.th.OutlierMinExecs {
			continue
		}
		ex := f.execs(s.ID)
		if int64(len(ex)) < f.th.OutlierMinExecs {
			continue
		}
		els := make([]int64, len(ex))
		for j := range ex {
			els[j] = ex[j].Stats.Elapsed
		}
		med := median(els)
		var hits []*Execution
		var excess int64
		for j := range ex {
			e := ex[j].Stats.Elapsed
			if float64(e) > f.th.OutlierFactor*float64(med) && e > f.th.OutlierMinUs {
				hits = append(hits, &ex[j])
				excess += e - med
			}
		}
		if len(hits) == 0 {
			continue
		}
		sort.SliceStable(hits, func(a, b int) bool { return hits[a].Stats.Elapsed > hits[b].Stats.Elapsed })
		worst := hits[0].Stats.Elapsed
		x := Finding{
			Rule: RuleOutlierExecs, Title: "Outlier executions", Statement: s.ID, ImpactUs: excess,
			Severity: f.timeSeverity(excess, f.total),
			Summary: fmt.Sprintf("%s: %d of %d executions over %gx the median %s; slowest %s (%.0fx); %s over the median in total",
				f.label(s.ID), len(hits), len(ex), f.th.OutlierFactor, fmtUs(med), fmtUs(worst), float64(worst)/float64(max(med, 1)), fmtUs(excess)),
		}
		for k, e := range hits {
			if k == f.th.MaxEvidenceRows {
				x.Evidence = append(x.Evidence, row("...", fmt.Sprintf("%d more outlier executions", len(hits)-k)))
				break
			}
			cur := &f.m.Cursors[e.Cursor]
			v := fmt.Sprintf("%s  %d rows  %d disk  %d fetches  cursor at line %d", fmtUs(e.Stats.Elapsed), e.Stats.Rows, e.Stats.Disk, len(e.Fetches), cur.Line)
			if b := f.bindPreview(e.BindSet); b != "" {
				v += "  binds " + b
			}
			r := stmtRow(s.ID, fmt.Sprintf("exec %d", e.ExecNo), v)
			r.Cursor, r.ExecNo, r.Call, r.Line, r.Us = e.Cursor, e.ExecNo, e.Exec, int(f.m.Calls[e.Exec].Line), e.Stats.Elapsed
			x.Evidence = append(x.Evidence, r)
		}
		f.add(x)
	}
}

// bindPreview joins the bind values of a bind set, truncated to BindPreviewMax.
func (f *finder) bindPreview(id model.ID) string {
	if id == model.None || int(id) >= len(f.m.BindSets) {
		return ""
	}
	bs := &f.m.BindSets[id]
	var parts []string
	for j := bs.First; j < bs.First+bs.N; j++ {
		b := &f.m.Binds[j]
		switch {
		case b.NoDef:
			continue
		case b.IsNull:
			parts = append(parts, fmt.Sprintf(":%d=NULL", b.Pos))
		case b.IsDump:
			parts = append(parts, fmt.Sprintf(":%d=<dump>", b.Pos))
		default:
			parts = append(parts, fmt.Sprintf(":%d=%s", b.Pos, b.Value))
		}
	}
	s := strings.Join(parts, " ")
	if len(s) > f.th.BindPreviewMax {
		cut := f.th.BindPreviewMax - 3
		for cut > 0 && s[cut]&0xC0 == 0x80 {
			cut--
		}
		s = s[:cut] + "..."
	}
	return s
}

// ---- plan change ------------------------------------------------------------

// planChanges: a statement with more than one plan hash, from STAT dumps or
// from the plh= of its EXEC calls (plh=0, e.g. PL/SQL, is ignored). Severity
// notable; serious when the average execution time of one plan is at least
// OutlierFactor x another's and the statement took at least NotableMinUs.
func (f *finder) planChanges() {
	m := f.m
	type planAgg struct {
		execs, elapsed int64
		dumps, line    int
		firstLine      int
	}
	for i := range f.stats {
		s := &f.stats[i]
		agg := map[uint64]*planAgg{}
		var order []uint64
		get := func(h uint64, line int) *planAgg {
			a := agg[h]
			if a == nil {
				a = &planAgg{firstLine: line}
				agg[h] = a
				order = append(order, h)
			}
			return a
		}
		for _, pid := range s.Plans {
			p := &m.Plans[pid]
			if p.PLH == 0 {
				continue
			}
			a := get(p.PLH, p.Line)
			a.dumps++
			a.line = p.Line
		}
		if len(s.PlanHashes) < 2 && s.Executions < 2 {
			continue
		}
		var ex []Execution
		if s.Executions > 1 && f.acc != nil {
			if ea := f.execAgg(s.ID); ea != nil {
				for _, p := range ea.plans {
					a := get(p.plh, p.line)
					a.execs += p.execs
					a.elapsed += p.elapsed
				}
			}
		} else if s.Executions > 1 {
			ex = f.execs(s.ID)
			for j := range ex {
				c := &m.Calls[ex[j].Exec]
				if c.PLH == 0 {
					continue
				}
				a := get(uint64(c.PLH), int(c.Line))
				a.execs++
				a.elapsed += ex[j].Stats.Elapsed
			}
		}
		if len(agg) < 2 {
			continue
		}
		sort.SliceStable(order, func(a, b int) bool { return agg[order[a]].firstLine < agg[order[b]].firstLine })
		sev := SeverityNotable
		var minAvg, maxAvg float64 = -1, 0
		for _, h := range order {
			a := agg[h]
			if a.execs == 0 {
				continue
			}
			avg := float64(a.elapsed) / float64(a.execs)
			if minAvg < 0 || avg < minAvg {
				minAvg = avg
			}
			if avg > maxAvg {
				maxAvg = avg
			}
		}
		if minAvg > 0 && maxAvg >= f.th.OutlierFactor*minAvg && s.Elapsed >= f.th.NotableMinUs {
			sev = SeveritySerious
		}
		var hs []string
		for _, h := range order {
			hs = append(hs, fmt.Sprint(h))
		}
		x := Finding{
			Rule: RulePlanChange, Title: "Plan change", Statement: s.ID, Severity: sev, ImpactUs: s.Elapsed,
			Summary: fmt.Sprintf("%s: %d plans (plan hash %s)", f.label(s.ID), len(order), strings.Join(hs, ", ")),
		}
		if minAvg > 0 && maxAvg > minAvg {
			x.Summary += fmt.Sprintf("; slowest plan %.1fx the fastest per execution", maxAvg/minAvg)
		}
		for _, h := range order {
			a := agg[h]
			var parts []string
			if a.execs > 0 {
				parts = append(parts, fmt.Sprintf("%d executions, avg %s", a.execs, fmtUs(a.elapsed/a.execs)))
			}
			if a.dumps > 0 {
				parts = append(parts, fmt.Sprintf("%d STAT dumps, last at line %d", a.dumps, a.line))
			} else {
				parts = append(parts, "no STAT dump")
			}
			r := stmtRow(s.ID, fmt.Sprintf("plan %d", h), strings.Join(parts, "; "))
			r.Line, r.Us = a.firstLine, a.elapsed
			if a.dumps > 0 {
				r.Line = a.line
			}
			x.Evidence = append(x.Evidence, r)
		}
		f.add(x)
	}
}

// ---- parse and cursor churn -------------------------------------------------

// hardParses: trace-level. Fires when a statement with more than
// HardParseMinExecs executions hard parses on more than HardParseRatio of
// them, or trace-wide when at least HardParseMinTotal hard parses happen on
// more than HardParseRatio of all executions. Hard parse = library cache miss
// on PARSE (StmtStats.HardParses; 19c usually reports the same miss again on
// the first EXEC, so EXEC misses are not added). Severity by the
// elapsed time of the missing calls; at least notable when a single
// statement qualifies (repeated hard parses of one sql_id point at
// invalidations or cursor sharing failures).
func (f *finder) hardParses() {
	m := f.m
	missUs := make([]int64, len(f.stats))
	switch {
	case f.sc != nil:
		copy(missUs, f.sc.missUs)
	case f.acc != nil:
		for i := range missUs {
			if s := f.acc.acc(model.ID(i)); s != nil {
				missUs[i] = s.missUs
			}
		}
	default:
		for i := range m.Calls {
			c := &m.Calls[i]
			if c.Mis > 0 && c.Kind == trace.CallParse && !m.PXChild(c.Context) {
				missUs[c.Statement] += c.E
			}
		}
	}
	var hp, ex, impact int64
	var ids, single []model.ID
	for i := range f.stats {
		s := &f.stats[i]
		if !f.isSQL(s.ID) {
			continue
		}
		n := s.HardParses
		hp += n
		ex += s.Executions
		impact += missUs[i]
		if n > 0 {
			ids = append(ids, s.ID)
		}
		if s.Executions > f.th.HardParseMinExecs && float64(n)/float64(s.Executions) > f.th.HardParseRatio {
			single = append(single, s.ID)
		}
	}
	traceWide := hp >= f.th.HardParseMinTotal && ex > 0 && float64(hp)/float64(ex) > f.th.HardParseRatio
	if !traceWide && len(single) == 0 {
		return
	}
	misses := func(id model.ID) int64 { return f.stats[id].HardParses }
	isSingle := map[model.ID]bool{}
	for _, id := range single {
		isSingle[id] = true
	}
	sort.SliceStable(ids, func(a, b int) bool {
		if isSingle[ids[a]] != isSingle[ids[b]] {
			return isSingle[ids[a]]
		}
		if misses(ids[a]) != misses(ids[b]) {
			return misses(ids[a]) > misses(ids[b])
		}
		return missUs[ids[a]] > missUs[ids[b]]
	})
	once := 0
	for _, id := range ids {
		if misses(id) == 1 && f.stats[id].Executions <= 1 {
			once++
		}
	}
	x := Finding{Rule: RuleHardParses, Title: "Hard parses", Statement: model.None, ImpactUs: impact, Severity: f.timeSeverity(impact, f.total)}
	if len(single) > 0 {
		x.Severity = atLeast(x.Severity, SeverityNotable)
	}
	if traceWide {
		x.Summary = fmt.Sprintf("%d hard parses / %d executions (%.0f%%) in %d statements; %s in hard-parsing calls", hp, ex, 100*float64(hp)/float64(ex), len(ids), fmtUs(impact))
		if once > len(ids)/2 {
			x.Summary += fmt.Sprintf("; %d statements executed once", once)
		}
	} else {
		x.Summary = fmt.Sprintf("%d statements hard parsed on most executions", len(single))
	}
	if len(single) == 1 {
		x.Statement = single[0]
	}
	for k, id := range ids {
		if k == f.th.MaxEvidenceRows {
			x.Evidence = append(x.Evidence, row("...", fmt.Sprintf("%d more statements with hard parses", len(ids)-k)))
			break
		}
		s := &f.stats[id]
		r := stmtRow(id, f.label(id), fmt.Sprintf("%d hard parses / %d executions, %s", misses(id), s.Executions, fmtUs(missUs[id])))
		r.Us = missUs[id]
		x.Evidence = append(x.Evidence, r)
	}
	f.add(x)
}

func (f *finder) closeTypes() [][4]int64 {
	m := f.m
	if f.sc != nil {
		return f.sc.closes
	}
	out := make([][4]int64, len(m.Statements))
	if f.acc != nil {
		for i := range out {
			if s := f.acc.acc(model.ID(i)); s != nil {
				out[i] = s.closes
			}
		}
		return out
	}
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Kind == trace.CallClose && c.Type >= 0 && c.Type < 4 && !m.PXChild(c.Context) {
			out[c.Statement][c.Type]++
		}
	}
	return out
}

func closeSummary(t [4]int64) string {
	var parts []string
	names := [4]string{"hard (type 0)", "to session cursor cache (type 1)", "to PL/SQL cursor cache (type 2)", "already cached (type 3)"}
	for i, n := range t {
		if n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, names[i]))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "closes: " + strings.Join(parts, ", ")
}

// parsePerExec: trace-level, one evidence row per statement with more than
// ParseExecMinExecs executions and more than ParseExecRatio PARSE calls per
// execution. Severity by the parse elapsed time of those statements.
func (f *finder) parsePerExec() {
	var ids []model.ID
	var impact, parses, execs int64
	for i := range f.stats {
		s := &f.stats[i]
		if !f.isSQL(s.ID) || s.Executions <= f.th.ParseExecMinExecs {
			continue
		}
		if float64(s.Parse.Count)/float64(s.Executions) > f.th.ParseExecRatio {
			ids = append(ids, s.ID)
			impact += s.Parse.Elapsed
			parses += s.Parse.Count
			execs += s.Executions
		}
	}
	if len(ids) == 0 {
		return
	}
	sort.SliceStable(ids, func(a, b int) bool { return f.stats[ids[a]].Parse.Count > f.stats[ids[b]].Parse.Count })
	ct := f.closeTypes()
	x := Finding{Rule: RuleParsePerExec, Title: "Parse per execution", Statement: model.None, ImpactUs: impact, Severity: f.timeSeverity(impact, f.total),
		Summary: fmt.Sprintf("%d statements: %d parses / %d executions, %s parsing", len(ids), parses, execs, fmtUs(impact))}
	if len(ids) == 1 {
		x.Statement = ids[0]
		x.Summary = fmt.Sprintf("%s: %d parses / %d executions, %s parsing", f.label(ids[0]), parses, execs, fmtUs(impact))
	}
	for k, id := range ids {
		if k == f.th.MaxEvidenceRows {
			x.Evidence = append(x.Evidence, row("...", fmt.Sprintf("%d more statements", len(ids)-k)))
			break
		}
		s := &f.stats[id]
		v := fmt.Sprintf("%d parses / %d executions (%.2f), %s parsing", s.Parse.Count, s.Executions, float64(s.Parse.Count)/float64(s.Executions), fmtUs(s.Parse.Elapsed))
		if c := closeSummary(ct[id]); c != "" {
			v += "; " + c
		}
		r := stmtRow(id, f.label(id), v)
		r.Us = s.Parse.Elapsed
		x.Evidence = append(x.Evidence, r)
	}
	f.add(x)
}

// hardCloses: trace-level. Counts CLOSE type=0 of statements parsed at least
// HardCloseMinParses times whose closes are more than HardCloseShare type 0;
// fires above HardCloseMinCount. Severity by count (countSeverity).
func (f *finder) hardCloses() {
	ct := f.closeTypes()
	var ids []model.ID
	var n int64
	for i := range f.stats {
		s := &f.stats[i]
		t := ct[i]
		all := t[0] + t[1] + t[2] + t[3]
		if !f.isSQL(s.ID) || s.Parse.Count < f.th.HardCloseMinParses || all == 0 {
			continue
		}
		if float64(t[0])/float64(all) > f.th.HardCloseShare {
			ids = append(ids, s.ID)
			n += t[0]
		}
	}
	if n <= f.th.HardCloseMinCount {
		return
	}
	sort.SliceStable(ids, func(a, b int) bool { return ct[ids[a]][0] > ct[ids[b]][0] })
	x := Finding{Rule: RuleHardCloses, Title: "Hard closes", Statement: model.None, Severity: f.countSeverity(n),
		Summary: fmt.Sprintf("%d hard closes (CLOSE type=0) in %d repeatedly parsed statements", n, len(ids))}
	if len(ids) == 1 {
		x.Statement = ids[0]
	}
	for k, id := range ids {
		if k == f.th.MaxEvidenceRows {
			x.Evidence = append(x.Evidence, row("...", fmt.Sprintf("%d more statements", len(ids)-k)))
			break
		}
		x.Evidence = append(x.Evidence, stmtRow(id, f.label(id), fmt.Sprintf("%d parses; %s", f.stats[id].Parse.Count, closeSummary(ct[id]))))
	}
	f.add(x)
}

// ---- client-side time -------------------------------------------------------

// inCallIdleWait reports whether w is an idle wait that happened inside the
// time window of the call it is attributed to (the builder leaves it not
// Between): the session slept or waited inside the call (dbms_session.sleep,
// a PX dequeue in a slave call) rather than waiting for the next call.
func inCallIdleWait(w *model.Wait) bool {
	return w.Idle && !w.Between && w.Call != model.None
}

// idleSplit sums the idle/between-call waits of the trace into think time
// (between calls) and in-call idle time, in total and by event and statement.
type idleSplit struct {
	us      int64
	n       map[model.ID]int64 // waits by event
	byEvent map[model.ID]int64
	byStmt  map[model.ID]int64
}

func (f *finder) splitIdle() (think, inCall idleSplit) {
	mk := func() idleSplit {
		return idleSplit{n: map[model.ID]int64{}, byEvent: map[model.ID]int64{}, byStmt: map[model.ID]int64{}}
	}
	if f.sc != nil {
		return f.sc.think, f.sc.inCall
	}
	think, inCall = mk(), mk()
	if f.acc != nil {
		conv := func(a *idleAcc) idleSplit {
			o := idleSplit{us: a.us, n: a.n, byEvent: a.byEvent, byStmt: make(map[model.ID]int64, len(a.byStmt))}
			for sl, v := range a.byStmt {
				o.byStmt[model.ID(sl)] = v
			}
			return o
		}
		return conv(&f.acc.think), conv(&f.acc.inCall)
	}
	for i := range f.m.Waits {
		w := &f.m.Waits[i]
		if !w.Idle && !w.Between {
			continue
		}
		a := &think
		if inCallIdleWait(w) {
			a = &inCall
		}
		a.us += w.Ela
		if f.m.Events[w.Event].Idle { // evidence lists idle events only
			a.n[w.Event]++
			a.byEvent[w.Event] += w.Ela
		}
		if w.Statement != model.None {
			a.byStmt[w.Statement] += w.Ela
		}
	}
	return think, inCall
}

// topIDs returns the keys of m by descending value (ties by id), at most k.
func topIDs(m map[model.ID]int64, k int) []model.ID {
	ids := make([]model.ID, 0, len(m))
	for id, v := range m {
		if v > 0 {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(a, b int) bool {
		if m[ids[a]] != m[ids[b]] {
			return m[ids[a]] > m[ids[b]]
		}
		return ids[a] < ids[b]
	})
	if len(ids) > k {
		ids = ids[:k]
	}
	return ids
}

// thinkTime: trace-level, idle time between calls (waits outside any call:
// SQL*Net message from client, ...; in-call idle waits are the separate
// in-call-idle finding) above ThinkTimeShare of response time. Evidence: the
// top idle events and statements. Severity by the idle time (timeSeverity).
func (f *finder) thinkTime() {
	think, _ := f.splitIdle()
	idle := think.us
	if f.total <= 0 || float64(idle)/float64(f.total) <= f.th.ThinkTimeShare {
		return
	}
	x := Finding{Rule: RuleThinkTime, Title: "Think time", Statement: model.None, ImpactUs: idle, Severity: f.timeSeverity(idle, f.total),
		Summary: fmt.Sprintf("%s of %s response time (%.0f%%) idle between calls", fmtUs(idle), fmtUs(f.total), 100*float64(idle)/float64(f.total))}
	f.idleEvidence(&x, think, 3, 5)
	f.add(x)
}

// inCallIdle: trace-level, idle waits inside calls (PL/SQL lock timer from
// dbms_session.sleep, ...) above InCallIdleShare of response time. Always
// info: it is time the call spent sleeping, not work or client think time.
func (f *finder) inCallIdle() {
	_, in := f.splitIdle()
	if f.total <= 0 || in.us == 0 || float64(in.us)/float64(f.total) <= f.th.InCallIdleShare {
		return
	}
	x := Finding{Rule: RuleInCallIdle, Title: "Idle waits inside calls", Statement: model.None, ImpactUs: in.us, Severity: SeverityInfo,
		Summary: fmt.Sprintf("%s of %s response time (%.0f%%) idle inside calls (PL/SQL lock timer, dequeue); included in call elapsed", fmtUs(in.us), fmtUs(f.total), 100*float64(in.us)/float64(f.total))}
	f.idleEvidence(&x, in, 3, 5)
	f.add(x)
}

func (f *finder) idleEvidence(x *Finding, a idleSplit, nEvents, nStmts int) {
	for _, ev := range topIDs(a.byEvent, nEvents) {
		us := a.byEvent[ev]
		rr := row(f.m.Events[ev].Name, fmt.Sprintf("%s in %d waits (%.0f%%)", fmtUs(us), a.n[ev], 100*float64(us)/float64(f.total)))
		rr.Us = us
		x.Evidence = append(x.Evidence, rr)
	}
	for _, id := range topIDs(a.byStmt, nStmts) {
		s := &f.stats[id]
		r := stmtRow(id, f.label(id), fmt.Sprintf("%s idle (%.0f%% of response time); %s elapsed in calls", fmtUs(a.byStmt[id]), 100*float64(a.byStmt[id])/float64(f.total), fmtUs(s.Elapsed)))
		r.Us = a.byStmt[id]
		x.Evidence = append(x.Evidence, r)
	}
}

// smallFetches: per statement, executions with at least
// SmallFetchMinFetchesPerExec fetches averaging fewer than SmallFetchRows
// rows per fetch; fires when those executions made more than
// SmallFetchMinFetches fetches and returned more than SmallFetchMinRows rows.
// Impact: the fetch calls' elapsed plus the idle time before them (round
// trips); timeSeverity.
func (f *finder) smallFetches() {
	m := f.m
	for i := range f.stats {
		s := &f.stats[i]
		if !f.isSQL(s.ID) || s.Fetch.Count <= f.th.SmallFetchMinFetches || s.Fetch.Rows <= f.th.SmallFetchMinRows {
			continue
		}
		if f.acc != nil {
			f.smallFetchesAgg(s)
			continue
		}
		ex := f.execs(s.ID)
		var nEx, fetches, rows, impact int64
		var firstRow *Execution
		for j := range ex {
			e := &ex[j]
			nf := int64(len(e.Fetches))
			if nf < f.th.SmallFetchMinFetchesPerExec {
				continue
			}
			var r int64
			for _, cid := range e.Fetches {
				r += m.Calls[cid].R
			}
			if float64(r)/float64(nf) >= f.th.SmallFetchRows {
				continue
			}
			nEx++
			fetches += nf
			rows += r
			for _, cid := range e.Fetches {
				impact += m.Calls[cid].E + m.Calls[cid].IdleEla
			}
			if firstRow == nil {
				firstRow = e
			}
		}
		if fetches <= f.th.SmallFetchMinFetches || rows <= f.th.SmallFetchMinRows {
			continue
		}
		avg := float64(rows) / float64(fetches)
		x := Finding{Rule: RuleSmallFetches, Title: "Small fetches", Statement: s.ID, ImpactUs: impact, Severity: f.timeSeverity(impact, f.total),
			Summary: fmt.Sprintf("%s: %.1f rows per fetch; %d fetches, %d rows in %d of %d executions; %s in these fetches and preceding round trips",
				f.label(s.ID), avg, fetches, rows, nEx, len(ex), fmtUs(impact))}
		x.Evidence = append(x.Evidence,
			stmtRow(s.ID, "small-fetch executions", fmt.Sprintf("%d of %d (at least %d fetches, under %g rows per fetch)", nEx, len(ex), f.th.SmallFetchMinFetchesPerExec, f.th.SmallFetchRows)),
			stmtRow(s.ID, "fetches / rows", fmt.Sprintf("%d / %d (%.1f rows per fetch)", fetches, rows, avg)),
			stmtRow(s.ID, "whole statement", fmt.Sprintf("%d fetches / %d rows (%.1f rows per fetch)", s.Fetch.Count, s.Fetch.Rows, float64(s.Fetch.Rows)/float64(s.Fetch.Count))),
		)
		if firstRow != nil {
			r := stmtRow(s.ID, fmt.Sprintf("exec %d", firstRow.ExecNo), fmt.Sprintf("first: %d fetches, %d rows, %s", len(firstRow.Fetches), firstRow.Stats.Rows, fmtUs(firstRow.Stats.Elapsed)))
			r.Cursor, r.ExecNo, r.Call, r.Line, r.Us = firstRow.Cursor, firstRow.ExecNo, firstRow.Exec, int(m.Calls[firstRow.Exec].Line), firstRow.Stats.Elapsed
			x.Evidence = append(x.Evidence, r)
		}
		f.add(x)
	}
}

// isDML: INSERT, UPDATE, DELETE, MERGE (Oracle command types).
func isDML(oct int) bool { return oct == 2 || oct == 6 || oct == 7 || oct == 189 }

func (f *finder) eventUs(name string) (us, n int64) {
	if f.sc != nil {
		for i := range f.m.Events {
			if f.m.Events[i].Name == name {
				us += f.sc.events[i].us
				n += f.sc.events[i].n
			}
		}
		return
	}
	if f.acc != nil {
		for i := range f.m.Events {
			if f.m.Events[i].Name == name && i < len(f.acc.main.events) {
				us += f.acc.main.events[i].us
				n += f.acc.main.events[i].n
			}
		}
		return
	}
	for i := range f.m.Waits {
		w := &f.m.Waits[i]
		if f.m.Events[w.Event].Name == name && !f.m.PXChild(w.Context) {
			us += w.Ela
			n++
		}
	}
	return
}

// commitPerRow: trace-level, more than CommitMinCount commits (XCTEND rlbk=0
// rd_only=0) at more than CommitPerDMLRatio commits per DML execution.
// Impact: "log file sync" time; at least notable.
func (f *finder) commitPerRow() {
	var commits int64
	for i := range f.m.Transactions {
		t := &f.m.Transactions[i]
		if t.Rlbk == 0 && t.RdOnly == 0 && (f.sc == nil || f.sc.txIn(t)) {
			commits++
		}
	}
	if commits <= f.th.CommitMinCount {
		return
	}
	var dmlExecs, dmlRows int64
	var ids []model.ID
	for i := range f.stats {
		s := &f.stats[i]
		if f.m.Statements[i].Kind == model.StmtSQL && isDML(f.m.Statements[i].OCT) && s.Executions > 0 {
			dmlExecs += s.Executions
			dmlRows += s.Exec.Rows
			ids = append(ids, s.ID)
		}
	}
	if dmlExecs == 0 || float64(commits)/float64(dmlExecs) <= f.th.CommitPerDMLRatio {
		return
	}
	lfs, nlfs := f.eventUs("log file sync")
	x := Finding{Rule: RuleCommitPerRow, Title: "Commit per row", Statement: model.None, ImpactUs: lfs,
		Severity: atLeast(f.timeSeverity(lfs, f.total), SeverityNotable),
		Summary:  fmt.Sprintf("%d commits / %d DML executions (%d rows); %s log file sync", commits, dmlExecs, dmlRows, fmtUs(lfs))}
	x.Evidence = append(x.Evidence,
		row("commits", fmt.Sprintf("%d (read-write, XCTEND rlbk=0 rd_only=0)", commits)),
		row("DML executions", fmt.Sprintf("%d INSERT/UPDATE/DELETE/MERGE executions, %d rows, %.2f commits per execution", dmlExecs, dmlRows, float64(commits)/float64(dmlExecs))),
	)
	if nlfs > 0 {
		r := row("log file sync", fmt.Sprintf("%s in %d waits", fmtUs(lfs), nlfs))
		r.Us = lfs
		x.Evidence = append(x.Evidence, r)
	}
	sort.SliceStable(ids, func(a, b int) bool { return f.stats[ids[a]].Executions > f.stats[ids[b]].Executions })
	for k, id := range ids {
		if k == 5 {
			break
		}
		s := &f.stats[id]
		x.Evidence = append(x.Evidence, stmtRow(id, f.label(id), fmt.Sprintf("%d executions, %d rows", s.Executions, s.Exec.Rows)))
	}
	f.add(x)
}

// roundTrips: trace-level, more than RoundTripsMin "SQL*Net message to
// client" waits at more than RoundTripsPerRow per row of the top-level calls.
// Severity by round-trip count (countSeverity).
func (f *finder) roundTrips() {
	trips, _ := f.eventUs("SQL*Net message to client")
	if trips <= f.th.RoundTripsMin {
		return
	}
	var rows int64
	switch {
	case f.sc != nil:
		rows = f.sc.topRows
	case f.acc != nil:
		rows = f.acc.topRows
	default:
		for i := range f.m.Calls {
			c := &f.m.Calls[i]
			if c.Parent == model.None && (c.Kind == trace.CallExec || c.Kind == trace.CallFetch) {
				rows += c.R
			}
		}
	}
	ratio := float64(trips) / float64(max(rows, 1))
	if ratio <= f.th.RoundTripsPerRow {
		return
	}
	fromUs, fromN := f.eventUs("SQL*Net message from client")
	x := Finding{Rule: RuleRoundTrips, Title: "Round trips per row", Statement: model.None, ImpactUs: fromUs, Severity: f.countSeverity(trips),
		Summary: fmt.Sprintf("%d SQL*Net round trips / %d rows (%.2f per row)", trips, rows, ratio)}
	x.Evidence = append(x.Evidence,
		row("SQL*Net message to client", fmt.Sprintf("%d waits", trips)),
		row("rows", fmt.Sprintf("%d (top-level calls)", rows)),
	)
	if fromN > 0 {
		r := row("SQL*Net message from client", fmt.Sprintf("%s in %d waits (avg %s)", fmtUs(fromUs), fromN, fmtUs(fromUs/fromN)))
		r.Us = fromUs
		x.Evidence = append(x.Evidence, r)
	}
	f.add(x)
}

// fmtUs formats microseconds for summaries: us, ms or s (ASCII only).
func fmtUs(us int64) string {
	switch {
	case us < 1000 && us > -1000:
		return fmt.Sprintf("%d us", us)
	case us < 1_000_000 && us > -1_000_000:
		return fmt.Sprintf("%.1f ms", float64(us)/1e3)
	}
	return fmt.Sprintf("%.3f s", float64(us)/1e6)
}
