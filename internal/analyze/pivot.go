package analyze

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Fact selects the fact table a pivot groups.
type Fact int

const (
	FactCalls Fact = iota
	FactWaits
)

func (f Fact) String() string {
	if f == FactWaits {
		return "waits"
	}
	return "calls"
}

// ParseFact accepts "calls" or "waits".
func ParseFact(s string) (Fact, error) {
	switch strings.ToLower(s) {
	case "calls", "call", "c":
		return FactCalls, nil
	case "waits", "wait", "w":
		return FactWaits, nil
	}
	return 0, fmt.Errorf("unknown fact %q (calls|waits)", s)
}

// Filter restricts the fact rows a pivot sees; it mirrors the UI's
// callFilter / waitFilter (web/src/app/store.ts). A row is in the window when
// its [tim-ela, tim] interval overlaps [StartTim, EndTim].
type Filter struct {
	StartTim, EndTim int64      // tim range, 0 = unbounded
	Contexts         []model.ID // session contexts; empty = all
	IncludeIdle      bool       // waits only: keep events of the Idle class
	Statement        *model.ID  // only rows of this statement (nil = all)
	Event            *model.ID  // waits only: only this event (nil = all)
}

// Matcher is a compiled Filter: the context set is built once.
type Matcher struct {
	f    Filter
	ctxs map[model.ID]bool
}

// Matcher compiles the filter for use over many rows.
func (f Filter) Matcher() *Matcher {
	mt := &Matcher{f: f}
	if len(f.Contexts) > 0 {
		mt.ctxs = make(map[model.ID]bool, len(f.Contexts))
		for _, c := range f.Contexts {
			mt.ctxs[c] = true
		}
	}
	return mt
}

func (mt *Matcher) inWindow(tim, ela int64) bool {
	if mt.f.EndTim != 0 && tim-ela > mt.f.EndTim {
		return false
	}
	if mt.f.StartTim != 0 && tim < mt.f.StartTim {
		return false
	}
	return true
}

// Call reports whether the call is in scope (Event is ignored: calls have none).
func (mt *Matcher) Call(c *model.Call) bool {
	if !mt.inWindow(c.Tim, c.E) || (mt.ctxs != nil && !mt.ctxs[c.Context]) {
		return false
	}
	return mt.f.Statement == nil || c.Statement == *mt.f.Statement
}

// Wait reports whether the wait is in scope.
func (mt *Matcher) Wait(w *model.Wait) bool {
	if (!mt.f.IncludeIdle && w.Idle) || !mt.inWindow(w.Tim, w.Ela) || (mt.ctxs != nil && !mt.ctxs[w.Context]) {
		return false
	}
	if mt.f.Statement != nil && w.Statement != *mt.f.Statement {
		return false
	}
	return mt.f.Event == nil || w.Event == *mt.f.Event
}

// Dim describes a pivot dimension. Extra names a second, descriptive column
// (statement text, wait class) that some dimensions carry.
type Dim struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Extra string `json:"extra,omitempty"`
}

// Measure describes a pivot measure. Unit is "us" for time (values are
// microseconds), "" for counts and "%" for shares.
type Measure struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Unit  string `json:"unit"`
	Title string `json:"title,omitempty"`
}

// Same ids, order and meaning as callDims / waitDims / callMeasures /
// waitMeasures in web/src/views/Pivot.tsx.
var (
	callDimList = []Dim{
		{"stmt", "Statement", "Text"}, {"kind", "Call kind", ""}, {"dep", "Recursive depth", ""},
		{"session", "Session", ""}, {"module", "Module", ""}, {"action", "Action", ""},
		{"client", "Client id", ""}, {"service", "Service", ""}, {"plh", "Plan hash", ""},
		{"execNo", "Execution #", ""}, {"cursor", "Cursor", ""}, {"closeType", "Close type", ""},
		{"time", "Time bucket", ""}, {"og", "Optimizer goal", ""},
	}
	waitDimList = []Dim{
		{"event", "Event", "Class"}, {"class", "Wait class", ""}, {"stmt", "Statement", "Text"},
		{"obj", "Object", ""}, {"p1", "p1 (by event)", ""}, {"p2", "p2 (by event)", ""},
		{"between", "Inside / between calls", ""}, {"idle", "Idle / non-idle", ""}, {"dep", "Recursive depth", ""},
		{"session", "Session", ""}, {"module", "Module", ""}, {"action", "Action", ""},
		{"client", "Client id", ""}, {"service", "Service", ""}, {"callKind", "Call kind (attributed call)", ""},
		{"time", "Time bucket", ""},
	}
	callMeasureList = []Measure{
		{"count", "Calls", "", ""},
		{"e", "Elapsed", "us", "Σ e= (includes recursive children)"},
		{"selfE", "Self elapsed", "us", "Σ elapsed minus recursive children"},
		{"c", "CPU", "us", ""},
		{"selfC", "Self CPU", "us", ""},
		{"p", "Disk", "", "Σ p= physical reads"},
		{"cr", "Query", "", "Σ cr= consistent gets"},
		{"cu", "Current", "", "Σ cu= current gets"},
		{"r", "Rows", "", ""},
		{"mis", "Misses", "", "Σ mis= library cache misses"},
		{"wait", "In-call waits", "us", ""},
		{"idle", "Idle", "us", "waits between calls attributed to these calls"},
		{"avgE", "Avg elapsed", "us", ""},
		{"maxE", "Max elapsed", "us", ""},
	}
	waitMeasureList = []Measure{
		{"count", "Waits", "", ""},
		{"ela", "Time", "us", ""},
		{"avg", "Avg", "us", ""},
		{"min", "Min", "us", ""},
		{"max", "Max", "us", ""},
		{"share", "Share", "%", "share of all wait time in scope"},
	}
)

// Dims lists the dimensions of a fact table.
func Dims(f Fact) []Dim {
	if f == FactWaits {
		return waitDimList
	}
	return callDimList
}

// Measures lists the measures of a fact table.
func Measures(f Fact) []Measure {
	if f == FactWaits {
		return waitMeasureList
	}
	return callMeasureList
}

// DefaultMeasure is the measure the UI sorts by initially.
func DefaultMeasure(f Fact) string {
	if f == FactWaits {
		return "ela"
	}
	return "e"
}

// MeasureIndex returns the position of measure id in Measures(f), or -1.
func MeasureIndex(f Fact, id string) int {
	for i, m := range Measures(f) {
		if m.ID == id {
			return i
		}
	}
	return -1
}

// PivotRow is one group. Keys are the raw dimension keys (negative = none),
// Labels the display names, Extra the descriptive column of dimensions that
// have one ("" otherwise). Values are indexed like PivotResult.Measures.
type PivotRow struct {
	Keys   []int64   `json:"keys"`
	Labels []string  `json:"labels"`
	Extra  []string  `json:"extra"`
	Values []float64 `json:"values"`
}

// PivotResult is a grouped fact table.
type PivotResult struct {
	Fact     Fact       `json:"fact"`
	Dims     []Dim      `json:"dims"`
	Measures []Measure  `json:"measures"`
	Rows     []PivotRow `json:"rows"`
	Total    []float64  `json:"total"` // measures over every row in scope
	Facts    int        `json:"facts"` // fact rows in scope
	BucketUs int64      `json:"bucketUs"`
}

// SortBy orders the rows by a measure, descending; ties by label.
func (r *PivotResult) SortBy(measure string) error {
	k := MeasureIndex(r.Fact, measure)
	if k < 0 {
		return fmt.Errorf("unknown %s measure %q", r.Fact, measure)
	}
	sort.SliceStable(r.Rows, func(a, b int) bool {
		va, vb := r.Rows[a].Values[k], r.Rows[b].Values[k]
		if va != vb {
			return va > vb
		}
		return strings.Join(r.Rows[a].Labels, "\x00") < strings.Join(r.Rows[b].Labels, "\x00")
	})
	return nil
}

// Project keeps only the measures with the given ids, in that order (rows and
// totals included). The "share" measure is computed before, over all rows.
func (r *PivotResult) Project(ids []string) {
	idx := make([]int, len(ids))
	ms := make([]Measure, len(ids))
	for i, id := range ids {
		idx[i] = MeasureIndex(r.Fact, id)
		ms[i] = Measures(r.Fact)[idx[i]]
	}
	pick := func(v []float64) []float64 {
		out := make([]float64, len(idx))
		for i, k := range idx {
			out[i] = v[k]
		}
		return out
	}
	r.Measures = ms
	r.Total = pick(r.Total)
	for i := range r.Rows {
		r.Rows[i].Values = pick(r.Rows[i].Values)
	}
}

// dimImpl resolves a dimension for the rows of one model.
type dimImpl struct {
	Dim
	key   func(r factRow) int64
	name  func(k int64) string
	extra func(k int64) string
}

// factRow is the fact row a dimension keys: r.c for a calls pivot, r.w for waits.
type factRow struct {
	c *model.Call
	w *model.Wait
}

// interner hands out dense ids for arbitrary comparable keys.
type interner[K comparable] struct {
	ids  map[K]int64
	keys []K
}

func newInterner[K comparable]() *interner[K] { return &interner[K]{ids: map[K]int64{}} }

func (n *interner[K]) id(k K) int64 {
	if v, ok := n.ids[k]; ok {
		return v
	}
	v := int64(len(n.keys))
	n.keys = append(n.keys, k)
	n.ids[k] = v
	return v
}

// SessionName is how the UI labels a context's session.
func SessionName(c *model.Context) string {
	if c.SessionID != "" {
		return c.SessionID
	}
	if c.Process != "" {
		return "pid " + c.Process
	}
	return "(unknown session)"
}

func ctxDim(m *model.Model, d Dim, ctx func(r factRow) model.ID, get func(c *model.Context) string, none string) dimImpl {
	names := newInterner[string]()
	keyOf := make([]int64, len(m.Contexts))
	for i := range m.Contexts {
		v := get(&m.Contexts[i])
		if v == "" {
			v = none
		}
		keyOf[i] = names.id(v)
	}
	return dimImpl{Dim: d,
		key: func(r factRow) int64 {
			c := ctx(r)
			if c < 0 || int(c) >= len(keyOf) {
				return -1
			}
			return keyOf[c]
		},
		name: func(k int64) string {
			if k < 0 {
				return none
			}
			return names.keys[k]
		},
	}
}

// Zone returns the time zone the trace file was written in (UTC if unknown).
func Zone(m *model.Model) *time.Location {
	for _, mk := range m.Markers {
		if mk.HasTime {
			return mk.Time.Location()
		}
	}
	return time.UTC
}

// TimeLabel formats a tim value like the UI: wall clock HH:MM:SS.mmm in the
// trace's zone, or "+<seconds>" from the trace start without a time anchor.
func TimeLabel(m *model.Model, tim int64) string {
	if w := m.WallOf(tim); w != 0 {
		return time.UnixMicro(w).In(Zone(m)).Format("15:04:05.000")
	}
	return fmt.Sprintf("+%.3fs", float64(tim-m.Span.FirstTim)/1e6)
}

func timeDim(m *model.Model, d Dim, tim func(r factRow) int64) dimImpl {
	bucket := TimelineBucket(m)
	base := m.Span.FirstTim
	if bucket > 0 {
		d.Label = fmt.Sprintf("Time (%s buckets)", fmtBucket(bucket))
	}
	return dimImpl{Dim: d,
		key: func(r factRow) int64 {
			t := tim(r)
			if t <= 0 || bucket <= 0 || t < base {
				return -1
			}
			return (t - base) / bucket
		},
		name: func(k int64) string {
			if k < 0 {
				return "(no time)"
			}
			return TimeLabel(m, base+k*bucket)
		},
	}
}

func fmtBucket(us int64) string {
	switch {
	case us%3600000000 == 0:
		return fmt.Sprintf("%dh", us/3600000000)
	case us%60000000 == 0:
		return fmt.Sprintf("%dmin", us/60000000)
	case us%1000000 == 0:
		return fmt.Sprintf("%ds", us/1000000)
	case us%1000 == 0:
		return fmt.Sprintf("%dms", us/1000)
	}
	return fmt.Sprintf("%dµs", us)
}

// StatementLabel is the UI's short name of a statement (sql_id or kind).
func StatementLabel(st *model.Statement) string {
	switch st.Kind {
	case model.StmtSQL:
		if st.SQLID != "" {
			return st.SQLID
		}
		return fmt.Sprintf("hv:%d", st.HV)
	case model.StmtParseError:
		return "parse error"
	}
	return st.Kind.String()
}

// Preview collapses text to one line of at most max bytes.
func Preview(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	if max < 4 {
		return s[:max]
	}
	cut := max - 3
	for cut > 0 && s[cut]&0xC0 == 0x80 { // do not split a UTF-8 sequence
		cut--
	}
	return s[:cut] + "..."
}

func stmtDim(m *model.Model, d Dim, stmt func(r factRow) model.ID, none string) dimImpl {
	return dimImpl{Dim: d,
		key: func(r factRow) int64 { return int64(stmt(r)) },
		name: func(k int64) string {
			if k < 0 || int(k) >= len(m.Statements) {
				return none
			}
			return StatementLabel(&m.Statements[k])
		},
		extra: func(k int64) string {
			if k < 0 || int(k) >= len(m.Statements) {
				return ""
			}
			return Preview(m.Statements[k].Text, 70)
		},
	}
}

func intName(prefix, none string, minValid int64) func(int64) string {
	return func(k int64) string {
		if k < minValid {
			return none
		}
		return prefix + fmt.Sprint(k)
	}
}

var closeTypeNames = map[int64]string{0: "hard close", 1: "cached (new)", 2: "cached (replaced)", 3: "cached (again)"}
var ogNames = map[int64]string{1: "ALL_ROWS", 2: "FIRST_ROWS", 3: "RULE", 4: "CHOOSE"}

func kindName(k int64) string {
	if k < 0 {
		return "unattributed"
	}
	return trace.CallKind(k).String()
}

func callDims(m *model.Model) map[string]dimImpl {
	ctx := func(r factRow) model.ID { return r.c.Context }
	d := func(id string) Dim {
		for _, x := range callDimList {
			if x.ID == id {
				return x
			}
		}
		panic("pivot: no call dim " + id)
	}
	plh := newInterner[uint64]()
	out := []dimImpl{
		stmtDim(m, d("stmt"), func(r factRow) model.ID { return r.c.Statement }, "(no statement)"),
		{Dim: d("kind"), key: func(r factRow) int64 { return int64(r.c.Kind) }, name: kindName},
		{Dim: d("dep"), key: func(r factRow) int64 { return int64(r.c.Dep) }, name: intName("dep ", "(none)", 0)},
		ctxDim(m, d("session"), ctx, func(x *model.Context) string { return SessionName(x) }, "(no session)"),
		ctxDim(m, d("module"), ctx, func(x *model.Context) string { return x.Module }, "(no module)"),
		ctxDim(m, d("action"), ctx, func(x *model.Context) string { return x.Action }, "(no action)"),
		ctxDim(m, d("client"), ctx, func(x *model.Context) string { return x.ClientID }, "(no client id)"),
		ctxDim(m, d("service"), ctx, func(x *model.Context) string { return x.Service }, "(no service)"),
		{Dim: d("plh"), key: func(r factRow) int64 { return plh.id(uint64(r.c.PLH)) }, name: func(k int64) string {
			if v := plh.keys[k]; v != 0 {
				return fmt.Sprint(v)
			}
			return "(no plan)"
		}},
		{Dim: d("execNo"), key: func(r factRow) int64 { return int64(r.c.ExecNo) }, name: intName("exec ", "(not an execution)", 1)},
		{Dim: d("cursor"), key: func(r factRow) int64 { return int64(r.c.Cursor) }, name: func(k int64) string {
			if k < 0 || int(k) >= len(m.Cursors) {
				return "(no cursor)"
			}
			cu := &m.Cursors[k]
			n := int64(cu.Number)
			if n == 0 {
				n = k
			}
			return fmt.Sprintf("#%d (line %s)", n, commas(int64(cu.Line)))
		}},
		{Dim: d("closeType"), key: func(r factRow) int64 {
			if r.c.Kind != trace.CallClose {
				return -1
			}
			return int64(r.c.Type)
		}, name: func(k int64) string {
			if k < 0 {
				return "(not a close)"
			}
			if s, ok := closeTypeNames[k]; ok {
				return s
			}
			return fmt.Sprintf("type %d", k)
		}},
		timeDim(m, d("time"), func(r factRow) int64 { return r.c.Tim }),
		{Dim: d("og"), key: func(r factRow) int64 { return int64(r.c.OG) }, name: func(k int64) string {
			if s, ok := ogNames[k]; ok {
				return s
			}
			if k == 0 {
				return "(none)"
			}
			return fmt.Sprintf("og %d", k)
		}},
	}
	return index(out)
}

func waitDims(m *model.Model, src Facts) map[string]dimImpl {
	ctx := func(r factRow) model.ID { return r.w.Context }
	d := func(id string) Dim {
		for _, x := range waitDimList {
			if x.ID == id {
				return x
			}
		}
		panic("pivot: no wait dim " + id)
	}
	className := func(ev *model.Event) string {
		if ev.Idle {
			return "Idle"
		}
		if ev.Class == "" {
			return "unknown"
		}
		return ev.Class
	}
	classes := newInterner[string]()
	classOf := make([]int64, len(m.Events))
	for i := range m.Events {
		classOf[i] = classes.id(className(&m.Events[i]))
	}
	objs := newInterner[int64]()
	p1 := newInterner[[2]int64]()
	p2 := newInterner[[2]int64]()
	param := func(n *interner[[2]int64], p2nd bool) func(int64) string {
		return func(k int64) string {
			pr := n.keys[k]
			name := "p1"
			if p2nd {
				name = "p2"
			}
			if pr[0] >= 0 && int(pr[0]) < len(m.Events) {
				ev := &m.Events[pr[0]]
				if p2nd && ev.P2Name != "" {
					name = ev.P2Name
				} else if !p2nd && ev.P1Name != "" {
					name = ev.P1Name
				}
			}
			if !p2nd && pr[0] >= 0 && int(pr[0]) < len(m.Events) && m.Events[pr[0]].IsFileP1() {
				if fn := m.FileName(pr[1]); fn != "" {
					return fmt.Sprintf("%s=%d (%s)", name, pr[1], fn)
				}
			}
			return fmt.Sprintf("%s=%d", name, pr[1])
		}
	}
	out := []dimImpl{
		{Dim: d("event"), key: func(r factRow) int64 { return int64(r.w.Event) }, name: func(k int64) string {
			if k < 0 || int(k) >= len(m.Events) {
				return fmt.Sprintf("event %d", k)
			}
			return m.Events[k].Name
		}, extra: func(k int64) string {
			if k < 0 || int(k) >= len(m.Events) {
				return ""
			}
			return className(&m.Events[k])
		}},
		{Dim: d("class"), key: func(r factRow) int64 {
			e := r.w.Event
			if e < 0 || int(e) >= len(classOf) {
				return -1
			}
			return classOf[e]
		}, name: func(k int64) string {
			if k < 0 {
				return "unknown"
			}
			return classes.keys[k]
		}},
		stmtDim(m, d("stmt"), func(r factRow) model.ID { return r.w.Statement }, "(no cursor)"),
		{Dim: d("obj"), key: func(r factRow) int64 {
			if o := r.w.ObjID; o > 0 {
				return objs.id(o)
			}
			return -1
		}, name: func(k int64) string {
			if k < 0 {
				return "(none)"
			}
			if n := m.ObjectName(objs.keys[k]); n != "" {
				return fmt.Sprintf("%s (obj# %d)", n, objs.keys[k])
			}
			return fmt.Sprintf("obj# %d", objs.keys[k])
		}},
		{Dim: d("p1"), key: func(r factRow) int64 { return p1.id([2]int64{int64(r.w.Event), r.w.P1}) }, name: param(p1, false)},
		{Dim: d("p2"), key: func(r factRow) int64 { return p2.id([2]int64{int64(r.w.Event), r.w.P2}) }, name: param(p2, true)},
		{Dim: d("between"), key: func(r factRow) int64 { return b2i(r.w.Between) }, name: func(k int64) string {
			if k == 1 {
				return "between calls"
			}
			return "inside a call"
		}},
		{Dim: d("idle"), key: func(r factRow) int64 { return b2i(r.w.Idle) }, name: func(k int64) string {
			if k == 1 {
				return "idle"
			}
			return "non-idle"
		}},
		{Dim: d("dep"), key: func(r factRow) int64 { return int64(r.w.Dep) }, name: intName("dep ", "(none)", 0)},
		ctxDim(m, d("session"), ctx, func(x *model.Context) string { return SessionName(x) }, "(no session)"),
		ctxDim(m, d("module"), ctx, func(x *model.Context) string { return x.Module }, "(no module)"),
		ctxDim(m, d("action"), ctx, func(x *model.Context) string { return x.Action }, "(no action)"),
		ctxDim(m, d("client"), ctx, func(x *model.Context) string { return x.ClientID }, "(no client id)"),
		ctxDim(m, d("service"), ctx, func(x *model.Context) string { return x.Service }, "(no service)"),
		{Dim: d("callKind"), key: func(r factRow) int64 {
			if k, ok := src.CallKind(r.w.Call); ok {
				return int64(k)
			}
			return -1
		}, name: kindName},
		timeDim(m, d("time"), func(r factRow) int64 { return r.w.Tim }),
	}
	return index(out)
}

func index(ds []dimImpl) map[string]dimImpl {
	out := make(map[string]dimImpl, len(ds))
	for _, d := range ds {
		out[d.ID] = d
	}
	return out
}

func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func commas(n int64) string {
	s := fmt.Sprint(n)
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

// accumulator slots
const (
	cCount = iota
	cE
	cSelfE
	cC
	cSelfC
	cP
	cCR
	cCU
	cR
	cMis
	cWait
	cIdle
	cMaxE
	cN
)

const (
	wCount = iota
	wEla
	wMin
	wMax
	wN
)

const maxPivotDims = 4

// Pivot groups the calls or waits of m by the given dimensions (ids of
// Dims(fact)), over the rows accepted by f. Rows come sorted by the default
// measure (DefaultMeasure); use SortBy for another order.
func Pivot(m *model.Model, fact Fact, by []string, f Filter) (*PivotResult, error) {
	return PivotOn(context.Background(), m, ModelFacts(m), fact, by, f)
}

// PivotOn is Pivot over any Facts (m supplies the dimension tables).
func PivotOn(ctx context.Context, m *model.Model, src Facts, fact Fact, by []string, f Filter) (*PivotResult, error) {
	if len(by) == 0 {
		return nil, fmt.Errorf("pivot: no dimension given")
	}
	if len(by) > maxPivotDims {
		return nil, fmt.Errorf("pivot: at most %d dimensions", maxPivotDims)
	}
	var all map[string]dimImpl
	if fact == FactWaits {
		all = waitDims(m, src)
	} else {
		all = callDims(m)
	}
	dims := make([]dimImpl, len(by))
	seen := map[string]bool{}
	for i, id := range by {
		d, ok := all[id]
		if !ok {
			return nil, fmt.Errorf("pivot: unknown %s dimension %q (have %s)", fact, id, dimIDs(fact))
		}
		if seen[id] {
			return nil, fmt.Errorf("pivot: dimension %q given twice", id)
		}
		seen[id] = true
		dims[i] = d
	}
	nAcc := cN
	if fact == FactWaits {
		nAcc = wN
	}
	newAcc := func() []int64 {
		a := make([]int64, nAcc)
		if fact == FactWaits {
			a[wMin] = -1 // unset
		}
		return a
	}
	type group struct {
		keys [maxPivotDims]int64
		acc  []int64
	}
	groups := map[[maxPivotDims]int64]*group{}
	var order []*group
	total := newAcc()
	if fact == FactCalls && f.Event != nil {
		return nil, fmt.Errorf("pivot: an event filter only applies to waits")
	}
	mt := f.Matcher()
	rows := 0
	add := func(rw factRow) {
		rows++
		var k [maxPivotDims]int64
		for j := range dims {
			k[j] = dims[j].key(rw)
		}
		g := groups[k]
		if g == nil {
			g = &group{keys: k, acc: newAcc()}
			groups[k] = g
			order = append(order, g)
		}
		if fact == FactCalls {
			addCall(g.acc, rw.c)
			addCall(total, rw.c)
		} else {
			addWait(g.acc, rw.w.Ela)
			addWait(total, rw.w.Ela)
		}
	}
	var err error
	if fact == FactCalls {
		err = src.EachCall(ctx, f.Scan(), func(c *model.Call) bool {
			if mt.Call(c) {
				add(factRow{c: c})
			}
			return true
		})
	} else {
		err = src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
			if mt.Wait(w) {
				add(factRow{w: w})
			}
			return true
		})
	}
	if err != nil {
		return nil, err
	}
	r := &PivotResult{Fact: fact, Measures: Measures(fact), Facts: rows, BucketUs: TimelineBucket(m)}
	for _, d := range dims {
		r.Dims = append(r.Dims, d.Dim)
	}
	r.Total = values(fact, total, total)
	r.Rows = make([]PivotRow, 0, len(order))
	for _, g := range order {
		row := PivotRow{Keys: make([]int64, len(dims)), Labels: make([]string, len(dims)), Extra: make([]string, len(dims)), Values: values(fact, g.acc, total)}
		for j, d := range dims {
			row.Keys[j] = g.keys[j]
			row.Labels[j] = d.name(g.keys[j])
			if d.extra != nil {
				row.Extra[j] = d.extra(g.keys[j])
			}
		}
		r.Rows = append(r.Rows, row)
	}
	r.SortBy(DefaultMeasure(fact))
	return r, nil
}

func dimIDs(f Fact) string {
	var ids []string
	for _, d := range Dims(f) {
		ids = append(ids, d.ID)
	}
	return strings.Join(ids, ",")
}

func addCall(a []int64, c *model.Call) {
	a[cCount]++
	a[cE] += c.E
	a[cSelfE] += c.SelfE
	a[cC] += c.C
	a[cSelfC] += c.SelfC
	a[cP] += c.P
	a[cCR] += c.CR
	a[cCU] += c.CU
	a[cR] += c.R
	a[cMis] += int64(c.Mis)
	a[cWait] += c.WaitEla
	a[cIdle] += c.IdleEla
	if c.E > a[cMaxE] {
		a[cMaxE] = c.E
	}
}

func addWait(a []int64, ela int64) {
	a[wCount]++
	a[wEla] += ela
	if a[wMin] < 0 || ela < a[wMin] {
		a[wMin] = ela
	}
	if ela > a[wMax] {
		a[wMax] = ela
	}
}

// values maps an accumulator to the measure list of the fact.
func values(fact Fact, a, total []int64) []float64 {
	if fact == FactCalls {
		avg := 0.0
		if a[cCount] > 0 {
			avg = float64(a[cE]) / float64(a[cCount])
		}
		return []float64{float64(a[cCount]), float64(a[cE]), float64(a[cSelfE]), float64(a[cC]), float64(a[cSelfC]),
			float64(a[cP]), float64(a[cCR]), float64(a[cCU]), float64(a[cR]), float64(a[cMis]),
			float64(a[cWait]), float64(a[cIdle]), avg, float64(a[cMaxE])}
	}
	avg, min, share := 0.0, 0.0, 0.0
	if a[wCount] > 0 {
		avg = float64(a[wEla]) / float64(a[wCount])
		min = float64(a[wMin])
	}
	if total[wEla] > 0 {
		share = 100 * float64(a[wEla]) / float64(total[wEla])
	}
	return []float64{float64(a[wCount]), float64(a[wEla]), avg, min, float64(a[wMax]), share}
}

// TimelineBucket picks the bucket size for the trace span; see BucketForSpan.
func TimelineBucket(m *model.Model) int64 {
	return BucketForSpan(m.Span.Us())
}

// BucketForSpan is THE bucket rule, shared by the CLI (timeline, pivot) and
// the UI (pickBucket in web/src/data/derive.ts must stay identical): the
// smallest of 1 ms, 10 ms, 100 ms, 1 s, 10 s, 1 min, 10 min, 1 h with
// floor(span/bucket) <= 400 (so 200-400 buckets once the span exceeds 2x the
// smallest size), else span/400. 0 when the span is unknown (<= 0).
func BucketForSpan(spanUs int64) int64 {
	if spanUs <= 0 {
		return 0
	}
	for _, b := range []int64{1000, 10000, 100000, 1000000, 10000000, 60000000, 600000000, 3600000000} {
		if spanUs/b <= 400 {
			return b
		}
	}
	return spanUs / 400
}

// ContextStats summarises the activity of one session context (same
// definitions as the UI Sessions view).
type ContextStats struct {
	Context  model.ID `json:"context"`
	Calls    int64    `json:"calls"`
	Rows     int64    `json:"rows"`
	Elapsed  int64    `json:"elapsed"` // Σ e of top-level calls (response time)
	CPU      int64    `json:"cpu"`     // Σ c of top-level calls
	WaitUs   int64    `json:"waitUs"`  // waits of non-idle events
	IdleUs   int64    `json:"idleUs"`  // waits of Idle-class events
	FirstTim int64    `json:"firstTim"`
	LastTim  int64    `json:"lastTim"`
}

// Contexts computes ContextStats for every model.Context, in id order.
func Contexts(m *model.Model) []ContextStats {
	if a := AggOf(m); a != nil {
		return a.ctx
	}
	out := make([]ContextStats, len(m.Contexts))
	for i := range out {
		out[i].Context = model.ID(i)
	}
	span := func(s *ContextStats, from, to int64) {
		if s.FirstTim == 0 || from < s.FirstTim {
			s.FirstTim = from
		}
		if to > s.LastTim {
			s.LastTim = to
		}
	}
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Context < 0 || int(c.Context) >= len(out) {
			continue
		}
		s := &out[c.Context]
		s.Calls++
		s.Rows += c.R
		if c.Parent == model.None {
			s.Elapsed += c.E
			s.CPU += c.C
		}
		if c.Tim != 0 {
			span(s, c.Tim-c.E, c.Tim)
		}
	}
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.Context < 0 || int(w.Context) >= len(out) {
			continue
		}
		s := &out[w.Context]
		if w.Idle {
			s.IdleUs += w.Ela
		} else {
			s.WaitUs += w.Ela
		}
		if w.Tim != 0 {
			span(s, w.Tim, w.Tim)
		}
	}
	return out
}
