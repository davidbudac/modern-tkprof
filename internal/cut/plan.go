package cut

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
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
// wall clock with what the selection keeps.
func (c *Cutter) Check(ctx context.Context, sel Selection, dir string) (*Check, error) {
	fh, err := os.CreateTemp(dir, "mtkprof-cut-*.trc")
	if err != nil {
		return nil, err
	}
	path := fh.Name()
	defer os.Remove(path)
	p, s, err := c.run(ctx, &sel, fh)
	if cerr := fh.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	m2, err := model.Build(path, model.Options{})
	if err != nil {
		return nil, fmt.Errorf("parse the cut: %w", err)
	}
	return compare(s, m2, p), nil
}

func compare(s *selected, m2 *model.Model, p *Plan) *Check {
	ck := &Check{CallsWant: s.nKept, WaitsWant: s.exp.waits.n, WaitUsWant: s.exp.waits.us, Lines: p.Lines, Bytes: p.Bytes,
		Statements: len(m2.Statements), BindSets: len(m2.BindSets), Plans: len(m2.Plans), UnknownLines: m2.Diag.UnknownLines}
	keys := stmtKeys(m2)
	got := map[stmtKind]*count{}
	first := int64(0)
	for i := range m2.Calls {
		cl := &m2.Calls[i]
		k := stmtKind{keys[cl.Statement], cl.Kind}
		g := got[k]
		if g == nil {
			g = &count{}
			got[k] = g
		}
		g.n++
		g.us += cl.E
		ck.Calls++
		if w := m2.CallWall(cl); w != 0 && (first == 0 || w < first) {
			first = w
		}
	}
	for i := range m2.Waits {
		ck.Waits++
		ck.WaitUs += m2.Waits[i].Ela
	}
	for i := range m2.Statements {
		if m2.Statements[i].Kind == model.StmtUnknown && !s.exp.unknown[keys[i]] {
			ck.NewUnknown++
		}
	}
	var mis []string
	for k, w := range s.exp.calls {
		if g := got[k]; g == nil || *g != *w {
			gg := count{}
			if g != nil {
				gg = *g
			}
			mis = append(mis, fmt.Sprintf("%s %s: want %d calls %d µs, got %d calls %d µs", k.stmt, k.kind, w.n, w.us, gg.n, gg.us))
		}
	}
	for k, g := range got {
		if s.exp.calls[k] == nil {
			mis = append(mis, fmt.Sprintf("%s %s: want none, got %d calls %d µs", k.stmt, k.kind, g.n, g.us))
		}
	}
	sort.Strings(mis)
	if len(mis) > 20 {
		mis = mis[:20]
	}
	ck.Mismatches = mis
	ck.WallOK = s.exp.firstWall == 0 || first == s.exp.firstWall
	ck.OK = len(mis) == 0 && ck.Calls == ck.CallsWant && ck.Waits == ck.WaitsWant && ck.WaitUs == ck.WaitUsWant && ck.WallOK && ck.NewUnknown == 0
	return ck
}
