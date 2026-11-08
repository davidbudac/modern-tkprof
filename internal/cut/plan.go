package cut

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Piece is a block of the new file: kept lines (one or more runs of source
// lines with nothing inserted between them), or a borrowed or generated block.
type Piece struct {
	Kind   string   `json:"kind"` // header | kept | before | after | generated
	Title  string   `json:"title,omitempty"`
	Reason string   `json:"reason,omitempty"`
	File   int      `json:"file"`
	From   int32    `json:"from,omitempty"`  // first source line (0: generated)
	To     int32    `json:"to,omitempty"`    // last source line
	Lines  []int32  `json:"lines,omitempty"` // the source lines when they are not one run (session markers)
	Runs   int      `json:"runs,omitempty"`  // kept: runs of consecutive source lines
	N      int64    `json:"n"`               // lines
	O0     int64    `json:"o0"`              // first and last line in the new file
	O1     int64    `json:"o1"`
	Edge   int64    `json:"edge,omitempty"` // kept: call and wait lines outside the window, kept to finish a call
	SQL    string   `json:"sql,omitempty"`
	Head   []string `json:"head"`
	Tail   []string `json:"tail,omitempty"`
}

// Run is a stretch of source lines with one label: K kept, E kept to finish
// a call, H file header, B borrowed (used before the cut), A borrowed (after
// it), C a caller left out (statement selection).
type Run struct {
	From int32  `json:"f"`
	To   int32  `json:"t"`
	L    string `json:"l"`
}

// FileRuns are the labelled lines of one source file (lines without a label are left out).
type FileRuns struct {
	Idx   int    `json:"idx"`
	Name  string `json:"name"`
	Lines int    `json:"lines"`
	Runs  []Run  `json:"runs"`
}

// Plan describes the new file: its pieces in order and, per source file,
// where every line goes.
type Plan struct {
	Files      []FileRuns `json:"files"`
	Pieces     []*Piece   `json:"pieces"`
	Lines      int64      `json:"lines"`
	Bytes      int64      `json:"bytes"`
	KeptFrom   int64      `json:"keptFrom"` // tim extent of the kept calls
	KeptTo     int64      `json:"keptTo"`
	Calls      int64      `json:"calls"`
	Waits      int64      `json:"waits"`
	WaitUs     int64      `json:"waitUs"`
	Statements []StmtCut  `json:"statements"`
	Callers    []model.ID `json:"callers"`
	Processes  int        `json:"processes"`
	Binds      string     `json:"binds"`
	// BindsAllowed are the bind modes the source allows (set by the server:
	// a session with redacted or dropped values never gets them back)
	BindsAllowed []string `json:"bindsAllowed"`
}

// MaxRuns caps the runs of one file in a Plan: beyond it, short gaps are closed.
const MaxRuns = 20000

const (
	headLines = 7
	tailLines = 5
	maxText   = 400
)

type planner struct {
	p     *Plan
	cur   *Piece
	last  int32 // last source line of the current kept piece
	tail  [][]byte
	runs  [][]Run
	out   int64
	bytes int64
}

func kindOf(l byte) string {
	switch l {
	case 'K', 'E':
		return "kept"
	case 'H':
		return "header"
	case 'B':
		return "before"
	case 'A':
		return "after"
	}
	return "generated"
}

func clip(b []byte) string {
	if len(b) > maxText {
		return string(b[:maxText]) + "…"
	}
	return string(b)
}

func (pl *planner) put(it *item) error {
	pl.out++
	pl.bytes += int64(len(it.text)) + 1
	kind := kindOf(it.label)
	if it.start != nil || pl.cur == nil || pl.cur.Kind != kind || (kind == "kept" && int32(pl.cur.File) != it.file) {
		pl.endPiece()
		p := it.start
		if p == nil {
			p = &Piece{Kind: kind, File: int(it.file)}
		}
		p.O0 = pl.out
		pl.cur = p
		pl.p.Pieces = append(pl.p.Pieces, p)
		if kind == "kept" {
			p.Runs = 1
		}
	} else if kind == "kept" && it.line != pl.last+1 {
		pl.cur.Runs++
	}
	p := pl.cur
	p.N++
	p.O1 = pl.out
	if it.line > 0 {
		if p.From == 0 || it.line < p.From {
			p.From = it.line
		}
		if it.line > p.To {
			p.To = it.line
		}
		pl.last = it.line
		pl.addRun(int(it.file), it.line, string(it.label))
	}
	if it.label == 'E' {
		p.Edge++
	}
	if len(p.Head) < headLines {
		p.Head = append(p.Head, clip(it.text))
	} else {
		pl.tail = append(pl.tail, append([]byte(nil), it.text...))
		if len(pl.tail) > tailLines {
			pl.tail = pl.tail[1:]
		}
	}
	return nil
}

func (pl *planner) endPiece() {
	if pl.cur != nil && len(pl.tail) > 0 {
		for _, t := range pl.tail {
			pl.cur.Tail = append(pl.cur.Tail, clip(t))
		}
	}
	pl.tail = pl.tail[:0]
}

func (pl *planner) addRun(f int, line int32, l string) {
	for len(pl.runs) <= f {
		pl.runs = append(pl.runs, nil)
	}
	rs := pl.runs[f]
	if n := len(rs); n > 0 && rs[n-1].L == l && rs[n-1].To+1 == line {
		rs[n-1].To = line
		return
	}
	pl.runs[f] = append(rs, Run{line, line, l})
}

// finish sorts and caps the runs and adds the callers' lines.
func (pl *planner) finish(c *Cutter, s *selected) {
	pl.endPiece()
	m := c.m
	for f := range m.File.Files {
		for len(pl.runs) <= f {
			pl.runs = append(pl.runs, nil)
		}
		if s != nil {
			for _, l := range s.callers[f] {
				pl.addRun(f, l, "C")
			}
		}
		rs := pl.runs[f]
		sort.SliceStable(rs, func(i, j int) bool { return rs[i].From < rs[j].From })
		// merge neighbours of one label
		var out []Run
		for _, r := range rs {
			if n := len(out); n > 0 && out[n-1].L == r.L && r.From <= out[n-1].To+1 {
				if r.To > out[n-1].To {
					out[n-1].To = r.To
				}
				continue
			}
			out = append(out, r)
		}
		lines := m.File.Files[f].Lines
		for gap := int32(1); len(out) > MaxRuns; gap *= 2 {
			var c []Run
			for _, r := range out {
				if n := len(c); n > 0 && c[n-1].L == r.L && r.From <= c[n-1].To+gap {
					c[n-1].To = r.To
					continue
				}
				c = append(c, r)
			}
			out = c
		}
		pl.p.Files = append(pl.p.Files, FileRuns{Idx: f, Name: m.File.Files[f].Name, Lines: lines, Runs: out})
	}
	pl.p.Lines, pl.p.Bytes = pl.out, pl.bytes
}

type writerSink struct {
	w *bufio.Writer
}

func (ws writerSink) put(it *item) error {
	if _, err := ws.w.Write(it.text); err != nil {
		return err
	}
	return ws.w.WriteByte('\n')
}

type tee [2]sink

func (t tee) put(it *item) error {
	if err := t[0].put(it); err != nil {
		return err
	}
	return t[1].put(it)
}

// Plan describes the new file of a selection without writing it.
func (c *Cutter) Plan(ctx context.Context, sel Selection) (*Plan, error) {
	p, _, err := c.run(ctx, &sel, nil)
	return p, err
}

// Write writes the new file of a selection to w.
func (c *Cutter) Write(ctx context.Context, sel Selection, w io.Writer) (*Plan, error) {
	p, _, err := c.run(ctx, &sel, w)
	return p, err
}

func (c *Cutter) run(ctx context.Context, sel *Selection, w io.Writer) (*Plan, *selected, error) {
	s, err := c.selectFacts(ctx, sel)
	if err != nil {
		return nil, nil, err
	}
	p := &Plan{KeptFrom: s.keptFrom, KeptTo: s.keptTo, Calls: s.nKept, Waits: s.exp.waits.n, WaitUs: s.exp.waits.us, Binds: sel.Binds.String()}
	for id := range s.callerStmts {
		p.Callers = append(p.Callers, id)
	}
	sort.Slice(p.Callers, func(i, j int) bool { return p.Callers[i] < p.Callers[j] })
	for _, st := range s.stmts {
		p.Statements = append(p.Statements, *st)
	}
	sort.Slice(p.Statements, func(i, j int) bool {
		if p.Statements[i].ElaUs != p.Statements[j].ElaUs {
			return p.Statements[i].ElaUs > p.Statements[j].ElaUs
		}
		return p.Statements[i].ID < p.Statements[j].ID
	})
	for p2, sp := range s.spans {
		if len(sp) > 0 {
			_ = p2
			p.Processes++
		}
	}
	pl := &planner{p: p}
	var out sink = pl
	var bw *bufio.Writer
	if w != nil {
		bw = bufio.NewWriterSize(w, 1<<20)
		out = tee{pl, writerSink{bw}}
	}
	if err := c.walk(ctx, sel, s, out); err != nil {
		return nil, nil, err
	}
	pl.finish(c, s)
	if bw != nil {
		if err := bw.Flush(); err != nil {
			return nil, nil, err
		}
	}
	return p, s, nil
}

// Check is the comparison of a written cut, parsed back, with its selection.
type Check struct {
	OK           bool     `json:"ok"`
	Calls        int64    `json:"calls"`
	CallsWant    int64    `json:"callsWant"`
	Waits        int64    `json:"waits"`
	WaitsWant    int64    `json:"waitsWant"`
	WaitUs       int64    `json:"waitUs"`
	WaitUsWant   int64    `json:"waitUsWant"`
	WallOK       bool     `json:"wallOk"`       // the first kept call has the same wall clock in both
	NewUnknown   int      `json:"newUnknown"`   // statements that lost their SQL text (cursor opened before the cut, not restated)
	UnknownLines int      `json:"unknownLines"` // lines the parser did not recognise
	Statements   int      `json:"statements"`
	BindSets     int      `json:"bindSets"`
	Plans        int      `json:"plans"`
	Lines        int64    `json:"lines"`
	Bytes        int64    `json:"bytes"`
	Mismatches   []string `json:"mismatches,omitempty"` // statement and call kind: want vs got, the first 20
}

// Check writes the cut to a temporary file in dir, parses it and compares
// its calls (per statement and call kind: count and elapsed), waits and
// wall clock with what the selection keeps. See CheckMax.
func (c *Cutter) Check(ctx context.Context, sel Selection, dir string) (*Check, error) {
	return c.CheckMax(ctx, sel, dir, 0)
}

// TooBigError is the error of a check whose new file is bigger than its
// limit (CheckMax): the write stopped there and nothing was parsed.
type TooBigError struct{ Max int64 }

func (e *TooBigError) Error() string {
	return fmt.Sprintf("the new file is bigger than %d MiB, the limit of a re-parse check", e.Max>>20)
}

// CheckMax is Check with a limit: a new file bigger than maxBytes (> 0) is
// not checked (*TooBigError). The parse back is an aggregation-only build
// with a sink that keeps only what the comparison needs (checkSink), so its
// memory is that of the cut's dimensions, not of its facts; ctx cancels the
// write and the parse alike (model.Options.Ctx), and the temporary file is
// removed however the check ends.
func (c *Cutter) CheckMax(ctx context.Context, sel Selection, dir string, maxBytes int64) (*Check, error) {
	return c.check(ctx, sel, dir, maxBytes, parseAgg)
}

// parser parses a written cut back (parseAgg; the tests compare it with a
// full build).
type parser func(ctx context.Context, path string) (*parsed, error)

func (c *Cutter) check(ctx context.Context, sel Selection, dir string, maxBytes int64, parse parser) (*Check, error) {
	fh, err := os.CreateTemp(dir, "mtkprof-cut-*.trc")
	if err != nil {
		return nil, err
	}
	path := fh.Name()
	defer os.Remove(path)
	var w io.Writer = fh
	if maxBytes > 0 {
		w = &limitWriter{w: fh, left: maxBytes, max: maxBytes}
	}
	p, s, err := c.run(ctx, &sel, w)
	if cerr := fh.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	got, err := parse(ctx, path)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("parse the cut: %w", err)
	}
	return compare(s, got, p), nil
}

// limitWriter fails a write that would take the output past max bytes.
type limitWriter struct {
	w         io.Writer
	left, max int64
}

func (l *limitWriter) Write(b []byte) (int, error) {
	if int64(len(b)) > l.left {
		return 0, &TooBigError{Max: l.max}
	}
	n, err := l.w.Write(b)
	l.left -= int64(n)
	return n, err
}

// parsed is what a check compares of the cut parsed back.
type parsed struct {
	calls        map[stmtKind]*count // per statement (key) and call kind: count and elapsed
	nCalls       int64
	waits        count
	first        int64    // the earliest wall clock of a call's end (0: none known)
	unknown      []string // keys of the statements without SQL text
	statements   int
	bindSets     int
	plans        int
	unknownLines int
}

// parseAgg parses a cut with an aggregation-only build: the calls and waits
// go to a checkSink instead of the model, the bind sets are counted as the
// builder decodes them.
func parseAgg(ctx context.Context, path string) (*parsed, error) {
	var k *checkSink
	m, err := model.Build(path, model.Options{Ctx: ctx, Aggregate: true, SpillBinds: true,
		NewTee: func(m *model.Model) model.Sink { k = newCheckSink(m); return k }})
	if err != nil {
		return nil, err
	}
	return k.result(m), nil
}

// checkSink accumulates what compare needs of the calls and waits of an
// aggregation-only build: per cursor and call kind the count and elapsed
// (the cursor's statement is resolved at the end, after implicit cursors
// were adopted, as a full build re-points its calls), the waits' count and
// µs, the earliest wall clock of a call, and the number of bind sets.
type checkSink struct {
	m        *model.Model
	calls    map[callKey]*count
	n        int64
	waits    count
	first    int64
	bindSets int
}

// callKey is a call's cursor (None: the call has none, stmt is its
// statement) and kind.
type callKey struct {
	cur, stmt model.ID
	kind      trace.CallKind
}

// checkHook, when set (tests), runs after every call the check sink takes.
var checkHook func()

func newCheckSink(m *model.Model) *checkSink {
	return &checkSink{m: m, calls: map[callKey]*count{}}
}

func (k *checkSink) Call(c *model.Call) {
	key := callKey{cur: c.Cursor, stmt: model.None, kind: c.Kind}
	if c.Cursor < 0 {
		key = callKey{cur: model.None, stmt: c.Statement, kind: c.Kind}
	}
	g := k.calls[key]
	if g == nil {
		g = &count{}
		k.calls[key] = g
	}
	g.n++
	g.us += c.E
	k.n++
	if w := k.m.CallWall(c); w != 0 && (k.first == 0 || w < k.first) {
		k.first = w
	}
	if checkHook != nil {
		checkHook()
	}
}

func (k *checkSink) Child(*model.ChildRec, *model.Call) {}

func (k *checkSink) Wait(w *model.Wait, _ *model.Call) {
	k.waits.n++
	k.waits.us += w.Ela
}

func (k *checkSink) Adopt(model.ID, model.ID) {}
func (k *checkSink) Finish()                  {}

func (k *checkSink) BindSet(*model.BindSet, []model.Bind) { k.bindSets++ }

func (k *checkSink) result(m *model.Model) *parsed {
	keys := stmtKeys(m)
	out := &parsed{calls: map[stmtKind]*count{}, nCalls: k.n, waits: k.waits, first: k.first, statements: len(m.Statements),
		bindSets: k.bindSets, plans: len(m.Plans), unknownLines: m.Diag.UnknownLines, unknown: unknownKeys(m, keys)}
	for key, c := range k.calls {
		st := key.stmt
		if key.cur >= 0 && int(key.cur) < len(m.Cursors) {
			st = m.Cursors[key.cur].Statement
		}
		sk := stmtKind{stmtKeyOf(keys, st), key.kind}
		g := out.calls[sk]
		if g == nil {
			g = &count{}
			out.calls[sk] = g
		}
		g.n += c.n
		g.us += c.us
	}
	return out
}

// stmtKeyOf is the key of statement id ("" for none).
func stmtKeyOf(keys []string, id model.ID) string {
	if id < 0 || int(id) >= len(keys) {
		return ""
	}
	return keys[id]
}

// unknownKeys are the keys of the statements of m without SQL text.
func unknownKeys(m *model.Model, keys []string) []string {
	var out []string
	for i := range m.Statements {
		if m.Statements[i].Kind == model.StmtUnknown {
			out = append(out, keys[i])
		}
	}
	return out
}

func compare(s *selected, got *parsed, p *Plan) *Check {
	ck := &Check{CallsWant: s.nKept, WaitsWant: s.exp.waits.n, WaitUsWant: s.exp.waits.us, Lines: p.Lines, Bytes: p.Bytes,
		Calls: got.nCalls, Waits: got.waits.n, WaitUs: got.waits.us,
		Statements: got.statements, BindSets: got.bindSets, Plans: got.plans, UnknownLines: got.unknownLines}
	for _, k := range got.unknown {
		if !s.exp.unknown[k] {
			ck.NewUnknown++
		}
	}
	var mis []string
	for k, w := range s.exp.calls {
		if g := got.calls[k]; g == nil || *g != *w {
			gg := count{}
			if g != nil {
				gg = *g
			}
			mis = append(mis, fmt.Sprintf("%s %s: want %d calls %d µs, got %d calls %d µs", k.stmt, k.kind, w.n, w.us, gg.n, gg.us))
		}
	}
	for k, g := range got.calls {
		if s.exp.calls[k] == nil {
			mis = append(mis, fmt.Sprintf("%s %s: want none, got %d calls %d µs", k.stmt, k.kind, g.n, g.us))
		}
	}
	sort.Strings(mis)
	if len(mis) > 20 {
		mis = mis[:20]
	}
	ck.Mismatches = mis
	ck.WallOK = s.exp.firstWall == 0 || got.first == s.exp.firstWall
	ck.OK = len(mis) == 0 && ck.Calls == ck.CallsWant && ck.Waits == ck.WaitsWant && ck.WaitUs == ck.WaitUsWant && ck.WallOK && ck.NewUnknown == 0
	return ck
}
