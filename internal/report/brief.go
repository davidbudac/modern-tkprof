package report

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// A brief is the Markdown an agent (or a person) reads to understand a trace:
// the facts mtkprof computes for a scope, the DBA's notes next to the things
// they annotate, and the case text. It is facts only (DESIGN.md): the closing
// section asks the agent to interpret and to cite.

// Limits of BriefOptions; zero selects the default.
const (
	BriefDefaultStatements = 10
	BriefMaxStatements     = 50
	BriefDefaultSQLChars   = 2000
	BriefMinSQLChars       = 100
	BriefMaxSQLChars       = 20000
	BriefDefaultPlanLines  = 40
	BriefMaxPlanLines      = 200
	BriefNoPlans           = -1 // MaxPlanLines: leave the plans out
	BriefMaxNotes          = 2000
	BriefMaxNoteChars      = 20000
	BriefMaxCaseChars      = 200000
)

const (
	briefShare      = 0.8 // the statements listed cover this share of the response time
	briefSlowExecs  = 3   // executions listed per statement
	briefMaxFinding = 20
	briefMaxEvid    = 10
	briefMaxPlans   = 3 // plan hashes drawn per statement
	briefMaxProfile = 15
	briefMaxContext = 8
	briefMaxWaits   = 5
	briefMaxLinks   = 3
	briefBindMax    = 60  // bytes of a kept bind value
	briefBindsMax   = 800 // bytes of the binds of one execution
)

// BriefBinds says what a brief shows of bind values.
type BriefBinds int

const (
	// BriefBindsMask (the zero value, the default) shows each value as its
	// type, length and a hash salted per brief: equal values match inside one
	// brief and nowhere else.
	BriefBindsMask BriefBinds = iota
	BriefBindsKeep            // values as traced
	BriefBindsNone            // no bind values
)

var briefBindNames = [...]string{"mask", "keep", "none"}

func (b BriefBinds) String() string {
	if b >= 0 && int(b) < len(briefBindNames) {
		return briefBindNames[b]
	}
	return "binds?"
}

// ParseBriefBinds reads keep, mask or none; "" is mask.
func ParseBriefBinds(v string) (BriefBinds, error) {
	if v == "" {
		return BriefBindsMask, nil
	}
	for i, n := range briefBindNames {
		if v == n {
			return BriefBinds(i), nil
		}
	}
	return 0, fmt.Errorf("binds: want keep, mask or none")
}

// Note kinds, as the desktop's annotations name them.
const (
	NoteStatement = "statement"
	NoteExecution = "execution"
	NoteWindow    = "window"
	NoteLine      = "line"
)

// NoteStmt names a statement by what survives a re-parse: its sql_id and a
// hash of its kind and text (NoteHash).
type NoteStmt struct {
	SQLID string `json:"sqlId"`
	Hash  string `json:"hash"`
}

// Note is a note the DBA wrote on a trace, in the shape of the desktop's
// annotation (web/src/lib/data/annotations.ts), so the shell can pass its
// annotations through. Which fields matter depends on Kind:
//
//	statement  Stmt
//	execution  Stmt, ExecNo, CursorLine (the trace line of the cursor)
//	window     From, To (tim, µs), Label
//	line       File, Line, Label (a bookmark)
//
// ID, Created and Updated are accepted and not used.
type Note struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"`
	Note       string    `json:"note"`
	Created    int64     `json:"created"`
	Updated    int64     `json:"updated"`
	Stmt       *NoteStmt `json:"stmt"`
	ExecNo     int32     `json:"execNo"`
	CursorLine int32     `json:"cursorLine"`
	From       int64     `json:"from"`
	To         int64     `json:"to"`
	Label      string    `json:"label"`
	File       int32     `json:"file"`
	Line       int32     `json:"line"`
}

// NoteHash is the hash of a statement a NoteStmt carries: FNV-1a 32 of
// "<kind>\n<text>" over the UTF-16 code units of the string, 8 hex digits
// (textHash and stmtRef of the desktop).
func NoteHash(kind model.StatementKind, text string) string {
	h := uint32(0x811c9dc5)
	for _, u := range utf16.Encode([]rune(fmt.Sprintf("%d\n%s", int(kind), text))) {
		h ^= uint32(u)
		h *= 0x01000193
	}
	return fmt.Sprintf("%08x", h)
}

// BriefOptions are the options of Brief. Zero values select the defaults.
type BriefOptions struct {
	Case          string // the DBA's description of the problem, printed once, quoted
	Notes         []Note
	MaxStatements int // statements listed at most (default BriefDefaultStatements)
	MaxSQLChars   int // characters of one statement's SQL (default BriefDefaultSQLChars)
	MaxPlanLines  int // lines of one plan (default BriefDefaultPlanLines; BriefNoPlans: no plans)
	Binds         BriefBinds
	// Salt of the masked bind hashes. Empty: random per brief, so the same
	// value gets another hash in the next brief and the hashes cannot be
	// matched against a table of hashes of guessed values.
	Salt       string
	Thresholds *analyze.Thresholds // finding thresholds; nil = defaults
}

// Check reports an option out of range.
func (o BriefOptions) Check() error {
	switch {
	case o.MaxStatements < 0 || o.MaxStatements > BriefMaxStatements:
		return fmt.Errorf("maxStatements: want 0 (default %d) to %d", BriefDefaultStatements, BriefMaxStatements)
	case o.MaxSQLChars != 0 && (o.MaxSQLChars < BriefMinSQLChars || o.MaxSQLChars > BriefMaxSQLChars):
		return fmt.Errorf("maxSqlChars: want 0 (default %d) or %d to %d", BriefDefaultSQLChars, BriefMinSQLChars, BriefMaxSQLChars)
	case o.MaxPlanLines < BriefNoPlans || o.MaxPlanLines > BriefMaxPlanLines:
		return fmt.Errorf("maxPlanLines: want %d (no plans), 0 (default %d) or 1 to %d", BriefNoPlans, BriefDefaultPlanLines, BriefMaxPlanLines)
	case o.Binds < BriefBindsMask || o.Binds > BriefBindsNone:
		return fmt.Errorf("binds: want keep, mask or none")
	case len(o.Case) > BriefMaxCaseChars:
		return fmt.Errorf("case: more than %d bytes", BriefMaxCaseChars)
	case len(o.Notes) > BriefMaxNotes:
		return fmt.Errorf("notes: more than %d", BriefMaxNotes)
	}
	for i := range o.Notes {
		if err := o.Notes[i].check(); err != nil {
			return fmt.Errorf("notes[%d]: %v", i, err)
		}
	}
	return nil
}

func (n *Note) check() error {
	if len(n.Note) > BriefMaxNoteChars {
		return fmt.Errorf("note: more than %d bytes", BriefMaxNoteChars)
	}
	switch n.Kind {
	case NoteStatement, NoteExecution:
		if n.Stmt == nil || (n.Stmt.SQLID == "" && n.Stmt.Hash == "") {
			return fmt.Errorf("%s note without stmt", n.Kind)
		}
		if n.Kind == NoteExecution && n.ExecNo <= 0 {
			return fmt.Errorf("execution note without execNo")
		}
	case NoteWindow:
		if n.To < n.From {
			return fmt.Errorf("window note: to %d is before from %d", n.To, n.From)
		}
	case NoteLine:
	default:
		return fmt.Errorf("kind %q: want statement, execution, window or line", n.Kind)
	}
	return nil
}

func (o BriefOptions) withDefaults() BriefOptions {
	if o.MaxStatements == 0 {
		o.MaxStatements = BriefDefaultStatements
	}
	if o.MaxSQLChars == 0 {
		o.MaxSQLChars = BriefDefaultSQLChars
	}
	if o.MaxPlanLines == 0 {
		o.MaxPlanLines = BriefDefaultPlanLines
	}
	return o
}

// BriefSource is where Brief reads rows from: the calls and waits of a scope
// and the bind values. slice.FactSource has all of it.
type BriefSource interface {
	analyze.Facts
	analyze.CallRows
	Binds(set model.ID) []model.Bind
}

// BriefResult is a rendered brief.
type BriefResult struct {
	Markdown  string
	EstTokens int // bytes over 4
}

// stmtExecs summarises the executions of one listed statement in scope.
type stmtExecs struct {
	n             int64
	sum, min, max int64
	slow          []analyze.ExecInfo          // the slowest, slowest first
	noted         map[execAt]analyze.ExecInfo // the executions that have a note
}

type execAt struct {
	cursorLine int32
	execNo     int32
}

// briefNotes are the notes of a brief by where they print.
type briefNotes struct {
	onStmt  map[model.ID][]Note // statement notes of the listed statements
	onExec  map[model.ID][]Note // execution notes of the listed statements
	window  []Note              // window notes that overlap the scope
	other   []otherNote
	outside int // notes about things outside the scope, left out
}

type otherNote struct {
	Note
	where string // what the note is about, as far as the trace tells
}

type briefWriter struct {
	b    strings.Builder
	m    *model.Model
	src  BriefSource
	f    analyze.Filter
	o    BriefOptions
	salt string
	h    *textWriter // clock and sql_id formatting only

	prof     analyze.ScopeProfile
	stats    []analyze.StmtStats
	shown    []model.ID
	rank     map[model.ID]int
	ownTotal int64 // own time of the statements with time in scope
	ownShown int64
	inScope  int // statements with time in scope
	findings []analyze.Finding
	waits    map[model.ID][]analyze.StmtEventWait
	execs    map[model.ID]*stmtExecs
	notes    briefNotes
}

// Brief renders the brief of the rows of src that f accepts (the window and
// the contexts; the other fields of f are ignored). The statements it lists
// are the ones whose own time adds up to 80% of the scope's response time,
// at most o.MaxStatements. m and src are read, never changed.
func Brief(ctx context.Context, m *model.Model, src BriefSource, f analyze.Filter, o BriefOptions) (BriefResult, error) {
	if err := o.Check(); err != nil {
		return BriefResult{}, err
	}
	o = o.withDefaults()
	if o.Salt == "" {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return BriefResult{}, err
		}
		o.Salt = hex.EncodeToString(raw[:])
	}
	f.Statement, f.Event, f.IncludeIdle = nil, nil, true
	w := &briefWriter{m: m, src: src, f: f, o: o, salt: o.Salt, h: &textWriter{m: m, loc: zone(m)}, rank: map[model.ID]int{}}
	if err := w.collect(ctx); err != nil {
		return BriefResult{}, err
	}
	w.write()
	md := w.b.String()
	return BriefResult{Markdown: md, EstTokens: len(md) / 4}, nil
}

// collect reads everything the sections need, so rendering cannot fail.
func (w *briefWriter) collect(ctx context.Context) error {
	var err error
	if w.prof, err = analyze.ProfileOfOn(ctx, w.m, w.src, w.f); err != nil {
		return err
	}
	if w.stats, err = analyze.StatementsOn(ctx, w.m, w.src, w.f); err != nil {
		return err
	}
	th := analyze.DefaultThresholds()
	if w.o.Thresholds != nil {
		th = *w.o.Thresholds
	}
	if w.findings, err = analyze.FindingsOnWith(ctx, w.m, w.src, w.f, th); err != nil {
		return err
	}
	w.pickStatements()
	if w.waits, err = analyze.TopStmtWaitsOn(ctx, w.src, w.f, w.shown, briefMaxWaits); err != nil {
		return err
	}
	w.sortNotes()
	return w.scanExecs(ctx)
}

// own is the time a statement accounts for by itself: its elapsed time
// without its recursive children, plus the idle time between its calls.
func (w *briefWriter) own(s *analyze.StmtStats) int64 { return s.SelfElapsed + s.IdleUs }

func (w *briefWriter) inScopeStmt(s *analyze.StmtStats) bool {
	return s.AllCalls.Count > 0 || s.Errors > 0 || s.PXElapsed > 0
}

func (w *briefWriter) pickStatements() {
	var ids []model.ID
	for i := range w.stats {
		if s := &w.stats[i]; w.inScopeStmt(s) {
			ids = append(ids, model.ID(i))
			w.ownTotal += w.own(s)
		}
	}
	w.inScope = len(ids)
	sort.SliceStable(ids, func(a, b int) bool { return w.own(&w.stats[ids[a]]) > w.own(&w.stats[ids[b]]) })
	base := w.prof.ResponseUs
	if base <= 0 {
		base = w.ownTotal
	}
	var cum int64
	for _, id := range ids {
		own := w.own(&w.stats[id])
		if len(w.shown) == w.o.MaxStatements || (len(w.shown) > 0 && (own <= 0 || float64(cum) >= briefShare*float64(base))) {
			break
		}
		w.shown = append(w.shown, id)
		w.rank[id] = len(w.shown)
		cum += own
	}
	w.ownShown = cum
}

// scanExecs reads the executions of every listed statement once: their
// summary, the slowest few, and the ones a note names.
func (w *briefWriter) scanExecs(ctx context.Context) error {
	w.execs = make(map[model.ID]*stmtExecs, len(w.shown))
	for _, sid := range w.shown {
		x := &stmtExecs{noted: map[execAt]analyze.ExecInfo{}}
		want := map[execAt]bool{}
		for _, n := range w.notes.onExec[sid] {
			want[execAt{n.CursorLine, n.ExecNo}] = true
		}
		err := analyze.EachExecutionIn(ctx, w.m, w.src, w.f, sid, func(e *analyze.ExecInfo) {
			el := e.Stats.Elapsed
			if x.n == 0 || el < x.min {
				x.min = el
			}
			if x.n == 0 || el > x.max {
				x.max = el
			}
			x.n++
			x.sum += el
			if len(want) > 0 {
				if at := (execAt{int32(w.m.Cursors[e.Cursor].Line), e.ExecNo}); want[at] {
					x.noted[at] = *e
				}
			}
			x.slow = append(x.slow, *e)
			sort.Slice(x.slow, func(i, j int) bool { // total order: the scan order of the last open executions is not stable
				if a, b := x.slow[i].Stats.Elapsed, x.slow[j].Stats.Elapsed; a != b {
					return a > b
				}
				return x.slow[i].Seq < x.slow[j].Seq
			})
			if len(x.slow) > briefSlowExecs {
				x.slow = x.slow[:briefSlowExecs]
			}
		})
		if err != nil {
			return err
		}
		w.execs[sid] = x
	}
	w.settleExecNotes()
	return nil
}

// ---- notes ------------------------------------------------------------------

// resolveStmt is the desktop's resolveStmt: the statement with the sql_id and
// the hash, else the only statement with the sql_id.
func (w *briefWriter) resolveStmt(ns *NoteStmt) (model.ID, bool) {
	bySQL, n := model.None, 0
	for i := range w.m.Statements {
		st := &w.m.Statements[i]
		if st.SQLID != ns.SQLID {
			continue
		}
		if NoteHash(st.Kind, st.Text) == ns.Hash {
			return model.ID(i), true
		}
		bySQL = model.ID(i)
		n++
	}
	return bySQL, ns.SQLID != "" && n == 1
}

// sortNotes puts every note where it prints. Execution notes of the listed
// statements wait in onExec until the executions have been read.
func (w *briefWriter) sortNotes() {
	n := &w.notes
	n.onStmt, n.onExec = map[model.ID][]Note{}, map[model.ID][]Note{}
	for _, note := range w.o.Notes {
		switch note.Kind {
		case NoteWindow:
			if strings.TrimSpace(note.Note) == "" {
				continue
			}
			if note.To >= w.f.StartTim && (w.f.EndTim == 0 || note.From <= w.f.EndTim) {
				n.window = append(n.window, note)
			} else {
				n.outside++
			}
		case NoteLine:
			if strings.TrimSpace(note.Note) != "" {
				n.other = append(n.other, otherNote{note, fmt.Sprintf("trace line %d of file %d", note.Line, note.File)})
			}
		default:
			if strings.TrimSpace(note.Note) == "" {
				continue
			}
			sid, ok := w.resolveStmt(note.Stmt)
			switch {
			case !ok:
				n.other = append(n.other, otherNote{note, "a statement that is not in this trace (sql_id " + note.Stmt.SQLID + ")"})
			case !w.inScopeStmt(&w.stats[sid]):
				n.outside++
			case w.rank[sid] == 0:
				n.other = append(n.other, otherNote{note, w.unlisted(sid, note)})
			case note.Kind == NoteStatement:
				n.onStmt[sid] = append(n.onStmt[sid], note)
			default:
				n.onExec[sid] = append(n.onExec[sid], note)
			}
		}
	}
}

func (w *briefWriter) unlisted(sid model.ID, n Note) string {
	what := "statement"
	if n.Kind == NoteExecution {
		what = fmt.Sprintf("execution %d of statement", n.ExecNo)
	}
	st := &w.m.Statements[sid]
	return fmt.Sprintf("%s %s %s (not listed above)", what, w.h.sqlID(st), code(preview(st.Text, 60)))
}

// settleExecNotes drops the execution notes whose execution is not in scope.
func (w *briefWriter) settleExecNotes() {
	for sid, notes := range w.notes.onExec {
		kept := notes[:0]
		for _, n := range notes {
			if _, ok := w.execs[sid].noted[execAt{n.CursorLine, n.ExecNo}]; ok {
				kept = append(kept, n)
			} else {
				w.notes.outside++
			}
		}
		w.notes.onExec[sid] = kept
	}
}

// ---- rendering --------------------------------------------------------------

func (w *briefWriter) p(format string, a ...any) { fmt.Fprintf(&w.b, format, a...) }
func (w *briefWriter) nl()                       { w.b.WriteByte('\n') }

func (w *briefWriter) write() {
	w.p("# Trace brief\n\n")
	w.p("An Oracle SQL trace (event 10046) as read by mtkprof. The sections below are facts read from the trace; the notes and the case description are the DBA's own words.\n\n")
	w.header()
	w.profile()
	w.statementsSection()
	w.findingsSection()
	w.otherNotes()
	w.caseText()
	w.forAgent()
}

func (w *briefWriter) windowText() string {
	m, f := w.m, w.f
	lo, hi := m.Span.FirstTim, m.Span.LastTim
	whole := f.StartTim == 0 && f.EndTim == 0
	if f.StartTim != 0 {
		lo = f.StartTim
	}
	if f.EndTim != 0 {
		hi = f.EndTim
	}
	what := "the whole trace"
	if !whole {
		what = "a time window"
	}
	span := fmt.Sprintf("tim %d to %d", lo, hi)
	if m.WallOf(lo) != 0 {
		span = fmt.Sprintf("%s to %s, %s", w.h.wallZ(m.WallOf(lo)), w.h.wallZ(m.WallOf(hi)), span)
	}
	return fmt.Sprintf("%s (%s; %s)", what, span, dur(max(hi-lo, 0)))
}

func (w *briefWriter) header() {
	m := w.m
	w.p("## Trace\n\n")
	w.p("- **Database:** Oracle %s, instance %s\n", dash(m.File.Version), dash(m.File.Instance))
	w.p("- **Files:** ")
	for i, fe := range m.File.Files {
		if i == briefMaxContext {
			w.p(" and %d more", len(m.File.Files)-i)
			break
		}
		if i > 0 {
			w.p(", ")
		}
		w.p("%s (%.1f MB, %s lines)", code(fe.Name), float64(fe.Size)/1e6, commas(int64(fe.Lines)))
	}
	w.nl()
	w.p("- **Sessions:** %d with time in scope", w.prof.Sessions)
	if w.f.NoContexts {
		w.p("; no session context selected")
	} else if n := len(w.f.Contexts); n > 0 {
		w.p("; %d of %d session contexts selected", n, len(m.Contexts))
	}
	w.nl()
	w.contexts()
	w.p("- **Window:** %s\n", w.windowText())
	w.p("- **Response time:** %s", dur(w.prof.ResponseUs))
	if w.prof.Sessions > 1 {
		w.p(" (sum of %d session spans; wall clock %s)", w.prof.Sessions, dur(w.prof.WallUs))
	}
	w.nl()
	w.p("- **Bind values:** %s\n", map[BriefBinds]string{
		BriefBindsMask: "masked: each value is shown as its type, length and a hash that is the same for equal values inside this brief only",
		BriefBindsKeep: "as traced",
		BriefBindsNone: "left out",
	}[w.o.Binds])
	w.p("- **SQL text:** as traced; literals in it are not masked\n")
	if m.Diag.BindMode == "none" {
		w.p("- **Note:** the trace was opened without bind values, so none can be shown\n")
	}
	if m.File.Truncated {
		w.p("- **Note:** the trace was cut by max_dump_file_size (%s bytes)\n", commas(m.File.DumpSizeLimit))
	}
	if m.Diag.UnknownLines > 0 {
		w.p("- **Note:** %d trace lines were not recognised\n", m.Diag.UnknownLines)
	}
	w.nl()
	if len(w.notes.window) > 0 {
		w.p("### Notes on time windows\n\n")
		for _, n := range w.notes.window {
			lead := fmt.Sprintf("%s to %s (%s)", w.h.clock(n.From), w.h.clock(n.To), dur(n.To-n.From))
			if n.Label != "" {
				lead += " " + quote(n.Label)
			}
			w.bullet(lead+": ", n.Note)
		}
		w.nl()
	}
}

func (w *briefWriter) contexts() {
	m := w.m
	var ids []model.ID
	switch {
	case w.f.NoContexts:
		return
	case len(w.f.Contexts) > 0:
		ids = w.f.Contexts
	default:
		for i := range m.Contexts {
			ids = append(ids, model.ID(i))
		}
	}
	for i, id := range ids {
		if i == briefMaxContext {
			w.p("  - and %d more\n", len(ids)-i)
			break
		}
		if id < 0 || int(id) >= len(m.Contexts) {
			continue
		}
		c := &m.Contexts[id]
		w.p("  - context %d: session %s, service %s, module %s, action %s\n", id, analyze.SessionName(c), dash(c.Service), dash(c.Module), dash(c.Action))
	}
}

func (w *briefWriter) profile() {
	p := w.prof
	type row struct {
		name, class      string
		us, count, maxUs int64
	}
	rows := []row{{name: "CPU", us: p.CPUUs}}
	accounted := p.CPUUs
	for _, e := range p.Events {
		name := e.Name
		if e.Idle {
			name += " (idle)"
		}
		rows = append(rows, row{name, e.Class, e.Us, e.Count, e.MaxUs})
		accounted += e.Us
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].us > rows[j].us })
	w.p("## Resource profile\n\n")
	w.p("The response time of the scope split into CPU of the top-level calls and every wait. Idle waits are time between calls, mostly the client or the network.\n\n")
	w.p("| Component | Seconds | %% | Count | Avg ms | Max ms | Class |\n|---|---:|---:|---:|---:|---:|---|\n")
	line := func(r row) {
		cnt, avg, mx := "", "", ""
		if r.count > 0 {
			cnt, avg, mx = commas(r.count), ms(float64(r.us)/float64(r.count)), ms(float64(r.maxUs))
		}
		w.p("| %s | %s | %s | %s | %s | %s | %s |\n", cell(r.name), secs(r.us), share(r.us, p.ResponseUs), cnt, avg, mx, cell(r.class))
	}
	for i, r := range rows {
		if i == briefMaxProfile {
			var us, n int64
			for _, o := range rows[i:] {
				us += o.us
			}
			n = int64(len(rows) - i)
			w.p("| %d other components | %s | %s | | | | |\n", n, secs(us), share(us, p.ResponseUs))
			break
		}
		line(r)
	}
	if un := p.ResponseUs - accounted; un != 0 {
		line(row{name: "unaccounted-for", us: un})
	}
	w.p("| **Total response time** | %s | 100.0%% | | | | |\n\n", secs(p.ResponseUs))
}

func (w *briefWriter) statementsSection() {
	w.p("## Top statements\n\n")
	if len(w.shown) == 0 {
		w.p("No statement has time in this scope.\n\n")
		return
	}
	w.p("Ranked by own time: elapsed time without recursive children, plus idle time between the statement's calls. Listed until they cover %d%% of the response time, at most %d. %d of %d statements with time in scope are listed",
		int(briefShare*100), w.o.MaxStatements, len(w.shown), w.inScope)
	if rest := w.inScope - len(w.shown); rest > 0 {
		w.p("; the other %d add up to %s (%s of the response time)", rest, dur(w.ownTotal-w.ownShown), share(w.ownTotal-w.ownShown, w.prof.ResponseUs))
	}
	w.p(".\n\n")
	for _, sid := range w.shown {
		w.statement(sid)
	}
}

func (w *briefWriter) statement(sid model.ID) {
	m := w.m
	s, st := &w.stats[sid], &w.m.Statements[sid]
	w.p("### %d. %s %s, %s of the response time\n\n", w.rank[sid], code(w.h.sqlID(st)), ref.CommandName(st.OCT), share(w.own(s), w.prof.ResponseUs))
	for _, n := range w.notes.onStmt[sid] {
		w.bullet("**Note:** ", n.Note)
	}
	if len(w.notes.onStmt[sid]) > 0 {
		w.nl()
	}
	w.p("- **Time:** own %s; elapsed %s including recursive children; cpu %s; waits inside calls %s; idle between calls %s\n",
		dur(w.own(s)), dur(s.Elapsed), dur(s.CPU), dur(s.WaitUs), dur(s.IdleUs))
	w.p("- **Work:** executions %s, rows %s, disk reads %s, query gets %s, current gets %s, cursors %d", commas(s.Executions), commas(s.AllCalls.Rows),
		commas(s.AllCalls.Disk), commas(s.AllCalls.Query), commas(s.AllCalls.Current), s.Cursors)
	if s.HardParses > 0 {
		w.p(", hard parses %s", commas(s.HardParses))
	}
	if s.Errors > 0 {
		w.p(", errors %d", s.Errors)
	}
	w.nl()
	where := fmt.Sprintf("%s to %s; first trace line %d", w.h.clock(s.FirstTim), w.h.clock(s.LastTim), st.FirstLine)
	if len(st.Cursors) > 0 {
		c := &m.Contexts[m.Cursors[st.Cursors[0]].Context]
		where += fmt.Sprintf("; module %s, action %s, session %s", dash(c.Module), dash(c.Action), analyze.SessionName(c))
	}
	w.p("- **Where:** %s\n", where)
	if s.PXSessions > 0 {
		w.p("- **Parallel slaves:** %d processes, %s elapsed, %s cpu (not in the figures above)\n", s.PXSessions, dur(s.PXElapsed), dur(s.PXCPU))
	}
	w.links(s)
	w.nl()
	w.sql(st)
	w.callTable(s)
	w.topWaits(sid)
	w.executions(sid)
	w.plans(sid, s)
}

func (w *briefWriter) links(s *analyze.StmtStats) {
	list := func(title string, ls []analyze.Link) {
		if len(ls) == 0 {
			return
		}
		w.p("- **%s:** ", title)
		for i, l := range ls {
			if i == briefMaxLinks {
				w.p(" and %d more", len(ls)-i)
				break
			}
			if i > 0 {
				w.p(", ")
			}
			w.p("%s (%s, %s calls)", code(w.h.sqlID(&w.m.Statements[l.Statement])), dur(l.Elapsed), commas(l.Calls))
		}
		w.nl()
	}
	list("Recursive statements it runs", s.Children)
	list("Called recursively from", s.Parents)
}

func (w *briefWriter) sql(st *model.Statement) {
	text := strings.TrimRight(st.Text, " \t\r\n")
	more := 0
	if len(text) > w.o.MaxSQLChars {
		cut := w.o.MaxSQLChars
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		more = utf8.RuneCountInString(text[cut:])
		text = text[:cut]
	}
	if more > 0 {
		text += fmt.Sprintf("\n/* %s more characters not shown */", commas(int64(more)))
	}
	w.fence("sql", text)
}

func (w *briefWriter) callTable(s *analyze.StmtStats) {
	w.p("| Call | Count | Misses | CPU s | Elapsed s | Disk | Query | Current | Rows |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
	row := func(name string, c analyze.CallStats) {
		if c.Count > 0 {
			w.p("| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n", name, commas(c.Count), commas(c.Misses), secs(c.CPU), secs(c.Elapsed), commas(c.Disk), commas(c.Query), commas(c.Current), commas(c.Rows))
		}
	}
	row("Parse", s.Parse)
	row("Execute", s.Exec)
	row("Fetch", s.Fetch)
	row("Close", s.Close)
	row("Other", s.Other)
	row("**Total**", s.Total)
	w.nl()
}

func (w *briefWriter) topWaits(sid model.ID) {
	ws := w.waits[sid]
	if len(ws) == 0 {
		return
	}
	w.p("Top waits of this statement:\n\n")
	for _, x := range ws {
		if x.Event < 0 || int(x.Event) >= len(w.m.Events) {
			continue
		}
		ev := &w.m.Events[x.Event]
		name := ev.Name
		if ev.Idle {
			name += " (idle)"
		}
		obj := ""
		if x.Obj > 0 {
			obj = fmt.Sprintf(", obj# %d", x.Obj)
			if n := w.m.ObjectName(x.Obj); n != "" {
				obj += " " + n
			}
		}
		w.p("- %s: %s in %s waits, longest %s%s\n", name, dur(x.Us), commas(x.Count), dur(x.MaxUs), obj)
	}
	w.nl()
}

func (w *briefWriter) executions(sid model.ID) {
	x := w.execs[sid]
	if x == nil || x.n == 0 {
		return
	}
	if x.n > 1 {
		w.p("Executions: %s; elapsed min %s, avg %s, max %s. The slowest:\n\n", commas(x.n), dur(x.min), dur(x.sum/x.n), dur(x.max))
	} else {
		w.p("One execution:\n\n")
	}
	for _, e := range x.slow {
		w.execLine(&e)
	}
	w.nl()
	for _, n := range w.notes.onExec[sid] {
		e := x.noted[execAt{n.CursorLine, n.ExecNo}]
		w.bullet(fmt.Sprintf("**Note on execution %d** (cursor at line %d, %s): ", n.ExecNo, n.CursorLine, dur(e.Stats.Elapsed)), n.Note)
	}
	if len(w.notes.onExec[sid]) > 0 {
		w.nl()
	}
}

func (w *briefWriter) execLine(e *analyze.ExecInfo) {
	m := w.m
	w.p("- exec %d of the cursor at line %d, %s: elapsed %s, cpu %s, %s rows, %s disk, %s query, %d fetches", e.ExecNo, m.Cursors[e.Cursor].Line, w.h.clock(e.StartTim),
		dur(e.Stats.Elapsed), dur(e.Stats.CPU), commas(e.Stats.Rows), commas(e.Stats.Disk), commas(e.Stats.Query), e.NumFetches)
	if b := w.bindText(e.BindSet); b != "" {
		w.p("\n  binds: %s", code(b))
	}
	w.nl()
}

// bindText renders a bind set per the binds option; "" when there is none to show.
func (w *briefWriter) bindText(set model.ID) string {
	if w.o.Binds == BriefBindsNone || set == model.None {
		return ""
	}
	var parts []string
	size := 0
	binds := w.src.Binds(set)
	for i := range binds {
		b := binds[i]
		if size > briefBindsMax {
			parts = append(parts, fmt.Sprintf("... %d more binds", len(binds)-i))
			break
		}
		switch {
		case b.NoDef:
			parts = append(parts, fmt.Sprintf(":%d (same as an earlier bind)", b.Pos))
		case b.IsNull:
			parts = append(parts, fmt.Sprintf(":%d %s=NULL", b.Pos, b.TypeName()))
		case w.o.Binds == BriefBindsMask:
			parts = append(parts, fmt.Sprintf(":%d %s", b.Pos, model.RedactedValueSalt(&b, w.salt)))
		case b.IsDump:
			parts = append(parts, fmt.Sprintf(":%d %s=<%d-byte dump>", b.Pos, b.TypeName(), b.Avl))
		default:
			v := b.Value
			if len(v) > briefBindMax {
				cut := briefBindMax - 3
				for cut > 0 && !utf8.RuneStart(v[cut]) {
					cut--
				}
				v = v[:cut] + "..."
			}
			parts = append(parts, fmt.Sprintf(":%d %s=%q", b.Pos, b.TypeName(), v))
		}
		size += len(parts[len(parts)-1]) + 2
	}
	return strings.Join(parts, "  ")
}

func (w *briefWriter) plans(sid model.ID, s *analyze.StmtStats) {
	if w.o.MaxPlanLines == BriefNoPlans || len(s.Plans) == 0 {
		return
	}
	m := w.m
	last := map[uint64]model.ID{}
	dumps := map[uint64]int{}
	for _, pid := range s.Plans {
		last[m.Plans[pid].PLH] = pid
		dumps[m.Plans[pid].PLH]++
	}
	for i, h := range s.PlanHashes {
		if i == briefMaxPlans {
			var rest []string
			for _, h := range s.PlanHashes[i:] {
				rest = append(rest, fmt.Sprint(h))
			}
			w.p("%d more plan hashes: %s\n\n", len(rest), strings.Join(rest, ", "))
			break
		}
		p := &m.Plans[last[h]]
		w.p("Execution plan, plan hash %d (row source statistics from the STAT lines at trace line %d; %d dumps of this plan):\n\n", p.PLH, p.Line, dumps[h])
		var b strings.Builder
		fmt.Fprintf(&b, "%4s %11s %8s %10s %9s %9s %11s  %s\n", "Id", "Rows", "Starts", "CR", "PR", "PW", "Time ms", "Operation")
		for j := p.First; j < p.First+p.N; j++ {
			if int(j-p.First) == w.o.MaxPlanLines {
				fmt.Fprintf(&b, "... %d more plan lines\n", int(p.N)-w.o.MaxPlanLines)
				break
			}
			l := &m.PlanLines[j]
			op := strings.Repeat(" ", l.Depth) + l.Op
			if l.Object != "" {
				op += " " + l.Object
			}
			if l.Cost >= 0 {
				op += fmt.Sprintf("  [cost %d card %d]", l.Cost, l.Card)
			}
			fmt.Fprintf(&b, "%4d %11s %8s %10s %9s %9s %11s  %s\n", l.ID, commas(l.Cnt), commas(l.Str), commas(l.CR), commas(l.PR), commas(l.PW), ms(float64(l.TimeUs)), op)
		}
		w.fence("text", strings.TrimRight(b.String(), "\n"))
	}
}

func (w *briefWriter) findingsSection() {
	w.p("## Findings\n\n")
	if len(w.findings) == 0 {
		w.p("No rule of mtkprof found anything in this scope.\n\n")
		return
	}
	w.p("Rule hits computed by mtkprof over the same scope, most serious first. A finding is a fact about the trace, not a diagnosis.\n\n")
	for i, f := range w.findings {
		if i == briefMaxFinding {
			w.p("%d more findings are not shown.\n\n", len(w.findings)-i)
			break
		}
		w.p("### %d. %s (%s)\n\n%s\n\n", i+1, f.Title, f.Severity, f.Summary)
		if f.Statement != model.None {
			st := &w.m.Statements[f.Statement]
			at := "not listed above"
			if r := w.rank[f.Statement]; r > 0 {
				at = fmt.Sprintf("statement %d above", r)
			}
			w.p("- Statement: %s %s (%s); impact %s\n", code(w.h.sqlID(st)), code(preview(st.Text, 60)), at, dur(f.ImpactUs))
		} else {
			w.p("- Impact: %s\n", dur(f.ImpactUs))
		}
		for j, e := range f.Evidence {
			if j == briefMaxEvid {
				w.p("- and %d more evidence rows\n", len(f.Evidence)-j)
				break
			}
			v := w.evidenceValue(f.Rule, e)
			if e.Line > 0 {
				v += fmt.Sprintf(" (trace line %d)", e.Line)
			}
			w.p("- %s: %s\n", oneLine(e.Label), oneLine(v))
		}
		w.nl()
	}
}

// evidenceValue is the value of an evidence row with its bind values taken
// out and put back the way the brief shows them: the rule appends them
// unmasked, and an aggregate model leaves them out.
func (w *briefWriter) evidenceValue(rule string, e analyze.EvidenceRow) string {
	if rule != analyze.RuleOutlierExecs {
		return e.Value
	}
	v, _, _ := strings.Cut(e.Value, analyze.EvidenceBindsMarker)
	if e.Call == model.None {
		return v
	}
	if c, ok := w.src.CallAt(int64(e.Call)); ok {
		if b := w.bindText(c.BindSet); b != "" {
			v += "; binds " + b
		}
	}
	return v
}

func (w *briefWriter) otherNotes() {
	n := w.notes
	if len(n.other) == 0 && n.outside == 0 {
		return
	}
	w.p("## Other notes\n\n")
	for _, o := range n.other {
		w.bullet("About "+o.where+": ", o.Note.Note)
	}
	if n.outside > 0 {
		w.p("- %d more notes are about things outside this scope and are left out.\n", n.outside)
	}
	w.nl()
}

func (w *briefWriter) caseText() {
	c := strings.TrimSpace(w.o.Case)
	if c == "" {
		return
	}
	w.p("## Case description\n\nThe DBA's own words:\n\n")
	for _, ln := range strings.Split(c, "\n") {
		w.p("> %s\n", strings.TrimRight(ln, "\r"))
	}
	w.nl()
}

func (w *briefWriter) forAgent() {
	w.p("## For the agent\n\n")
	w.p("You are helping a DBA understand this Oracle SQL trace. Everything above is read from the trace; interpreting it is your part.\n\n")
	w.p("- Keep what the trace shows apart from what you infer. Mark an inference as one and say what would confirm it.\n")
	w.p("- Cite what you rely on: a sql_id, a trace line number, a finding, a wait event, or a figure from the tables above. Do not quote a number that is not in this brief.\n")
	w.p("- This is a summary. Only the largest statements are listed, SQL and plans are cut where marked, and each statement shows its slowest executions only. If you need something that is not here, say what you need instead of guessing.\n")
	w.p("- A statement's elapsed time includes its recursive children; own time does not. Idle time is time between calls, usually spent in the client or on the network, not in the database.\n")
	switch w.o.Binds {
	case BriefBindsMask:
		w.p("- Bind values are masked as `<TYPE len=N h=XXXXXXXX>`: equal tokens are equal values, and the value itself is not known. Bind positions count from 0 as in the trace.\n")
	case BriefBindsKeep:
		w.p("- Bind values are shown as traced. Bind positions count from 0 as in the trace.\n")
	}
	w.p("- Answer with the likely causes in order, the evidence for each, and the next thing to check or change. Keep it short.\n")
}

// ---- markdown helpers -------------------------------------------------------

// bullet prints a list item whose text may span lines; the lines after the
// first are indented under it.
func (w *briefWriter) bullet(lead, text string) {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	w.p("- %s%s\n", lead, strings.TrimRight(lines[0], "\r"))
	for _, ln := range lines[1:] {
		if ln = strings.TrimRight(ln, "\r"); ln == "" {
			w.nl()
		} else {
			w.p("  %s\n", ln)
		}
	}
}

// fence prints a fenced block, longer fences than any run of backticks in text.
func (w *briefWriter) fence(lang, text string) {
	f := strings.Repeat("`", max(3, longestRun(text, '`')+1))
	w.p("%s%s\n%s\n%s\n\n", f, lang, text, f)
}

func longestRun(s string, c byte) int {
	best, run := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			run++
			best = max(best, run)
		} else {
			run = 0
		}
	}
	return best
}

// code is s as an inline code span.
func code(s string) string {
	s = oneLine(s)
	f := strings.Repeat("`", longestRun(s, '`')+1)
	if strings.HasPrefix(s, "`") || strings.HasSuffix(s, "`") {
		return f + " " + s + " " + f
	}
	return f + s + f
}

func quote(s string) string { return `"` + oneLine(s) + `"` }

// oneLine collapses s to a single line.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// cell is s for a table cell.
func cell(s string) string { return strings.ReplaceAll(oneLine(s), "|", `\|`) }

func share(part, total int64) string {
	if total <= 0 {
		return "-"
	}
	return fmt.Sprintf("%.1f%%", 100*float64(part)/float64(total))
}

// dur is a duration in µs as seconds, milliseconds or microseconds.
func dur(us int64) string {
	switch {
	case us >= 1_000_000 || us <= -1_000_000:
		return fmt.Sprintf("%.3f s", float64(us)/1e6)
	case us >= 1000 || us <= -1000:
		return fmt.Sprintf("%.1f ms", float64(us)/1e3)
	}
	return fmt.Sprintf("%d µs", us)
}
