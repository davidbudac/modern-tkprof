// Package peek summarises a trace file without parsing it: what the folder
// picker shows before anything is opened (DESIGN § Opening a folder).
//
// One sequential read of the file looks only at the prologue, the `***`
// marker lines and the first and last `tim=`; nothing else of a line is
// read. The wall clock is anchored as the model anchors it (a marker that
// carries a time anchors the first tim after it), so Start and End are the
// times the opened trace shows.
package peek

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// MaxSessions bounds Summary.Sessions; SessionCount counts all of them.
const MaxSessions = 200

// MaxOptDumps bounds Summary.OptSQLIDs; OptDumps counts all of the dumps.
const MaxOptDumps = 100

// Session is a SESSION ID of the file with the first module, action,
// client id and service written for it.
type Session struct {
	ID      string     `json:"id"` // sid.serial#
	Module  string     `json:"module,omitempty"`
	Action  string     `json:"action,omitempty"`
	Client  string     `json:"client,omitempty"`
	Service string     `json:"service,omitempty"`
	At      *time.Time `json:"at,omitempty"` // the time on its first SESSION ID line
}

// Summary is what a peek knows about one file.
type Summary struct {
	Path     string    `json:"path"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	// the prologue
	TraceFile string `json:"traceFile,omitempty"`
	Version   string `json:"version,omitempty"`
	Instance  string `json:"instance,omitempty"`
	Node      string `json:"node,omitempty"`
	Process   string `json:"process,omitempty"` // Unix process pid / Windows thread id, without the image
	// the traced time: wall clock of the first and last tim (or of the first
	// and last timed marker when the file has no tim), and the tim span
	Start     *time.Time `json:"start,omitempty"`
	End       *time.Time `json:"end,omitempty"`
	ElapsedUs int64      `json:"elapsedUs"`
	// SQL trace: the file has a 10046 line with a tim= (a background
	// process trace of an ADR folder has none)
	SQLTrace     bool      `json:"sqlTrace"`
	Sessions     []Session `json:"sessions"`
	SessionCount int       `json:"sessionCount"`
	// What the file holds: "10046" (SQL trace records), "10053" (optimizer
	// dumps and no 10046 record) or "both" (event 10046 and 10053 on in one
	// session: an interleaved file); "" when neither was seen (a background
	// process trace). The file is read to its end for it, so the answer is
	// complete unless the read was cancelled first (Read returns the error,
	// Summary.Error is then set): Kind and the dump fields hold what was seen,
	// and a "10053" can still turn out to be "both".
	Kind string `json:"kind,omitempty"`
	// OptDumps is the number of optimizer (10053) dumps seen (a dump starts
	// at its first "Registered qb: ... (PARSER)" line); OptSQLIDs the sql_id
	// of the first MaxOptDumps of them, in file order ("" for a dump cut
	// before its sql_id line).
	OptDumps  int      `json:"optDumps,omitempty"`
	OptSQLIDs []string `json:"optSqlIds,omitempty"`
	// chain markers and the dump size limit
	ContinuedFrom string `json:"continuedFrom,omitempty"`
	ContinuesIn   string `json:"continuesIn,omitempty"`
	Truncated     bool   `json:"truncated,omitempty"`
	// the file could not be read (the other fields hold what was read)
	Error string `json:"error,omitempty"`
}

// File peeks at the file at path.
func File(ctx context.Context, path string) (Summary, error) {
	s := Summary{Path: path, Sessions: []Session{}}
	f, err := os.Open(path)
	if err != nil {
		return s, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return s, err
	}
	if fi.IsDir() {
		return s, errors.New("is a directory")
	}
	s.Size, s.Modified = fi.Size(), fi.ModTime()
	err = Read(ctx, f, s.Size, &s)
	return s, err
}

const chunk = 4 << 20

// tailMax bounds how far back from the end the last tim= is looked for.
const tailMax = 16 << 20

// Read fills s from r (size bytes).
func Read(ctx context.Context, r io.ReaderAt, size int64, s *Summary) error {
	if s.Sessions == nil {
		s.Sessions = []Session{}
	}
	p := &peeker{s: s, cls: trace.NewClassifier(true), header: true, sessions: map[string]int{}, cur: -1}
	buf := make([]byte, chunk)
	var base int64 // file offset of buf[0]
	carry := 0
	for base+int64(carry) < size {
		if err := ctx.Err(); err != nil {
			p.setKind()
			return err
		}
		n, err := r.ReadAt(buf[carry:], base+int64(carry))
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		data := buf[:carry+n]
		last := base+int64(len(data)) >= size || n == 0
		end := len(data)
		if !last {
			if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
				end = i + 1
			} // else a line longer than the buffer: cut it here
		}
		p.region(data[:end], base)
		p.scanDumps(data[:end])
		if n == 0 {
			break
		}
		carry = copy(buf, data[end:])
		base += int64(end)
	}
	p.setKind()
	p.finish(ctx, r, size)
	return nil
}

type peeker struct {
	s      *Summary
	cls    *trace.Classifier
	header bool

	firstTim, lastTim int64
	hasFirst, hasLast bool
	// anchoring: a timed marker waits for the next tim
	pending     bool
	anchor      time.Time
	firstOff    int64 // wall µs - tim of the first anchor
	lastOff     int64 // of the last anchor
	anchored    bool
	firstMarker *time.Time
	lastMarker  *time.Time

	// statement text being skipped: SQL until an END OF STMT at or after
	// sqlFrom, a PARSE ERROR's text until perrTo (file offsets)
	inSQL   bool
	sqlFrom int64
	perrTo  int64

	sessions map[string]int // id -> index in s.Sessions (-1: past MaxSessions)
	cur      int            // the session the attribute markers belong to

	// optimizer dumps (scanDumps)
	record bool // a 10046 record was seen
	inDump bool
	wantID bool // the dump's sql_id line is still to come
	idAt   int  // index of the dump in s.OptSQLIDs, -1 past MaxOptDumps
}

var (
	markerPrefix = []byte("*** ")
	cursorPrefix = []byte("PARSING IN CURSOR #")
	perrPrefix   = []byte("PARSE ERROR #")
	endOfStmt    = []byte("END OF STMT")
)

// lenSlack: an END OF STMT line ends the statement text once at least
// len-4 bytes of it were read (the parser's rule; nasty_sql.trc has the
// terminator and `***` lines inside its SQL).
const lenSlack = 4

// region looks at whole lines of the file; base is the offset of b[0].
func (p *peeker) region(b []byte, base int64) {
	pos := 0
	if p.header {
		pos = p.prologue(b)
	}
	pos = p.skipText(b, base, pos)
	if pos >= len(b) {
		return
	}
	if !p.hasFirst {
		p.findFirstTim(b[pos:])
	}
	cursor := pos // where a pending anchor looks for its tim
	next := [3]int{-2, -2, -2}
	prefixes := [3][]byte{markerPrefix, cursorPrefix, perrPrefix}
	for pos < len(b) {
		// the next line that starts with one of the prefixes
		k, at := -1, len(b)
		for i := range next {
			if next[i] != -1 && next[i] < pos {
				next[i] = lineIndex(b, pos, prefixes[i])
			}
			if next[i] >= 0 && next[i] < at {
				k, at = i, next[i]
			}
		}
		if k < 0 {
			break
		}
		end := lineEnd(b, at)
		if k == 0 {
			if p.pending {
				p.resolve(b[cursor:at])
			}
			p.marker(trimCR(b[at+len(markerPrefix) : end]))
			cursor = end
			pos = end
			continue
		}
		// SQL text after a PARSING IN CURSOR or PARSE ERROR line
		p.record = true
		n := lenField(b[at:end])
		textAt := base + int64(end) + 1
		if k == 1 {
			p.inSQL, p.sqlFrom = true, textAt+int64(max(n-lenSlack, 0))
		} else {
			p.inSQL, p.perrTo = false, textAt+int64(n)+1
		}
		if p.pending {
			p.resolve(b[cursor:end])
		}
		pos = p.skipText(b, base, min(end+1, len(b)))
		cursor = pos
	}
	if p.pending && cursor < len(b) {
		p.resolve(b[cursor:])
	}
}

// skipText moves pos past the statement text being skipped: to the line
// after its END OF STMT, or past a PARSE ERROR's len+1 bytes.
func (p *peeker) skipText(b []byte, base int64, pos int) int {
	if p.perrTo > base+int64(pos) {
		to := int(min(p.perrTo-base, int64(len(b))))
		pos = min(lineEnd(b, max(to-1, pos))+1, len(b))
		if base+int64(pos) >= p.perrTo {
			p.perrTo = 0
		}
	}
	if !p.inSQL {
		return pos
	}
	from := max(pos, int(min(max(p.sqlFrom-base, 0), int64(len(b)))))
	// the terminator's line may start before from (the slack): back up to its start
	from = lineStart(b, from)
	for from < len(b) {
		at := lineIndex(b, from, endOfStmt)
		if at < 0 {
			return len(b)
		}
		end := lineEnd(b, at)
		if len(trimCR(b[at:end])) == len(endOfStmt) {
			p.inSQL = false
			return min(end+1, len(b))
		}
		from = end
	}
	return len(b)
}

// lineIndex is the offset of the first line at or after from that starts with prefix; -1 if none.
func lineIndex(b []byte, from int, prefix []byte) int {
	for i := from; i < len(b); {
		j := bytes.Index(b[i:], prefix)
		if j < 0 {
			return -1
		}
		at := i + j
		if at == 0 || b[at-1] == '\n' {
			return at
		}
		i = at + 1
	}
	return -1
}

// lineEnd is the offset of the newline that ends the line holding at (len(b) without one).
func lineEnd(b []byte, at int) int {
	if i := bytes.IndexByte(b[at:], '\n'); i >= 0 {
		return at + i
	}
	return len(b)
}

// lenField is the len= of a PARSING IN CURSOR or PARSE ERROR line (0 when absent).
func lenField(line []byte) int {
	i := bytes.Index(line, []byte(" len="))
	if i < 0 {
		return 0
	}
	n := 0
	for _, c := range line[i+5:] {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
		if n > 1<<30 {
			return 0
		}
	}
	return n
}

// prologue reads the header lines at the start of the file; the offset of
// the first line after them.
func (p *peeker) prologue(b []byte) int {
	pos := 0
	for pos < len(b) {
		end := bytes.IndexByte(b[pos:], '\n')
		next := len(b)
		if end >= 0 {
			next = pos + end + 1
			end += pos
		} else {
			end = len(b)
		}
		line := trimCR(b[pos:end])
		switch p.cls.Next(line) {
		case trace.KindHeader:
			p.headerLine(trace.ParseHeader(line))
		case trace.KindBlank:
		default:
			p.header = false
			return pos
		}
		pos = next
	}
	return pos
}

func (p *peeker) headerLine(h trace.Header) {
	s := p.s
	switch h.Key {
	case "Trace file":
		s.TraceFile = h.Value
	case "Oracle Version":
		s.Version = h.Value
	case "Instance name":
		s.Instance = h.Value
	case "Node name":
		s.Node = h.Value
	case "Unix process pid", "Windows thread id":
		// "133382, image: oracle@host": the pid
		s.Process, _, _ = strings.Cut(h.Value, ",")
	}
}

func (p *peeker) marker(rest []byte) {
	m := trace.ParseMarker(rest)
	if m.HasTime {
		t := m.Time
		if p.firstMarker == nil {
			p.firstMarker = &t
		}
		p.lastMarker = &t
		p.anchor, p.pending = t, true
	}
	s := p.s
	switch m.Kind {
	case trace.MarkerSessionID:
		i, ok := p.sessions[m.Value]
		if !ok {
			s.SessionCount++
			i = -1
			if len(s.Sessions) < MaxSessions {
				ss := Session{ID: m.Value}
				if m.HasTime {
					t := m.Time
					ss.At = &t
				}
				s.Sessions = append(s.Sessions, ss)
				i = len(s.Sessions) - 1
			}
			p.sessions[m.Value] = i
		}
		p.cur = i
	case trace.MarkerModuleName:
		p.attr(func(ss *Session) *string { return &ss.Module }, m.Value)
	case trace.MarkerActionName:
		p.attr(func(ss *Session) *string { return &ss.Action }, m.Value)
	case trace.MarkerClientID:
		p.attr(func(ss *Session) *string { return &ss.Client }, m.Value)
	case trace.MarkerServiceName:
		p.attr(func(ss *Session) *string { return &ss.Service }, m.Value)
	case trace.MarkerTraceContinuedFrom:
		if s.ContinuedFrom == "" {
			s.ContinuedFrom = m.Value
		}
	case trace.MarkerTraceContinuesIn:
		s.ContinuesIn = m.Value
	case trace.MarkerDumpSizeLimit:
		s.Truncated = true
	}
}

// attr sets a session attribute the first time it is written with a value.
func (p *peeker) attr(field func(*Session) *string, v string) {
	if p.cur < 0 || v == "" {
		return
	}
	if f := field(&p.s.Sessions[p.cur]); *f == "" {
		*f = v
	}
}

// resolve anchors the pending marker time to the first tim in b.
func (p *peeker) resolve(b []byte) {
	tim, _, ok := firstTim(b)
	if !ok {
		return
	}
	off := p.anchor.UnixMicro() - tim
	if !p.anchored {
		p.firstOff, p.anchored = off, true
	}
	p.lastOff = off
	p.pending = false
}

func (p *peeker) findFirstTim(b []byte) {
	tim, _, ok := firstTim(b)
	if !ok {
		return
	}
	p.firstTim, p.hasFirst = tim, true
	p.s.SQLTrace = true
}

// finish reads the last tim from the end of the file and sets the times.
func (p *peeker) finish(ctx context.Context, r io.ReaderAt, size int64) {
	s := p.s
	if p.hasFirst {
		for n := int64(1 << 20); ; n *= 4 {
			if n > size {
				n = size
			}
			b := make([]byte, n)
			if _, err := r.ReadAt(b, size-n); err != nil && !errors.Is(err, io.EOF) {
				break
			}
			if tim, ok := lastTim(b); ok {
				p.lastTim, p.hasLast = tim, true
				break
			}
			if n >= size || n >= tailMax || ctx.Err() != nil {
				break
			}
		}
	}
	if !p.hasLast && p.hasFirst {
		p.lastTim, p.hasLast = p.firstTim, true
	}
	if p.hasFirst && p.anchored {
		st := time.UnixMicro(p.firstTim + p.firstOff).In(p.anchor.Location())
		en := time.UnixMicro(p.lastTim + p.lastOff).In(p.anchor.Location())
		s.Start, s.End = &st, &en
		if p.lastTim > p.firstTim {
			s.ElapsedUs = p.lastTim - p.firstTim
		}
	} else if p.firstMarker != nil {
		s.Start, s.End = p.firstMarker, p.lastMarker
		if p.hasFirst && p.lastTim > p.firstTim {
			s.ElapsedUs = p.lastTim - p.firstTim
		}
	}
	// markers after the last tim (a closing timestamp) still count as traced time
	if s.End != nil && p.lastMarker != nil && p.lastMarker.After(*s.End) {
		t := *p.lastMarker
		s.End = &t
	}
	if s.ElapsedUs == 0 && s.Start != nil && s.End != nil && s.End.After(*s.Start) {
		s.ElapsedUs = s.End.Sub(*s.Start).Microseconds()
	}
}

var timKey = []byte("tim=")

// firstTim is the first " tim=" or ",tim=" value in b and its offset.
func firstTim(b []byte) (int64, int, bool) {
	for i := 0; i < len(b); {
		j := bytes.Index(b[i:], timKey)
		if j < 0 {
			return 0, 0, false
		}
		at := i + j
		if v, ok := timAt(b, at); ok {
			return v, at, true
		}
		i = at + len(timKey)
	}
	return 0, 0, false
}

// lastTim is the last " tim=" or ",tim=" value in b.
func lastTim(b []byte) (int64, bool) {
	for end := len(b); end > 0; {
		at := bytes.LastIndex(b[:end], timKey)
		if at < 0 {
			return 0, false
		}
		if v, ok := timAt(b, at); ok {
			return v, true
		}
		end = at
	}
	return 0, false
}

// timAt reads the tim= at b[at:] when it is a field of a 10046 line.
func timAt(b []byte, at int) (int64, bool) {
	if at == 0 || (b[at-1] != ' ' && b[at-1] != ',') || !sqlLine(b[lineStart(b, at):]) {
		return 0, false
	}
	d := at + len(timKey)
	e := d
	for e < len(b) && b[e] >= '0' && b[e] <= '9' {
		e++
	}
	if e == d || e-d > 19 {
		return 0, false
	}
	v, err := strconv.ParseInt(string(b[d:e]), 10, 64)
	return v, err == nil && v > 0
}

func lineStart(b []byte, at int) int {
	return bytes.LastIndexByte(b[:at], '\n') + 1
}

var sqlPrefixes = [][]byte{
	[]byte("PARSING IN CURSOR #"), []byte("PARSE #"), []byte("EXEC #"), []byte("FETCH #"), []byte("WAIT #"),
	[]byte("CLOSE #"), []byte("XCTEND "), []byte("STAT #"), []byte("ERROR #"), []byte("PARSE ERROR #"),
	[]byte("LOBREAD:"), []byte("LOBWRITE:"), []byte("LOBGETLEN:"), []byte("LOBAPPEND:"), []byte("LOBARRREAD:"),
	[]byte("LOBARRWRITE:"), []byte("LOBTMPCREATE:"), []byte("LOBTMPFREE:"), []byte("LOBARRTMPFRE:"), []byte("LOBPGSIZE:"),
}

func sqlLine(line []byte) bool {
	for _, p := range sqlPrefixes {
		if bytes.HasPrefix(line, p) {
			return true
		}
	}
	return false
}

func trimCR(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\r' {
		return b[:n-1]
	}
	return b
}

var (
	dumpStartKey = []byte("Registered qb: ")
	dumpSQLIDKey = []byte("----- Current SQL Statement for this session (sql_id=")
	dumpEndKey   = []byte(" END SQL Statement Dump ")
)

// scanDumps follows the optimizer dumps through b (whole lines): a dump
// starts at a "Registered qb: ... (PARSER)" line and ends at the END banner.
// It looks for those lines with substring searches, not line by line, so a
// 10046 trace costs one more search for the start key per chunk.
func (p *peeker) scanDumps(b []byte) {
	s := p.s
	for pos := 0; pos < len(b); {
		if !p.inDump {
			at := lineIndex(b, pos, dumpStartKey)
			if at < 0 {
				return
			}
			pos = lineEnd(b, at)
			if !trace.IsDumpStart(trimCR(b[at:pos])) {
				continue
			}
			p.inDump, p.wantID, p.idAt = true, true, -1
			s.OptDumps++
			if len(s.OptSQLIDs) < MaxOptDumps {
				s.OptSQLIDs = append(s.OptSQLIDs, "")
				p.idAt = len(s.OptSQLIDs) - 1
			}
			continue
		}
		stop, next := len(b), len(b)
		for i := pos; i < len(b); {
			j := bytes.Index(b[i:], dumpEndKey)
			if j < 0 {
				break
			}
			ls, le := lineStart(b, i+j), lineEnd(b, i+j)
			if trace.IsDumpEnd(trimCR(b[ls:le])) {
				stop, next = ls, le
				break
			}
			i = le
		}
		if p.wantID {
			if at := lineIndex(b[:stop], pos, dumpSQLIDKey); at >= 0 {
				if id, ok := trace.DumpSQLID(trimCR(b[at:lineEnd(b[:stop], at)])); ok {
					p.wantID = false
					if p.idAt >= 0 {
						s.OptSQLIDs[p.idAt] = id
					}
				}
			}
		}
		if stop == len(b) && next == len(b) {
			return // the END banner is in a later chunk
		}
		p.inDump = false
		pos = next
	}
}

// setKind sets Summary.Kind from what was seen so far.
func (p *peeker) setKind() {
	s := p.s
	switch rec, opt := p.record || s.SQLTrace, s.OptDumps > 0; {
	case rec && opt:
		s.Kind = "both"
	case rec:
		s.Kind = "10046"
	case opt:
		s.Kind = "10053"
	}
}
