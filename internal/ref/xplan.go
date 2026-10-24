package ref

import (
	"regexp"
	"strconv"
	"strings"
)

// XPlanRow is one operation of a DBMS_XPLAN table, with the per-id sections
// (predicates, query block / alias) merged in. Numeric columns the table
// does not have, or has blank, are -1 (an optimizer estimate or a count is
// never negative).
type XPlanRow struct {
	ID       int
	Depth    int // indentation of the Operation cell: 0 for the root
	Op       string
	Name     string
	Inactive bool  // adaptive-plan row marked '-' in the Id column
	ERows    int64 // Rows / E-Rows (estimate)
	EBytes   int64 // Bytes / E-Bytes
	Cost     int64
	Starts   int64
	ARows    int64
	ATimeUs  int64 // A-Time in microseconds
	Buffers  int64
	Reads    int64
	Writes   int64
	OMem     int64 // OMem / 0Mem, bytes
	OneMem   int64 // 1Mem, bytes
	UsedMem  int64 // Used-Mem, bytes
	UsedPass int64 // passes in the parentheses of Used-Mem
	Access   string
	Filter   string
	Storage  string
	QBlock   string // Query Block Name
	Alias    string // Object Alias
	Star     bool   // '*' in the Id column: the Predicate Information has this id
}

// XPlan is one parsed DBMS_XPLAN listing.
type XPlan struct {
	SQLID    string
	PlanHash uint64
	HasHash  bool
	Rows     []XPlanRow
	Notes    []string // lines of the trailing Note section, "- " prefix removed
	byID     map[int]int
}

// Row finds an operation by its Id, or nil.
func (x *XPlan) Row(id int) *XPlanRow {
	if i, ok := x.byID[id]; ok {
		return &x.Rows[i]
	}
	return nil
}

var (
	reHashLine   = regexp.MustCompile(`(?i)Plan\s+hash\s+value\s*:\s*(\d+)`)
	reSQLIDLine  = regexp.MustCompile(`(?i)^\s*SQL_ID\s+([A-Za-z0-9]+)`)
	reHeaderLine = regexp.MustCompile(`(?i)\|\s*Id\s*\|.*Operation`)
	reRule       = regexp.MustCompile(`^[-|=\s]+$`)
	rePredStart  = regexp.MustCompile(`(?i)^\s*(\d+)\s*-\s*(access|filter|storage)\s*\(`)
	rePredIdless = regexp.MustCompile(`(?i)^\s*(access|filter|storage)\s*\(`)
	reSection    = regexp.MustCompile(`(?i)^\s*(Column Projection Information|Hint Report|Outline Data|Query Block|Remote SQL|Peeked Binds|Predicate Information|Other XML|Dynamic sampling|Sql Plan Directive)\b|^\s*Note\s*$`)
	reColonHead  = regexp.MustCompile(`(?i)^[A-Z].*:$`)
	reQBLine     = regexp.MustCompile(`^\s*(\d+)\s*-\s*(\S+)(?:\s*/\s*(\S+))?`)
	reIDDash     = regexp.MustCompile(`^\d+\s*-`)
	reIDCell     = regexp.MustCompile(`(\d+)`)
)

// ParseXPlan parses the first plan in a DBMS_XPLAN text, or nil when the text
// has no plan table.
func ParseXPlan(text string) *XPlan {
	if ps := ParseXPlans(text); len(ps) > 0 {
		return ps[0]
	}
	return nil
}

// ParseXPlans parses every plan of a DBMS_XPLAN text. A DISPLAY_CURSOR spool
// can hold several child cursors, DISPLAY_AWR several plan hash values; each
// "Plan hash value:" line starts one plan (the "SQL_ID ..., child number"
// header above it belongs to that plan). Segments without a plan table are
// dropped.
func ParseXPlans(text string) []*XPlan {
	lines := expandTableTabs(strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n"))
	var hashAt []int
	for i, l := range lines {
		if reHashLine.MatchString(l) {
			hashAt = append(hashAt, i)
		}
	}
	if len(hashAt) == 0 {
		// no hash line: still a plan table, maybe
		if x := parseXPlanLines(lines); x != nil {
			return []*XPlan{x}
		}
		return nil
	}
	starts := make([]int, len(hashAt))
	for k, h := range hashAt {
		starts[k] = 0
		if k > 0 {
			starts[k] = h
			for j := h - 1; j > hashAt[k-1]; j-- {
				if reSQLIDLine.MatchString(lines[j]) {
					starts[k] = j
					break
				}
			}
		}
	}
	var out []*XPlan
	for k := range hashAt {
		end := len(lines)
		if k+1 < len(hashAt) {
			end = starts[k+1]
		}
		if x := parseXPlanLines(lines[starts[k]:end]); x != nil {
			out = append(out, x)
		}
	}
	return out
}

func parseXPlanLines(lines []string) *XPlan {
	x := &XPlan{byID: map[int]int{}}
	for _, l := range lines {
		if m := reHashLine.FindStringSubmatch(l); m != nil {
			if h, err := strconv.ParseUint(m[1], 10, 64); err == nil {
				x.PlanHash, x.HasHash = h, true
			}
			break
		}
	}
	for _, l := range lines {
		if m := reSQLIDLine.FindStringSubmatch(l); m != nil {
			x.SQLID = m[1]
			break
		}
	}
	x.Rows = parseXPlanTable(lines)
	if len(x.Rows) == 0 {
		return nil
	}
	for i := range x.Rows {
		if _, dup := x.byID[x.Rows[i].ID]; !dup {
			x.byID[x.Rows[i].ID] = i
		}
	}
	for id, p := range parsePredicates(lines) {
		if r := x.Row(id); r != nil {
			r.Access, r.Filter, r.Storage = p[0], p[1], p[2]
		}
	}
	for id, q := range parseQueryBlocks(lines) {
		if r := x.Row(id); r != nil {
			r.QBlock, r.Alias = q[0], q[1]
		}
	}
	x.Notes = parseNotes(lines)
	return x
}

// ---- table ----------------------------------------------------------------

type colKind int

const (
	colOther colKind = iota
	colID
	colOp
	colName
	colRows
	colBytes
	colCost
	colStarts
	colARows
	colATime
	colBuffers
	colReads
	colWrites
	colOMem
	colOneMem
	colUsedMem
)

// headerKind maps a lower-cased, trimmed header cell to a column.
func headerKind(h string) colKind {
	switch h {
	case "id":
		return colID
	case "operation":
		return colOp
	case "name", "object name":
		return colName
	case "rows", "e-rows":
		return colRows
	case "bytes", "e-bytes":
		return colBytes
	case "starts":
		return colStarts
	case "a-rows":
		return colARows
	case "a-time":
		return colATime
	case "buffers":
		return colBuffers
	case "reads":
		return colReads
	case "writes":
		return colWrites
	case "omem", "0mem":
		return colOMem
	case "1mem":
		return colOneMem
	case "used-mem":
		return colUsedMem
	}
	if strings.Contains(h, "cost") {
		return colCost
	}
	return colOther
}

func pipeIndexes(s string) []int {
	var p []int
	for i := 0; i < len(s); i++ {
		if s[i] == '|' {
			p = append(p, i)
		}
	}
	return p
}

// parseXPlanTable reads the first plan table. Columns are located from the
// header line, so tables with or without the ALLSTATS columns, partition
// columns, TQ / IN-OUT / PQ Distrib or O/1/M columns all parse; cells are
// taken between the pipes of the row itself, and from the header's pipe
// positions when a row has a different number of pipes.
func parseXPlanTable(lines []string) []XPlanRow {
	hi := -1
	for i, l := range lines {
		if reHeaderLine.MatchString(l) {
			hi = i
			break
		}
	}
	if hi < 0 {
		return nil
	}
	hp := pipeIndexes(lines[hi])
	kinds := make([]colKind, len(hp)-1)
	for c := 0; c+1 < len(hp); c++ {
		kinds[c] = headerKind(strings.ToLower(strings.TrimSpace(lines[hi][hp[c]+1 : hp[c+1]])))
	}
	var rows []XPlanRow
	for i := hi + 1; i < len(lines); i++ {
		line := lines[i]
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if reRule.MatchString(t) {
			// the closing rule ends the table unless more rows follow it
			more := false
			for j := i + 1; j < len(lines); j++ {
				if strings.HasPrefix(lines[j], "|") && reIDCell.MatchString(lines[j]) {
					more = true
					break
				}
				if reRule.MatchString(strings.TrimSpace(lines[j])) {
					break
				}
			}
			if !more {
				break
			}
			continue
		}
		if !strings.HasPrefix(line, "|") {
			continue
		}
		pp := hp
		if rp := pipeIndexes(line); len(rp) == len(hp) {
			pp = rp
		}
		cell := func(c int) string {
			if c+1 >= len(pp) || pp[c+1] > len(line) {
				if c+1 < len(pp) && pp[c]+1 <= len(line) {
					return line[pp[c]+1:]
				}
				return ""
			}
			return line[pp[c]+1 : pp[c+1]]
		}
		r := XPlanRow{ERows: -1, EBytes: -1, Cost: -1, Starts: -1, ARows: -1, ATimeUs: -1, Buffers: -1, Reads: -1, Writes: -1, OMem: -1, OneMem: -1, UsedMem: -1, UsedPass: -1}
		gotID, gotOp := false, false
		for c, k := range kinds {
			s := cell(c)
			switch k {
			case colID:
				m := reIDCell.FindString(s)
				if m == "" {
					break
				}
				r.ID, _ = strconv.Atoi(m)
				gotID = true
				r.Star = strings.Contains(s, "*")
				r.Inactive = strings.HasPrefix(strings.TrimSpace(s), "-") && !strings.HasPrefix(strings.TrimSpace(s), "->")
			case colOp:
				op := strings.TrimRight(s, " ")
				sp := len(op) - len(strings.TrimLeft(op, " "))
				r.Op = strings.TrimSpace(op)
				r.Depth = sp - 1
				if r.Depth < 0 {
					r.Depth = 0
				}
				gotOp = r.Op != ""
			case colName:
				r.Name = strings.TrimSpace(s)
			case colRows:
				r.ERows = orMissing(parseCount(s))
			case colBytes:
				r.EBytes = orMissing(parseCount(s))
			case colCost:
				r.Cost = orMissing(parseCostCell(s))
			case colStarts:
				r.Starts = orMissing(parseCount(s))
			case colARows:
				r.ARows = orMissing(parseCount(s))
			case colATime:
				r.ATimeUs = orMissing(parseTimeUs(s))
			case colBuffers:
				r.Buffers = orMissing(parseCount(s))
			case colReads:
				r.Reads = orMissing(parseCount(s))
			case colWrites:
				r.Writes = orMissing(parseCount(s))
			case colOMem:
				r.OMem = orMissing(parseByteSize(s))
			case colOneMem:
				r.OneMem = orMissing(parseByteSize(s))
			case colUsedMem:
				r.UsedMem, r.UsedPass = parseUsedMem(s)
			}
		}
		if gotID && gotOp {
			rows = append(rows, r)
		}
	}
	return rows
}

func orMissing(v int64, ok bool) int64 {
	if !ok {
		return -1
	}
	return v
}

// ---- value parsers (port of the visualizer's values.ts) ---------------------

func expandTableTabs(lines []string) []string {
	for i, l := range lines {
		if !strings.HasPrefix(l, "|") || !strings.Contains(l, "\t") {
			continue
		}
		var b strings.Builder
		for _, r := range l {
			if r == '\t' {
				b.WriteString(strings.Repeat(" ", 8-b.Len()%8))
			} else {
				b.WriteRune(r)
			}
		}
		lines[i] = b.String()
	}
	return lines
}

func scaled(num string, suffix byte, base float64) (int64, bool) {
	v, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, false
	}
	if suffix != 0 {
		p := strings.IndexByte("KMGTPE", suffix&^0x20) + 1
		for ; p > 0; p-- {
			v *= base
		}
	}
	return int64(v + 0.5), true
}

var (
	reCount = regexp.MustCompile(`(?i)^([\d.]+)\s*([KMGTPE])?$`)
	reBytes = regexp.MustCompile(`(?i)^([\d.]+)\s*([KMGTPE])?B?$`)
	reCost  = regexp.MustCompile(`(?i)^([\d.]+)\s*([KMGTPE])?`)
	reTime  = regexp.MustCompile(`(\d+):(\d+):(\d+)(?:\.(\d+))?`)
	reUsed  = regexp.MustCompile(`^(\S+?)\s*(?:\((\d+)\))?$`)
)

func suffixOf(m []string, i int) byte {
	if m[i] == "" {
		return 0
	}
	return m[i][0]
}

// parseCount reads a count with 1000-based K/M/G/T suffixes ("100K", "1,234").
func parseCount(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if m := reCount.FindStringSubmatch(s); m != nil {
		return scaled(m[1], suffixOf(m, 2), 1000)
	}
	return 0, false
}

// parseByteSize reads a size with 1024-based suffixes ("2048K", "10M").
func parseByteSize(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if m := reBytes.FindStringSubmatch(s); m != nil {
		return scaled(m[1], suffixOf(m, 2), 1024)
	}
	return 0, false
}

// parseCostCell reads "137   (1)" / "4823K (1)": the cost, without the %CPU.
func parseCostCell(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if m := reCost.FindStringSubmatch(s); m != nil {
		return scaled(m[1], suffixOf(m, 2), 1000)
	}
	return 0, false
}

// parseTimeUs reads A-Time ("00:00:00.06", "01:02:03") as microseconds.
func parseTimeUs(s string) (int64, bool) {
	m := reTime.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	h, _ := strconv.ParseInt(m[1], 10, 64)
	mi, _ := strconv.ParseInt(m[2], 10, 64)
	sec, _ := strconv.ParseInt(m[3], 10, 64)
	us := (h*3600 + mi*60 + sec) * 1_000_000
	if f := m[4]; f != "" {
		v, _ := strconv.ParseFloat("0."+f, 64)
		us += int64(v*1e6 + 0.5)
	}
	return us, true
}

// parseUsedMem reads "1385K (0)": bytes used and the passes in parentheses.
func parseUsedMem(s string) (bytes, passes int64) {
	bytes, passes = -1, -1
	m := reUsed.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return
	}
	b, ok := parseByteSize(m[1])
	if !ok {
		return
	}
	bytes = b
	if m[2] != "" {
		passes, _ = strconv.ParseInt(m[2], 10, 64)
	}
	return
}

// ---- Predicate Information ---------------------------------------------------

type openPred struct {
	id       int
	typ      string
	parts    []string
	depth    int
	inSingle bool
	inDouble bool
}

// feed adds a chunk to an open predicate and reports whether its outer
// parenthesis closed. Parentheses inside quotes are not counted; the quote
// state carries over lines because DBMS_XPLAN wraps predicates anywhere.
func (o *openPred) feed(chunk string) bool {
	for i := 0; i < len(chunk); i++ {
		switch ch := chunk[i]; {
		case o.inSingle:
			if ch == '\'' {
				o.inSingle = false
			}
		case o.inDouble:
			if ch == '"' {
				o.inDouble = false
			}
		case ch == '\'':
			o.inSingle = true
		case ch == '"':
			o.inDouble = true
		case ch == '(':
			o.depth++
		case ch == ')':
			o.depth--
			if o.depth == 0 {
				o.parts = append(o.parts, strings.TrimSpace(chunk[:i]))
				return true
			}
		}
	}
	o.parts = append(o.parts, strings.TrimSpace(chunk))
	return false
}

// parsePredicates reads the Predicate Information block: id -> [access,
// filter, storage] with the outer "access(" ... ")" removed and wrapped
// lines joined by one space. The same kind twice for an id is joined by
// " AND ". An Id-less "filter(" line is a further predicate of the id above.
func parsePredicates(lines []string) map[int][3]string {
	out := map[int][3]string{}
	start := -1
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "Predicate Information") {
			start = i
			break
		}
	}
	if start < 0 {
		return out
	}
	slot := map[string]int{"access": 0, "filter": 1, "storage": 2}
	store := func(o *openPred) {
		var keep []string
		for _, p := range o.parts {
			if p != "" {
				keep = append(keep, p)
			}
		}
		text := strings.Join(keep, " ")
		if text == "" {
			return
		}
		e := out[o.id]
		k := slot[o.typ]
		if e[k] != "" {
			e[k] += " AND " + text
		} else {
			e[k] = text
		}
		out[o.id] = e
	}
	var open *openPred
	cur, haveCur := 0, false
	begin := func(id int, typ, rest string) {
		cur, haveCur = id, true
		open = &openPred{id: id, typ: typ, depth: 1}
		if open.feed(rest) {
			store(open)
			open = nil
		}
	}
	for _, line := range lines[start+1:] {
		t := strings.TrimSpace(line)
		if open == nil && (t == "" || reRule.MatchString(t)) {
			continue
		}
		if reSection.MatchString(line) || (reColonHead.MatchString(t) && !reIDDash.MatchString(t)) {
			break
		}
		if open != nil {
			if t == "" {
				continue
			}
			if open.feed(t) {
				store(open)
				open = nil
			}
			continue
		}
		if m := rePredStart.FindStringSubmatch(line); m != nil {
			id, _ := strconv.Atoi(m[1])
			begin(id, strings.ToLower(m[2]), line[len(m[0]):])
			continue
		}
		if m := rePredIdless.FindStringSubmatch(line); m != nil && haveCur {
			begin(cur, strings.ToLower(m[1]), line[len(m[0]):])
		}
	}
	if open != nil {
		store(open)
	}
	return out
}

// ---- Query Block Name / Object Alias, Note ---------------------------------

// parseQueryBlocks reads "   2 - SEL$1 / O@SEL$1" lines: id -> [qblock, alias],
// quotes stripped.
func parseQueryBlocks(lines []string) map[int][2]string {
	out := map[int][2]string{}
	start := -1
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "Query Block Name") && strings.Contains(l, "Object Alias") {
			start = i
			break
		}
	}
	if start < 0 {
		return out
	}
	seen := false
	for _, line := range lines[start+1:] {
		t := strings.TrimSpace(line)
		if t == "" || reRule.MatchString(t) {
			if seen && t == "" {
				break
			}
			continue
		}
		m := reQBLine.FindStringSubmatch(line)
		if m == nil {
			break
		}
		seen = true
		id, _ := strconv.Atoi(m[1])
		out[id] = [2]string{strings.ReplaceAll(m[2], `"`, ""), strings.ReplaceAll(m[3], `"`, "")}
	}
	return out
}

// parseNotes reads the "Note" section ("   - dynamic statistics used: ...").
func parseNotes(lines []string) []string {
	at := -1
	for i, l := range lines {
		if strings.EqualFold(strings.TrimSpace(l), "Note") {
			at = i
			break
		}
	}
	if at < 0 {
		return nil
	}
	i := at + 1
	for i < len(lines) && strings.TrimSpace(lines[i]) != "" && strings.Trim(strings.TrimSpace(lines[i]), "-") == "" {
		i++
	}
	var notes []string
	for ; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(t, "- ") {
			break
		}
		notes = append(notes, strings.TrimSpace(t[2:]))
	}
	return notes
}
