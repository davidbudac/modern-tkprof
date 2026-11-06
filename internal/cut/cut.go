// Package cut writes a new trace file from a part of a trace set: a time
// window, some sessions or files, or one statement (docs/DESIGN.md § Cut).
//
// A cut never splits a call. The unit it keeps is a call with everything
// rolled up under it: its recursive calls, waits and binds, which the trace
// writes before the call's own line. In a whole-trace selection the units are
// the top-level calls; with a statement they are that statement's calls.
// What the kept lines need from the rest of the trace comes with them:
//
//   - borrowed from before the cut: the file header, the session markers in
//     force, the PARSING IN CURSOR block of every cursor the kept lines use
//     (restated right before its first use) and plans dumped earlier;
//   - borrowed from after the cut: the STAT lines of a cursor that closed
//     after it;
//   - generated: provenance lines in the header, a `***` timestamp wherever
//     the wall-clock anchor would otherwise be lost, and trcsess's process
//     switch line between the files of a joined set.
//
// The decisions come from the model and its fact rows (calls, waits, bind
// sets: the spill of an engine session), the text only from the trace files:
// a planning pass and the writing pass are the same walk with another sink, so
// what the Cut pane shows is what the file gets. Check writes the file, parses
// it back and compares its numbers with the selection's.
package cut

import (
	"context"
	"fmt"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Facts is where the cut reads the fact rows (slice.FactSource has it all).
type Facts interface {
	NumCalls() int64
	EachCall(ctx context.Context, sc analyze.Scan, fn func(c *model.Call) bool) error
	EachWait(ctx context.Context, sc analyze.Scan, fn func(w *model.Wait) bool) error
	BindSetAt(set model.ID) (model.BindSet, bool)
}

// Binds says what happens to the bind values of the kept BINDS blocks.
type Binds uint8

const (
	BindsKeep Binds = iota // as traced
	BindsMask              // each value replaced by model.RedactedValueSalt's token
	BindsNone              // BINDS blocks left out
)

var bindsNames = [...]string{"keep", "mask", "none"}

func (b Binds) String() string {
	if int(b) < len(bindsNames) {
		return bindsNames[b]
	}
	return "binds?"
}

// ParseBinds reads keep|mask|none.
func ParseBinds(s string) (Binds, error) {
	for i, n := range bindsNames {
		if s == n {
			return Binds(i), nil
		}
	}
	return 0, fmt.Errorf("binds %q: keep|mask|none", s)
}

// Selection is what to keep. The zero value keeps the whole trace set.
type Selection struct {
	From, To     int64      // tim window (0 = unbounded): a unit is kept when its [tim-e, tim] overlaps it
	Contexts     []model.ID // session contexts (empty = all, unless NoContexts)
	NoContexts   bool       // an explicit empty set: nothing is kept
	Statement    *model.ID  // keep this statement's calls (with their recursive work), not whole top-level calls
	Executions   bool       // widen to whole executions: every call of a kept call's execution (EXEC and its FETCHes)
	Binds        Binds
	NoPlans      bool   // do not borrow plans dumped outside the kept lines
	NoProvenance bool   // no "mtkprof cut:" header lines
	Salt         string // salt of the BindsMask hash
}

// Cutter cuts one trace set. It caches the per-file indexes it builds (the
// `***` markers of each file) and is safe for concurrent use.
type Cutter struct {
	m   *model.Model
	f   Facts
	lis []*trace.LineIndex

	idx *indexes
}

// New returns the cutter of a model, its fact rows and the line index of
// every input file (File.Files order).
func New(m *model.Model, f Facts, lis []*trace.LineIndex) *Cutter {
	return &Cutter{m: m, f: f, lis: lis, idx: newIndexes(m, lis)}
}

// span is a run of kept lines of one process key: [from, to], 1-based, inclusive.
type span struct{ from, to int32 }

// pkey identifies a process of the trace set: the file and the process of
// its contexts (one per file, except trcsess output, which switches).
type pkey struct {
	file int
	pid  string
}

// selected is what the fact passes decided.
type selected struct {
	pks     []pkey
	pkOf    map[pkey]int
	ctxPK   []int32
	ctxByPK [][]model.ID // contexts of each process key in line order
	spans   [][]span     // per process key, sorted, merged
	multiP  bool         // the kept lines come from more than one process: switch lines between them

	keptCall bitset
	nKept    int64
	ref      bitset     // cursors the kept lines use
	lastUse  []fileLine // per cursor: its last kept call
	// per file: lines of fact records decided against their span
	keepOut     [][]int32 // kept, outside every span (a wait whose call is kept; a BINDS block of a kept EXEC)
	dropIn      [][]int32 // inside a span, left out (a wait of a call that is not kept)
	callers     [][]int32 // statement selection: lines of the calls above the kept ones (left out)
	callerStmts map[model.ID]bool

	borrowedPlans map[fileLine][]model.ID // inserted after a cursor's last kept call
	planLabel     map[model.ID]byte       // 'B' dumped before that call, 'A' after

	exp      expected
	keptFrom int64 // tim extent of the kept calls (min tim-e, max tim)
	keptTo   int64
	stmts    map[model.ID]*StmtCut
}

type fileLine struct{ file, line int32 }

// expected are the numbers the new file must have (Check).
type expected struct {
	calls     map[stmtKind]*count
	waits     count
	firstWall int64
	unknown   map[string]bool // statement keys of cursors opened before tracing started, kept
}

type stmtKind struct {
	stmt string
	kind trace.CallKind
}

type count struct{ n, us int64 }

// StmtCut is one statement's part of a cut.
type StmtCut struct {
	ID     model.ID `json:"id"`
	Calls  int64    `json:"calls"`
	Execs  int64    `json:"execs"`
	ElaUs  int64    `json:"elaUs"` // Σ elapsed of its kept calls at its smallest depth in the cut
	MinDep int      `json:"minDep"`
}

func (c *Cutter) selectFacts(ctx context.Context, sel *Selection) (*selected, error) {
	m := c.m
	s := &selected{pkOf: map[pkey]int{}, ctxPK: make([]int32, len(m.Contexts)), stmts: map[model.ID]*StmtCut{}, callerStmts: map[model.ID]bool{}}
	for i := range m.Contexts {
		cx := &m.Contexts[i]
		k := pkey{cx.FileIdx, cx.Process}
		p, ok := s.pkOf[k]
		if !ok {
			p = len(s.pks)
			s.pks = append(s.pks, k)
			s.pkOf[k] = p
		}
		s.ctxPK[i] = int32(p)
	}
	s.ctxByPK = make([][]model.ID, len(s.pks))
	for i := range m.Contexts {
		p := s.ctxPK[i]
		s.ctxByPK[p] = append(s.ctxByPK[p], model.ID(i))
	}
	for _, l := range s.ctxByPK {
		sort.SliceStable(l, func(a, b int) bool { return m.Contexts[l[a]].Line < m.Contexts[l[b]].Line })
	}
	s.spans = make([][]span, len(s.pks))
	nf := len(m.File.Files)
	s.keepOut, s.dropIn, s.callers = make([][]int32, nf), make([][]int32, nf), make([][]int32, nf)

	var ctxOK map[model.ID]bool
	if len(sel.Contexts) > 0 && !sel.NoContexts {
		ctxOK = make(map[model.ID]bool, len(sel.Contexts))
		for _, id := range sel.Contexts {
			ctxOK[id] = true
		}
	}
	isUnit := func(cl *model.Call) bool {
		if sel.Statement != nil {
			return cl.Statement == *sel.Statement
		}
		return cl.Parent == model.None
	}
	inScope := func(cl *model.Call) bool {
		if sel.NoContexts || (ctxOK != nil && !ctxOK[cl.Context]) {
			return false
		}
		if cl.Tim == 0 {
			return sel.From == 0 && sel.To == 0
		}
		if sel.To != 0 && cl.Tim-cl.E > sel.To {
			return false
		}
		return sel.From == 0 || cl.Tim >= sel.From
	}
	body := c.idx.bodyStarts()
	// pass 1: the unit spans. A unit is (the last call of its process at the
	// same or a smaller depth, the unit's line]: its recursive calls, waits
	// and binds come before it, after that call.
	type exKey struct {
		cur  model.ID
		exec int32
	}
	execs := map[exKey]bool{}
	lastCall := make([]int32, len(s.pks)) // per process key: the line of its last call
	unitPass := func(add func(cl *model.Call, from int32)) error {
		last := make([][]int32, len(s.pks))
		return c.f.EachCall(ctx, analyze.Scan{}, func(cl *model.Call) bool {
			if cl.Context < 0 || int(cl.Context) >= len(s.ctxPK) {
				return true
			}
			p := s.ctxPK[cl.Context]
			d := int(cl.Dep)
			ls := last[p]
			from := int32(body[s.pks[p].file])
			for i := 0; i <= d && i < len(ls); i++ {
				if ls[i]+1 > from {
					from = ls[i] + 1
				}
			}
			for len(ls) <= d {
				ls = append(ls, 0)
			}
			ls[d] = cl.Line
			last[p] = ls
			lastCall[p] = cl.Line
			add(cl, from)
			return true
		})
	}
	err := unitPass(func(cl *model.Call, from int32) {
		if !isUnit(cl) || !inScope(cl) {
			return
		}
		p := s.ctxPK[cl.Context]
		s.spans[p] = append(s.spans[p], span{from, cl.Line})
		if sel.Executions && cl.ExecNo > 0 && (cl.Kind == trace.CallExec || cl.Kind == trace.CallFetch) {
			execs[exKey{cl.Cursor, cl.ExecNo}] = true
		}
	})
	if err != nil {
		return nil, err
	}
	if len(execs) > 0 {
		err = unitPass(func(cl *model.Call, from int32) {
			if !isUnit(cl) || sel.NoContexts || (ctxOK != nil && !ctxOK[cl.Context]) || cl.ExecNo == 0 ||
				(cl.Kind != trace.CallExec && cl.Kind != trace.CallFetch) || !execs[exKey{cl.Cursor, cl.ExecNo}] {
				return
			}
			p := s.ctxPK[cl.Context]
			s.spans[p] = append(s.spans[p], span{from, cl.Line})
		})
		if err != nil {
			return nil, err
		}
	}
	for p := range s.spans {
		sp := mergeSpans(s.spans[p])
		// the lines after a process's last call (its last waits, a final STAT
		// dump, a closing marker) go with that call when it is kept
		if n := len(sp); n > 0 && sel.Statement == nil && sp[n-1].to == lastCall[p] {
			end := int32(1 << 30) // to the end of the file
			if l := m.File.Files[s.pks[p].file].Lines; l > int(sp[n-1].to) {
				end = int32(l)
			}
			sp[n-1].to = end
		}
		s.spans[p] = sp
	}

	// pass 2: the kept calls are the calls inside the spans (the text pass
	// decides a call line the same way, so the two cannot disagree)
	n := c.f.NumCalls()
	s.keptCall = newBitset(n)
	s.ref = newBitset(int64(len(m.Cursors)))
	s.lastUse = make([]fileLine, len(m.Cursors))
	var callerMark bitset
	if sel.Statement != nil {
		callerMark = newBitset(n)
	}
	s.exp.calls = map[stmtKind]*count{}
	s.exp.unknown = map[string]bool{}
	keys := stmtKeys(m)
	err = c.f.EachCall(ctx, analyze.Scan{}, func(cl *model.Call) bool {
		if cl.Context < 0 || int(cl.Context) >= len(s.ctxPK) {
			return true
		}
		p := s.ctxPK[cl.Context]
		file := int32(s.pks[p].file)
		if !inSpans(s.spans[p], cl.Line) {
			if callerMark.has(int64(cl.ID)) {
				s.callers[file] = append(s.callers[file], cl.Line)
				s.callerStmts[cl.Statement] = true
				if cl.Parent != model.None {
					callerMark.set(int64(cl.Parent))
				}
			}
			return true
		}
		s.keptCall.set(int64(cl.ID))
		s.nKept++
		if callerMark.n > 0 && cl.Parent != model.None {
			callerMark.set(int64(cl.Parent))
		}
		if cl.Cursor >= 0 {
			s.ref.set(int64(cl.Cursor))
			s.lastUse[cl.Cursor] = fileLine{file, cl.Line}
		}
		if cl.BindSet != model.None && sel.Binds != BindsNone {
			if bs, ok := c.f.BindSetAt(cl.BindSet); ok && !inSpans(s.spans[p], int32(bs.Line)) {
				s.keepOut[file] = append(s.keepOut[file], int32(bs.Line))
			}
		}
		k := stmtKind{keys[cl.Statement], cl.Kind}
		ce := s.exp.calls[k]
		if ce == nil {
			ce = &count{}
			s.exp.calls[k] = ce
		}
		ce.n++
		ce.us += cl.E
		if st := m.Statements[cl.Statement]; st.Kind == model.StmtUnknown {
			s.exp.unknown[keys[cl.Statement]] = true
		}
		if w := m.CallWall(cl); w != 0 && (s.exp.firstWall == 0 || w < s.exp.firstWall) {
			s.exp.firstWall = w
		}
		if cl.Tim != 0 {
			if s.keptFrom == 0 || cl.Tim-cl.E < s.keptFrom {
				s.keptFrom = cl.Tim - cl.E
			}
			if cl.Tim > s.keptTo {
				s.keptTo = cl.Tim
			}
		}
		sc := s.stmts[cl.Statement]
		if sc == nil {
			sc = &StmtCut{ID: cl.Statement, MinDep: int(cl.Dep)}
			s.stmts[cl.Statement] = sc
		}
		sc.Calls++
		if cl.Kind == trace.CallExec {
			sc.Execs++
		}
		switch d := int(cl.Dep); {
		case d < sc.MinDep:
			sc.MinDep, sc.ElaUs = d, cl.E
		case d == sc.MinDep:
			sc.ElaUs += cl.E
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	// pass 3: the waits follow their call (or, with none, their span)
	err = c.f.EachWait(ctx, analyze.Scan{}, func(w *model.Wait) bool {
		if w.Context < 0 || int(w.Context) >= len(s.ctxPK) {
			return true
		}
		p := s.ctxPK[w.Context]
		file := s.pks[p].file
		in := inSpans(s.spans[p], w.Line)
		keep := in
		if w.Call != model.None {
			keep = s.keptCall.has(int64(w.Call))
		}
		switch {
		case keep && !in:
			s.keepOut[file] = append(s.keepOut[file], w.Line)
		case !keep && in:
			s.dropIn[file] = append(s.dropIn[file], w.Line)
		}
		if !keep {
			return true
		}
		if w.Cursor >= 0 {
			s.ref.set(int64(w.Cursor))
		}
		s.exp.waits.n++
		s.exp.waits.us += w.Ela
		return true
	})
	if err != nil {
		return nil, err
	}
	for f := range s.keepOut {
		sortLines(s.keepOut[f])
		sortLines(s.dropIn[f])
	}
	// the processes of the new file: those with kept lines
	procs := map[int]bool{}
	for p := range s.spans {
		if len(s.spans[p]) > 0 {
			procs[p] = true
		}
	}
	for f, ls := range s.keepOut {
		if len(ls) > 0 {
			for p, k := range s.pks {
				if k.file == f {
					procs[p] = true
				}
			}
		}
	}
	s.multiP = len(procs) > 1
	if !sel.NoPlans {
		c.borrowPlans(s)
	}
	return s, nil
}

// borrowPlans picks, for every cursor the kept lines use that has no STAT
// dump among them, one dump from elsewhere: the first after its last kept
// call, else the last before it. It goes after that call.
func (c *Cutter) borrowPlans(s *selected) {
	m := c.m
	byCursor := map[model.ID][]model.ID{}
	for i := range m.Plans {
		p := &m.Plans[i]
		if p.Cursor >= 0 && s.ref.has(int64(p.Cursor)) {
			byCursor[p.Cursor] = append(byCursor[p.Cursor], p.ID)
		}
	}
	s.borrowedPlans = map[fileLine][]model.ID{}
	s.planLabel = map[model.ID]byte{}
	for cur, plans := range byCursor {
		cx := m.Cursors[cur].Context
		if cx < 0 {
			continue
		}
		p := s.ctxPK[cx]
		file := s.pks[p].file
		kept := false
		for _, id := range plans {
			if inSpans(s.spans[p], int32(m.Plans[id].Line)) {
				kept = true
				break
			}
		}
		last := s.lastUse[cur]
		if kept || last.line == 0 || int(last.file) != file {
			continue
		}
		pick := model.None
		for _, id := range plans { // plans are in line order
			if int32(m.Plans[id].Line) > last.line {
				pick = id
				break
			}
			pick = id
		}
		if pick == model.None || !c.idx.isStat(file, m.Plans[pick].Line) {
			continue
		}
		s.borrowedPlans[last] = append(s.borrowedPlans[last], pick)
		if int32(m.Plans[pick].Line) > last.line {
			s.planLabel[pick] = 'A'
		} else {
			s.planLabel[pick] = 'B'
		}
	}
}

// stmtKeys names every statement the same way in two models of the same
// trace text (Check compares a cut with its source by them).
func stmtKeys(m *model.Model) []string {
	out := make([]string, len(m.Statements))
	for i := range m.Statements {
		st := &m.Statements[i]
		switch {
		case st.Kind == model.StmtSQL && st.SQLID != "":
			out[i] = "sql:" + st.SQLID
		case st.Kind == model.StmtSQL:
			out[i] = fmt.Sprintf("hv:%d:%s", st.HV, st.Text)
		default:
			out[i] = st.Kind.String() + ":" + st.Text
		}
	}
	return out
}

func mergeSpans(sp []span) []span {
	if len(sp) < 2 {
		return sp
	}
	sort.Slice(sp, func(i, j int) bool { return sp[i].from < sp[j].from })
	out := sp[:1]
	for _, x := range sp[1:] {
		l := &out[len(out)-1]
		if x.from <= l.to+1 {
			if x.to > l.to {
				l.to = x.to
			}
			continue
		}
		out = append(out, x)
	}
	return out
}

func inSpans(sp []span, line int32) bool {
	i := sort.Search(len(sp), func(i int) bool { return sp[i].to >= line })
	return i < len(sp) && sp[i].from <= line
}

func sortLines(ls []int32) {
	if !sort.SliceIsSorted(ls, func(i, j int) bool { return ls[i] < ls[j] }) {
		sort.Slice(ls, func(i, j int) bool { return ls[i] < ls[j] })
	}
}

func hasLine(ls []int32, line int32) bool {
	i := sort.Search(len(ls), func(i int) bool { return ls[i] >= line })
	return i < len(ls) && ls[i] == line
}

type bitset struct {
	w []uint64
	n int64
}

func newBitset(n int64) bitset { return bitset{w: make([]uint64, (n+63)/64), n: n} }

func (b bitset) set(i int64) {
	if i >= 0 && i < b.n {
		b.w[i>>6] |= 1 << (uint(i) & 63)
	}
}

func (b bitset) has(i int64) bool {
	return i >= 0 && i < b.n && b.w[i>>6]&(1<<(uint(i)&63)) != 0
}
