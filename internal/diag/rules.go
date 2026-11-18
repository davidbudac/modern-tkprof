package diag

import (
	"bytes"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The rules of the outline: what makes a line (or a few lines) the start of a part of a dump.
//
// A "head" is such a start. The children of a node are the heads found in its lines; a head's part runs
// to the line before the next head of the same or a lower rank (rank 0 is the outermost), or to its own
// end line where the kind has one. Rank is the one number that makes parts nest: a title (1) ends the
// part of the title before it, a frame (2) nests in the title above it, a state object nests by its
// indentation. Which rules apply to a node depends on its kind (profileOf): the lines of a heap dump
// are not tested for state objects, an incident file has nothing but its [TOC] markers.
//
// Every rule below names the fixture line that shows it (testdata/diag/19c, testdata/traces/19c and, for
// the lines marked big, testdata/big/diag, which is not in git).
//
//	rule             what it matches                                          fixture
//	title            ----- Title -----  (3 or more dashes each side)          diag_errorstack_l2:33
//	                 --------- Binary Stack Dump ---------                    diag_errorstack_l2:188
//	                 ----- Process State Dump (2)-----                        diag_errorstack_l2:5045
//	                 not a rule of dashes, not a table's column underline     diag_errorstack_l2:53, :7374
//	title (nested)   a few titles that sit under another title: the cursor    diag_errorstack_l2:7604 (Session Open
//	                 dumps, rank by subTitleRank                              Cursors), :7609 (Dump Cursor), :7654
//	                                                                          (Bind Byte Code), :7662 (Bind Info)
//	banner           rule, title, rule or underline: ===, TITLE, ---          diag_errorstack_l2:7342-7344 (CURRENT
//	                 a banner whose top rule is "=" is a part of its own       SESSION'S INSTANTIATION STATE)
//	                 (rank 1); one framed by dashes only sits inside the      diag_sysstate_l1:2481-2483 (Sampled
//	                 part it is in (a leaf, rank leafRank)                    Session History of session 1 ...)
//	                 a title over an underline of about its length            diag_procstate:35-36 (PROCESS STATE)
//	nested heap      HEAP DUMP heap name="..." inside a PGA summary: the heap   diag_pga_summary:90 (a sampled heap, in
//	                 dump of a heap with much free memory, a part of the       the part PRIVATE MEMORY SUMMARY), rank
//	                 banner it stands in (rank rankTitle+1), with its end line rankTitle+1
//	nested section   a section start inside another section's lines           diag_errorstack_l2:5046 (PROCESS STATE in
//	                 (trace.IsSectionStart), rank 0, with its end line        a diagnostic dump), diag_deadlock:86
//	                 where the kind has one                                   (dbkedDefDump inside a deadlock)
//	frame            ========== FRAME [n] (caller()+off -> callee()) ====     diag_errorstack_l2:190
//	process          PROCESS <n>: <name> in a system state                    diag_sysstate_l1:2294
//	state object     SO: 0x..., type: name (n), nested by indentation         diag_procstate:39 (indent 2), :107 (4),
//	                                                                          :334 (6), :754 (8)
//	chain            Chain N:  in a hang analysis                             diag_hang:65, :192
//	hang labels      the lines that name the parts of a hang analysis         diag_hang:55 (Chains most likely ...), :61
//	                                                                          (Non-intersecting chains), :245 (State of
//	                                                                          ALL nodes), :259 (HANG ANALYSIS DUMPS)
//	summary          Dumping the Process Summary  in a system state           diag_sysstate_l1:42
//	toc              [TOCnnnnn] on a line of its own or at the end of a line   big/diag_oom_incident:35, :79806
//	                 up to [TOCnnnnn-END]; the title is the table of          (NamespaceDump:  [TOC00026]); the table
//	                 contents at the end of the file, else the line after     big/diag_oom_incident:114950-115159
//	extent           EXTENT n addr=0x...                                      diag_heap_pga:10
//	free lists       FREE LISTS:   and its  Bucket n size=...  lines          diag_heap_pga:(the line after the extents)
//	unpinned         UNPINNED RECREATABLE CHUNKS (lru first):
//	permanent        PERMANENT CHUNKS:
//	sub-heaps        N LARGEST SUB HEAPS for heap name="..."                  diag_heap_sub:922
//
// Each rank is relative: only the order of the numbers among the heads of one node matters.

// The ranks: a nested section without an end line (a diagnostic dump inside a deadlock) is the outermost,
// one with an end line (a process state inside a diagnostic dump) comes next and holds whatever follows
// until its end line, whatever its rank; titles and the like start at rankTitle.
const (
	rankNestedPlain = 0
	rankNested      = 1
	rankTitle       = 2
)

// leafRank is the rank of a head that holds no other head: any other head ends it, and it ends only
// another leaf, so it nests in whatever is open.
const leafRank = 1000

// profile says which rules apply to the lines of a node. A node's profile is that of the scan that found it
// plus its own kind's (ownProfile): inside a process state that sits in a diagnostic dump the rules of both
// apply, so what a scan finds in a node is what the scan of the node finds.
type profile uint16

const (
	pTitle profile = 1 << iota
	pFrame
	pBanner
	pNested
	pProcess
	pSO
	pChain
	pTOC
	pHeap
	pSummary
	pHeapNest // a heap dump nested in the part (a sampled heap of a PGA summary), and nothing else that starts a section
)

// ownProfile is the set of rules a node of this kind brings for its own lines. The kinds that are parts of
// a dump (title, banner, frame, ...) bring none: their lines are read with the rules of the scan they
// were found in.
func ownProfile(kind string) profile {
	switch kind {
	case "heap", "extents", "extent", "freelists", "bucket", "unpinned", "permanent", "subheaps":
		return pHeap
	case "incident", "toc":
		return pTOC
	case "hang", "chain":
		return pChain
	case "sysstate":
		return pProcess | pSO | pBanner | pTitle | pSummary
	case "procstate", "process", "so":
		return pSO | pBanner | pTitle
	case "pga-summary":
		return pBanner | pTitle | pHeapNest
	case "diagdump", "deadlock":
		return pTitle | pFrame | pBanner | pNested
	}
	return 0
}

// rule lines

// ruleLine: a line of five or more "=" (ch '=') or "-" (ch '-'), blanks after them allowed.
func ruleLine(b []byte) (ch byte, ok bool) {
	b = bytes.TrimRight(b, " \t\r")
	if len(b) < 5 || (b[0] != '=' && b[0] != '-') {
		return 0, false
	}
	c := b[0]
	for _, x := range b {
		if x != c {
			return 0, false
		}
	}
	return c, true
}

// dashTitle: "----- Title -----": a run of 3 or more dashes, the title, a run of 3 or more dashes.
func dashTitle(b []byte) (string, bool) {
	b = bytes.TrimRight(b, " \t\r")
	lead := 0
	for lead < len(b) && b[lead] == '-' {
		lead++
	}
	if lead < 3 || lead >= len(b) {
		return "", false
	}
	trail := 0
	for trail < len(b)-lead && b[len(b)-1-trail] == '-' {
		trail++
	}
	if trail < 3 {
		return "", false
	}
	mid := bytes.TrimSpace(b[lead : len(b)-trail])
	if !hasAlnum(mid) {
		return "", false
	}
	return string(mid), true
}

func hasAlnum(b []byte) bool {
	for _, c := range b {
		if c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' {
			return true
		}
	}
	return false
}

// subTitleRank: the rank of titles that sit under another title (see the table above); rankTitle for the rest.
func subTitleRank(title string) int {
	switch {
	case strings.HasPrefix(title, "Dump Cursor "):
		return rankTitle + 2
	case strings.HasPrefix(title, "Bind Byte Code"), strings.HasPrefix(title, "Bind Info"):
		return rankTitle + 3
	case title == "Session Open Cursors", title == "Generic Session Cached Cursor Dump", title == "RDBMS Session Cached Cursor Dump":
		return rankTitle + 1
	case title == "Generic Session Cached Cursors Dump", strings.HasPrefix(title, "Finished Dumping Generic Session Cached"):
		return rankTitle + 2
	}
	return rankTitle
}

// bannerTitleOK: a line that can be the title of a banner: some text, not a rule, not too long.
func bannerTitleOK(b []byte) (string, bool) {
	t := bytes.TrimSpace(b)
	if len(t) < 3 || len(t) > 120 || !hasAlnum(t) {
		return "", false
	}
	if _, rule := ruleLine(t); rule {
		return "", false
	}
	if t[0] == '-' || t[0] == '=' || bytes.HasPrefix(t, []byte("*** ")) { // not a rule, not a timestamp marker
		return "", false
	}
	return string(t), true
}

// underlineOK: next is a rule of dashes about as long as the title (within 3, as internal/opt's banners).
func underlineOK(title string, next []byte) bool {
	ch, ok := ruleLine(next)
	if !ok || ch != '-' {
		return false
	}
	d := len(bytes.TrimRight(next, " \t\r")) - len(title)
	return d >= -3 && d <= 3
}

// head is a start the rules found.
type head struct {
	kind  string
	title string
	sub   string
	from  int // first line (the top rule of a banner)
	hl    int // lines the heading itself takes
	rank  int
	n     int
	name  string
	depth *int
	size  int64
	end   endRule // where the part ends by itself, when it does
	to    int     // set when the part was closed by its end line
	nkid  int     // heads added directly under this one
	cut   bool    // a part with an end line of its own that was closed without reaching it
	facts int     // lines after the start still looked at for the facts of the title
	toc   bool
	// a nested section: its kind and what its title is made of
	sk trace.SectionKind
	sf *sectionFacts
}

// endRule: how a nested section ends on its own.
type endRule uint8

const (
	endNone endRule = iota
	endProcState
	endSysState
	endHang
	endHeap
	endPGADetail
)

func endOf(k trace.SectionKind) endRule {
	switch k {
	case trace.SectionProcState:
		return endProcState
	case trace.SectionSysState:
		return endSysState
	case trace.SectionHang:
		return endHang
	case trace.SectionHeap:
		return endHeap
	case trace.SectionPGADetail:
		return endPGADetail
	}
	return endNone
}

// matchesEnd: line ends a part with this end rule; withRule: the line after it (a rule) is part of it too.
func (e endRule) matchesEnd(line []byte, n, from int) (hit, withRule bool) {
	switch e {
	case endProcState:
		return exact(line, "END OF PROCESS STATE"), false
	case endSysState:
		return exact(line, "END OF SYSTEM STATE"), false
	case endHang:
		return exact(line, "END OF HANG ANALYSIS"), true
	case endHeap:
		return n > from+1 && len(line) == 54 && line[0] == '*' && bytes.Count(line, []byte{'*'}) == 54, false
	case endPGADetail:
		return exact(line, "End PGA memory detail dump"), true
	}
	return false, false
}

func exact(line []byte, s string) bool {
	if len(line) < len(s) || string(line[:len(s)]) != s {
		return false
	}
	for _, c := range line[len(s):] {
		if c != ' ' && c != '\r' {
			return false
		}
	}
	return true
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.TrimRight(s[:n], " ") + "..."
}

// sectionTitle is the title of a section of kind k from its start line, and what a later look at the
// lines after it (facts) adds.
type sectionFacts struct {
	name     string // heap name
	depth    *int
	size     int64
	level    string // diagnostic dump level; system state: the parenthetical
	pid      string // PGA detail
	incID    string
	problem  string
	incident bool   // diagdump: "Starting incident default dumps"
	orano    string // deadlock: ORA-00060
}

// startFacts reads what the start line itself says.
func startFacts(k trace.SectionKind, line []byte) sectionFacts {
	var f sectionFacts
	s := string(line)
	switch k {
	case trace.SectionHeap:
		// HEAP DUMP heap name="pga heap"  desc=0x7f952ce9a220
		if i := strings.Index(s, `name="`); i >= 0 {
			rest := s[i+6:]
			if j := strings.IndexByte(rest, '"'); j >= 0 {
				f.name = strings.TrimSpace(rest[:j])
			}
		}
	case trace.SectionDiagDump:
		// dbkedDefDump(): Starting a non-incident diagnostic dump (flags=0x0, level=2, mask=0x0)
		if i := strings.Index(s, "level="); i >= 0 {
			rest := s[i+6:]
			j := 0
			for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
				j++
			}
			f.level = rest[:j]
		}
		f.incident = strings.Contains(s, "Starting incident")
	case trace.SectionSysState:
		// SYSTEM STATE (level=10, with short stacks)
		if i := strings.IndexByte(s, '('); i >= 0 {
			if j := strings.LastIndexByte(s, ')'); j > i {
				f.level = s[i : j+1]
			}
		}
	case trace.SectionDeadlock:
		// DEADLOCK DETECTED ( ORA-00060 )
		if i := strings.Index(s, "ORA-"); i >= 0 {
			j := i + 4
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			f.orano = s[i:j]
		}
	}
	return f
}

// absorb reads a line after the start line for the facts the start line does not give; it reports
// whether it found something.
func (f *sectionFacts) absorb(k trace.SectionKind, line []byte) {
	switch k {
	case trace.SectionHeap:
		// " dsx heap size=4707160, dsx heap depth=0"
		if i := bytes.Index(line, []byte("dsx heap size=")); i >= 0 {
			rest := line[i+len("dsx heap size="):]
			j := 0
			for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
				j++
			}
			if v, err := strconv.ParseInt(string(rest[:j]), 10, 64); err == nil {
				f.size = v
			}
			if i := bytes.Index(rest, []byte("dsx heap depth=")); i >= 0 {
				d := rest[i+len("dsx heap depth="):]
				j := 0
				for j < len(d) && d[j] >= '0' && d[j] <= '9' {
					j++
				}
				if v, err := strconv.Atoi(string(d[:j])); err == nil {
					f.depth = &v
				}
			}
		}
	case trace.SectionPGADetail:
		// "PGA memory detail for pid 6, OS pid 13806"
		const p = "PGA memory detail for pid "
		if bytes.HasPrefix(line, []byte(p)) {
			rest := line[len(p):]
			j := 0
			for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
				j++
			}
			f.pid = string(rest[:j])
		}
	case trace.SectionIncident:
		// "========= Dump for incident 199651 (ORA 6544 [pevm_peruws_callback-1]) ========"
		const p = "Dump for incident "
		if i := bytes.Index(line, []byte(p)); i >= 0 && bytes.HasPrefix(line, []byte("====")) && f.incID == "" {
			rest := string(line[i+len(p):])
			j := 0
			for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
				j++
			}
			f.incID = rest[:j]
			rest = strings.TrimSpace(rest[j:])
			rest = strings.TrimRight(rest, "= \t\r")
			rest = strings.TrimSpace(rest)
			if strings.HasPrefix(rest, "(") && strings.HasSuffix(rest, ")") {
				rest = rest[1 : len(rest)-1]
			}
			f.problem = rest
		}
	}
}

// title is the node title of a section of kind k.
func (f *sectionFacts) title(k trace.SectionKind) string {
	switch k {
	case trace.SectionHeap:
		if f.name != "" {
			return "Heap dump: " + f.name
		}
		return "Heap dump"
	case trace.SectionPGASummary:
		return "PGA memory summary"
	case trace.SectionPGADetail:
		if f.pid != "" {
			return "PGA memory detail (pid " + f.pid + ")"
		}
		return "PGA memory detail"
	case trace.SectionDiagDump:
		if f.level != "" {
			return "Diagnostic dump (level " + f.level + ")"
		}
		return "Diagnostic dump"
	case trace.SectionProcState:
		return "Process state"
	case trace.SectionSysState:
		if f.level != "" {
			return "System state " + f.level
		}
		return "System state"
	case trace.SectionHang:
		return "Hang analysis"
	case trace.SectionDeadlock:
		if f.orano != "" {
			return "Deadlock (" + f.orano + ")"
		}
		return "Deadlock"
	case trace.SectionIncident:
		if f.incID != "" {
			t := "Incident " + f.incID
			if f.problem != "" {
				t += " (" + f.problem + ")"
			}
			return t
		}
		return "Incident dump"
	}
	return k.String()
}

// sub is the second line of the node of a section.
func (f *sectionFacts) sub(k trace.SectionKind) string {
	switch k {
	case trace.SectionHeap:
		if f.size > 0 || f.depth != nil {
			var parts []string
			if f.size > 0 {
				parts = append(parts, humanBytes(f.size))
			}
			if f.depth != nil {
				parts = append(parts, "depth "+strconv.Itoa(*f.depth))
			}
			return strings.Join(parts, ", ")
		}
	case trace.SectionDiagDump:
		if f.incident {
			return "incident default dumps"
		}
	}
	return ""
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return strconv.FormatFloat(float64(n)/(1<<30), 'f', 1, 64) + " GB"
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	case n >= 1<<10:
		return strconv.FormatFloat(float64(n)/(1<<10), 'f', 1, 64) + " KB"
	}
	return strconv.FormatInt(n, 10) + " bytes"
}

// sectionFactsLines is how many lines after a start the facts are looked for (a heap header has about ten).
const sectionFactsLines = 14

// nodeKind is the node kind of a section kind (its String).
func nodeKind(k trace.SectionKind) string { return k.String() }

// digits parses the decimal number at the start of b, and how many bytes it took.
func digits(b []byte) (int, int) {
	n, i := 0, 0
	for i < len(b) && b[i] >= '0' && b[i] <= '9' && i < 9 {
		n = n*10 + int(b[i]-'0')
		i++
	}
	return n, i
}

// tocMarker finds "[TOCnnnnn]" or "[TOCnnnnn-END]" at the end of a line (after trimming blanks), alone on
// the line (indented or not) or after its text. It gives the number, whether it closes, the text before an opening marker that
// does not stand alone, and whether the line is only the marker.
func tocMarker(line []byte) (num int, closes bool, before string, alone, ok bool) {
	t := bytes.TrimRight(line, " \t\r")
	if len(t) < 8 || t[len(t)-1] != ']' {
		return
	}
	i := bytes.LastIndex(t, []byte("[TOC"))
	if i < 0 {
		return
	}
	body := t[i+4 : len(t)-1]
	n, k := digits(body)
	if k != 5 {
		return
	}
	switch string(body[k:]) {
	case "":
		before = strings.TrimSpace(string(t[:i]))
		return n, false, before, before == "", true
	case "-END":
		// a line of its own, or after the text of a line (big/diag_oom_incident:79808)
		return n, true, "", strings.TrimSpace(string(t[:i])) == "", true
	}
	return
}

// tocTableLine parses a line of an incident file's table of contents at its end:
// "| | TOC00004 - Parser State" or "TOC00000 - Table of contents".
func tocTableLine(line []byte) (num int, title string, ok bool) {
	t := line
	for len(t) >= 2 && t[0] == '|' && t[1] == ' ' {
		t = t[2:]
	}
	if len(t) < 11 || string(t[:3]) != "TOC" {
		return
	}
	n, k := digits(t[3:])
	if k != 5 || !bytes.HasPrefix(t[3+k:], []byte(" - ")) {
		return
	}
	return n, strings.TrimSpace(string(t[3+k+3:])), true
}
