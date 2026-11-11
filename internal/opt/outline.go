package opt

import (
	"strconv"
	"strings"
)

// Levels of the outline: 0 the dump, 1 a phase, then sections as the mock-up's parser opens them.
const (
	lvlPhase = 1
	lvlRun   = 5
)

func roleName(r byte) string {
	switch r {
	case 't':
		return "bt"
	case 'h':
		return "bh"
	case 'b':
		return "bb"
	case 'u':
		return "uh"
	case 'l':
		return "ul"
	}
	return ""
}

func (ds *dstate) recordRole(e *lineEnt) {
	if e.role != 0 {
		ds.d.Roles[e.n] = roleName(e.role)
	}
	if e.title && e.bTop >= ds.d.ViewFrom {
		ds.d.Banners = append(ds.d.Banners, Banner{Top: e.bTop, Title: e.n, Bottom: e.bBottom, Text: string(trimB(e.b))})
	}
}

// afterLine takes a line of the dump's view after its END line (the adaptive plan's execution lines).
func (ds *dstate) afterLine(e *lineEnt) {
	if e.skip {
		ds.addSkip(e.n)
		return
	}
	ds.recordRole(e)
	ds.landmark(e)
}

func (ds *dstate) addSkip(n int) {
	if k := len(ds.skips); k > 0 && ds.skips[k-1].To == n-1 {
		ds.skips[k-1].To = n
		return
	}
	ds.skips = append(ds.skips, Range{n, n})
}

// isQBSContent: a line that belongs to the parser's query blocks (the run of Registered qb: blocks).
func isQBSContent(b []byte) bool {
	switch {
	case len(b) == 0, isBlank(b), hp(b, "Registered qb:"), hp(b, "---"), hp(b, "QUERY BLOCK SIGNATURE"),
		hp(b, "  signature"), hp(b, "    fro("), hp(b, "  fro("):
		return true
	}
	return false
}

// inLine takes a line from the dump's first line to its END line.
func (ds *dstate) inLine(e *lineEnt) {
	i, b := e.n, e.b
	if e.skip {
		ds.addSkip(i)
		return
	}
	d := ds.d
	if !e.blank {
		ds.pushNB(i)
	}
	ds.recordRole(e)
	if !ds.qbsOver && i > d.From && !isQBSContent(b) {
		ds.qbsOver = true
	}
	ds.facts(e)
	ds.outline(e)
	if ds.pend > 0 && !e.blank {
		for _, f := range ds.stack {
			if f.wantNB && f.nbFirst == 0 && i > f.nbAfter {
				f.nbFirst = i
				ds.pend--
			}
		}
	}
	ds.landmark(e)
	ds.digestLine(e)
	ds.sqlVersion(e)
	if ds.curRun != nil {
		ds.curRun.hash.add(b)
	}
	ds.sections(e)
	if rh := ds.runHeadFrame(); rh != nil {
		ds.collectRunHead(rh, e)
	}
	if !e.blank && ds.top().n.Lvl <= lvlPhase {
		ds.unplaced++
	}
	if IsEnd(b) {
		ds.endDump(i)
	}
}

func (ds *dstate) phaseKind() string {
	if len(ds.stack) > 1 {
		return ds.stack[1].n.Kind
	}
	return ""
}

// outline is the stack machine of parse.mjs: opening a node of level L closes the open nodes of level L or more.
func (ds *dstate) outline(e *lineEnt) {
	i, b := e.n, e.b
	d := ds.d
	title := ""
	if e.title {
		title = string(trimB(b))
	}
	var c0 byte
	if len(b) > 0 {
		c0 = b[0]
	}
	switch {
	case i == d.From:
		ds.open(KindPhaseEnv, "Environment", "Environment", i, lvlPhase)
		ds.lastSec = nil
	case !ds.seenT && c0 == 'C' && hp(b, "Considering Query Transformations on query block"):
		ds.seenT = true
		ds.open(KindPhaseTrans, "Transformations", "Transformations", i, lvlPhase)
		ds.lastSec = nil
	case !ds.seenFQ && c0 == 'F' && hp(b, "Final query after transformations"):
		ds.seenFQ = true
		ds.open(KindPhaseCost, "Costing", "Costing", i, lvlPhase)
		ds.lastSec = nil
	case !ds.seenRS && c0 == 'S' && hp(b, "Starting SQL statement dump"):
		ds.seenRS = true
		ds.open(KindPhaseResult, "Result", "Result", i, lvlPhase)
		ds.lastSec = nil
	}
	switch ds.phaseKind() {
	case KindPhaseEnv:
		ds.envLine(e, title)
	case KindPhaseTrans, KindPhaseCost:
		ds.transLine(e, title)
	case KindPhaseResult:
		ds.resultLine(e, title)
	}
}

func (ds *dstate) envLine(e *lineEnt, title string) {
	i, b := e.n, e.b
	from := i
	if e.title {
		from = e.bTop
	}
	switch {
	case i == ds.d.From:
		ds.open(KindParserQBs, "Query blocks from the parser", "Parser query blocks", i, 2)
	case !ds.preamble && (hp(b, "SPM:") || hp(b, "kkoctx()")):
		ds.preamble = true
		ds.open(KindPreamble, "Preamble", "Preamble", i, 2)
	case hp(b, "OPTIMIZER INFORMATION") && isBlank(b[len("OPTIMIZER INFORMATION"):]):
		ds.open(KindOptInfo, "Optimizer information", "Optimizer information", i, 2)
	case hp(b, "----- Current SQL Statement for this session"):
		ds.open(KindStatement, "Current SQL statement", "Statement", i, 3)
	case hp(b, "Legend") && isBlank(b[len("Legend"):]):
		ds.open(KindLegend, "Legend", "Legend", i, 3)
	case e.title && hp2(title, "PARAMETERS USED BY THE OPTIMIZER"):
		ds.open(KindParams, "Parameters used by the optimizer", "Parameters", from, 3)
	case e.title && hp2(title, "Column Usage Monitoring"):
		ds.open(KindColUsage, "Column usage monitoring", "Column usage", from, 3)
	case e.title && hp2(title, "PARAMETERS WITH ALTERED VALUES"):
		ds.open(KindParamsAlt, "Altered values", "Altered values", from, 4)
	case e.title && hp2(title, "PARAMETERS WITH DEFAULT VALUES"):
		f := ds.open(KindParamsDef, "Default values", "Default values", from, 4)
		f.n.BannerBottom = e.bBottom
		ds.watchNB(f, e.bBottom)
	case e.title && hp2(title, "PARAMETERS IN OPT_PARAM HINT"):
		ds.open(KindParamsOptP, "OPT_PARAM hint", "OPT_PARAM hint", from, 4)
	}
}

func hp2(s, p string) bool { return strings.HasPrefix(s, p) }

// afterPrefixTok matches prefix followed by a token (\S+) and returns the token.
func afterPrefixTok(b []byte, prefix string) (string, bool) {
	if !hp(b, prefix) {
		return "", false
	}
	t, _ := token(b[len(prefix):])
	if len(t) == 0 {
		return "", false
	}
	return string(t), true
}

func (ds *dstate) transLine(e *lineEnt, title string) {
	i, b := e.n, e.b
	from := i
	if e.title {
		from = e.bTop
	}
	var c0 byte
	if len(b) > 0 {
		c0 = b[0]
	}
	inIter, inRun := ds.has(KindIteration), ds.has(KindRun)
	phaseCost := ds.phaseKind() == KindPhaseCost

	if c0 == 'C' {
		if qb, ok := afterPrefixTok(b, "Considering Query Transformations on query block "); ok {
			if !inIter && !inRun {
				lvl := 2
				if ds.has(KindCBQT) {
					lvl = 3
				}
				ds.open(KindQT, "Query transformations · "+qb, "QT "+qb, i, lvl)
				ds.lastSec = nil
			}
			return
		}
		if qb, ok := afterPrefixTok(b, "CBQT: Considering cost-based transformation on query block "); ok {
			ds.open(KindCBQT, "Cost-based transformations · "+qb, "CBQT "+qb, i, 2)
			ds.lastSec = nil
			return
		}
	}
	if e.title && !inRun {
		if hp2(title, "Peeked values of the binds") {
			ds.open(KindPeekedBinds, "Peeked values of the binds", "Peeked binds", from, 2)
			ds.lastSec = nil
			return
		}
		if hp2(title, "SPD: BEGIN context at statement level") {
			ds.open(KindSPD, "SQL plan directives", "SPD", from, 2)
			ds.lastSec = nil
			return
		}
	}
	if c0 >= 'A' && c0 <= 'z' {
		if wc := leadWord(b); wc > 0 {
			pfx := string(b[:wc])
			rest := b[wc:]
			if hp(rest, ": Starting iteration ") {
				if n, space, ok := iterStart(rest[len(": Starting iteration "):]); ok {
					for len(ds.stack) > 1 && (ds.top().n.Lvl >= 5 || ds.top().n.Kind == KindTSec || ds.top().n.Kind == KindRegistered) {
						ds.popTo(i - 1)
					}
					if t := ds.top().n; t.Kind == KindIteration && t.Prefix == pfx {
						ds.popTo(i - 1)
					}
					nn := strconv.Itoa(n)
					it := ds.mk(KindIteration, pfx+" iteration "+nn+" · "+space, pfx+" iteration "+nn, i, 4)
					it.Prefix, it.N, it.Space = pfx, n, space
					ds.push(it)
					ds.keep(i, i)
					return
				}
			}
			if kept, ok := verdictOf(rest); ok {
				var it *frame
				for k := len(ds.stack) - 1; k >= 0; k-- {
					if n := ds.stack[k].n; n.Kind == KindIteration && n.Prefix == pfx {
						it = ds.stack[k]
						break
					}
				}
				if it != nil {
					it.n.Verdict = &Verdict{Text: string(trimB(b)), Line: i, Kept: kept}
					ds.closeThrough(it.n, i)
				}
				return
			}
		}
	}
	if c0 == 'k' {
		if qb, qbn, ok := kkOptimizing(b); ok {
			iter := ds.innermost(KindIteration)
			f := ds.open(KindRun, "", "", i, lvlRun)
			n := f.n
			n.QB, n.QBN, n.Final = qb, qbn, phaseCost
			if iter != nil {
				n.Iter = iter.n.ID
			}
			for _, fr := range ds.stack {
				if fr.n.Kind == KindIteration {
					fr.n.RunIDs = append(fr.n.RunIDs, n.ID)
				}
			}
			ds.runList = append(ds.runList, n)
			n.N = len(ds.runList)
			f.hash.init()
			ds.curRun = f
			ds.keep(i, i)
			return
		}
		if hp(b, "kkoqbc: finish optimizing query block") {
			if r := ds.innermost(KindRun); r != nil {
				r.hash.add(b)
				ds.curRun = nil
				ds.closeThrough(r.n, i)
				ds.keep(i, i)
			}
			return
		}
	}
	if c0 == 'F' && hp(b, "Final query after transformations") {
		ds.open(KindFinalQuery, "Final query after transformations", "Final query", i, lvlRun)
		return
	}
	if inRun {
		ds.runLine(e, title, from)
		return
	}
	if e.title && !inIter && len(ds.stack) > 2 && (hp2(title, "Cost-based") || hp2(title, "Cost-Based") || hp2(title, "Statistic-based")) {
		var prev *frame
		pk := -1
		for k, fr := range ds.stack {
			if fr.n.Kind == KindCBSec {
				prev, pk = fr, k
				break
			}
		}
		merged := false
		if prev != nil && prev.n.Title == title && pk >= len(ds.stack)-2 {
			hasIter := false
			for _, c := range prev.n.Children {
				if c.Kind == KindIteration {
					hasIter = true
					break
				}
			}
			if !hasIter {
				prev.n.Count++
				prev.n.Label = title + " ×" + strconv.Itoa(prev.n.Count)
				merged = true
			}
		}
		if !merged {
			f := ds.open(KindCBSec, title, cbCrumb(title), from, 3)
			f.n.Title, f.n.Count = title, 1
		}
		ds.lastSec = nil
		return
	}
	if !inIter && len(ds.stack) > 2 && c0 == 'R' {
		if qb, deriv, ok := registeredQB(b); ok {
			lvl := 3
			if ds.has(KindCBSec) {
				lvl = 4
			}
			f := ds.open(KindRegistered, "Registered qb: "+qb+" ("+deriv+")", "Registered "+qb, i, lvl)
			f.n.QB = qb
			ds.lastSec = nil
			return
		}
	}
	if e.title && !inIter && len(ds.stack) > 2 && !hp2(title, "Query transformations (QT)") &&
		!hp2(title, "COST-BASED QUERY TRANSFORMATIONS") && !hp2(title, "SPD: ") && !hp2(title, "QUERY BLOCK SIGNATURE") {
		lvl := 2
		if ds.has(KindCBSec) {
			lvl = 4
		} else {
			for k := 2; k < len(ds.stack); k++ {
				switch ds.stack[k].n.Kind {
				case KindQT, KindCBQT, KindPeekedBinds, KindSPD:
					lvl = 3
				}
				if lvl == 3 {
					break
				}
			}
		}
		if ls := ds.lastSec; ls != nil && ds.top().n == ls && ls.Title == title {
			ls.Count++
			ls.Label = title + " ×" + strconv.Itoa(ls.Count)
		} else {
			f := ds.open(KindTSec, title, secCrumb(title), from, lvl)
			f.n.Title, f.n.Count = title, 1
			ds.lastSec = f.n
		}
	}
}

// iterStart parses "(\d+), state space = (.*)" after "Starting iteration ".
func iterStart(rest []byte) (int, string, bool) {
	d, r := digits(rest)
	if len(d) == 0 || !hp(r, ", state space = ") {
		return 0, "", false
	}
	return atoi(d), string(r[len(", state space = "):]), true
}

// verdictOf matches ": Updated best state, Cost = X" and ": Not update best state, Cost = X".
func verdictOf(rest []byte) (kept bool, ok bool) {
	var r []byte
	switch {
	case hp(rest, ": Updated best state, Cost = "):
		kept, r = true, rest[len(": Updated best state, Cost = "):]
	case hp(rest, ": Not update best state, Cost = "):
		r = rest[len(": Not update best state, Cost = "):]
	default:
		return false, false
	}
	t, _ := token(r)
	return kept, len(t) > 0
}

// kkOptimizing matches "kkoqbc: optimizing query block X (#n)".
func kkOptimizing(b []byte) (qb, qbn string, ok bool) {
	const p = "kkoqbc: optimizing query block "
	if !hp(b, p) {
		return
	}
	t, rest := token(b[len(p):])
	if len(t) == 0 || !hp(rest, " (#") {
		return
	}
	d, r := digits(rest[3:])
	if len(d) == 0 || !hp(r, ")") {
		return
	}
	return string(t), string(d), true
}

// registeredQB matches "Registered qb: X 0xHEX (derivation)" and returns X and the text in the parentheses.
func registeredQB(b []byte) (qb, deriv string, ok bool) {
	const p = "Registered qb: "
	if !hp(b, p) {
		return
	}
	t, rest := token(b[len(p):])
	if len(t) == 0 || !hp(rest, " 0x") {
		return
	}
	rest = rest[3:]
	n := 0
	for n < len(rest) && isWord(rest[n]) {
		n++
	}
	if n == 0 || !hp(rest[n:], " (") {
		return
	}
	r := trimRightB(rest[n+2:])
	if len(r) == 0 || r[len(r)-1] != ')' {
		return
	}
	return string(t), string(r[:len(r)-1]), true
}

// cbCrumb: the title without "Cost-based " and without a trailing "(...)".
func cbCrumb(t string) string {
	t = strings.TrimPrefix(t, "Cost-based ")
	t = strings.TrimPrefix(t, "Cost-Based ")
	return strings.TrimSpace(stripParen(t))
}

func secCrumb(t string) string {
	if c := strings.TrimSpace(stripParen(t)); c != "" {
		return c
	}
	return t
}

// stripParen is replace(/\s*\(.*\)\s*$/, ”): from the first "(" when the text ends with ")".
func stripParen(t string) string {
	r := strings.TrimRight(t, " \t\r\n\f\v")
	if !strings.HasSuffix(r, ")") {
		return t
	}
	k := strings.IndexByte(r, '(')
	if k < 0 || k > len(r)-2 {
		return t
	}
	return strings.TrimRight(r[:k], " \t\r\n\f\v")
}

func (ds *dstate) runLine(e *lineEnt, title string, from int) {
	i, b := e.n, e.b
	run := ds.innermost(KindRun)
	var c0 byte
	if len(b) > 0 {
		c0 = b[0]
	}
	switch {
	case e.title && title == "QUERY BLOCK TEXT":
		f := ds.open(KindRunHead, "Query block text, signature, system statistics", "Header", from, 6)
		f.rh = &rhState{bottom: e.bBottom}
		ds.rhf = f
	case e.title && title == "BASE STATISTICAL INFORMATION":
		ds.open(KindBaseStats, "Base statistical information", "Base statistics", from, 6)
	case c0 == 'A' && ds.tableStart(e):
	case c0 == 'O' && hp(b, "OPTIMIZER STATISTICS AND COMPUTATIONS") && isBlank(b[len("OPTIMIZER STATISTICS AND COMPUTATIONS"):]):
		ds.open(KindJoinSearch, "Join order search", "Join orders", i, 6)
	case c0 == 'S' && hp(b, "Searching for inflection point (join #"):
		d, r := digits(b[len("Searching for inflection point (join #"):])
		if len(d) > 0 && hp(r, ")") {
			ds.open(KindAPSearch, "Adaptive plan: inflection point, join #"+string(d), "AP join #"+string(d), i, 6)
			ds.watchNB(ds.top(), i-1)
		}
	case c0 == 'F' && hp(b, "Final cost for query block"):
		ds.open(KindFinalCost, "Final cost", "Final cost", i, 6)
	case c0 == 'J' && ds.joinOrder(e):
	case c0 == '(' && hp(b, "(newjo-stop"):
		for len(ds.stack) > 1 && ds.top().n.Lvl >= 7 {
			ds.popTo(i - 1)
		}
	case e.title && hp2(title, "Now joining: "):
		t, _ := token([]byte(title[len("Now joining: "):]))
		if len(t) > 0 {
			tb := string(t)
			f := ds.open(KindJoinStep, "Now joining: "+tb, "Now joining "+stripHash(tb), from, 8)
			f.n.Table = tb
		}
	}
	// facts the trace states about the open node
	t := ds.top()
	s0 := b
	if len(b) > 0 && b[0] == ' ' {
		s0 = skipSpace(b)
	}
	if len(s0) == 0 {
		return
	}
	switch s0[0] {
	case 'B':
		if t.n.Kind == KindTable && hp(s0, "Best:: AccessPath: ") {
			if tk, _ := token(s0[len("Best:: AccessPath: "):]); len(tk) > 0 {
				t.n.Best, t.n.Result = string(tk), string(tk)
			}
		}
		if t.n.Kind == KindJoinStep && c0 == 'B' && hp(b, "Best:: JoinMethod: ") {
			if tk, _ := token(b[len("Best:: JoinMethod: "):]); len(tk) > 0 {
				t.n.Method, t.n.Result = string(tk), string(tk)
			}
		}
		if hp(s0, "Best join order: ") && run != nil {
			if d, _ := digits(s0[len("Best join order: "):]); len(d) > 0 {
				run.n.BestJo = atoi(d)
			}
		}
		if jo := ds.innermost(KindJoinOrder); jo != nil && c0 == 'B' && hp(b, "Best so far:") {
			ds.tableCost(jo, b[len("Best so far:"):])
		}
	case 'J':
		if c0 == 'J' && hp(b, "Join order aborted") {
			if jo := ds.innermost(KindJoinOrder); jo != nil {
				jo.aborted = true
			}
		}
	case 'T':
		if c0 == ' ' && hp(s0, "Table#:") {
			if jo := ds.innermost(KindJoinOrder); jo != nil {
				ds.tableCost(jo, b)
			}
		}
	case 'A':
		if t.n.Kind == KindAPSearch && hp(s0, "AP: Found point of inflection") {
			ds.popTo(i - 1)
		}
	}
}

func stripHash(s string) string {
	k := strings.LastIndexByte(s, '#')
	if k < 0 || k == len(s)-1 {
		return s
	}
	for _, c := range []byte(s[k+1:]) {
		if !isDigit(c) {
			return s
		}
	}
	return s[:k]
}

// tableCost matches the tail of "(Best so far:)?\s+Table#:\s*\d+\s+cost:\s*(\S+)" on rest (after the optional
// "Best so far:") and records the cost on the join order.
func (ds *dstate) tableCost(jo *frame, rest []byte) {
	if len(rest) == 0 || !isSpace(rest[0]) {
		return
	}
	r := skipSpace(rest)
	if !hp(r, "Table#:") {
		return
	}
	r = skipSpace(r[len("Table#:"):])
	d, r := digits(r)
	if len(d) == 0 || len(r) == 0 || !isSpace(r[0]) {
		return
	}
	r = skipSpace(r)
	if !hp(r, "cost:") {
		return
	}
	if tk, _ := token(skipSpace(r[len("cost:"):])); len(tk) > 0 {
		jo.cost = string(tk)
	}
}

// tableStart matches "Access path analysis for T" followed within three lines by SINGLE TABLE ACCESS PATH.
func (ds *dstate) tableStart(e *lineEnt) bool {
	b := e.b
	const p = "Access path analysis for "
	if !hp(b, p) {
		return false
	}
	t, _ := token(b[len(p):])
	if len(t) == 0 {
		return false
	}
	s := ds.s
	found := false
	for k := 1; k <= 3; k++ {
		if hp(s.ent(e.n+k).b, "SINGLE TABLE ACCESS PATH") {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	name := string(t)
	const q = "Single Table Cardinality Estimation for "
	for k := 1; k <= 5; k++ {
		l := s.ent(e.n + k).b
		if x := indexOf(l, q); x >= 0 {
			if tk, _ := token(l[x+len(q):]); len(tk) > 0 {
				name = string(tk)
				break
			}
		}
	}
	f := ds.open(KindTable, name, name, e.n, 6)
	f.n.Table = string(t)
	ds.addTable(string(t))
	return true
}

func (ds *dstate) joinOrder(e *lineEnt) bool {
	b := e.b
	const p = "Join order["
	if !hp(b, p) || !ds.has(KindJoinSearch) {
		return false
	}
	d, r := digits(b[len(p):])
	if len(d) == 0 || !hp(r, "]:") || len(r) < 3 || !isSpace(r[2]) {
		return false
	}
	n := atoi(d)
	tables := strings.Fields(string(r[2:]))
	label := "Join order[" + string(d) + "]:  " + strings.Join(tables, "  ")
	f := ds.open(KindJoinOrder, label, "Join order "+string(d), e.n, 7)
	f.n.N = n
	f.n.Tables = tables
	ds.keep(e.n, e.n)
	return true
}

func (ds *dstate) resultLine(e *lineEnt, title string) {
	i, b := e.n, e.b
	from := i
	if e.title {
		from = e.bTop
	}
	var c0 byte
	if len(b) > 0 {
		c0 = b[0]
	}
	s0 := b
	if c0 == ' ' {
		s0 = skipSpace(b)
	}
	switch {
	case c0 == 'S' && hp(b, "Starting SQL statement dump"):
		ds.open(KindStmtDump, "Statement dump", "Statement dump", i, 2)
	case c0 == '-' && hp(b, "----- Explain Plan Dump -----"):
		ds.open(KindPlan, "Explain plan", "Plan", i, 2)
	case e.title && !e.bUnder && title == "Plan Table":
		ds.open(KindPlanTable, "Plan table", "Plan table", from, 3)
	case c0 == 'Q' && hp(b, "Query Block Name / Object Alias"):
		ds.open(KindPlanQBs, "Query block name / object alias", "Query blocks", i, 3)
	case c0 == 'P' && hp(b, "Predicate Information:"):
		ds.open(KindPlanPreds, "Predicate information", "Predicates", i, 3)
	case c0 == 'C' && hp(b, "Content of other_xml column"):
		ds.open(KindOtherXML, "Content of other_xml column", "other_xml", i, 2)
	case c0 == 'P' && hp(b, "Peeked Binds") && isBlank(b[len("Peeked Binds"):]):
		ds.open(KindPeeked, "Peeked binds", "Peeked binds", i, 3)
	case len(s0) > 0 && s0[0] == 'a' && hp(s0, "adaptive_plan") && colonAfterSpace(s0[len("adaptive_plan"):]) && ds.top().n.Kind == KindPeeked:
		ds.popTo(i - 1)
	case e.title && title == "Optimizer Metrics":
		ds.open(KindOptMetrics, "Optimizer metrics", "Metrics", from, 3)
	case e.title && title == "QUERY BLOCK REGISTRY":
		ds.open(KindQBRegXML, "Query block registry (XML)", "QB registry", from, 3)
	case len(s0) > 0 && s0[0] == 'O' && hp(s0, "Outline Data:"):
		ds.open(KindOutlineData, "Outline data", "Outline data", i, 3)
	case len(s0) > 0 && s0[0] == 'H' && hp(s0, "Hint Report:"):
		ds.open(KindHintReport, "Hint report", "Hint report", i, 3)
	case c0 == 'O' && hp(b, "Optimizer state dump:"):
		f := ds.open(KindStateDump, "Optimizer state dump", "State dump", i, 2)
		ds.watchNB(f, i)
	case c0 == 'C' && hp(b, "Compilation Environment Dump") && ds.has(KindStateDump):
		ds.open(KindStateParams, "Parameters", "Parameters", i, 3)
	case c0 == 'B' && hp(b, "Bug Fix Control Environment") && ds.has(KindStateDump):
		ds.open(KindStateFix, "Fix controls", "Fix controls", i, 3)
	case c0 == 'Q' && hp(b, "Query Block Registry:"):
		ds.open(KindQBRegistry, "Query block registry", "QB registry", i, 2)
	case c0 == 'D' && hp(b, "Dumping Hints") && isBlank(b[len("Dumping Hints"):]):
		ds.open(KindHints, "Dumping hints", "Hints", i, 2)
	}
}

func colonAfterSpace(b []byte) bool {
	b = skipSpace(b)
	return len(b) > 0 && b[0] == ':'
}

func indexOf(b []byte, s string) int {
	return strings.Index(string(b), s)
}
