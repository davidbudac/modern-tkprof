package opt

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Scan is what one pass over a trace file finds: the file facts and the model of every dump.
type Scan struct {
	File  File
	Dumps []*Dump
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

// ScanReader reads a trace from r in one streaming pass. The memory it holds is the model, not the text:
// a window of a few lines is all that is kept of the file. It reads what it can: a file of another Oracle
// version, a truncated file, an empty file or one with no dump at all gives a Scan without an error; the
// error is that of the reader.
func ScanReader(r io.Reader, name string) (*Scan, error) {
	s := &scanner{}
	s.file.Name = filepath.Base(name)
	s.nth = map[string]int{}
	s.nilEnt.blank = true
	br := bufio.NewReaderSize(r, 1<<20)
	var long []byte
	for {
		frag, err := br.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			long = append(long, frag...)
			continue
		}
		line := frag
		if len(long) > 0 {
			long = append(long, frag...)
			line = long
		}
		if len(line) > 0 {
			if line[len(line)-1] == '\n' {
				line = line[:len(line)-1]
			}
			if n := len(line); n > 0 && line[n-1] == '\r' {
				line = line[:n-1]
			}
			s.feed(line)
		}
		long = long[:0]
		if err != nil {
			if err != io.EOF {
				s.flush()
				return s.result(), err
			}
			break
		}
	}
	s.flush()
	return s.result(), nil
}

// IsStart reports whether line is a "Registered qb: … (PARSER)" line, the line a dump opens with.
func IsStart(line []byte) bool {
	if !hp(line, "Registered qb: ") {
		return false
	}
	rest := line[len("Registered qb: "):]
	tok, rest := token(rest)
	if len(tok) == 0 || !hp(rest, " 0x") {
		return false
	}
	rest = rest[3:]
	n := 0
	for n < len(rest) && isHex(rest[n]) {
		n++
	}
	if n == 0 {
		return false
	}
	return hp(rest[n:], " (PARSER)")
}

// IsEnd reports whether line is the END SQL Statement Dump line.
func IsEnd(line []byte) bool {
	return len(line) > 0 && line[0] == '=' && bytes.Contains(line, []byte("END SQL Statement Dump"))
}

// lineEnt is one line of the window.
type lineEnt struct {
	b                 []byte
	n                 int
	blank, sep, under bool
	skip              bool // inside a 10046 record
	role              byte // 't' banner top, 'h' title, 'b' bottom, 'u' heading above an underline, 'l' the underline
	title             bool // the title line of a banner or underline heading
	bTop, bBottom     int
	bUnder            bool
}

const ringSize = 16

type scanner struct {
	file  File
	dumps []*Dump

	ring   [ringSize]lineEnt
	nilEnt lineEnt
	head   int
	done1  int // pass 1 (banners) done for titles up to this line
	done2  int // pass 2 (underline headings) done up to this line
	done3  int // the main stage done up to this line

	// 10046 records, the read stage
	inStmt, inBinds, bindOpen, bindDump bool
	firstSkip                           int

	cur     *dstate
	nodeSeq int
	foldSeq int
	nth     map[string]int
}

func (s *scanner) ent(k int) *lineEnt {
	if k < 1 || k > s.head {
		return &s.nilEnt
	}
	return &s.ring[k&(ringSize-1)]
}

// feed takes the next line; line is only valid during the call.
func (s *scanner) feed(line []byte) {
	s.head++
	n := s.head
	e := &s.ring[n&(ringSize-1)]
	*e = lineEnt{b: append(e.b[:0], line...), n: n}
	e.blank, e.sep, e.under = classify(e.b)
	s.recordStage(e)
	if n <= 40 {
		s.prologue(e.b)
	}
	s.advance()
}

// releaseVersion reads the version from the banner of a release before 18c, which writes no "Version" line:
// "Oracle Database 11g Enterprise Edition Release 11.2.0.3.0 - 64bit Production" -> "11.2.0.3.0". From 18c the
// banner says "Release 19.0.0.0.0", not the release update, so a version ending in .0.0.0.0 gives "".
func releaseVersion(release string) string {
	_, rest, ok := strings.Cut(release, "Release ")
	if !ok {
		return ""
	}
	i := 0
	for i < len(rest) && (isDigit(rest[i]) || rest[i] == '.') {
		i++
	}
	v := strings.TrimRight(rest[:i], ".")
	if v == "" || !isDigit(v[0]) || strings.HasSuffix(v, ".0.0.0.0") {
		return ""
	}
	return v
}

func (s *scanner) prologue(b []byte) {
	if s.file.Version == "" && hp(b, "Version ") {
		rest := b[len("Version "):]
		i := 0
		for i < len(rest) && (isDigit(rest[i]) || rest[i] == '.') {
			i++
		}
		if i > 0 && isDigit(rest[0]) && rest[i-1] != '.' {
			s.file.Version = string(rest[:i])
		}
	}
	if s.file.Release == "" && hp(b, "Oracle Database ") && bytes.Contains(b, []byte("Release")) {
		s.file.Release = string(trimB(b))
	}
}

// recordKind says whether line starts a 10046 record: 1 PARSING IN CURSOR, 2 BINDS, 3 any other.
func recordKind(b []byte) int {
	if len(b) < 5 {
		return 0
	}
	switch b[0] {
	case 'P':
		if hp(b, "PARSING IN CURSOR #") {
			return 1
		}
		if hp(b, "PARSE #") || hp(b, "PARSE ERROR #") {
			return 3
		}
	case 'E':
		if hp(b, "EXEC #") || hp(b, "ERROR #") {
			return 3
		}
	case 'F':
		if hp(b, "FETCH #") {
			return 3
		}
	case 'C':
		if hp(b, "CLOSE #") {
			return 3
		}
	case 'W':
		if hp(b, "WAIT #") {
			return 3
		}
	case 'S':
		if hp(b, "STAT #") {
			return 3
		}
	case 'B':
		if hp(b, "BINDS #") {
			return 2
		}
	case 'X':
		if hp(b, "XCTEND ") {
			return 3
		}
	}
	return 0
}

// isBindShape is the shape of a line of a 10046 BINDS block (the lines internal/trace takes for bind lines).
func isBindShape(b []byte) bool {
	switch {
	case hp(b, " Bind#"), hp(b, " bind "), hp(b, "  oacdty="), hp(b, "  oacflg="), hp(b, "  kxsbbbfp="),
		hp(b, "  value="), hp(b, " value=Unhandled datatype"), hp(b, "  No oacdef for this bind."),
		string(b) == "kkscoacd", hp(b, "Dump of memory from "), hp(b, "Dumping "), hp(b, "toid ptr value="):
		return true
	}
	return false
}

// isHexDumpLine: a line of a memory dump, "[7F5D6B5C0A00, 7F5D6B5C0A10) = 00000000 ..." or "7F5D6B5C0A00 4F52...".
func isHexDumpLine(b []byte) bool {
	t := skipSpace(b)
	if len(t) == 0 {
		return false
	}
	if t[0] == '[' {
		return true
	}
	n := 0
	for n < len(t) && isHex(t[n]) {
		n++
	}
	return n >= 4 && n < len(t) && t[n] == ' '
}

func oddQuotes(b []byte) bool { return bytes.Count(b, []byte{'"'})%2 == 1 }

// recordStage marks the lines that belong to a 10046 record (they sit between the optimizer's lines in an
// interleaved file) and counts the records.
func (s *scanner) recordStage(e *lineEnt) {
	b := e.b
	if s.inStmt {
		e.skip = true
		if string(trimB(b)) == "END OF STMT" {
			s.inStmt = false
		}
		return
	}
	if s.inBinds {
		switch {
		case s.bindOpen:
			e.skip = true
			if oddQuotes(b) {
				s.bindOpen = false
			}
			return
		case e.blank || isBindShape(b):
			e.skip = true
			s.bindDump = hp(b, "Dump of memory from ") || (s.bindDump && !hp(b, " Bind#") && !hp(b, "  value="))
			if t := skipSpace(b); hp(t, "value=\"") && oddQuotes(t) {
				s.bindOpen = true
			}
			return
		case s.bindDump && isHexDumpLine(b):
			e.skip = true
			return
		}
		s.inBinds = false
		s.bindDump = false
	}
	if len(b) == 0 {
		return
	}
	k := recordKind(b)
	if k == 0 {
		return
	}
	s.file.Records10046++
	e.skip = true
	if s.firstSkip == 0 {
		s.firstSkip = e.n
	}
	switch k {
	case 1:
		s.inStmt = true
	case 2:
		s.inBinds = true
	}
}

// advance runs the stages that lag behind the read: the banner pass one (needs the line after the title), the
// underline headings (need the roles of the two lines after), and the main stage (needs five lines ahead).
func (s *scanner) advance() {
	for s.done1 < s.head-1 {
		s.done1++
		s.banner1(s.done1)
	}
	for s.done2 < s.head-3 {
		s.done2++
		s.banner2(s.done2)
	}
	for s.done3 < s.head-5 {
		s.done3++
		s.process(s.done3)
	}
}

// flush runs the stages to the end of the file.
func (s *scanner) flush() {
	n := s.head
	for s.done2 < n-1 {
		s.done2++
		s.banner2(s.done2)
	}
	for s.done3 < n {
		s.done3++
		s.process(s.done3)
	}
	if s.cur != nil {
		s.cur.finish(n)
		s.cur = nil
	}
}

// banner1: a separator line, a title, a separator line (greedy from the top); parse.mjs's first pass.
func (s *scanner) banner1(j int) {
	if j < 2 {
		return
	}
	e, p, q := s.ent(j), s.ent(j-1), s.ent(j+1)
	if p.role != 0 || e.role != 0 || !p.sep || !q.sep || e.sep || e.blank {
		return
	}
	p.role, e.role, q.role = 't', 'h', 'b'
	e.title, e.bTop, e.bBottom, e.bUnder = true, j-1, j+1, false
}

// banner2: a title followed by an underline of about its length; parse.mjs's second pass.
func (s *scanner) banner2(i int) {
	if i < 1 {
		return
	}
	e, nx, pv := s.ent(i), s.ent(i+1), s.ent(i-1)
	if e.role != 0 || nx.role != 0 || e.sep || e.blank || !nx.under {
		return
	}
	if i > 1 && pv.sep && pv.role == 0 {
		return
	}
	d := runeLen(nx.b) - runeLen(e.b)
	if d > 3 || d < -3 {
		return
	}
	e.role, nx.role = 'u', 'l'
	e.title, e.bTop, e.bBottom, e.bUnder = true, i, i+1, true
}

// process is the main stage for line k: it finds dumps and hands their lines to the dump being built.
func (s *scanner) process(k int) {
	e := s.ent(k)
	ds := s.cur
	switch {
	case ds != nil && ds.inside:
		if !e.skip && ds.qbsOver && len(e.b) > 0 && e.b[0] == 'R' && IsStart(e.b) {
			// a dump that began and did not end, and a new one starts here
			s.startDump(k)
			s.cur.inLine(e)
			return
		}
		ds.inLine(e)
	case !e.skip && len(e.b) > 0 && e.b[0] == 'R' && IsStart(e.b):
		s.startDump(k)
		s.cur.inLine(e)
	default:
		if ds != nil {
			ds.afterLine(e)
		}
	}
}

func (s *scanner) startDump(i int) {
	if s.cur != nil {
		s.cur.finish(i - 1)
	}
	d := &Dump{}
	d.Idx = len(s.dumps)
	d.From = i
	d.ViewFrom = i
	if d.Idx == 0 {
		d.ViewFrom = 1
	}
	s.dumps = append(s.dumps, d)
	s.cur = newDState(s, d)
	s.cur.begin()
}

func (s *scanner) result() *Scan {
	sc := &Scan{File: s.file, Dumps: s.dumps}
	sc.File.Lines = s.head
	if sc.File.Version == "" {
		sc.File.Version = releaseVersion(sc.File.Release)
	}
	sc.File.Tested = strings.HasPrefix(sc.File.Version, "19.")
	sc.File.Dumps = make([]DumpInfo, len(s.dumps))
	for i, d := range s.dumps {
		sc.File.Dumps[i] = d.DumpInfo
	}
	return sc
}
