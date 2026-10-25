package analyze

import (
	"context"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// pendChild is what the calls of one statement nested in one parent call add
// once the parent's statement is known.
type pendChild struct {
	stmt         model.ID
	calls, e, cp int64
}

// StatementsOn is Statements computed from the call rows of src that f
// accepts (Matcher.Call: the [tim-ela, tim] window, contexts, statement), so
// a subset of the trace set (the contexts of some of its files, a time range)
// gets its own statement table; with an empty filter it equals Statements(m)
// field for field. Waits are not scanned: WaitUs and IdleUs are the waits
// attributed to the calls in scope (Call.WaitEla / IdleEla), as in
// Statements, so f.IncludeIdle and f.Event do not change the answer.
//
// Scope of the fields that are not sums over calls:
//   - Cursors: cursors with a call in scope (PX slave calls included); without
//     a time window also every cursor parsed in a context in scope, so the
//     whole set counts all cursors of the statement.
//   - Plans, PlanHashes: the STAT dumps of the cursors counted in Cursors.
//   - Errors: the errors of contexts in scope whose tim is in the window.
//   - Parents, Children, ChildUs, and whether a call is nested in a call of its
//     own statement (Elapsed, CPU): the parent call is looked up whether or not
//     it is in scope; a child in scope counts.
//
// The parent of a recursive call comes after it in the fact table (it is
// written when it completes), so the children wait in a map keyed by the
// parent id until it is scanned: its size is that of the open call stack, not
// of the trace. Parents the scan did not visit (another context of a
// continued file, which the contexts hint may skip) are looked up by a second
// scan of all calls, which stops once they are found.
func StatementsOn(ctx context.Context, m *model.Model, src Facts, f Filter) ([]StmtStats, error) {
	out := make([]StmtStats, len(m.Statements))
	for i := range out {
		out[i].ID = model.ID(i)
		out[i].MinDep = 1 << 30
		out[i].MaxDep = -1
	}
	mt := f.Matcher()
	type edge struct{ parent, child model.ID }
	edges := make(map[edge]*Link)
	pxProcs := map[model.ID]map[string]bool{}
	pending := map[model.ID][]pendChild{} // parent call id -> children in scope by statement
	cursorIn := make([]bool, len(m.Cursors))
	resolve := func(parent model.ID, pstmt model.ID) {
		for _, ch := range pending[parent] {
			if ch.stmt == pstmt {
				continue // nested in a call of its own statement
			}
			s := &out[ch.stmt]
			s.Elapsed += ch.e
			s.CPU += ch.cp
			e := edge{pstmt, ch.stmt}
			l, ok := edges[e]
			if !ok {
				l = &Link{}
				edges[e] = l
			}
			l.Calls += ch.calls
			l.Elapsed += ch.e
			out[pstmt].ChildUs += ch.e
		}
		delete(pending, parent)
	}
	err := src.EachCall(ctx, Scan{Contexts: f.Contexts}, func(c *model.Call) bool {
		if len(pending) > 0 {
			if _, ok := pending[c.ID]; ok {
				resolve(c.ID, c.Statement)
			}
		}
		if !mt.Call(c) {
			return true
		}
		if c.Cursor >= 0 && int(c.Cursor) < len(cursorIn) {
			cursorIn[c.Cursor] = true
		}
		s := &out[c.Statement]
		if m.PXChild(c.Context) {
			s.PXElapsed += c.SelfE
			s.PXCPU += c.SelfC
			if pxProcs[c.Statement] == nil {
				pxProcs[c.Statement] = map[string]bool{}
			}
			pxProcs[c.Statement][PXProcess(m, c.Context)] = true
			return true
		}
		switch c.Kind {
		case trace.CallParse:
			s.Parse.add(c)
			if c.Mis > 0 {
				s.HardParses += int64(c.Mis)
			}
		case trace.CallExec:
			s.Exec.add(c)
			s.Executions++
		case trace.CallFetch:
			s.Fetch.add(c)
		case trace.CallClose:
			s.Close.add(c)
		default:
			s.Other.add(c)
		}
		s.AllCalls.add(c)
		if dep := int(c.Dep); dep < s.MinDep {
			s.MinDep = dep
		}
		if dep := int(c.Dep); dep > s.MaxDep {
			s.MaxDep = dep
		}
		s.SelfElapsed += c.SelfE
		s.SelfCPU += c.SelfC
		s.WaitUs += c.WaitEla
		s.IdleUs += c.IdleEla
		if c.Parent == model.None {
			s.TopLevel = true
			s.Elapsed += c.E
			s.CPU += c.C
		} else {
			chs := pending[c.Parent]
			j := 0
			for j < len(chs) && chs[j].stmt != c.Statement {
				j++
			}
			if j == len(chs) {
				chs = append(chs, pendChild{stmt: c.Statement})
			}
			chs[j].calls++
			chs[j].e += c.E
			chs[j].cp += c.C
			pending[c.Parent] = chs
		}
		if c.Tim != 0 {
			if s.FirstTim == 0 || c.Tim-c.E < s.FirstTim {
				s.FirstTim = c.Tim - c.E
				s.FirstWallUs = m.CallWall(c) - c.E
			}
			if c.Tim > s.LastTim {
				s.LastTim = c.Tim
				s.LastWallUs = m.CallWall(c)
			}
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	if len(pending) > 0 { // parents outside the scanned rows
		err = src.EachCall(ctx, Scan{}, func(c *model.Call) bool {
			if _, ok := pending[c.ID]; ok {
				resolve(c.ID, c.Statement)
			}
			return len(pending) > 0
		})
		if err != nil {
			return nil, err
		}
	}
	for sid, procs := range pxProcs {
		out[sid].PXSessions = len(procs)
	}
	keys := make([]edge, 0, len(edges))
	for e := range edges {
		keys = append(keys, e)
	}
	sort.Slice(keys, func(i, j int) bool { // the order Statements uses
		if keys[i].parent != keys[j].parent {
			return keys[i].parent < keys[j].parent
		}
		return keys[i].child < keys[j].child
	})
	for _, e := range keys {
		l := edges[e]
		out[e.parent].Children = append(out[e.parent].Children, Link{Statement: e.child, Calls: l.Calls, Elapsed: l.Elapsed})
		out[e.child].Parents = append(out[e.child].Parents, Link{Statement: e.parent, Calls: l.Calls, Elapsed: l.Elapsed})
	}
	for i := range out {
		s := &out[i]
		s.Total.addStats(s.Parse)
		s.Total.addStats(s.Exec)
		s.Total.addStats(s.Fetch)
		if s.MinDep == 1<<30 {
			s.MinDep = m.Statements[i].MinDep
			s.MaxDep = s.MinDep
		}
		sort.Slice(s.Children, func(a, b int) bool { return s.Children[a].Elapsed > s.Children[b].Elapsed })
		sort.Slice(s.Parents, func(a, b int) bool { return s.Parents[a].Elapsed > s.Parents[b].Elapsed })
	}

	// cursors, plans, errors
	noWindow := f.StartTim == 0 && f.EndTim == 0
	ctxIn := func(id model.ID) bool { return mt.ctxs == nil || mt.ctxs[id] }
	for i := range m.Cursors {
		cu := &m.Cursors[i]
		if noWindow && ctxIn(cu.Context) && (f.Statement == nil || cu.Statement == *f.Statement) {
			cursorIn[i] = true
		}
	}
	for i := range m.Statements {
		for _, cur := range m.Statements[i].Cursors {
			if cur >= 0 && int(cur) < len(cursorIn) && cursorIn[cur] {
				out[i].Cursors++
			}
		}
	}
	for i := range m.Errors {
		e := &m.Errors[i]
		if e.Statement == model.None || !ctxIn(e.Context) || !mt.inWindow(e.Tim, 0) {
			continue
		}
		if f.Statement == nil || e.Statement == *f.Statement {
			out[e.Statement].Errors++
		}
	}
	seen := map[model.ID]map[uint64]bool{}
	for i := range m.Plans {
		p := &m.Plans[i]
		if p.Cursor < 0 || int(p.Cursor) >= len(cursorIn) {
			if !noWindow || mt.ctxs != nil || f.Statement != nil {
				continue // no cursor to scope it by: only the whole set has it
			}
		} else if !cursorIn[p.Cursor] {
			continue
		}
		s := &out[p.Statement]
		s.Plans = append(s.Plans, p.ID)
		if seen[p.Statement] == nil {
			seen[p.Statement] = map[uint64]bool{}
		}
		if !seen[p.Statement][p.PLH] {
			seen[p.Statement][p.PLH] = true
			s.PlanHashes = append(s.PlanHashes, p.PLH)
		}
	}
	return out, nil
}
