package slice

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"sort"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The line endpoints connect the trace text (a file and a 1-based line) with
// the model: /api/lines/at (time -> line) and /api/at (line -> objects). Both
// rest on the fact tables being in file and line order: the calls of one file
// are adjacent rows, Call.Line (and Wait.Line) is non-decreasing along them,
// so one binary search through FactSource.CallAt / WaitAt finds a row without
// scanning (docs/PLAN-DESKTOP.md § 5).

// notFound is an error that answers 404.
type notFound string

func (e notFound) Error() string { return string(e) }

// WithLines gives the server the line indexes of the input files (index i =
// model.File.Files[i]) and thereby the endpoints that need the trace text:
// /api/lines (also with annot=1), /api/lines/at, /api/at and /api/search. It
// must be called before Handler.
func (s *Server) WithLines(lis []*trace.LineIndex) *Server {
	s.lis = lis
	return s
}

type lineID struct {
	line int
	id   model.ID
}

// fileInfo is what the line endpoints know about one input file.
type fileInfo struct {
	calls, waits rowRange // fact rows of the file (hi <= lo: none)
	ctxs         []lineID // session contexts announced in the file, by line
	cursors      []lineID // PARSING IN CURSOR blocks (not implicit cursors), by line
	plans        []lineID // STAT blocks, by line of the first STAT line
	errors       []lineID // ERROR and PARSE ERROR lines, by line
	commits      []lineID // XCTEND lines, by line
}

func (s *Server) files() []fileInfo {
	s.fileOnce.Do(func() {
		m := s.m
		fs := make([]fileInfo, len(s.lis))
		fileOf := func(ctx model.ID) int {
			if ctx < 0 || int(ctx) >= len(m.Contexts) {
				return -1
			}
			if f := m.Contexts[ctx].FileIdx; f >= 0 && f < len(fs) {
				return f
			}
			return -1
		}
		merge := func(dst *rowRange, r rowRange) {
			if r.hi <= r.lo {
				return
			}
			if dst.hi <= dst.lo {
				*dst = r
				return
			}
			dst.lo, dst.hi = min(dst.lo, r.lo), max(dst.hi, r.hi)
		}
		for i := range m.Contexts {
			c := &m.Contexts[i]
			f := fileOf(c.ID)
			if f < 0 {
				continue
			}
			cr, wr := s.src.RowsOfContext(c.ID)
			merge(&fs[f].calls, cr)
			merge(&fs[f].waits, wr)
			fs[f].ctxs = append(fs[f].ctxs, lineID{c.Line, c.ID})
		}
		for i := range m.Cursors {
			c := &m.Cursors[i]
			if f := fileOf(c.Context); f >= 0 && !c.Implicit {
				fs[f].cursors = append(fs[f].cursors, lineID{c.Line, c.ID})
			}
		}
		// A plan has no context of its own, and its cursor may have been
		// parsed in an earlier file of a TRACE CONTINUES chain. Plans are
		// created in file order, so a plan is in the file of its cursor or a
		// later one; a line that goes back (or past the end of the file) means
		// the next file. Wrong only when a chain's file starts with a plan
		// of an older cursor on a higher line than the last plan before it.
		cur, prev := 0, 0
		for i := range m.Plans {
			p := &m.Plans[i]
			if p.Cursor < 0 || int(p.Cursor) >= len(m.Cursors) || len(fs) == 0 {
				continue
			}
			nf := max(cur, fileOf(m.Cursors[p.Cursor].Context))
			if nf == cur && p.Line < prev {
				nf++
			}
			for nf+1 < len(fs) && p.Line > s.lis[nf].Lines() {
				nf++
			}
			cur, prev = min(nf, len(fs)-1), p.Line
			fs[cur].plans = append(fs[cur].plans, lineID{p.Line, p.ID})
		}
		for i := range m.Errors {
			e := &m.Errors[i]
			if f := fileOf(e.Context); f >= 0 {
				fs[f].errors = append(fs[f].errors, lineID{e.Line, e.ID})
			}
		}
		for i := range m.Transactions {
			x := &m.Transactions[i]
			if f := fileOf(x.Context); f >= 0 {
				fs[f].commits = append(fs[f].commits, lineID{x.Line, x.ID})
			}
		}
		byLine := func(a, b lineID) int { return a.line - b.line }
		for i := range fs {
			sortStable(fs[i].ctxs, byLine)
			sortStable(fs[i].cursors, byLine)
			sortStable(fs[i].plans, byLine)
			sortStable(fs[i].errors, byLine)
			sortStable(fs[i].commits, byLine)
		}
		s.fileInfo = fs
	})
	return s.fileInfo
}

func sortStable(x []lineID, cmp func(a, b lineID) int) {
	sort.SliceStable(x, func(i, j int) bool { return cmp(x[i], x[j]) < 0 })
}

// lastAtOrBefore is the entry with the greatest line <= line.
func lastAtOrBefore(x []lineID, line int) (lineID, bool) {
	i := sort.Search(len(x), func(i int) bool { return x[i].line > line })
	if i == 0 {
		return lineID{}, false
	}
	return x[i-1], true
}

// fileParam resolves ?file=i (default 0).
func (s *Server) fileParam(q url.Values) (int, *trace.LineIndex, *fileInfo, error) {
	fi, err := intParam(q, "file", 0, 0, 1<<30)
	if err != nil {
		return 0, nil, nil, err
	}
	if int(fi) >= len(s.lis) {
		return 0, nil, nil, notFound("no such file")
	}
	return int(fi), s.lis[fi], &s.files()[fi], nil
}

// firstCall is the first row of rg whose call satisfies pred, which must be
// monotone along the rows (false..., true...); rg.hi when none does.
func (s *Server) firstCall(rg rowRange, pred func(*model.Call) bool) (int64, error) {
	lo, hi := rg.lo, rg.hi
	for lo < hi {
		mid := lo + (hi-lo)/2
		c, ok := s.src.CallAt(mid)
		if !ok {
			return 0, fmt.Errorf("read call row %d", mid)
		}
		if pred(&c) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo, nil
}

func (s *Server) firstWait(rg rowRange, pred func(*model.Wait) bool) (int64, error) {
	lo, hi := rg.lo, rg.hi
	for lo < hi {
		mid := lo + (hi-lo)/2
		w, ok := s.src.WaitAt(mid)
		if !ok {
			return 0, fmt.Errorf("read wait row %d", mid)
		}
		if pred(&w) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo, nil
}

// ---- /api/lines/at -----------------------------------------------------------

// linesAt answers {"line":L}: the first line of the file whose record (call or
// wait) has tim >= the given one. Calls and waits are each searched by binary
// search (tim grows along the rows of a file) and the smaller line wins (a
// call's WAIT lines come before its own line). A tim past the last record gives
// the line of the last call or wait; a file without rows is a 404.
func (s *Server) linesAt(_ context.Context, q url.Values) (any, error) {
	_, _, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	if q.Get("tim") == "" {
		return nil, bad("tim is required")
	}
	tim, err := strconv.ParseInt(q.Get("tim"), 10, 64)
	if err != nil {
		return nil, bad("tim: %q is not an integer", q.Get("tim"))
	}
	hasCalls, hasWaits := f.calls.hi > f.calls.lo, f.waits.hi > f.waits.lo
	if !hasCalls && !hasWaits {
		return nil, notFound("no rows in this file")
	}
	line, last := int32(-1), int32(-1)
	pick := func(cur *int32, l int32, ok bool) {
		if ok && (*cur < 0 || l < *cur) {
			*cur = l
		}
	}
	if hasCalls {
		i, err := s.firstCall(f.calls, func(c *model.Call) bool { return c.Tim >= tim })
		if err != nil {
			return nil, err
		}
		if i < f.calls.hi {
			c, _ := s.src.CallAt(i)
			pick(&line, c.Line, true)
		}
		c, ok := s.src.CallAt(f.calls.hi - 1)
		if !ok {
			return nil, fmt.Errorf("read call row %d", f.calls.hi-1)
		}
		last = max(last, c.Line)
	}
	if hasWaits {
		i, err := s.firstWait(f.waits, func(w *model.Wait) bool { return w.Tim >= tim })
		if err != nil {
			return nil, err
		}
		if i < f.waits.hi {
			w, _ := s.src.WaitAt(i)
			pick(&line, w.Line, true)
		}
		w, ok := s.src.WaitAt(f.waits.hi - 1)
		if !ok {
			return nil, fmt.Errorf("read wait row %d", f.waits.hi-1)
		}
		last = max(last, w.Line)
	}
	if line < 0 {
		line = last
	}
	return struct {
		Line int32 `json:"line"`
	}{line}, nil
}

// ---- /api/at -----------------------------------------------------------------

// atAnswer is the answer of /api/at; model.None (-1) where absent.
type atAnswer struct {
	Call     model.ID `json:"call"`
	Stmt     model.ID `json:"stmt"`
	Cursor   model.ID `json:"cursor"`
	ExecNo   int32    `json:"execNo"`
	Wait     model.ID `json:"wait"`
	BindSet  model.ID `json:"bindSet"`
	Ctx      model.ID `json:"ctx"`
	PlanLine int32    `json:"planLine"` // index into Model.PlanLines
	Kind     string   `json:"kind"`

	// The execution the line belongs to (set when execNo >= 1) and its
	// neighbours; -1 where absent. See execSpan.
	ExecFrom   int32  `json:"execFrom"`   // BINDS block of the EXEC, else its first call
	ExecTo     int32  `json:"execTo"`     // last FETCH (or the CLOSE that follows it)
	PrevExec   int32  `json:"prevExec"`   // EXEC line of the previous execution of the cursor
	NextExec   int32  `json:"nextExec"`   // EXEC line of the next execution of the cursor
	CursorLine int32  `json:"cursorLine"` // PARSING IN CURSOR line of the cursor (this file)
	CloseLine  int32  `json:"closeLine"`  // CLOSE of the cursor at or after the line
	Object     string `json:"object"`     // owner.name of a wait's obj# ("" when unknown)

	// The bind set of the line (bindSet >= 0): the line of its BINDS header, -1
	// otherwise, and its values, so a client without the facts tables (an
	// engine session) can decode a bind line.
	BindLine int32     `json:"bindLine"`
	Binds    []BindRow `json:"binds,omitempty"`
}

// at answers which model objects a line belongs to. See the route table in
// docs/PLAN-DESKTOP.md § 2 and the rules in the switch below.
func (s *Server) at(_ context.Context, q url.Values) (any, error) {
	fi, li, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	l64, err := intParam(q, "line", 0, 1, 1<<31-1)
	if err != nil {
		return nil, err
	}
	if q.Get("line") == "" {
		return nil, bad("line is required")
	}
	line := int(l64)
	if line > li.Lines() {
		return nil, notFound("no such line")
	}
	kind, text, err := kindAt(li, line)
	if err != nil {
		return nil, err
	}
	a := atAnswer{Call: model.None, Stmt: model.None, Cursor: model.None, ExecNo: -1, Wait: model.None, BindSet: model.None, Ctx: model.None, PlanLine: -1, Kind: kind.String(),
		ExecFrom: -1, ExecTo: -1, PrevExec: -1, NextExec: -1, CursorLine: -1, CloseLine: -1, BindLine: -1}

	// the last call at or before the line, the first one after it, the wait on it
	ci, err := s.firstCall(f.calls, func(c *model.Call) bool { return int(c.Line) > line })
	if err != nil {
		return nil, err
	}
	var prev *model.Call
	var owner model.Call // the call of a BINDS block (bindOwner)
	owner.ID = model.None
	if ci > f.calls.lo && f.calls.hi > f.calls.lo {
		if c, ok := s.src.CallAt(ci - 1); ok {
			prev = &c
		}
	}
	var wait *model.Wait
	if f.waits.hi > f.waits.lo {
		wi, err := s.firstWait(f.waits, func(w *model.Wait) bool { return int(w.Line) > line })
		if err != nil {
			return nil, err
		}
		if wi > f.waits.lo {
			if w, ok := s.src.WaitAt(wi - 1); ok && int(w.Line) == line {
				wait = &w
			}
		}
	}
	fromCall := func(c *model.Call) {
		a.Call, a.Stmt, a.Cursor, a.ExecNo, a.BindSet, a.Ctx = c.ID, c.Statement, c.Cursor, c.ExecNo, c.BindSet, c.Context
	}

	switch {
	case kind == trace.KindParsingInCursor || kind == trace.KindSQLText || kind == trace.KindEndOfStmt:
		// the statement text belongs to the PARSING IN CURSOR above it, not to a call
		if e, ok := lastAtOrBefore(f.cursors, line); ok {
			cur := &s.m.Cursors[e.id]
			a.Cursor, a.Stmt, a.Ctx = cur.ID, cur.Statement, cur.Context
		}
	case kind == trace.KindStat:
		// STAT lines of one dump are adjacent: the dump is the last plan that
		// starts at or before the line, the line is the one with that id=
		if e, ok := lastAtOrBefore(f.plans, line); ok {
			p := &s.m.Plans[e.id]
			if i := planLineOf(s.m, p, text); i >= 0 {
				cur := &s.m.Cursors[p.Cursor]
				a.PlanLine, a.Cursor, a.Stmt, a.Ctx = int32(i), cur.ID, p.Statement, cur.Context
			}
		}
	case wait != nil:
		// a WAIT line comes before the call it is attributed to
		a.Wait, a.Cursor, a.Stmt, a.Ctx = wait.ID, wait.Cursor, wait.Statement, wait.Context
		if wait.ObjID > 0 {
			a.Object = s.m.ObjectName(wait.ObjID)
		}
		if wait.Call >= 0 {
			if c, ok := s.src.CallAt(int64(wait.Call)); ok {
				a.Call, a.ExecNo, a.BindSet = c.ID, c.ExecNo, c.BindSet
			}
		}
	case (kind == trace.KindBinds || kind == trace.KindBindLine || ((kind == trace.KindUnknown || kind == trace.KindBlank) && continuesBinds(li, line))) && s.bindOwner(f, ci, line, &owner) == nil && owner.ID != model.None:
		// a BINDS block is attached to the EXEC that follows it
		fromCall(&owner)
	case prev != nil:
		fromCall(prev)
	}
	if a.BindSet >= 0 {
		if l, ok := s.src.BindSetLine(a.BindSet); ok {
			a.BindLine = int32(l)
			a.Binds = s.bindsOf(a.BindSet)
		}
	}
	if a.Ctx == model.None {
		if e, ok := lastAtOrBefore(f.ctxs, line); ok {
			a.Ctx = e.id
		}
	}
	if a.Cursor >= 0 && int(a.Cursor) < len(s.m.Cursors) {
		cur := &s.m.Cursors[a.Cursor]
		if !cur.Implicit && cur.Context >= 0 && int(cur.Context) < len(s.m.Contexts) && s.m.Contexts[cur.Context].FileIdx == fi {
			a.CursorLine = int32(cur.Line)
		}
		row := int64(a.Call)
		if a.Call < 0 {
			row = ci
		}
		if err := s.execSpan(f, &a, row); err != nil {
			return nil, err
		}
	}
	return a, nil
}

// maxBindBlockBack bounds how far back continuesBinds looks for the start of a
// BINDS block.
const maxBindBlockBack = 512

// continuesBinds reports whether the unrecognised (unknown or blank) line is a
// continuation line inside a BINDS block: a memory dump row or the rest of a
// multi-line value, which have no shape of their own. It is so when the nearest
// recognised line above it, skipping unknown and blank lines, is a BINDS line
// or a bind line.
func continuesBinds(li *trace.LineIndex, line int) bool {
	lo := max(1, line-maxBindBlockBack)
	if lo >= line {
		return false
	}
	raw, err := li.Read(lo, line-lo)
	if err != nil {
		return false
	}
	lines := splitLines(raw)
	for i := len(lines) - 1; i >= 0; i-- {
		switch k, _ := trace.Classify(lines[i], false); k {
		case trace.KindUnknown, trace.KindBlank:
		case trace.KindBinds, trace.KindBindLine:
			return true
		default:
			return false
		}
	}
	return false
}

// maxExecWalk bounds the walks over call rows of execSpan.
const maxExecWalk = 100_000

// execSpan fills the exec span, neighbour and close fields of a. row is the
// call row of the line (the first call after it when the line has no call).
// The calls of one execution are not adjacent rows (other cursors' calls come
// in between), so the walks go over the file's rows and look at the cursor:
// the span is the EXEC with the FETCHes of its ExecNo and the CLOSE that
// follows them; a PARSE, another EXEC or a higher ExecNo of the cursor ends it.
func (s *Server) execSpan(f *fileInfo, a *atAnswer, row int64) error {
	cur, n := a.Cursor, a.ExecNo
	read := func(r int64) (model.Call, error) {
		c, ok := s.src.CallAt(r)
		if !ok {
			return c, fmt.Errorf("read call row %d", r)
		}
		return c, nil
	}
	if row >= f.calls.lo && row < f.calls.hi {
		// the CLOSE of the cursor at or after the line
		for r, end := row, min(f.calls.hi, row+maxExecWalk); r < end; r++ {
			c, err := read(r)
			if err != nil {
				return err
			}
			if c.Cursor == cur && c.Kind == trace.CallClose {
				a.CloseLine = c.Line
				break
			}
		}
	}
	if n < 1 || a.Call < 0 || row < f.calls.lo || row >= f.calls.hi {
		return nil
	}
	first := row
	firstCall, err := read(row)
	if err != nil {
		return err
	}
	lastCall := firstCall
	if firstCall.Kind != trace.CallExec {
		for r, end := row-1, max(f.calls.lo, row-maxExecWalk); r >= end; r-- {
			c, err := read(r)
			if err != nil {
				return err
			}
			if c.Cursor != cur || c.Kind == trace.CallXctend {
				continue
			}
			if c.ExecNo != n || c.Kind == trace.CallParse || c.Kind == trace.CallClose {
				break // an earlier execution, a PARSE or a CLOSE
			}
			first, firstCall = r, c
			if c.Kind == trace.CallExec {
				break
			}
		}
	}
	// the previous execution: the nearest EXEC of the cursor before the span
	prevExec := int32(-1)
	for r, end := first-1, max(f.calls.lo, first-maxExecWalk); r >= end; r-- {
		c, err := read(r)
		if err != nil {
			return err
		}
		if c.Cursor == cur && c.Kind == trace.CallExec && c.ExecNo != n {
			prevExec = c.Line
			break
		}
	}
	// the end of the span and the next execution
	nextExec := int32(-1)
	inSpan := true
	for r, end := row+1, min(f.calls.hi, row+1+maxExecWalk); r < end; r++ {
		c, err := read(r)
		if err != nil {
			return err
		}
		if c.Cursor != cur || c.Kind == trace.CallXctend {
			continue
		}
		if inSpan {
			if c.ExecNo == n && c.Kind != trace.CallParse && c.Kind != trace.CallClose && c.Kind != trace.CallExec {
				lastCall = c
				continue
			}
			inSpan = false
			if c.Kind == trace.CallClose {
				lastCall = c
				continue
			}
		}
		if c.Kind == trace.CallExec && c.ExecNo != n {
			nextExec = c.Line
			break
		}
	}
	a.ExecFrom, a.ExecTo = firstCall.Line, lastCall.Line
	if firstCall.Kind == trace.CallExec && firstCall.BindSet >= 0 {
		if l, ok := s.src.BindSetLine(firstCall.BindSet); ok && int32(l) < a.ExecFrom {
			a.ExecFrom = int32(l)
		}
	}
	a.PrevExec, a.NextExec = prevExec, nextExec
	return nil
}

// maxBindOwnerScan is how many calls after a BINDS line bindOwner looks at: a
// BINDS block belongs to the first EXEC after it whose bind set started at or
// before the line, but the recursive calls of the statement come first.
const maxBindOwnerScan = 2048

// bindOwner sets *owner to the call a line of a BINDS block belongs to, given
// the first call row after the line; owner.ID stays None when there is none.
func (s *Server) bindOwner(f *fileInfo, after int64, line int, owner *model.Call) error {
	for row := after; row < f.calls.hi && row < after+maxBindOwnerScan; row++ {
		c, ok := s.src.CallAt(row)
		if !ok {
			return fmt.Errorf("read call row %d", row)
		}
		if c.BindSet < 0 {
			continue
		}
		if l, ok := s.src.BindSetLine(c.BindSet); ok && l <= line {
			*owner = c
			return nil
		}
	}
	return nil
}

// planLineOf finds the index into m.PlanLines of the STAT line text within
// plan p (matched by its "id=N"), or -1.
func planLineOf(m *model.Model, p *model.Plan, text []byte) int {
	i := bytes.Index(text, []byte(" id="))
	if i < 0 {
		return -1
	}
	j := i + 4
	k := j
	for k < len(text) && text[k] >= '0' && text[k] <= '9' {
		k++
	}
	id, err := strconv.Atoi(string(text[j:k]))
	if err != nil || p.First < 0 || int(p.First+p.N) > len(m.PlanLines) {
		return -1
	}
	for x := int(p.First); x < int(p.First+p.N); x++ {
		if m.PlanLines[x].ID == id {
			return x
		}
	}
	return -1
}

// ---- /api/lines/next ---------------------------------------------------------

// linesNext answers {"line":L}: the first line strictly after (dir=1) or
// strictly before (dir=-1) `from` that holds a structural element of the file:
// a call, a wait, a PARSING IN CURSOR block, a STAT block, a session context
// announcement, an ERROR / PARSE ERROR or an XCTEND. Calls and waits are found
// by binary search on the fact rows, the others in the sorted per-file lists
// of fileInfo, so every step is O(log n). what=gap finds the next call or wait
// whose idle gap before it is at least `min` microseconds (see nextGap; a walk
// over the rows). Nothing further in that direction is a 404.
func (s *Server) linesNext(ctx context.Context, q url.Values) (any, error) {
	_, _, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	from64, err := intParam(q, "from", 0, 0, 1<<31-1)
	if err != nil {
		return nil, err
	}
	from := int(from64)
	var dir int
	switch q.Get("dir") {
	case "1":
		dir = 1
	case "-1":
		dir = -1
	default:
		return nil, bad("dir: must be 1 or -1")
	}
	what := q.Get("what")
	var list []lineID
	switch what {
	case "call", "wait":
	case "cursor":
		list = f.cursors
	case "plan":
		list = f.plans
	case "ctx":
		list = f.ctxs
	case "error":
		list = f.errors
	case "commit":
		list = f.commits
	case "gap":
	default:
		return nil, bad("what: must be call, wait, cursor, plan, ctx, error, commit or gap")
	}
	line := -1
	switch what {
	case "gap":
		minGap, err := intParam(q, "min", 1_000_000, 1, 1<<62)
		if err != nil {
			return nil, err
		}
		if line, err = s.nextGap(ctx, f, from, dir, minGap); err != nil {
			return nil, err
		}
	case "call", "wait":
		rg := f.calls
		if what == "wait" {
			rg = f.waits
		}
		// the first row with line > from (dir 1) or >= from (dir -1, the row before it)
		past := func(l int32) bool { return int(l) > from }
		if dir < 0 {
			past = func(l int32) bool { return int(l) >= from }
		}
		var i int64
		if what == "call" {
			i, err = s.firstCall(rg, func(c *model.Call) bool { return past(c.Line) })
		} else {
			i, err = s.firstWait(rg, func(w *model.Wait) bool { return past(w.Line) })
		}
		if err != nil {
			return nil, err
		}
		if dir < 0 {
			i--
		}
		if i >= rg.lo && i < rg.hi {
			if what == "call" {
				c, ok := s.src.CallAt(i)
				if !ok {
					return nil, fmt.Errorf("read call row %d", i)
				}
				line = int(c.Line)
			} else {
				w, ok := s.src.WaitAt(i)
				if !ok {
					return nil, fmt.Errorf("read wait row %d", i)
				}
				line = int(w.Line)
			}
		}
	default:
		if dir > 0 {
			if i := sort.Search(len(list), func(i int) bool { return list[i].line > from }); i < len(list) {
				line = list[i].line
			}
		} else if i := sort.Search(len(list), func(i int) bool { return list[i].line >= from }); i > 0 {
			line = list[i-1].line
		}
	}
	if line < 0 {
		return nil, notFound("nothing further")
	}
	return struct {
		Line int `json:"line"`
	}{line}, nil
}
