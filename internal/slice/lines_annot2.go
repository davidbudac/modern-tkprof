package slice

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// annotIDs are the ids /api/at answers for a line (call, statement, cursor,
// execution number, wait); -1 where absent.
type annotIDs struct {
	C int32 `json:"c"`
	S int32 `json:"s"`
	U int32 `json:"u"`
	X int32 `json:"x"`
	W int32 `json:"w"`
}

func (a *annotIDs) none() bool { return a.C < 0 && a.S < 0 && a.U < 0 && a.X < 0 && a.W < 0 }

// annotLine2 is one line of an annot=2 page: the ids are flattened into the
// object by the embedded pointer, which stays nil (keys omitted) for a line
// with no id at all (framing lines).
type annotLine2 struct {
	T string `json:"t"`
	K string `json:"k"`
	*annotIDs
}

type annotPage2 struct {
	From  int          `json:"from"`
	Total int          `json:"total"`
	Lines []annotLine2 `json:"lines"`
}

// serveAnnotated2 answers /api/lines?...&annot=2 of file fi.
func (s *Server) serveAnnotated2(w http.ResponseWriter, fi, from, n int) {
	li, f := s.lis[fi], &s.files()[fi]
	from = max(from, 1)
	page := annotPage2{From: from, Total: li.Lines(), Lines: []annotLine2{}}
	if from <= li.Lines() && n > 0 {
		lines, err := s.annotate2(li, f, from, n)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		page.Lines = lines
	}
	writePage(w, page)
}

// annotate2 is annotate with the ids of every line, assigned by the rules of
// Server.at (same case order) in one pass: the first call and wait row of the
// page are found by binary search, then both row streams, the cursor list and
// the plan list are walked forward with the lines, so the cost is the page's
// lines plus the rows within it (plus one bindOwner scan per BINDS block).
func (s *Server) annotate2(li *trace.LineIndex, f *fileInfo, from, n int) ([]annotLine2, error) {
	lines, kinds, err := annotateRaw(li, from, n)
	if err != nil {
		return nil, err
	}
	out := make([]annotLine2, len(lines))
	ids := make([]annotIDs, len(lines)) // backing store of the embedded pointers
	m := s.m

	// call rows: next is the first row after the line (Line > line), prev the
	// row before it (the last call at or before the line)
	hasCalls := f.calls.hi > f.calls.lo
	next := f.calls.lo
	var nextCall, prevCall model.Call
	var nextOK, prevOK bool
	if hasCalls {
		next, err = s.firstCall(f.calls, func(c *model.Call) bool { return int(c.Line) >= from })
		if err != nil {
			return nil, err
		}
		if next > f.calls.lo {
			if prevCall, prevOK = s.src.CallAt(next - 1); !prevOK {
				return nil, fmt.Errorf("read call row %d", next-1)
			}
		}
		if next < f.calls.hi {
			if nextCall, nextOK = s.src.CallAt(next); !nextOK {
				return nil, fmt.Errorf("read call row %d", next)
			}
		}
	}
	// wait rows: wi is the first row not yet passed (Line > the last line seen)
	hasWaits := f.waits.hi > f.waits.lo
	wi := f.waits.lo
	var nextWait model.Wait
	var nextWaitOK bool
	if hasWaits {
		wi, err = s.firstWait(f.waits, func(w *model.Wait) bool { return int(w.Line) >= from })
		if err != nil {
			return nil, err
		}
		if wi < f.waits.hi {
			if nextWait, nextWaitOK = s.src.WaitAt(wi); !nextWaitOK {
				return nil, fmt.Errorf("read wait row %d", wi)
			}
		}
	}
	// cursor and plan lists: ci / pi entries start at or before the line
	ci := sort.Search(len(f.cursors), func(i int) bool { return f.cursors[i].line >= from })
	pi := sort.Search(len(f.plans), func(i int) bool { return f.plans[i].line >= from })

	var owner model.Call // the call of the current BINDS block
	ownerOK, ownerFor := false, int64(-1)
	inBinds := false
	var waitCall model.Call // the last call a wait was attributed to
	waitCallOK, waitCallID := false, model.None

	for i := range lines {
		line := from + i
		kind := kinds[i]
		// move the streams past this line
		for hasCalls && next < f.calls.hi && nextOK && int(nextCall.Line) <= line {
			prevCall, prevOK = nextCall, true
			next++
			nextOK = false
			if next < f.calls.hi {
				if nextCall, nextOK = s.src.CallAt(next); !nextOK {
					return nil, fmt.Errorf("read call row %d", next)
				}
			}
		}
		var wait *model.Wait
		var waitRow model.Wait
		for hasWaits && wi < f.waits.hi && nextWaitOK && int(nextWait.Line) <= line {
			if int(nextWait.Line) == line {
				waitRow, wait = nextWait, &waitRow
			}
			wi++
			nextWaitOK = false
			if wi < f.waits.hi {
				if nextWait, nextWaitOK = s.src.WaitAt(wi); !nextWaitOK {
					return nil, fmt.Errorf("read wait row %d", wi)
				}
			}
		}
		for ci < len(f.cursors) && f.cursors[ci].line <= line {
			ci++
		}
		for pi < len(f.plans) && f.plans[pi].line <= line {
			pi++
		}

		a := &ids[i]
		*a = annotIDs{-1, -1, -1, -1, -1}
		fromCall := func(c *model.Call) { a.C, a.S, a.U, a.X = int32(c.ID), int32(c.Statement), int32(c.Cursor), c.ExecNo }
		isBinds := kind == trace.KindBinds || kind == trace.KindBindLine
		if !isBinds && (kind == trace.KindUnknown || kind == trace.KindBlank) {
			// a continuation line of a bind value or dump belongs to the block
			// above it (see continuesBinds); a page that starts on one asks
			if i == 0 {
				inBinds = continuesBinds(li, line)
			}
			isBinds = inBinds
		}
		switch {
		case kind == trace.KindParsingInCursor || kind == trace.KindSQLText || kind == trace.KindEndOfStmt:
			if ci > 0 {
				cur := &m.Cursors[f.cursors[ci-1].id]
				a.U, a.S = int32(cur.ID), int32(cur.Statement)
			}
		case ci > 0 && parseErrorOwns(m, &m.Cursors[f.cursors[ci-1].id], kind, line):
			// a failed parse has a cursor of its own (the model makes one at the PARSE ERROR line): the line and the SQL text
			// after it (no terminator) are its, not the call before's
			cur := &m.Cursors[f.cursors[ci-1].id]
			a.U, a.S = int32(cur.ID), int32(cur.Statement)
		case kind == trace.KindSeparator && ci < len(f.cursors) && f.cursors[ci].line == line+1:
			// the `=====` rule directly above a cursor's PARSING IN CURSOR (or PARSE ERROR) line is the cursor's: without this
			// it closes the call before's run (a statement filter shows it as a stray row, a highlight runs over it)
			cur := &m.Cursors[f.cursors[ci].id]
			a.U, a.S = int32(cur.ID), int32(cur.Statement)
		case kind == trace.KindStat:
			if pi > 0 {
				p := &m.Plans[f.plans[pi-1].id]
				if planLineOf(m, p, lines[i]) >= 0 {
					a.U, a.S = int32(m.Cursors[p.Cursor].ID), int32(p.Statement)
				}
			}
		case wait != nil:
			a.W, a.U, a.S = int32(wait.ID), int32(wait.Cursor), int32(wait.Statement)
			if wait.Call >= 0 {
				if !waitCallOK || waitCallID != wait.Call {
					c, ok := s.src.CallAt(int64(wait.Call))
					waitCall, waitCallOK, waitCallID = c, ok, wait.Call
				}
				if waitCallOK {
					a.C, a.X = int32(waitCall.ID), waitCall.ExecNo
				}
			}
		case isBinds && s.annotOwner(f, &owner, &ownerOK, &ownerFor, &inBinds, kind, next, line) == nil && ownerOK:
			fromCall(&owner)
		case prevOK:
			fromCall(&prevCall)
		}
		if !isBinds {
			inBinds = false
		}
		if !a.none() {
			out[i].annotIDs = a
		}
		out[i].T, out[i].K = string(lines[i]), kind.String()
	}
	return out, nil
}

// annotOwner is bindOwner once per BINDS block: the lines of one block have
// the same first row after them, and the owner (the first call from there on
// whose bind set started at or before the line) can only differ between
// blocks, so it is looked up at a BINDS line, or at the first bind line of a
// page that starts inside a block, and reused for the lines that follow it.
// Reports whether an owner was found through *ok.
func (s *Server) annotOwner(f *fileInfo, owner *model.Call, ok *bool, forRow *int64, inBinds *bool, kind trace.Kind, after int64, line int) error {
	if *inBinds && kind != trace.KindBinds && *forRow == after {
		return nil
	}
	*inBinds, *forRow = true, after
	owner.ID = model.None
	if err := s.bindOwner(f, after, line, owner); err != nil {
		*ok = false
		return err
	}
	*ok = owner.ID != model.None
	return nil
}

// parseErrorOwns reports whether the line of kind `kind` is the PARSE ERROR line of
// cursor c (the last cursor that starts at or before it) or one of the SQL text
// lines that follow it (a cursor made by a failed parse: its statement is of kind
// StmtParseError and holds the text the parser read). The text has no terminator
// line, so its extent is the statement's own line count.
func parseErrorOwns(m *model.Model, c *model.Cursor, kind trace.Kind, line int) bool {
	switch kind {
	case trace.KindParseError:
		return c.Line == line
	case trace.KindUnknown, trace.KindBlank:
		if c.Statement < 0 || int(c.Statement) >= len(m.Statements) || line <= c.Line {
			return false
		}
		st := &m.Statements[c.Statement]
		if st.Kind != model.StmtParseError || line-c.Line > len(st.Text)+1 {
			return false
		}
		return line-c.Line <= strings.Count(st.Text, "\n")+1
	}
	return false
}
