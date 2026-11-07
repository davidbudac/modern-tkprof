package slice

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The Trace pane highlights a statement by the per-line statement id of the
// annotated pages (annot=2, annotate2) and filters the trace to a set of
// statements. The filter and the strip beside the scroll bar need the lines of
// a statement for the whole file, not for the pages that happen to be loaded:
// this is the same predicate (a line belongs to statement X iff annotate2
// answers s == X for it) computed from the fact rows with a few small text
// reads, so the cost does not depend on the size of the file's text.

const (
	defStmtRuns   = 100000
	maxStmtRuns   = 500000
	maxStmtIDs    = 20000
	maxStmtBins   = 2000
	cursorChunk   = 64 // lines read at first for the text of a cursor
	maxCursorRead = 512
)

// stmtLineMap is the statement of every line of one file as runs: run i covers
// the lines starts[i] .. starts[i+1]-1 (the last one to total) and belongs to
// stmts[i], -1 for none. Built once per file.
type stmtLineMap struct {
	total        int // lines of the file when it was built
	calls, waits rowRange
	starts       []int32
	stmts        []int32
}

// add appends the lines [from, to] of stmt, joining the run before it when it is
// the same statement and adjacent.
func (m *stmtLineMap) add(from, to int, stmt int32) {
	if from > to {
		return
	}
	if n := len(m.stmts); n > 0 && m.stmts[n-1] == stmt {
		return // (lines are added in order and without gaps: the run just grows)
	}
	m.starts = append(m.starts, int32(from))
	m.stmts = append(m.stmts, stmt)
}

// end is the last line of run i.
func (m *stmtLineMap) end(i int) int {
	if i+1 < len(m.starts) {
		return int(m.starts[i+1]) - 1
	}
	return m.total
}

// claim is a block of lines that a statement owns whatever the call rows say.
type claim struct {
	from, to int
	stmt     int32
}

// stmtMapOf returns the file's line map, building it when it is not there or the
// file grew (a live session) or its rows changed.
func (s *Server) stmtMapOf(ctx context.Context, fi int, li *trace.LineIndex, f *fileInfo) (*stmtLineMap, error) {
	s.stmtMu.Lock()
	defer s.stmtMu.Unlock()
	if m, ok := s.stmtMaps[fi]; ok && m.total == li.Lines() && m.calls == f.calls && m.waits == f.waits {
		return m, nil
	}
	m, err := s.buildStmtMap(ctx, fi, li, f)
	if err != nil {
		return nil, err
	}
	if s.stmtMaps == nil {
		s.stmtMaps = map[int]*stmtLineMap{}
	}
	s.stmtMaps[fi] = m
	return m, nil
}

// buildStmtMap sweeps the file in line order over three sources: the call rows
// (from a call's line on, until the next call row, the lines belong to that
// call's statement: annotate2's default), the wait rows (their own line belongs
// to the wait's statement) and the blocks (claims) whose lines annotate2 gives to
// another statement by their kind: a cursor's PARSING IN CURSOR line, SQL text and
// END OF STMT (and a failed parse's PARSE ERROR line with its text), a plan's STAT
// lines and a BINDS block (to the call the block is attached to). A claim wins
// over the default; where a claim overlaps one before it, the one before wins (the
// kinds cannot overlap in a real trace).
func (s *Server) buildStmtMap(ctx context.Context, fi int, li *trace.LineIndex, f *fileInfo) (*stmtLineMap, error) {
	m := &stmtLineMap{total: li.Lines(), calls: f.calls, waits: f.waits}
	claims, err := s.stmtClaims(ctx, fi, li, f)
	if err != nil {
		return nil, err
	}
	var (
		ci, wi   = f.calls.lo, f.waits.lo
		ki       int
		pos      = 1 // the next line without a statement yet
		def      = int32(-1)
		call     model.Call
		callOK   bool
		wait     model.Wait
		waitOK   bool
		readCall = func() error {
			callOK = false
			if ci < f.calls.hi {
				c, ok := s.src.CallAt(ci)
				if !ok {
					return fmt.Errorf("read call row %d", ci)
				}
				call, callOK = c, true
			}
			return nil
		}
		readWait = func() error {
			waitOK = false
			if wi < f.waits.hi {
				w, ok := s.src.WaitAt(wi)
				if !ok {
					return fmt.Errorf("read wait row %d", wi)
				}
				wait, waitOK = w, true
			}
			return nil
		}
		fill = func(upto int) { // the default statement for the lines up to (not including) `upto`
			if upto > pos {
				m.add(pos, upto-1, def)
				pos = upto
			}
		}
	)
	if err := readCall(); err != nil {
		return nil, err
	}
	if err := readWait(); err != nil {
		return nil, err
	}
	for n := 0; ; n++ {
		if n&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		// the next item in line order: a call row, a wait row or a claim
		kind, line := 0, int(^uint(0)>>1)
		if callOK && int(call.Line) < line {
			kind, line = 1, int(call.Line)
		}
		if waitOK && int(wait.Line) < line {
			kind, line = 2, int(wait.Line)
		}
		if ki < len(claims) && claims[ki].from < line {
			kind, line = 3, claims[ki].from
		}
		switch kind {
		case 0:
			fill(m.total + 1)
			return m, nil
		case 1:
			fill(line)                  // (the lines before it keep the call before's statement)
			def = int32(call.Statement) // (the call's own line and the lines after it, until the next call)
			ci++
			if err := readCall(); err != nil {
				return nil, err
			}
		case 2:
			if line >= pos && line <= m.total {
				fill(line)
				m.add(line, line, int32(wait.Statement))
				pos = line + 1
			}
			wi++
			if err := readWait(); err != nil {
				return nil, err
			}
		case 3:
			c := claims[ki]
			ki++
			from := max(c.from, pos)
			if from > c.to || from > m.total {
				continue
			}
			fill(from)
			m.add(from, min(c.to, m.total), c.stmt)
			pos = min(c.to, m.total) + 1
		}
	}
}

// stmtClaims lists the blocks of the file whose lines belong to a statement by
// their kind, sorted by first line: the cursors' text, the plans' STAT lines and
// the BINDS blocks.
func (s *Server) stmtClaims(ctx context.Context, fi int, li *trace.LineIndex, f *fileInfo) ([]claim, error) {
	var out []claim
	// cursors: the PARSING IN CURSOR line, its SQL text lines, END OF STMT
	for i, c := range f.cursors {
		if i&255 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		if c.line < 1 || c.line > li.Lines() || c.id < 0 || int(c.id) >= len(s.m.Cursors) {
			continue
		}
		cur := &s.m.Cursors[c.id]
		if cur.Statement < 0 || int(cur.Statement) >= len(s.m.Statements) {
			continue
		}
		from, end, pic, err := cursorBlock(li, c.line)
		if err != nil {
			return nil, err
		}
		if st := &s.m.Statements[cur.Statement]; st.Kind == model.StmtParseError {
			// a failed parse: the PARSE ERROR line and the SQL text the parser read after it
			out = append(out, claim{from, min(li.Lines(), c.line+strings.Count(st.Text, "\n")+1), int32(cur.Statement)})
			continue
		}
		if pic {
			out = append(out, claim{from, end, int32(cur.Statement)})
		} else if from < c.line {
			out = append(out, claim{from, from, int32(cur.Statement)}) // (the rule only)
		}
	}
	// plans: the STAT lines of a dump are adjacent
	for _, p := range f.plans {
		if p.id < 0 || int(p.id) >= len(s.m.Plans) {
			continue
		}
		pl := &s.m.Plans[p.id]
		if pl.N > 0 {
			out = append(out, claim{p.line, p.line + int(pl.N) - 1, int32(pl.Statement)})
		}
	}
	// BINDS blocks: the block belongs to the first call after it whose bind set starts at or before it
	bc, err := s.bindClaims(ctx, fi, li, f)
	if err != nil {
		return nil, err
	}
	out = append(out, bc...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].from < out[j].from })
	return out, nil
}

// cursorBlock reads the cursor whose first line is p: from is the `=====` rule
// on the line above when there is one (it belongs to the cursor), else p; pic says
// line p is a PARSING IN CURSOR line, and end is then the last line of its block:
// its END OF STMT line, or its last SQL text line when the text does not end with
// one. A PARSE ERROR cursor (not a PIC line) gets from only.
func cursorBlock(li *trace.LineIndex, p int) (from, end int, pic bool, err error) {
	first := max(1, p-1)
	cl := trace.NewClassifier(first == 1)
	chunk := cursorChunk
	pos := first
	from, end = p, p
	for pos-p < maxStmtLines && pos <= li.Lines() {
		n := min(chunk, li.Lines()-pos+1)
		raw, err := li.Read(pos, n)
		if err != nil {
			return 0, 0, false, err
		}
		lines := splitLines(raw)
		if len(lines) == 0 {
			break
		}
		for j, l := range lines {
			line := pos + j
			k := cl.Next(l)
			switch {
			case line < p:
				if k == trace.KindSeparator {
					from = line
				}
			case line == p:
				if k != trace.KindParsingInCursor {
					return from, p, false, nil
				}
				pic = true
			case k == trace.KindEndOfStmt:
				return from, line, true, nil
			case k == trace.KindSQLText:
				end = line
			default:
				return from, end, true, nil
			}
		}
		pos += len(lines)
		chunk = min(chunk*2, maxCursorRead)
	}
	return from, end, pic, nil
}

// bindClaims are the BINDS blocks of the file with the statement of the call each
// is attached to: bindOwner's rule, the first call row after the block (looking at
// most maxBindOwnerScan rows on) whose bind set starts at or before the block.
// One pass over the call rows resolves every header: a header waits in a short
// queue from the first call row after it until a call with a bind set at or before
// it takes it.
func (s *Server) bindClaims(ctx context.Context, fi int, li *trace.LineIndex, f *fileInfo) ([]claim, error) {
	hdrs, err := s.bindHeaders(ctx, fi, f)
	if err != nil {
		return nil, err
	}
	type waiting struct {
		hdr int
		row int64 // the first row that may own it
	}
	var out []claim
	var pending []waiting
	hp := 0
	for row := f.calls.lo; row < f.calls.hi; row++ {
		if row&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		c, ok := s.src.CallAt(row)
		if !ok {
			return nil, fmt.Errorf("read call row %d", row)
		}
		for hp < len(hdrs) && hdrs[hp] < int(c.Line) { // the headers above this call
			pending = append(pending, waiting{hdrs[hp], row})
			hp++
		}
		if len(pending) == 0 {
			continue
		}
		l := -1
		if c.BindSet >= 0 {
			if bl, ok := s.src.BindSetLine(c.BindSet); ok {
				l = bl
			}
		}
		keep := pending[:0]
		for _, w := range pending {
			switch {
			case l >= 0 && l <= w.hdr:
				end, ok, err := bindBlockExtent(li, w.hdr)
				if err != nil {
					return nil, err
				}
				if ok {
					out = append(out, claim{w.hdr, end, int32(c.Statement)})
				}
			case row+1 >= w.row+maxBindOwnerScan:
				// bindOwner looks at maxBindOwnerScan rows: this block has no owner
			default:
				keep = append(keep, w)
			}
		}
		pending = keep
	}
	return out, nil
}

// bindBlockExtent is the last line of the BINDS block whose header is at line hdr
// in the sense of annotate2: the block goes on over bind lines and over the
// unrecognised and blank lines after them (a continuation line of a value, a
// memory dump row, the blank lines before the next recognised line) up to the
// first other recognised line or the next BINDS header. ok=false when the line
// is not a BINDS header.
func bindBlockExtent(li *trace.LineIndex, hdr int) (end int, ok bool, err error) {
	end = hdr
	chunk := 32
	for next := hdr; next-hdr < maxBindBlock && next <= li.Lines(); {
		n := min(chunk, maxBindBlock-(next-hdr), li.Lines()-next+1)
		raw, err := li.Read(next, n)
		if err != nil {
			return 0, false, err
		}
		lines := splitLines(raw)
		if len(lines) == 0 {
			break
		}
		for i, l := range lines {
			line := next + i
			k, _ := trace.Classify(l, false)
			if line == hdr {
				if k != trace.KindBinds {
					return 0, false, nil
				}
				continue
			}
			switch k {
			case trace.KindBlank, trace.KindUnknown, trace.KindBindLine:
				end = line
			default:
				return end, true, nil
			}
		}
		next += len(lines)
		chunk = min(chunk*2, 512)
	}
	return end, true, nil
}

// linesStmts answers /api/lines/stmts?file=&ids=1,2,3[&limit=N][&union=1][&bins=B].
func (s *Server) linesStmts(ctx context.Context, q url.Values) (any, error) {
	fi, li, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	ids, err := stmtIDList(q.Get("ids"))
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", defStmtRuns, 1, maxStmtRuns)
	if err != nil {
		return nil, err
	}
	union, err := boolParam(q, "union")
	if err != nil {
		return nil, err
	}
	bins, err := intParam(q, "bins", 0, 1, maxStmtBins) // (absent: 0, no bins)
	if err != nil {
		return nil, err
	}
	if union && bins > 0 {
		return nil, bad("bins and union cannot be combined")
	}
	m, err := s.stmtMapOf(ctx, fi, li, f)
	if err != nil {
		return nil, err
	}
	return answerStmts(m, ids, int(limit), union, int(bins)), nil
}

// boolParam reads ?name=1|true|0|false (absent: false).
func boolParam(q url.Values, name string) (bool, error) {
	switch v := q.Get(name); v {
	case "", "0", "false":
		return false, nil
	case "1", "true":
		return true, nil
	default:
		return false, bad("%s: %q is not 0, 1, true or false", name, v)
	}
}

// stmtIDList parses ?ids=: distinct non-negative integers in the order given.
func stmtIDList(v string) ([]int32, error) {
	if v == "" {
		return nil, bad("ids is required")
	}
	parts := strings.Split(v, ",")
	if len(parts) > maxStmtIDs {
		return nil, bad("ids: at most %d ids", maxStmtIDs)
	}
	seen := make(map[int32]bool, len(parts))
	out := make([]int32, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 32)
		if err != nil || n < 0 {
			return nil, bad("ids: %q is not a statement id", p)
		}
		if !seen[int32(n)] {
			seen[int32(n)] = true
			out = append(out, int32(n))
		}
	}
	return out, nil
}

type stmtRuns struct {
	ID    int32    `json:"id"`
	Lines int      `json:"lines"`
	Runs  [][2]int `json:"runs"`
}

type stmtCounts struct {
	ID     int32 `json:"id"`
	Lines  int   `json:"lines"`
	Counts []int `json:"counts"`
}

// answerStmts reads the requested statements' lines off the map in one pass in
// line order.
func answerStmts(m *stmtLineMap, ids []int32, limit int, union bool, bins int) any {
	index := make(map[int32]int, len(ids))
	for i, id := range ids {
		index[id] = i
	}
	switch {
	case bins > 0:
		out := struct {
			Total   int          `json:"total"`
			Buckets int          `json:"buckets"`
			Size    int          `json:"size"`
			Stmts   []stmtCounts `json:"stmts"`
		}{Total: m.total, Stmts: make([]stmtCounts, len(ids))}
		for i, id := range ids {
			out.Stmts[i] = stmtCounts{ID: id, Counts: []int{}}
		}
		if m.total <= 0 {
			return out
		}
		b := min(bins, m.total)
		size := (m.total + b - 1) / b
		out.Buckets, out.Size = b, size
		for i := range out.Stmts {
			out.Stmts[i].Counts = make([]int, b)
		}
		for r := range m.starts {
			k, ok := index[m.stmts[r]]
			if !ok {
				continue
			}
			from, to := int(m.starts[r]), m.end(r)
			out.Stmts[k].Lines += to - from + 1
			for bk := (from - 1) / size; bk <= (to-1)/size && bk < b; bk++ {
				lo, hi := max(from, bk*size+1), min(to, (bk+1)*size)
				out.Stmts[k].Counts[bk] += hi - lo + 1
			}
		}
		return out
	case union:
		out := struct {
			Total     int      `json:"total"`
			Lines     int      `json:"lines"`
			Runs      [][2]int `json:"runs"`
			Truncated bool     `json:"truncated"`
		}{Total: m.total, Runs: [][2]int{}}
		for r := range m.starts {
			if _, ok := index[m.stmts[r]]; !ok {
				continue
			}
			from, to := int(m.starts[r]), m.end(r)
			out.Lines += to - from + 1
			if n := len(out.Runs); n > 0 && out.Runs[n-1][1] == from-1 {
				if !out.Truncated {
					out.Runs[n-1][1] = to
				}
				continue
			}
			if len(out.Runs) >= limit {
				out.Truncated = true
				continue
			}
			out.Runs = append(out.Runs, [2]int{from, to})
		}
		return out
	default:
		out := struct {
			Total     int        `json:"total"`
			Stmts     []stmtRuns `json:"stmts"`
			Truncated bool       `json:"truncated"`
		}{Total: m.total, Stmts: make([]stmtRuns, len(ids))}
		for i, id := range ids {
			out.Stmts[i] = stmtRuns{ID: id, Runs: [][2]int{}}
		}
		listed := 0
		for r := range m.starts {
			k, ok := index[m.stmts[r]]
			if !ok {
				continue
			}
			from, to := int(m.starts[r]), m.end(r)
			out.Stmts[k].Lines += to - from + 1
			if listed >= limit {
				out.Truncated = true
				continue
			}
			out.Stmts[k].Runs = append(out.Stmts[k].Runs, [2]int{from, to})
			listed++
		}
		return out
	}
}
