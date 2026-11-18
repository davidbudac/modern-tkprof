package trace

import "bytes"

// Diagnostic dump sections in a trace file.
//
// Besides event 10046 records and 10053 dumps, Oracle writes diagnostic dumps
// to a trace file: heap dumps, PGA memory dumps, the diagnostic dump of an
// errorstack, process state, system state, hang analysis, deadlock graphs and
// the table of contents of an incident file (docs/trace-format-diag.md, read
// off lab traces). The parser does not read them; like the optimizer dumps it
// recognises where one starts and ends so that its lines are not taken for
// unknown ones: they are counted as KindDiag, and the sections are reported
// through Stats.Sections. 10046 and 10053 are the primary formats and a
// section never costs them anything: the tracker only looks at lines no
// record matched (and at every line while a section is open), and a line of
// either primary format ends a section.
//
// Precedence, as for the optimizer dumps: the text of a cursor, of a PARSE
// ERROR and a BINDS block (the parser's own states) first, then an optimizer
// dump, then a section. So a start line inside statement text, inside a
// dump, or in the adaptive-plan chatter after one is not a section start;
// and a section is ended by anything a primary format owns:
//
//   - a valid 10046 record (the kinds isRecordKind accepts) or the exact
//     21-"=" separator 10046 writes before a cursor;
//   - the first line of an optimizer dump, or a line the optimizer tracker
//     claims (its runtime "AP: ..." lines);
//   - a "*** ... TRACE CONTINUES IN FILE" marker, or the end of the file.
//
// No fixture has any of these inside a dump. If one does, the section ends
// just before it and the line keeps its kind (a record), whatever the kind of
// section: a cut one (Section.Cut) when the kind has an end line it had not
// reached. "*** " markers and blank lines inside a section keep their kinds
// and do not end it. Every other line of a section is KindDiag (the "="
// rules of a dump, which the stateless classifier takes for separators,
// likewise; the lines of a heap dump's chunks, which it takes for nothing).
//
// Starts (IsSectionStart), each verified on the 19c lab fixtures:
//
//	heap         HEAP DUMP heap name="..."  desc=0x...
//	pga-summary  TOP 10 MEMORY USES FOR THIS PROCESS
//	pga-detail   Begin PGA memory detail dump
//	diagdump     dbkedDefDump(): Starting ...   (errorstack, deadlock, incident)
//	procstate    PROCESS STATE
//	sysstate     SYSTEM STATE (level=N[, with short stacks])
//	hang         HANG ANALYSIS:
//	deadlock     DEADLOCK DETECTED ( ORA-00060 )   (10.2: without the code)
//	incident     [TOC00000]   (the first marker of an incident file's contents)
//
// A section, once open, absorbs every other start: the heap dumps, the
// process state and the cursor dumps inside an errorstack are parts of that
// one section; reading the inside is another package's job. The exception is
// the heap dump, which is the one kind of section that comes in runs (see
// below) and so is split at each of its starts.
//
// Ends. A kind without an end line (diagdump, pga-summary, deadlock,
// incident) runs to the first line a primary format owns, as above, or to the
// end of the file; its Last is the last line it holds (the lines after it that
// are markers or blank lines are not part of it), and it is never Cut. The
// kinds with an end line:
//
//	procstate    END OF PROCESS STATE (a process state dump of its own ends
//	             with it, as the one inside an errorstack does)
//	sysstate     END OF SYSTEM STATE
//	pga-detail   End PGA memory detail dump and the "=" rule that follows it
//	hang         END OF HANG ANALYSIS and its rule, and, when a "HANG ANALYSIS
//	             DUMPS:" block follows (after blank lines, markers and rules),
//	             the block's "HANG ANALYSIS DUMPS: END" and its rule
//	heap         the line of 54 "*" that ends it, see below
//
// A heap dump ends at the first line of 54 "*" after its start. A heap run
// (the dump of a level with sub-heaps writes a heap, then its sub-heaps, each
// with its own start and end, and `heapdump` writes several) goes on after
// that rule: while only the lines that glue heaps together follow (more rules,
// "SUBHEAP n: desc=..." and "No stack allocations", with blank lines and
// markers between) they belong to the heap before, and the next HEAP DUMP
// starts the next section. So the heaps of a run are adjacent sections, one
// per HEAP DUMP line (the sub-heaps are sections of their own, not inside
// their parent), and a run ends at the last glue line. The line of 54 "*" right
// above a start belongs to the heap it leads: it is the first line of that
// section (so a section's First is its start line or that rule). A heap
// whose body reaches the end of the file without a rule is Cut.
//
// The rule lines around the other kinds are "=" lines. They are separators
// for the stateless classifier and for the parser before this file, and stay
// KindSeparator when they stand outside a section (only the ones at the end
// of a section, which the tracker looks for, belong to it): holding every
// separator of a 10046 trace back by a line to see whether a start follows
// would cost the primary formats more than the one line is worth.

// SectionKind says what a section is.
type SectionKind uint8

const (
	SectionNone SectionKind = iota
	SectionHeap
	SectionPGASummary
	SectionPGADetail
	SectionDiagDump
	SectionProcState
	SectionSysState
	SectionHang
	SectionDeadlock
	SectionIncident
	sectionKindCount
)

var sectionKindNames = [...]string{
	SectionNone:       "none",
	SectionHeap:       "heap",
	SectionPGASummary: "pga-summary",
	SectionPGADetail:  "pga-detail",
	SectionDiagDump:   "diagdump",
	SectionProcState:  "procstate",
	SectionSysState:   "sysstate",
	SectionHang:       "hang",
	SectionDeadlock:   "deadlock",
	SectionIncident:   "incident",
}

func (k SectionKind) String() string {
	if int(k) < len(sectionKindNames) {
		return sectionKindNames[k]
	}
	return "section?"
}

// SectionKinds are the kinds of section in the order of their numbers.
func SectionKinds() []SectionKind {
	out := make([]SectionKind, 0, sectionKindCount-1)
	for k := SectionNone + 1; k < sectionKindCount; k++ {
		out = append(out, k)
	}
	return out
}

// ParseSectionKind is the SectionKind with that String(); SectionNone for another name.
func ParseSectionKind(s string) SectionKind {
	for k := SectionNone + 1; k < sectionKindCount; k++ {
		if sectionKindNames[k] == s {
			return k
		}
	}
	return SectionNone
}

// hasEnd: the kinds whose dump prints an end line (a section that stops
// before it is Cut).
func (k SectionKind) hasEnd() bool {
	switch k {
	case SectionHeap, SectionPGADetail, SectionSysState, SectionHang, SectionProcState:
		return true
	}
	return false
}

// Section is one diagnostic dump found in a file (see section.go).
type Section struct {
	Kind SectionKind
	// First is the line of the start line (of a heap dump: of the line of "*"
	// right above it, when there is one), Last the last line the section
	// holds: its end line, or the last line before whatever ended it.
	First, Last int
	// Cut: a kind with an end line stopped without reaching it (the file ends,
	// "TRACE CONTINUES IN FILE", or a line of a primary format came first).
	Cut bool
}

// Lines is the number of lines First..Last.
func (s Section) Lines() int { return s.Last - s.First + 1 }

// IsSectionStart reports whether line starts a section, and which kind. It is
// the rule the tracker, the sniffer and the stateless callers share; the tracker
// only asks it for a line outside a section.
func IsSectionStart(line []byte) (SectionKind, bool) {
	if len(line) < 10 {
		return SectionNone, false
	}
	switch line[0] {
	case 'H':
		switch {
		case hasPrefix(line, `HEAP DUMP heap name="`):
			return SectionHeap, true
		case exactLine(line, "HANG ANALYSIS:"):
			return SectionHang, true
		}
	case 'P':
		if exactLine(line, "PROCESS STATE") {
			return SectionProcState, true
		}
	case 'S':
		if hasPrefix(line, "SYSTEM STATE (level=") {
			return SectionSysState, true
		}
	case 'D':
		if exactLine(line, "DEADLOCK DETECTED") || hasPrefix(line, "DEADLOCK DETECTED ( ORA-") {
			return SectionDeadlock, true
		}
	case 'T':
		if exactLine(line, "TOP 10 MEMORY USES FOR THIS PROCESS") {
			return SectionPGASummary, true
		}
	case 'B':
		if exactLine(line, "Begin PGA memory detail dump") {
			return SectionPGADetail, true
		}
	case 'd':
		if hasPrefix(line, "dbkedDefDump(): Starting ") {
			return SectionDiagDump, true
		}
	case '[':
		if exactLine(line, "[TOC00000]") {
			return SectionIncident, true
		}
	}
	return SectionNone, false
}

// exactLine: line is s, with at most trailing blanks.
func exactLine(line []byte, s string) bool {
	if !hasPrefix(line, s) {
		return false
	}
	for _, c := range line[len(s):] {
		if c != ' ' && c != '\r' {
			return false
		}
	}
	return true
}

// isStarRule: the 54 "*" that frame a heap dump.
func isStarRule(line []byte) bool {
	if len(line) != 54 || line[0] != '*' {
		return false
	}
	for _, c := range line {
		if c != '*' {
			return false
		}
	}
	return true
}

// isEqRule: a rule of "=" (five or more, nothing else).
func isEqRule(line []byte) bool {
	if len(line) < 5 || line[0] != '=' {
		return false
	}
	for _, c := range line {
		if c != '=' {
			return false
		}
	}
	return true
}

var starRule = bytes.Repeat([]byte{'*'}, 54)

type secState uint8

const (
	secOut     secState = iota // outside any section
	secHeld                    // outside; a line of 54 "*" waits to see whether a heap dump starts below it
	secBody                    // inside a section, before its end line (all of a kind that has none)
	secTail                    // heap: after its rule; hang: after END OF HANG ANALYSIS (see section.go)
	secClosing                 // after the final end line: only its closing rule may follow
)

// secAct is what the tracker says about a line.
type secAct uint8

const (
	secPass secAct = iota // not a section line (it keeps the kind recordKind gave it)
	secDiag               // a line of a section: KindDiag
	secWait               // a line of 54 "*" held back: counted when the next line tells
)

// what the parser does with the held line when the tracker has decided
const (
	relNone  uint8 = iota
	relDiag        // it leads the heap dump that starts on the line being decided
	relStray       // it is a stray rule: the line the parser would have counted before
)

// sectionTracker follows the section state of a stream of lines. The parser
// calls line for lines no cursor text, PARSE ERROR text or BINDS block took,
// when the line matched no record or the tracker is inside a section (a trace
// without sections pays one comparison per unknown line).
type sectionTracker struct {
	st   secState
	kind SectionKind
	cur  Section // the section in progress; Last is the last line it holds
	seen bool    // a section was found in this file

	held       int  // secHeld: the line of the rule
	dumps      bool // hang: inside the HANG ANALYSIS DUMPS block
	ruleAt     int  // heap tail: the last rule claimed ...
	beforeRule int  // ... and Last as it was before

	rel     uint8 // set by line when it settles a held line
	relLine int

	out *[]Section
}

// line decides about one line the stateless recordKind classified as r; n is
// its 1-based line number. The parser calls it after the optimizer tracker
// declined the line.
func (t *sectionTracker) line(n int, line []byte, r rec) secAct {
	t.rel = relNone
	if t.st == secHeld {
		h := t.held
		t.st, t.held = secOut, 0
		if r.kind == KindUnknown {
			if k, ok := IsSectionStart(line); ok && k == SectionHeap {
				t.begin(SectionHeap, h)
				t.cur.Last = n
				t.rel, t.relLine = relDiag, h
				return secDiag
			}
		}
		t.rel, t.relLine = relStray, h
	}
	if t.st == secOut {
		return t.outside(n, line, r)
	}
	switch {
	case isRecordKind(r.kind), r.kind == KindSeparator && isSeparator21(line):
		t.stop()
		return secPass
	case r.kind == KindMarker:
		if bytes.Contains(line[r.n:], []byte(continuesIn)) || t.st == secClosing {
			t.stop()
		}
		return secPass
	case r.kind == KindBlank:
		if t.st == secClosing {
			t.stop()
		}
		return secPass
	}
	// an unknown line, or a "=" line that is not the 10046 separator
	switch t.st {
	case secBody:
		return t.body(n, line)
	case secTail:
		return t.tail(n, line, r)
	}
	// secClosing: the closing rule of the end line, or the section is over
	if isEqRule(line) {
		t.cur.Last = n
		t.finish(false)
		return secDiag
	}
	t.stop()
	return t.outside(n, line, r)
}

// outside looks at a line outside any section.
func (t *sectionTracker) outside(n int, line []byte, r rec) secAct {
	if r.kind != KindUnknown {
		return secPass
	}
	if k, ok := IsSectionStart(line); ok {
		t.begin(k, n)
		return secDiag
	}
	if isStarRule(line) {
		t.st, t.held = secHeld, n
		return secWait
	}
	return secPass
}

func (t *sectionTracker) begin(k SectionKind, first int) {
	t.st, t.kind, t.seen = secBody, k, true
	t.cur = Section{Kind: k, First: first, Last: first}
	t.dumps = false
	t.ruleAt = 0
}

// body is a line inside a section before its end line.
func (t *sectionTracker) body(n int, line []byte) secAct {
	prev := t.cur.Last
	t.cur.Last = n
	switch t.kind {
	case SectionHeap:
		if isStarRule(line) {
			t.st = secTail
			t.beforeRule, t.ruleAt = prev, n
		}
	case SectionSysState:
		if exactLine(line, "END OF SYSTEM STATE") {
			t.finish(false)
		}
	case SectionProcState:
		if exactLine(line, "END OF PROCESS STATE") {
			t.finish(false)
		}
	case SectionPGADetail:
		if exactLine(line, "End PGA memory detail dump") {
			t.st = secClosing
		}
	case SectionHang:
		switch {
		case !t.dumps && exactLine(line, "END OF HANG ANALYSIS"):
			t.st = secTail
		case t.dumps && exactLine(line, "HANG ANALYSIS DUMPS: END"):
			t.st = secClosing
		}
	}
	return secDiag
}

// tail is a line after the end of a heap (its rule) or of a hang analysis's
// first part; what is not one of the lines that can follow ends the section.
func (t *sectionTracker) tail(n int, line []byte, r rec) secAct {
	switch t.kind {
	case SectionHeap:
		switch {
		case isStarRule(line):
			t.beforeRule, t.ruleAt = t.cur.Last, n
			t.cur.Last = n
			return secDiag
		case hasPrefix(line, "SUBHEAP ") && len(line) > 8 && isDigit(line[8]), hasPrefix(line, "No stack allocations"):
			t.cur.Last = n
			return secDiag
		}
		if k, ok := IsSectionStart(line); ok && k == SectionHeap {
			first := n
			if t.ruleAt == n-1 && t.beforeRule >= t.cur.First { // the rule right above leads this heap
				t.cur.Last = t.beforeRule
				first = n - 1
			}
			t.finish(false)
			t.begin(SectionHeap, first)
			t.cur.Last = n
			return secDiag
		}
	case SectionHang:
		switch {
		case isEqRule(line):
			t.cur.Last = n
			return secDiag
		case exactLine(line, "HANG ANALYSIS DUMPS:"):
			t.cur.Last = n
			t.st, t.dumps = secBody, true
			return secDiag
		}
	}
	t.stop()
	return t.outside(n, line, r)
}

// stop ends the section in progress at its last line: cut when its kind has
// an end line it did not reach.
func (t *sectionTracker) stop() {
	t.finish(t.st == secBody && t.cur.Kind.hasEnd())
}

func (t *sectionTracker) finish(cut bool) {
	t.cur.Cut = cut
	*t.out = append(*t.out, t.cur)
	t.st = secOut
}

// open returns the section in progress as the end of the input would leave
// it (a snapshot of a growing file).
func (t *sectionTracker) open() (Section, bool) {
	if t.st == secOut || t.st == secHeld {
		return Section{}, false
	}
	s := t.cur
	s.Cut = t.st == secBody && s.Kind.hasEnd()
	return s, true
}

// endOfInput ends the input: a section in progress stops (a held rule is the
// stray line it was; the parser settles that).
func (t *sectionTracker) endOfInput() {
	if t.st != secOut && t.st != secHeld {
		t.stop()
	}
}

// MarkSections gives the lines of a page that lie in a section the kind the
// parser counts them as (KindDiag), the way MarkOpt does for the optimizer
// dumps. kinds are what Classify or a Classifier said of lines (the first of
// which is line number lo of the file), sections the file's sections in file
// order (Stats.Sections, FileEntry.Sections). Inside a section the lines the
// stateless classifier did not recognise, its bind lines and its "=" rules
// become diagnostic lines; "*** " markers, blank lines, and lines of a
// primary format (records, the 21-"=" separator) keep their kind. The parser
// decides all this with a state kept from the start of the file; the sections
// carry what a page that starts anywhere needs.
func MarkSections(kinds []Kind, lines [][]byte, lo int, sections []Section) {
	if len(sections) == 0 || len(kinds) == 0 {
		return
	}
	si := 0 // the first section that has not ended before the line
	for i := range kinds {
		n := lo + i
		for si < len(sections) && sections[si].Last < n {
			si++
		}
		if si == len(sections) {
			return
		}
		if sections[si].First > n {
			continue
		}
		switch k := kinds[i]; {
		case isRecordKind(k), k == KindBlank, k == KindMarker, k == KindDiag:
		case k == KindSeparator && isSeparator21(lines[i]):
		default:
			kinds[i] = KindDiag
		}
	}
}
