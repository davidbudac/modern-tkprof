package diag

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Scan is what one pass over a trace file finds: the file facts and the whole top level of the outline.
type Scan struct {
	File File
	// Top is the whole top level; File.Outline is its first page (Cap nodes).
	Top []Node
	// MarkSQLIDs and MarkSessions are the statements and the "sid.serial" sessions the file names, in first-seen
	// order, at most MarkCap each: what a client marks when another tab holds the same (marks.go).
	MarkSQLIDs   []string
	MarkSessions []string
	// SessionMarks are the "*** SESSION ID:(sid.serial)" markers of the file in file order (a marker that repeats
	// the session before it is left out), at most sessionMarkCap: SessionAt says which session wrote a line.
	SessionMarks []SessionMark
}

// SessionMark is a "*** SESSION ID:(61.58038)" marker.
type SessionMark struct {
	Line int    `json:"line"`
	Key  string `json:"key"` // "sid.serial"
}

// sessionMarkCap bounds Scan.SessionMarks.
const sessionMarkCap = 50000

// SessionAt is the session of the last "*** SESSION ID" marker at or before line, with the line of that marker;
// "" when the file has no marker before it.
func (s *Scan) SessionAt(line int) (markerLine int, key string) {
	i := sort.Search(len(s.SessionMarks), func(i int) bool { return s.SessionMarks[i].Line > line })
	if i == 0 {
		return 0, ""
	}
	m := s.SessionMarks[i-1]
	return m.Line, m.Key
}

// ScanFile reads the file at path in one streaming pass.
func ScanFile(path string) (*Scan, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ScanReader(f, filepath.Base(path))
}

// ScanReader reads a trace from r in one streaming pass: the parser's sections (trace.SniffReader finds
// them with the rules of the 10046 parser) and, line by line, what the titles of the top level need. What
// is held is the model, not the text: a window of a few lines, one small record per section start and per
// run of lines between sections. It reads what it can: an empty file, a file of another Oracle version or
// one with no dump at all gives a Scan (an outline of the header and "Other lines") without an error;
// the error is that of the reader.
func ScanReader(r io.Reader, name string) (*Scan, error) {
	s := &scanner{}
	sn, err := trace.SniffReader(r, trace.SniffOptions{Line: s.line})
	s.flushDet()
	return s.result(filepath.Base(name), sn), err
}

// startRec is a section start the pass saw (a nested one too) with what its title is made of.
type startRec struct {
	line  int
	kind  trace.SectionKind
	facts sectionFacts
	kids  bool // the section that starts here has parts of its own
}

// gapRun is a maximal run of lines outside every section (the file header included).
type gapRun struct {
	from, to int
	recs     int    // 10046 record lines
	unk      int    // unplaced lines (after the header)
	first    string // the first unplaced line, for the Sub of the node
}

type hdrPhase uint8

const (
	hpStart hdrPhase = iota
	hpProlog
	hpMarks
	hpDone
)

type scanner struct {
	n int // lines seen

	// the file header
	hp                 hdrPhase
	hdrEnd             int
	prolog             bool
	marker             bool
	release            string
	version            string
	dumpFile, contFrom string
	records            int

	// section starts, runs of lines outside sections
	starts  []startRec
	capIdx  int
	capLeft int
	gaps    []gapRun
	gapOpen bool
	prevIn  bool

	// an incident file's "Dump for incident" line
	inc     sectionFacts
	incLine int

	// the top-level section that is open (its First) and the detector of its parts
	curFirst int
	det      detector

	marks marker

	sessMarks []SessionMark
}

// detector finds out whether the open top-level section has parts of its own: the walker runs over its
// lines until it finds the first head, and then stops (a section that has parts finds one early).
type detector struct {
	active            bool
	idx               int
	w                 walker
	found             bool
	prevB, curB       []byte
	havePrev, haveCur bool
	curN              int
}

func isRecordKind(k trace.Kind) bool {
	switch k {
	case trace.KindParsingInCursor, trace.KindParseError, trace.KindCall, trace.KindWait, trace.KindStat,
		trace.KindBinds, trace.KindXctend, trace.KindError, trace.KindLob, trace.KindRPC:
		return true
	}
	return false
}

func star54(b []byte) bool {
	if len(b) != 54 || b[0] != '*' {
		return false
	}
	return bytes.Count(b, []byte{'*'}) == 54
}

func hasPrefix(b []byte, p string) bool { return len(b) >= len(p) && string(b[:len(p)]) == p }

// line is called for every line of the file (trace.SniffOptions.Line).
func (s *scanner) line(n int, line []byte, k trace.Kind, open trace.Section) {
	in := open.Kind != trace.SectionNone
	s.n = n
	s.marks.line(line)
	if len(line) > 16 && line[0] == '*' && len(s.sessMarks) < sessionMarkCap && hasPrefix(line, "*** SESSION ID:(") {
		s.sessionMark(n, line)
	}
	if n <= 200 {
		s.early(n, line)
	}
	rec := isRecordKind(k)
	if rec {
		s.records++
	}
	if s.capLeft > 0 {
		st := &s.starts[s.capIdx]
		st.facts.absorb(st.kind, line)
		s.capLeft--
	}
	if len(line) > 18 && line[0] == '=' && s.incLine == 0 && bytes.Contains(line, []byte("Dump for incident ")) {
		s.inc.absorb(trace.SectionIncident, line)
		if s.inc.incID != "" {
			s.incLine = n
		}
	}
	if len(line) >= 10 && nestedFirst(line[0]) {
		if kk, ok := trace.IsSectionStart(line); ok {
			s.starts = append(s.starts, startRec{line: n, kind: kk, facts: startFacts(kk, line)})
			s.capIdx, s.capLeft = len(s.starts)-1, sectionFactsLines
		}
	}
	s.header(n, line, k, in, rec)
	s.gap(n, line, k, in, rec)
	s.sections(n, line, open)
	s.prevIn = in
}

// sessionMark keeps a "*** SESSION ID:(sid.serial) ..." marker whose session differs from the last one's.
func (s *scanner) sessionMark(n int, line []byte) {
	rest := line[len("*** SESSION ID:("):]
	sid, k := num(rest)
	if k == 0 || len(rest) <= k+1 || rest[k] != '.' {
		return
	}
	ser, k2 := num(rest[k+1:])
	if k2 == 0 {
		return
	}
	key := itoa(sid) + "." + itoa(ser)
	if m := len(s.sessMarks); m > 0 && s.sessMarks[m-1].Key == key {
		return
	}
	s.sessMarks = append(s.sessMarks, SessionMark{Line: n, Key: key})
}

// early reads the prologue and the incident facts of the first lines.
func (s *scanner) early(n int, line []byte) {
	if n == 1 && hasPrefix(line, "Dump file ") {
		s.dumpFile = strings.TrimSpace(string(line[len("Dump file "):]))
	}
	if s.contFrom == "" && hasPrefix(line, "Dump continued from file:") {
		s.contFrom = strings.TrimSpace(string(line[len("Dump continued from file:"):]))
	}
	if n > 60 {
		return
	}
	if s.version == "" && hasPrefix(line, "Version ") {
		rest := line[len("Version "):]
		i := 0
		for i < len(rest) && (rest[i] >= '0' && rest[i] <= '9' || rest[i] == '.') {
			i++
		}
		if i > 0 && rest[0] >= '0' && rest[0] <= '9' && rest[i-1] != '.' {
			s.version = string(rest[:i])
		}
	}
	if s.release == "" && hasPrefix(line, "Oracle Database ") && bytes.Contains(line, []byte("Release")) {
		s.release = strings.TrimSpace(string(line))
	}
}

// header follows the file header: the prologue (up to the first blank line), then blank lines and "*** "
// markers.
func (s *scanner) header(n int, line []byte, k trace.Kind, in, rec bool) {
	if s.hp == hpDone {
		return
	}
	hdr := false
	switch s.hp {
	case hpStart:
		switch {
		case hasPrefix(line, "Trace file ") || hasPrefix(line, "Dump file ") || hasPrefix(line, "Oracle Database "):
			s.hp, s.prolog, hdr = hpProlog, true, true
		case !in && (k == trace.KindBlank || k == trace.KindMarker):
			s.hp, hdr = hpMarks, true
			s.marker = k == trace.KindMarker
		}
	case hpProlog:
		if !in && !rec {
			hdr = true
			if k == trace.KindBlank {
				s.hp = hpMarks
			}
		}
	case hpMarks:
		if !in && (k == trace.KindBlank || k == trace.KindMarker) {
			hdr = true
			s.marker = s.marker || k == trace.KindMarker
		}
	}
	if hdr {
		s.hdrEnd = n
	} else {
		s.hp = hpDone
	}
}

// gap keeps the runs of lines outside sections.
func (s *scanner) gap(n int, line []byte, k trace.Kind, in, rec bool) {
	if in {
		s.gapOpen = false
		return
	}
	if !s.gapOpen {
		s.gaps = append(s.gaps, gapRun{from: n})
		s.gapOpen = true
	}
	g := &s.gaps[len(s.gaps)-1]
	g.to = n
	switch {
	case rec:
		g.recs++
	case s.hp == hpDone && k == trace.KindUnknown && !star54(line):
		g.unk++
		if g.first == "" {
			g.first = trunc(strings.Join(strings.Fields(string(line)), " "), 80)
		}
	}
}

// sections follows the top-level section that is open: whether it has parts of its own.
func (s *scanner) sections(n int, line []byte, open trace.Section) {
	if open.Kind == trace.SectionNone {
		s.flushDet()
		s.curFirst = 0
		return
	}
	d := &s.det
	if open.First != s.curFirst { // another section is open: its start line is this one
		s.flushDet()
		s.curFirst = open.First
		d.active, d.idx, d.found = false, len(s.starts)-1, false
		d.havePrev, d.haveCur = false, false
		if prof := ownProfile(nodeKind(open.Kind)); prof != 0 && len(s.starts) > 0 && s.starts[len(s.starts)-1].line == n {
			d.active = true
			d.w = walker{prof: prof, skipTo: n, claimed: n}
			d.w.emit = func(*head) { d.found = true }
		}
	}
	if !d.active {
		return
	}
	d.feed(n, line)
	if d.found {
		s.starts[d.idx].kids = true
		d.active = false
	}
}

// feed gives the walker the line before this one, now that its next line is known.
func (d *detector) feed(n int, line []byte) {
	if d.haveCur {
		var prev []byte
		if d.havePrev {
			prev = d.prevB
		}
		d.w.line(d.curN, prev, d.curB, line)
		if d.found {
			return
		}
		d.prevB = append(d.prevB[:0], d.curB...)
		d.havePrev = true
	}
	d.curB = append(d.curB[:0], line...)
	d.curN, d.haveCur = n, true
}

// flushDet finishes the detector at the end of its section: the last line has no next line.
func (s *scanner) flushDet() {
	d := &s.det
	if !d.active {
		return
	}
	if d.haveCur && !d.found {
		var prev []byte
		if d.havePrev {
			prev = d.prevB
		}
		d.w.line(d.curN, prev, d.curB, nil)
	}
	if d.found {
		s.starts[d.idx].kids = true
	}
	d.active = false
}

// startFor finds the start record of a section.
func (s *scanner) startFor(sec trace.Section) *startRec {
	i := sort.Search(len(s.starts), func(i int) bool { return s.starts[i].line >= sec.First })
	if i < len(s.starts) && s.starts[i].line <= sec.First+1 && s.starts[i].kind == sec.Kind {
		return &s.starts[i]
	}
	return nil
}

func releaseVersion(release string) string {
	_, rest, ok := strings.Cut(release, "Release ")
	if !ok {
		return ""
	}
	i := 0
	for i < len(rest) && (rest[i] >= '0' && rest[i] <= '9' || rest[i] == '.') {
		i++
	}
	v := strings.TrimRight(rest[:i], ".")
	if v == "" || v[0] < '0' || v[0] > '9' || strings.HasSuffix(v, ".0.0.0.0") {
		return ""
	}
	return v
}

// result assembles the file facts and the top level from what the pass saw.
func (s *scanner) result(name string, sn trace.Sniff) *Scan {
	lines := sn.Lines
	f := File{Name: name, Lines: lines, Release: s.release, Version: s.version, Records10046: s.records,
		Sections: make([]Section, len(sn.Sections))}
	if f.Version == "" {
		f.Version = releaseVersion(f.Release)
	}
	f.Tested = strings.HasPrefix(f.Version, "19.")
	for i, sec := range sn.Sections {
		f.Sections[i] = Section{Kind: sec.Kind.String(), First: sec.First, Last: sec.Last, Cut: sec.Cut}
	}
	if s.dumpFile != "" || s.contFrom != "" || s.incLine > 0 || slices.ContainsFunc(sn.Sections, func(x trace.Section) bool { return x.Kind == trace.SectionIncident }) {
		f.Incident = &Incident{DumpFile: s.dumpFile, ContinuedFrom: s.contFrom, ID: s.inc.incID, Problem: s.inc.problem}
	}

	top := make([]Node, 0, 2*len(sn.Sections)+2)
	pos := 1
	hdrEnd := s.hdrEnd
	if !s.prolog && !s.marker {
		hdrEnd = 0
	}
	if len(sn.Sections) > 0 {
		hdrEnd = min(hdrEnd, sn.Sections[0].First-1)
	}
	hdrEnd = min(hdrEnd, lines)
	if hdrEnd >= 1 {
		n := Node{ID: nodeID("header", 1, hdrEnd, 1, 0), Kind: "header", Title: "File header", Sub: s.release, From: 1, To: hdrEnd, Lines: hdrEnd}
		if f.Incident != nil && s.dumpFile != "" {
			n.Title = "Incident file header"
		}
		top = append(top, n)
		pos = hdrEnd + 1
	}
	gapIdx := 0
	addGap := func(a, b int) {
		if a > b {
			return
		}
		top = append(top, s.gapNode(a, b, hdrEnd, &gapIdx))
	}
	for _, sec := range sn.Sections {
		first := max(sec.First, pos)
		if sec.Last < first {
			continue
		}
		addGap(pos, first-1)
		top = append(top, s.sectionNode(sec, first))
		pos = sec.Last + 1
	}
	addGap(pos, lines)

	// the unplaced lines: those of the runs that hold no 10046 record
	for i := range top {
		if top[i].Kind == "other" {
			f.Unplaced += top[i].unk
		}
	}
	for i := range top {
		top[i].unk = 0
	}
	f.OutlineTotal = len(top)
	f.Outline = append([]Node{}, top[:min(len(top), Cap)]...)
	return &Scan{File: f, Top: top, MarkSQLIDs: s.marks.sqlIDs, MarkSessions: s.marks.sessions, SessionMarks: s.sessMarks}
}

// gapNode makes the node of a run of lines between sections (a, b) from the runs the pass kept.
func (s *scanner) gapNode(a, b, hdrEnd int, idx *int) Node {
	recs, unk, first := 0, 0, ""
	for *idx < len(s.gaps) && s.gaps[*idx].to < a {
		*idx++
	}
	for i := *idx; i < len(s.gaps) && s.gaps[i].from <= b; i++ {
		g := s.gaps[i]
		at := max(g.from, hdrEnd+1) // a run's lines are all of one node but the header's
		if at < a || at > b {
			continue
		}
		recs += g.recs
		unk += g.unk
		if first == "" {
			first = g.first
		}
	}
	n := Node{From: a, To: b, Lines: b - a + 1}
	if recs > 0 {
		n.Kind, n.Title, n.Records = "trace10046", "SQL trace (10046) lines", recs
		n.Sub = pluralN(recs, "10046 record line")
	} else {
		n.Kind, n.Title = "other", "Other lines"
		n.Sub = first
		if first == "" {
			n.Sub = markersOnlySub
		}
		n.unk = unk
	}
	n.ID = nodeID(n.Kind, a, b, 1, 0)
	return n
}

func pluralN(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(n) + " " + noun + "s"
}

// sectionNode makes the node of a section from its start record.
func (s *scanner) sectionNode(sec trace.Section, first int) Node {
	var facts sectionFacts
	kids := false
	if st := s.startFor(sec); st != nil {
		facts, kids = st.facts, st.kids
	}
	if sec.Kind == trace.SectionIncident && s.incLine >= sec.First && s.incLine <= sec.Last {
		facts.incID, facts.problem = s.inc.incID, s.inc.problem
	}
	k := nodeKind(sec.Kind)
	n := Node{ID: nodeID(k, first, sec.Last, 1, ownProfile(k)), Kind: k, Title: facts.title(sec.Kind), Sub: facts.sub(sec.Kind),
		From: first, To: sec.Last, Lines: sec.Last - first + 1, HasChildren: kids, Cut: sec.Cut,
		Name: facts.name, Depth: facts.depth, Size: facts.size, Reading: ReadingKindOf(k)}
	return n
}
