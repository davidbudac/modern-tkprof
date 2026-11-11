package opt

import (
	"bytes"
	"math/bits"
	"strconv"
	"strings"
)

// ---- the hash of a costing run's normalised text ----

type runHash struct {
	a, b  uint64
	lines int
}

func (h *runHash) init() {
	h.a, h.b, h.lines = 14695981039346656037, 0x84222325cbf29ce4, 0
}

const (
	prime1 = 1099511628211
	prime2 = 0x9E3779B97F4A7C15
)

func (h *runHash) mix(c byte) {
	h.a = (h.a ^ uint64(c)) * prime1
	h.b = bits.RotateLeft64((h.b^uint64(c))*prime2, 29)
}

// add folds one line in with the addresses and memory figures replaced: 0x… hex numbers, the number after
// addr=, in-use= and alloc= (they differ between two costings of the same text).
func (h *runHash) add(line []byte) {
	n := len(line)
	for i := 0; i < n; i++ {
		c := line[i]
		switch c {
		case '0':
			if i+2 < n && line[i+1] == 'x' && isHex(line[i+2]) && (i == 0 || !isWord(line[i-1])) {
				j := i + 2
				for j < n && isHex(line[j]) {
					j++
				}
				h.mix(1)
				i = j - 1
				continue
			}
		case '=':
			if i >= 4 && ((line[i-1] == 'r' && hp(line[i-4:], "addr") && (i == 4 || !isWord(line[i-5]))) ||
				(line[i-1] == 'c' && i >= 5 && hp(line[i-5:], "alloc") && (i == 5 || !isWord(line[i-6]))) ||
				(line[i-1] == 'e' && i >= 6 && hp(line[i-6:], "in-use") && (i == 6 || !isWord(line[i-7])))) {
				h.mix('=')
				h.mix(2)
				j := i + 1
				for j < n && isWord(line[j]) {
					j++
				}
				i = j - 1
				continue
			}
		}
		h.mix(c)
	}
	h.mix('\n')
	h.lines++
}

// generatedView: the names Oracle gives the inline and merged views it makes up (they are not tables).
func generatedView(name string) bool {
	return strings.HasPrefix(name, "from$_") || strings.HasPrefix(name, "VW_") || strings.HasPrefix(name, "VM_NWVW_")
}

// ---- facts read from the lines of a dump ----

func (ds *dstate) addTable(name string) {
	if name == "" || ds.tables[name] || generatedView(name) {
		return
	}
	ds.tables[name] = true
	ds.tableOrder = append(ds.tableOrder, name)
}

// objName matches "^\s+(\w+)\[[^\]]*\] \d+, type" (a line of "Objects referenced in the statement").
func objName(b []byte) (string, bool) {
	if len(b) == 0 || !isSpace(b[0]) {
		return "", false
	}
	r := skipSpace(b)
	i := 0
	for i < len(r) && isWord(r[i]) {
		i++
	}
	if i == 0 || i >= len(r) || r[i] != '[' {
		return "", false
	}
	k := bytes.IndexByte(r[i:], ']')
	if k < 0 {
		return "", false
	}
	rest := r[i+k+1:]
	if !hp(rest, " ") {
		return "", false
	}
	d, rest := digits(rest[1:])
	if len(d) == 0 || !hp(rest, ", type") {
		return "", false
	}
	return string(r[:i]), true
}

// tableStatsName matches "^\s*Table:\s+(\S+)\s+Alias:" (the line after "Table Stats::").
func tableStatsName(b []byte) (string, bool) {
	r := skipSpace(b)
	if !hp(r, "Table:") || len(r) == len("Table:") || !isSpace(r[len("Table:")]) {
		return "", false
	}
	t, rest := token(skipSpace(r[len("Table:"):]))
	if len(t) == 0 || !isSpace0(rest) {
		return "", false
	}
	if !hp(skipSpace(rest), "Alias:") {
		return "", false
	}
	return string(t), true
}

func isSpace0(b []byte) bool { return len(b) > 0 && isSpace(b[0]) }

func isLegendHeader(b []byte) bool { return hp(b, "Legend") && isBlank(b[len("Legend"):]) }

// fixLine matches "^\s+fix\s+\d+\s*=".
func fixLine(b []byte) bool {
	if len(b) == 0 || !isSpace(b[0]) {
		return false
	}
	r := skipSpace(b)
	if !hp(r, "fix") || len(r) == 3 || !isSpace(r[3]) {
		return false
	}
	r = skipSpace(r[3:])
	d, r := digits(r)
	if len(d) == 0 {
		return false
	}
	r = skipSpace(r)
	return len(r) > 0 && r[0] == '='
}

func (ds *dstate) facts(e *lineEnt) {
	i, b := e.n, e.b
	d := ds.d
	var c0 byte
	if len(b) > 0 {
		c0 = b[0]
	}

	// the statement as typed: the lines between "Current SQL Statement" and "Parser State" (12.2+), or, in 11.2 and
	// 12.1, which write no parser state, the banner of asterisks before "Legend"
	if ds.stmtState == 3 {
		switch {
		case c0 == 'L' && isLegendHeader(b):
			ds.endStmt(ds.stmtStars - 1)
		case c0 == '-' && hp(b, "----- Parser State -----"):
			ds.addStmtLine(ds.starsLine)
			ds.endStmt(i - 1)
		default:
			ds.addStmtLine(ds.starsLine)
			ds.stmtState = 1
		}
	}
	switch ds.stmtState {
	case 0:
		if c0 == '-' && hp(b, "----- Current SQL Statement for this session (sql_id=") {
			r := b[len("----- Current SQL Statement for this session (sql_id="):]
			k := 0
			for k < len(r) && isWord(r[k]) {
				k++
			}
			d.SQLID = string(r[:k])
			ds.d.Nth = ds.s.nth[d.SQLID] + 1
			ds.s.nth[d.SQLID] = d.Nth
			ds.stack[0].n.Label, ds.stack[0].n.Crumb = d.SQLID, d.SQLID
			ds.stmtCS = i
			d.StmtLine, d.StmtTo = i+1, i
			ds.stmtState = 1
		}
	case 1:
		switch {
		case c0 == '-' && hp(b, "----- Parser State -----"):
			ds.endStmt(i - 1)
		case c0 == '*' && isStars(b):
			// the end in 11.2 and 12.1 when "Legend" follows; otherwise a line of the statement
			ds.stmtStars, ds.starsLine = i, append(ds.starsLine[:0], b...)
			ds.stmtState = 3
		default:
			ds.addStmtLine(b)
		}
	}

	// the objects the statement references
	switch ds.objState {
	case 0:
		if c0 == 'O' && hp(b, "Objects referenced in the statement") {
			ds.objState = 1
		}
	case 1:
		if name, ok := objName(b); ok {
			ds.addTable(name)
		} else {
			ds.objState = 2
		}
	}
	if ds.tabNext {
		ds.tabNext = false
		if name, ok := tableStatsName(b); ok {
			ds.addTable(name)
		}
	}
	if c0 == 'T' && hp(b, "Table Stats::") {
		ds.tabNext = true
	}

	// plan_hash of the other_xml section ("plan_hash : 2477488908", not plan_hash_full)
	if d.PlanHash == "" && (c0 == ' ' || c0 == 'p') {
		r := skipSpace(b)
		if hp(r, "plan_hash") {
			r = skipSpace(r[len("plan_hash"):])
			if len(r) > 0 && r[0] == ':' {
				if dg, _ := digits(skipSpace(r[1:])); len(dg) > 0 {
					d.PlanHash = string(dg)
				}
			}
		}
	}

	// the legend: the trace's own abbreviation list
	switch ds.lgState {
	case 0:
		if c0 == 'L' && isLegendHeader(b) {
			ds.lgState = 1
		}
	case 1:
		ds.lgState = 2
	case 2:
		if e.sep {
			ds.lgState = 3
			break
		}
		if t, rest := token(b); len(t) > 0 && hp(rest, " - ") && !isSpace0(b) {
			text := string(trimB(rest[3:]))
			if text != "" {
				d.Legend = append(d.Legend, Term{Term: string(t), Text: text, Line: i, Codes: [][2]string{}})
				ds.lgLast = &d.Legend[len(d.Legend)-1]
			}
		} else if ds.lgLast != nil && isSpace0(b) {
			r := skipSpace(b)
			if dg, rest := digits(r); len(dg) > 0 && hp(rest, ": ") {
				if text := string(trimB(rest[2:])); text != "" {
					ds.lgLast.Codes = append(ds.lgLast.Codes, [2]string{string(dg), text})
				}
			}
		}
	}

	// the fix controls: the heading and the "fix N = x" lines after it
	if ds.fixFrom > 0 {
		if fixLine(b) {
			ds.fixTo = i
		} else {
			if ds.fixTo > ds.fixFrom {
				ds.addFold(ds.fixFrom, ds.fixTo, FoldFix, foldFixLabel)
			}
			ds.fixFrom = 0
		}
	}
	if c0 == 'B' && hp(b, "Bug Fix Control Environment") {
		ds.fixFrom, ds.fixTo = i, i
	}

	// the statement printed again in the statement dump
	if ds.seenRS {
		ds.statementAgain(e)
	}

	// the plan table
	if ds.planState < 5 {
		ds.planLine(e)
	}
}

func (ds *dstate) addStmtLine(b []byte) {
	if len(ds.stmtBuf) >= 1<<20 {
		return
	}
	if ds.stmtLines > 0 {
		ds.stmtBuf = append(ds.stmtBuf, '\n')
	}
	ds.stmtBuf = append(ds.stmtBuf, b...)
	ds.stmtLines++
}

func (ds *dstate) endStmt(to int) {
	d := ds.d
	d.StmtTo = to
	d.StmtText = string(ds.stmtBuf)
	d.SQLStart = cutRunes(collapseSpace(d.StmtText), 240)
	ds.stmtState = 2
	ds.keep(ds.stmtCS, d.StmtTo)
	ds.stmtBuf = nil
}

// isStars: a line of 40 or more asterisks, the banner that ends the statement text in 11.2 and 12.1 (43 there).
func isStars(b []byte) bool {
	b = trimB(b)
	if len(b) < 40 {
		return false
	}
	for _, c := range b {
		if c != '*' {
			return false
		}
	}
	return true
}

func (ds *dstate) statementAgain(e *lineEnt) {
	i, b := e.n, e.b
	sd := &ds.sd
	if ds.stmtState != 2 {
		return
	}
	switch sd.c2State {
	case 0:
		if hp(b, "----- Current SQL Statement for this session") {
			sd.c2, sd.c2State = i, 1
		}
	case 1:
		// 11.2 and 12.1 write no parser state: the copy ends at sql_text_length=
		if hp(b, "----- Parser State -----") || hp(b, "sql_text_length=") {
			sd.c2State = 2
			if !sd.c2Over && i-1 > sd.c2+1 && strings.TrimSpace(string(sd.c2Buf)) == strings.TrimSpace(ds.d.StmtText) {
				ds.addFold(sd.c2+1, i-1, FoldStmtAgn, "statement text, as at line "+strconv.Itoa(ds.d.StmtLine))
			}
			sd.c2Buf = nil
		} else if !sd.c2Over {
			if len(sd.c2Buf) > len(ds.d.StmtText)+1024 {
				sd.c2Over = true
			} else {
				if len(sd.c2Buf) > 0 || i > sd.c2+1 {
					sd.c2Buf = append(sd.c2Buf, '\n')
				}
				sd.c2Buf = append(sd.c2Buf, b...)
			}
		}
	}
	switch sd.sqState {
	case 0:
		if hp(b, "sql=") {
			sd.sq, sd.sqState = i, 1
		}
	case 1:
		if hp(b, "----- Explain Plan Dump") {
			sd.sqState = 2
			if i-1 > sd.sq {
				ds.addFold(sd.sq, i-1, FoldStmtAgn, "statement text, as at line "+strconv.Itoa(ds.d.StmtLine))
			}
		}
	}
}

// ---- the plan table ----

func isRowLine(b []byte) bool {
	if len(b) == 0 || b[0] != '|' {
		return false
	}
	r := skipSpace(b[1:])
	d, r := digits(r)
	return len(d) > 0 && len(skipSpace(r)) > 0 && skipSpace(r)[0] == '|'
}

func isIDHeader(b []byte) bool {
	if len(b) == 0 || b[0] != '|' {
		return false
	}
	r := skipSpace(b[1:])
	if !hp(r, "Id") {
		return false
	}
	r = skipSpace(r[2:])
	return len(r) > 0 && r[0] == '|'
}

// isTableEnd matches "^-+(\+-+)+\+\s*$": a rule line of one or more column groups (the standard plan has
// two, a partitioned or parallel plan has a third for Pstart/Pstop or TQ/IN-OUT/PQ Distrib).
func isTableEnd(b []byte) bool {
	i := 0
	for i < len(b) && b[i] == '-' {
		i++
	}
	if i == 0 || i >= len(b) || b[i] != '+' {
		return false
	}
	groups := 0
	for i < len(b) && b[i] == '+' {
		i++
		j := i
		for j < len(b) && b[j] == '-' {
			j++
		}
		if j == i {
			// "+" not followed by dashes: the closing one
			return groups > 0 && isBlank(b[i:])
		}
		groups++
		i = j
	}
	return false
}

func cols(b []byte) []string {
	p := strings.Split(string(b), "|")
	if len(p) < 3 {
		return nil
	}
	return p[1 : len(p)-1]
}

func col(c []string, k int) string {
	if k < len(c) {
		return strings.TrimSpace(c[k])
	}
	return ""
}

// qbLine matches "^\s*(\d+) - (\S+)\s*(?:\/ (.+?))?\s*$".
func qbLine(b []byte) (id int, qb, alias string, ok bool) {
	r := skipSpace(b)
	d, r := digits(r)
	if len(d) == 0 || !hp(r, " - ") {
		return
	}
	t, rest := token(r[3:])
	if len(t) == 0 {
		return
	}
	rest = skipSpace(rest)
	if len(rest) > 0 {
		if !hp(rest, "/ ") {
			return
		}
		alias = string(trimB(rest[2:]))
		if alias == "" {
			return
		}
	}
	return atoi(d), string(t), alias, true
}

// predLine matches "^\s*(\d+) - (.+?)\s*$".
func predLine(b []byte) (id int, text string, ok bool) {
	r := skipSpace(b)
	d, r := digits(r)
	if len(d) == 0 || !hp(r, " - ") {
		return
	}
	t := trimB(r[3:])
	if len(t) == 0 {
		return
	}
	return atoi(d), string(t), true
}

func (ds *dstate) planLine(e *lineEnt) {
	i, b := e.n, e.b
	switch ds.planState {
	case 0:
		if len(b) > 0 && b[0] == 'P' && hp(b, "Plan Table") && isBlank(b[len("Plan Table"):]) {
			ds.plan = &Plan{From: i - 1, Cols: []string{}, Rows: []PlanRow{}, QBs: map[int]PlanQB{}, Preds: map[int][]PlanPred{}}
			ds.planState, ds.planSkip = 1, i+1
		}
	case 1:
		if i <= ds.planSkip {
			return
		}
		p := ds.plan
		switch {
		case isIDHeader(b):
			p.Head = i
			p.Cols = nil
			for _, c := range cols(b) {
				p.Cols = append(p.Cols, strings.TrimSpace(c))
			}
			if p.Cols == nil {
				p.Cols = []string{}
			}
		case isRowLine(b):
			c := cols(b)
			if len(c) >= 2 {
				op := c[1]
				depth := len(op) - len(strings.TrimLeft(op, " ")) - 1
				if depth < 0 {
					depth = 0
				}
				row := PlanRow{Line: i, ID: atoi([]byte(strings.TrimSpace(c[0]))), Depth: depth, Op: strings.TrimSpace(op),
					Name: col(c, 2), Rows: col(c, 3), Bytes: col(c, 4), Cost: col(c, 5), Time: col(c, 6)}
				// the cells beyond the seven standard columns (Pstart, Pstop; TQ, IN-OUT, PQ Distrib), one for each
				// header column, "" for an empty cell
				if n := len(p.Cols) - planStdCols; n > 0 {
					row.Extra = make([]string, n)
					for k := range row.Extra {
						row.Extra[k] = col(c, planStdCols+k)
					}
				}
				p.Rows = append(p.Rows, row)
			}
		case isTableEnd(b):
			if len(p.Rows) > 0 {
				p.TableTo = i
				ds.planState = 2
			}
		}
	case 2:
		p := ds.plan
		switch {
		case hp(b, "Query Block Name / Object Alias"):
			ds.planState, ds.planSkip = 3, i+1
		case hp(b, "Predicate Information:"):
			p.To = i
			ds.planState, ds.planSkip, ds.lastPred = 4, i+1, -1
		case hp(b, "Content of other_xml column"):
			ds.planState = 5
			p.To = p.TableTo
		}
	case 3:
		if i <= ds.planSkip {
			return
		}
		p := ds.plan
		switch {
		case hp(b, "Predicate Information:"):
			p.To = i
			ds.planState, ds.planSkip, ds.lastPred = 4, i+1, -1
		case e.blank || hp(b, "Content of other_xml column"):
			ds.planState = 5
			p.To = p.TableTo
			if p.To < p.From {
				p.To = p.From
			}
		default:
			if id, qb, alias, ok := qbLine(b); ok {
				p.QBs[id] = PlanQB{QB: qb, Alias: alias, Line: i}
			}
		}
	case 4:
		if i <= ds.planSkip {
			return
		}
		p := ds.plan
		if id, text, ok := predLine(b); ok {
			p.Preds[id] = append(p.Preds[id], PlanPred{Text: text, Line: i})
			p.To = i
			ds.lastPred = id
			return
		}
		if len(b) > 0 && b[0] == ' ' && !e.blank && ds.lastPred >= 0 {
			// a predicate wrapped onto the next line
			ps := p.Preds[ds.lastPred]
			if n := len(ps); n > 0 {
				ps[n-1].Text += " " + string(trimB(b))
				p.To = i
				return
			}
		}
		ds.planState = 5
	}
}

// ---- sections whose lines are read by the section that is open ----

func (ds *dstate) sections(e *lineEnt) {
	switch ds.top().n.Kind {
	case KindParamsAlt:
		ds.paramLine(e, "altered")
	case KindParamsOptP:
		ds.paramLine(e, "opt_param")
	case KindPeekedBinds:
		ds.bindInfoLine(e)
	case KindPeeked:
		ds.peekedLine(e)
	case KindHints:
		ds.hintLine(e)
	case KindHintReport:
		ds.reportLine(e)
	case KindQBRegXML:
		if len(e.b) > 0 && e.b[0] == '<' {
			ds.excl = append(ds.excl, e.n)
		}
	}
}

func (ds *dstate) paramLine(e *lineEnt, from string) {
	t := skipSpace(e.b)
	if len(t) == 0 {
		return
	}
	if hp(t, "fix ") {
		d, r := digits(skipSpace(t[4:]))
		r = skipSpace(r)
		if len(d) > 0 && len(r) > 0 && r[0] == '=' {
			ds.d.Altered = append(ds.d.Altered, Param{Name: "fix " + string(d), Value: string(trimB(r[1:])), Line: e.n, From: from})
		}
		return
	}
	if !(t[0] == '_' || t[0] >= 'a' && t[0] <= 'z' || t[0] >= 'A' && t[0] <= 'Z') {
		return
	}
	k := 0
	for k < len(t) && (isWord(t[k]) || t[k] == '$' || t[k] == '#') {
		k++
	}
	r := skipSpace(t[k:])
	if len(r) == 0 || r[0] != '=' {
		return
	}
	ds.d.Altered = append(ds.d.Altered, Param{Name: string(t[:k]), Value: string(trimB(r[1:])), Line: e.n, From: from})
}

var dtypeNames = map[int]string{1: "VARCHAR2", 2: "NUMBER", 8: "LONG", 11: "ROWID", 12: "DATE", 23: "RAW", 96: "CHAR",
	100: "BINARY_FLOAT", 101: "BINARY_DOUBLE", 112: "CLOB", 113: "BLOB", 180: "TIMESTAMP", 181: "TIMESTAMP WITH TIME ZONE",
	182: "INTERVAL YEAR TO MONTH", 183: "INTERVAL DAY TO SECOND", 231: "TIMESTAMP WITH LOCAL TIME ZONE"}

// bindInfoLine reads the "Bind Info (kkscoacd)" block under "Peeked values of the binds".
func (ds *dstate) bindInfoLine(e *lineEnt) {
	b := e.b
	t := skipSpace(b)
	if ds.bindOpen {
		ds.d.BindLines = append(ds.d.BindLines, e.n)
		if oddQuotes(b) {
			ds.bindOpen = false
		}
		return
	}
	switch {
	case hp(b, " Bind#"):
		d, _ := digits(b[len(" Bind#"):])
		ds.bindInfo = append(ds.bindInfo, Bind{Pos: atoi(d) + 1})
	case hp(t, "oacdty=") && len(ds.bindInfo) > 0:
		d, _ := digits(t[len("oacdty="):])
		code := atoi(d)
		name := dtypeNames[code]
		if name == "" {
			name = "oacdty=" + string(d)
		}
		ds.bindInfo[len(ds.bindInfo)-1].Type = name
	case hp(t, "value=") && len(ds.bindInfo) > 0:
		v := string(trimRightB(t[len("value="):]))
		ds.bindInfo[len(ds.bindInfo)-1].Value = v
		ds.bindInfo[len(ds.bindInfo)-1].Line = e.n
		ds.d.BindLines = append(ds.d.BindLines, e.n)
		ds.bindOpen = strings.HasPrefix(v, `"`) && oddQuotes([]byte(v))
	}
}

// peekedLine reads the "Peeked Binds" block of the other_xml section.
func (ds *dstate) peekedLine(e *lineEnt) {
	t := trimB(e.b)
	if ds.bindOpen {
		ds.d.BindLines = append(ds.d.BindLines, e.n)
		if oddQuotes(e.b) {
			ds.bindOpen = false
		}
		return
	}
	switch {
	case string(t) == "Bind variable information":
		ds.peeked = append(ds.peeked, Bind{})
	case len(ds.peeked) == 0:
	case hp(t, "position="):
		ds.peeked[len(ds.peeked)-1].Pos = atoi(t[len("position="):])
	case hp(t, "dup_position="):
		ds.peeked[len(ds.peeked)-1].Dup = atoi(t[len("dup_position="):])
	case hp(t, "datatype(string)="):
		ds.peeked[len(ds.peeked)-1].Type = string(t[len("datatype(string)="):])
	case hp(t, "value="):
		v := string(t[len("value="):])
		ds.peeked[len(ds.peeked)-1].Value = v
		ds.peeked[len(ds.peeked)-1].Line = e.n
		ds.d.BindLines = append(ds.d.BindLines, e.n)
		ds.bindOpen = strings.HasPrefix(v, `"`) && oddQuotes([]byte(v))
	}
}

func intAfter(b []byte, key string) int {
	k := bytes.Index(b, []byte(key))
	if k < 0 {
		return 0
	}
	d, _ := digits(b[k+len(key):])
	return atoi(d)
}

func (ds *dstate) hintLine(e *lineEnt) {
	t := skipSpace(e.b)
	if !hp(t, "atom_hint=") {
		return
	}
	h := Hint{Line: e.n, Src: "dump", Err: intAfter(t, " err="), Used: intAfter(t, " used=")}
	if k := bytes.Index(t, []byte(" txt=")); k >= 0 {
		txt := string(trimRightB(t[k+5:]))
		txt = strings.TrimSpace(strings.TrimSuffix(txt, ")"))
		h.Text = txt
	}
	ds.d.Hints = append(ds.d.Hints, h)
}

// reportLine reads the Hint Report of the other_xml section: under "Query Block:" and "Table:" come the
// hints, a used one bare ("use_hash(c)"), the others after their verdict ("Unused: index(o no_such_index)",
// "Syntax Error: p53"), a reason on the line after.
func (ds *dstate) reportLine(e *lineEnt) {
	t := trimB(e.b)
	switch {
	case len(t) == 0, hp(t, "Hint Report:"), hp(t, "Query Block:"), hp(t, "Table:"), hp(t, "Statement:"), hp(t, "End Hint Report"), hp(t, "Total hints"):
		return
	case hp(t, "reason:"):
		if n := len(ds.d.Hints); n > 0 && ds.d.Hints[n-1].Src == "report" {
			ds.d.Hints[n-1].Note += ": " + string(trimB(t[len("reason:"):]))
		}
		return
	}
	h := Hint{Line: e.n, Text: string(t), Src: "report"}
	switch {
	case hp(t, "Unused:"):
		h.Note = "Unused"
	case hp(t, "Syntax Error:"):
		h.Note = "Syntax Error"
	}
	ds.d.Hints = append(ds.d.Hints, h)
}

// ---- the statements after each transformation ----

// sqlVersion reads the "UNPARSED QUERY IS" statements: the header's label and the statement on the line after.
func (ds *dstate) sqlVersion(e *lineEnt) {
	b := e.b
	n := len(b)
	if n < 24 {
		return
	}
	end := n
	for end > 0 && isSpace(b[end-1]) {
		end--
	}
	if end == 0 || b[end-1] != '*' {
		return
	}
	k := bytes.Index(b, []byte(" UNPARSED QUERY IS "))
	if k < 0 {
		return
	}
	// the stars before, three or more
	s := k
	for s > 0 && b[s-1] == '*' {
		s--
	}
	if k-s < 3 {
		return
	}
	// the stars after, three or more, and nothing else
	a := k + len(" UNPARSED QUERY IS ")
	z := a
	for z < end && b[z] == '*' {
		z++
	}
	if z != end || z-a < 3 {
		return
	}
	next := ds.s.ent(e.n + 1)
	if next.blank || (ds.qbsOver && len(next.b) > 0 && next.b[0] == 'R' && IsStart(next.b)) {
		// no statement, or the next line opens the next dump
		return
	}
	label := strings.TrimSpace(strings.TrimRight(string(b[:s]), ": \t\r\n\f\v"))
	if label == "" {
		label = cutBytes(strings.TrimSpace(string(ds.s.ent(e.n-1).b)), 70)
	}
	text := string(trimB(next.b))
	v := SQL{Head: e.n, Line: e.n + 1, Label: label, Text: text}
	if line, ok := ds.sqlByTxt[text]; ok {
		v.SameAs = line
		ds.addFold(e.n+1, e.n+1, FoldSameSQL, "same statement as line "+strconv.Itoa(line))
		ds.keep(e.n, e.n)
	} else {
		ds.sqlByTxt[text] = e.n + 1
		ds.keep(e.n, e.n+1)
	}
	if m := len(ds.versions); m > 0 {
		v.Prev = ds.versions[m-1].Line
	}
	ds.versions = append(ds.versions, v)
}

func cutBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return cutRunes(s, n)
}

// digestLine keeps the heading lines, the marker lines and the search's bookkeeping lines.
func (ds *dstate) digestLine(e *lineEnt) {
	b := e.b
	if len(b) == 0 {
		return
	}
	switch {
	case e.role == 'h' || e.role == 'u':
		ds.keep(e.n, e.n)
	case b[0] == '-' && isHeadingDash(b):
		ds.keep(e.n, e.n)
	case b[0] == '*' && hp(b, "*** "):
		ds.keep(e.n, e.n)
	case b[0] == 'N' && hp(b, "Number of join permutations tried"):
		ds.keep(e.n, e.n)
	case b[0] == 'R' && hp(b, "Registered qb: "):
		ds.keep(e.n, e.n)
	}
}

// ---- the run header's repeat of the statement ----

func (ds *dstate) runHeadFrame() *frame {
	if ds.rhf != nil && ds.rhf.rh != nil && !ds.rhf.rh.done {
		return ds.rhf
	}
	return nil
}

func (ds *dstate) collectRunHead(f *frame, e *lineEnt) {
	rh := f.rh
	if e.n <= rh.bottom {
		return
	}
	if e.role == 't' {
		ds.finishRunHead(rh, e.n)
		ds.rhf = nil
		return
	}
	if rh.over {
		return
	}
	rh.size += len(e.b) + 1
	if rh.size > len(ds.d.StmtText)+1024 {
		rh.over = true
		rh.lines = nil
		return
	}
	rh.lines = append(rh.lines, rhLine{e.n, string(e.b)})
}
