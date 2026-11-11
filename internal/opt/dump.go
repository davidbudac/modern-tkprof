package opt

import (
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// frame is an open node of the outline with the state the scan keeps for it while it is open.
type frame struct {
	n *Node

	// folds that trim blank lines at both ends need the first non-blank line after nbAfter
	wantNB  bool
	nbAfter int
	nbFirst int

	// join-order
	aborted bool
	cost    string

	// run: the hash of its normalised text, kept as the lines pass
	hash runHash

	// run-head: the statement text printed again
	rh *rhState

	bannerBottom int // params-default
}

type rhState struct {
	bottom int
	lines  []rhLine
	size   int
	over   bool // the body is longer than the statement: it cannot be equal
	done   bool
}

type rhLine struct {
	n int
	s string
}

// dstate is the scan state of one dump.
type dstate struct {
	s      *scanner
	d      *Dump
	inside bool // between the first Registered qb line and the END line

	stack   []*frame
	qbsOver bool // the parser's query blocks are over: a PARSER line now starts a new dump

	seenT, seenFQ, seenRS bool
	preamble              bool
	lastSec               *Node
	runList               []*Node
	curRun                *frame
	seenRuns              map[runKey]int

	folds  []Fold
	ranges []Range // digest ranges, merged when adjacent, sorted at the end
	skips  []Range // 10046 records inside the dump: never part of the digest
	cont   struct {
		indent, left int
		toCost       bool
	}
	nb   [3]int // the last three non-blank lines, latest first
	pend int    // frames waiting for their first non-blank line
	excl []int  // lines left out of the digest (the QUERY BLOCK REGISTRY XML line)

	unplaced int

	// facts
	stmtState  int // 0 waiting, 1 collecting, 2 done
	stmtBuf    []byte
	stmtLines  int
	stmtCS     int
	objState   int
	tabNext    bool
	lgState    int
	lgLast     *Term
	fixFrom    int
	fixTo      int
	tables     map[string]bool
	tableOrder []string
	planState  int
	planSkip   int
	plan       *Plan
	sd         sdState // the statement printed again in the statement dump

	bindInfo []Bind
	peeked   []Bind
	bindOpen bool // a quoted bind value runs over several lines
	lastPred int
	rhf      *frame // the run header collecting its body

	versions []SQL
	sqlByTxt map[string]int
}

type runKey struct {
	a, b uint64
	n    int
}

// sdState follows the repeats of the statement in "Starting SQL statement dump".
type sdState struct {
	c2State   int // 0 waiting for the second "Current SQL Statement", 1 collecting, 2 done
	c2        int
	c2Buf     []byte
	c2Over    bool
	sqState   int // 0 waiting for "sql=", 1 waiting for the explain plan dump, 2 done
	sq        int
	startedAt int
}

func newDState(s *scanner, d *Dump) *dstate {
	ds := &dstate{s: s, d: d, inside: true, seenRuns: map[runKey]int{}, tables: map[string]bool{}, sqlByTxt: map[string]int{}}
	d.Roles = map[int]string{}
	return ds
}

func (ds *dstate) top() *frame { return ds.stack[len(ds.stack)-1] }

func (ds *dstate) mk(kind, label, crumb string, from, lvl int) *Node {
	n := &Node{ID: "n" + strconv.Itoa(ds.s.nodeSeq), Kind: kind, Label: label, Crumb: crumb, From: from, To: from, Lvl: lvl}
	ds.s.nodeSeq++
	return n
}

func (ds *dstate) push(n *Node) *frame {
	top := ds.top().n
	top.Children = append(top.Children, n)
	f := &frame{n: n}
	ds.stack = append(ds.stack, f)
	return f
}

// begin opens the root of the outline and what comes before the dump in its view.
func (ds *dstate) begin() {
	d := ds.d
	root := ds.mk(KindDump, "?", "?", d.ViewFrom, 0)
	ds.stack = []*frame{{n: root}}
	if d.Idx == 0 && d.From > 1 {
		h := ds.mk(KindFileHeader, "File header", "File header", 1, 1)
		h.To = d.From - 1
		root.Children = append(root.Children, h)
		last := d.From - 1
		if fs := ds.s.firstSkip; fs > 0 && fs-1 < last {
			last = fs - 1
		}
		ds.keep(1, last)
	}
}

// popTo closes the innermost open node at line to.
func (ds *dstate) popTo(to int) {
	f := ds.top()
	ds.stack = ds.stack[:len(ds.stack)-1]
	n := f.n
	if to < n.From {
		to = n.From
	}
	n.To = to
	ds.onPop(f)
}

// open closes the open nodes of level lvl or deeper and opens a node under what is left.
func (ds *dstate) open(kind, label, crumb string, from, lvl int) *frame {
	for len(ds.stack) > 1 && ds.top().n.Lvl >= lvl {
		ds.popTo(from - 1)
	}
	n := ds.mk(kind, label, crumb, from, lvl)
	return ds.push(n)
}

func (ds *dstate) has(kind string) bool {
	for _, f := range ds.stack {
		if f.n.Kind == kind {
			return true
		}
	}
	return false
}

func (ds *dstate) innermost(kind string) *frame {
	for k := len(ds.stack) - 1; k >= 0; k-- {
		if ds.stack[k].n.Kind == kind {
			return ds.stack[k]
		}
	}
	return nil
}

// closeThrough closes nodes up to and including node, which ends at line at (the ones inside it end before).
func (ds *dstate) closeThrough(node *Node, at int) {
	for len(ds.stack) > 1 {
		f := ds.top()
		if f.n == node {
			ds.popTo(at)
			break
		}
		ds.popTo(at - 1)
	}
}

func (ds *dstate) closeAll(at int) {
	for len(ds.stack) > 1 {
		ds.popTo(at)
	}
}

func (ds *dstate) watchNB(f *frame, after int) {
	f.wantNB, f.nbAfter = true, after
	ds.pend++
}

func (ds *dstate) pushNB(i int) {
	ds.nb[2], ds.nb[1], ds.nb[0] = ds.nb[1], ds.nb[0], i
}

// lastNBle is the last non-blank line at or before to.
func (ds *dstate) lastNBle(to int) int {
	for _, x := range ds.nb {
		if x != 0 && x <= to {
			return x
		}
	}
	return 0
}

func (ds *dstate) addFold(from, to int, kind, label string) {
	ds.folds = append(ds.folds, Fold{From: from, To: to, Lines: to - from + 1, Kind: kind, Label: label, Closed: true})
}

func (ds *dstate) trimFold(f *frame, to int, kind, label string) {
	first := f.nbFirst
	if first == 0 || first > to {
		return
	}
	if last := ds.lastNBle(to); last > first {
		ds.addFold(first, last, kind, label)
	}
}

// keep adds lines from..to to the digest.
func (ds *dstate) keep(from, to int) {
	if to < from {
		return
	}
	if n := len(ds.ranges); n > 0 {
		last := &ds.ranges[n-1]
		if from >= last.From && from <= last.To+1 {
			if to > last.To {
				last.To = to
			}
			return
		}
	}
	ds.ranges = append(ds.ranges, Range{from, to})
}

func (ds *dstate) onPop(f *frame) {
	n := f.n
	if f.wantNB && f.nbFirst == 0 {
		ds.pend--
	}
	if ds.curRun == f {
		ds.curRun = nil
	}
	if ds.rhf == f {
		ds.rhf = nil
	}
	switch n.Kind {
	case KindRun:
		ds.finishRun(f)
	case KindJoinOrder:
		switch {
		case f.aborted:
			n.Result = "aborted"
		case f.cost != "":
			n.Result = "cost: " + f.cost
		}
		n.Cost = f.cost
	case KindParamsDef:
		ds.trimFold(f, n.To, FoldParams, "parameters with default values")
	case KindStateDump:
		ds.trimFold(f, n.To, FoldState, "optimizer state dump: the parameters and fix controls again")
	case KindAPSearch:
		ds.trimFold(f, n.To, FoldAP, "adaptive plan re-costing")
	case KindRunHead:
		if f.rh != nil && !f.rh.done {
			ds.finishRunHead(f.rh, n.To+1)
		}
	}
}

func (ds *dstate) finishRun(f *frame) {
	n := f.n
	key := runKey{f.hash.a, f.hash.b, f.hash.lines}
	if k, ok := ds.seenRuns[key]; ok {
		n.SameAs = k
		ds.addFold(n.From, n.To, FoldSameRun, "same as run "+strconv.Itoa(k))
	} else {
		ds.seenRuns[key] = n.N
	}
}

// finishRunHead decides at line t (the first line not in the body) whether the run header's body repeats the
// statement.
func (ds *dstate) finishRunHead(rh *rhState, t int) {
	rh.done = true
	if rh.over || ds.stmtState != 2 {
		return
	}
	var from, to int
	var parts []string
	for _, l := range rh.lines {
		if l.n >= t {
			break
		}
		parts = append(parts, l.s)
		if strings.TrimSpace(l.s) == "" {
			continue
		}
		if from == 0 {
			from = l.n
		}
		to = l.n
	}
	if from == 0 || to <= from {
		return
	}
	var body []string
	for _, l := range rh.lines {
		if l.n >= from && l.n <= to {
			body = append(body, l.s)
		}
	}
	if strings.TrimSpace(strings.Join(body, "\n")) == strings.TrimSpace(ds.d.StmtText) {
		ds.addFold(from, to, FoldStmtAgn, "statement text, as at line "+strconv.Itoa(ds.d.StmtLine))
	}
}

// endDump closes the dump at its END line.
func (ds *dstate) endDump(i int) {
	ds.d.End = i
	ds.closeAll(i)
	ds.closeFacts()
	ds.inside = false
	ds.keep(i, i)
}

// closeFacts ends the state machines that run to the end of the dump.
func (ds *dstate) closeFacts() {
	if ds.fixFrom > 0 && ds.fixTo > ds.fixFrom {
		ds.addFold(ds.fixFrom, ds.fixTo, FoldFix, foldFixLabel)
	}
	ds.fixFrom = 0
	if p := ds.plan; p != nil {
		if p.TableTo == 0 && len(p.Rows) > 0 {
			p.TableTo = p.Rows[len(p.Rows)-1].Line
		}
		if p.To == 0 {
			p.To = p.TableTo
		}
		if p.To == 0 {
			p.To = p.From
		}
	}
}

func (ds *dstate) finish(viewTo int) {
	d := ds.d
	if ds.inside {
		d.Truncated = true
		d.End = viewTo
		if d.End < d.From {
			d.End = d.From
		}
		ds.closeAll(d.End)
		ds.closeFacts()
		ds.inside = false
	}
	if viewTo < d.End {
		viewTo = d.End
	}
	d.ViewTo = viewTo
	d.LineCount = d.ViewTo - d.ViewFrom + 1
	root := ds.stack[0].n
	root.To = viewTo
	if d.End < viewTo {
		a := ds.mk(KindAfter, "After the dump", "After the dump", d.End+1, 1)
		a.To = viewTo
		root.Children = append(root.Children, a)
	}
	ds.stack = ds.stack[:1]
	d.Tree = root
	if d.SQLID == "" {
		root.Label, root.Crumb = "?", "?"
	}

	// runs: numbers, labels, the verdict of their iteration
	byID := map[string]*Node{}
	walk(root, func(n *Node, _ *Node) { byID[n.ID] = n })
	of := len(ds.runList)
	d.RunCount = of
	d.Runs = make([]Run, 0, of)
	for _, r := range ds.runList {
		r.Of = of
		r.Label = "Run " + strconv.Itoa(r.N) + " of " + strconv.Itoa(of) + " · " + r.QB + " (#" + r.QBN + ")"
		r.Crumb = r.QB + " run " + strconv.Itoa(r.N) + " of " + strconv.Itoa(of)
		if it := byID[r.Iter]; it != nil {
			if it.Verdict != nil {
				v := *it.Verdict
				r.Verdict = &v
			}
			r.IterLabel = it.Prefix + " iteration " + strconv.Itoa(it.N)
		}
		d.Runs = append(d.Runs, Run{ID: r.ID, N: r.N, Of: of, QB: r.QB, QBN: r.QBN, From: r.From, To: r.To,
			Verdict: r.Verdict, Iter: r.IterLabel, Final: r.Final, SameAs: r.SameAs, BestJo: r.BestJo})
	}
	// join orders: the best flag from the enclosing run
	var cur *Node
	var visit func(n *Node)
	visit = func(n *Node) {
		if n.Kind == KindRun {
			cur = n
		}
		if n.Kind == KindJoinOrder && cur != nil {
			n.IsBest = cur.BestJo != 0 && cur.BestJo == n.N
		}
		for _, c := range n.Children {
			visit(c)
		}
		if n.Kind == KindRun {
			cur = nil
		}
	}
	visit(root)
	normalize(root)

	// tables
	d.Tables = append([]string{}, ds.tableOrder...)

	// legend, banners, hints and so on that were not seen are empty lists, not null
	if d.Legend == nil {
		d.Legend = []Term{}
	}
	if d.Landmarks == nil {
		d.Landmarks = []Landmark{}
	}
	if d.Banners == nil {
		d.Banners = []Banner{}
	}
	if d.Hints == nil {
		d.Hints = []Hint{}
	}
	if d.Altered == nil {
		d.Altered = []Param{}
	}
	if d.BindLines == nil {
		d.BindLines = []int{}
	}
	if len(ds.peeked) > 0 {
		d.Binds = ds.peeked
	} else {
		d.Binds = ds.bindInfo
	}
	if d.Binds == nil {
		d.Binds = []Bind{}
	}
	d.SQL = ds.versions
	if d.SQL == nil {
		d.SQL = []SQL{}
	}
	for k := range d.SQL {
		d.SQL[k].N = k + 1
	}
	d.Plan = ds.plan
	d.Unplaced = ds.unplaced
	if d.Nth == 0 {
		d.Nth = 1
	}

	// folds: one per start line (the outer one wins), sorted
	sort.SliceStable(ds.folds, func(a, b int) bool {
		x, y := ds.folds[a], ds.folds[b]
		if x.From != y.From {
			return x.From < y.From
		}
		return x.To > y.To
	})
	d.Folds = make([]Fold, 0, len(ds.folds))
	for _, f := range ds.folds {
		if n := len(d.Folds); n > 0 && d.Folds[n-1].From == f.From {
			continue
		}
		f.ID = "f" + strconv.Itoa(ds.s.foldSeq)
		ds.s.foldSeq++
		d.Folds = append(d.Folds, f)
	}

	ds.digestNodes(root)
	d.Digest = ds.finalRanges()
}

// walk visits the tree in file order with each node's parent.
func walk(n *Node, f func(n, parent *Node)) {
	var rec func(n, p *Node)
	rec = func(n, p *Node) {
		f(n, p)
		for _, c := range n.Children {
			rec(c, n)
		}
	}
	rec(n, nil)
}

// normalize makes the ranges of the tree nest: a child inside its parent, siblings in order without overlap.
// The scan produces this by construction; this is the guard for the lines it was not built for.
func normalize(n *Node) {
	prev := 0
	for _, c := range n.Children {
		if c.From < n.From {
			c.From = n.From
		}
		if c.To > n.To {
			c.To = n.To
		}
		if c.To < c.From {
			c.To = c.From
		}
		if prev >= c.From {
			c.From = prev + 1
			if c.To < c.From {
				c.To = c.From
			}
		}
		prev = c.To
		normalize(c)
	}
}

// digestNodes adds the whole-section ranges of the digest from the finished tree.
func (ds *dstate) digestNodes(root *Node) {
	walk(root, func(n, _ *Node) {
		switch n.Kind {
		case KindParserQBs, KindPreamble, KindParamsAlt, KindParamsOptP, KindPeekedBinds, KindPeeked,
			KindPlan, KindQBRegistry, KindHints:
			ds.keep(n.From, n.To)
		case KindOtherXML:
			ds.keep(n.From, n.To)
		}
	})
}

// finalRanges sorts and merges the digest ranges and takes the 10046 records out of them.
func (ds *dstate) finalRanges() []Range {
	r := ds.ranges
	sort.Slice(r, func(a, b int) bool { return r[a].From < r[b].From })
	var out []Range
	for _, x := range r {
		if n := len(out); n > 0 && x.From <= out[n-1].To+1 {
			if x.To > out[n-1].To {
				out[n-1].To = x.To
			}
			continue
		}
		out = append(out, x)
	}
	// lines left out one by one (the registry XML) and the 10046 records
	cut := append([]Range(nil), ds.skips...)
	for _, l := range ds.excl {
		cut = append(cut, Range{l, l})
	}
	if len(cut) > 0 {
		sort.Slice(cut, func(a, b int) bool { return cut[a].From < cut[b].From })
		out = subtract(out, cut)
	}
	// stay inside the view
	lo, hi := ds.d.ViewFrom, ds.d.ViewTo
	res := out[:0]
	for _, x := range out {
		if x.From < lo {
			x.From = lo
		}
		if x.To > hi {
			x.To = hi
		}
		if x.To >= x.From {
			res = append(res, x)
		}
	}
	if res == nil {
		res = []Range{}
	}
	return res
}

// subtract removes the ranges in cut (sorted) from the ranges in a (sorted, disjoint).
func subtract(a, cut []Range) []Range {
	var out []Range
	j := 0
	for _, x := range a {
		from := x.From
		for j < len(cut) && cut[j].To < from {
			j++
		}
		k := j
		for k < len(cut) && cut[k].From <= x.To {
			c := cut[k]
			if c.From > from {
				out = append(out, Range{from, c.From - 1})
			}
			if c.To+1 > from {
				from = c.To + 1
			}
			k++
		}
		if from <= x.To {
			out = append(out, Range{from, x.To})
		}
	}
	return out
}

func collapseSpace(s string) string {
	var b strings.Builder
	space := false
	started := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v' {
			space = started
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		started = true
		b.WriteRune(r)
	}
	return b.String()
}

func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for k := range s {
		if i == n {
			return s[:k]
		}
		i++
	}
	return s
}
