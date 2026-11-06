package cut

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// indexes are what the cut reads from the trace text outside the kept lines,
// built once per file and kept by the Cutter.
type indexes struct {
	m   *model.Model
	lis []*trace.LineIndex

	mu      sync.Mutex
	files   map[int]*fileIndex
	adopted map[model.ID]int           // cursor -> line of the PARSING IN CURSOR that adopted it (0: none)
	cursors map[int]map[uint64][]curAt // per file: cursor number -> instances in line order
}

type curAt struct {
	line int32
	id   model.ID
}

// fileIndex: the prologue and the `***` lines of one file (one scan).
type fileIndex struct {
	body    int            // first line after the prologue (the header lines)
	markers []markerLine   // attribute, process and timestamp markers in line order
	zone    *time.Location // of the first timestamp: the zone generated timestamps are written in
}

type markerLine struct {
	line  int32
	kind  trace.MarkerKind
	value string
	text  string
	timed bool
}

func newIndexes(m *model.Model, lis []*trace.LineIndex) *indexes {
	return &indexes{m: m, lis: lis, files: map[int]*fileIndex{}}
}

func (x *indexes) path(f int) string { return x.m.File.Files[f].Path }

// file returns the index of file f, scanning it on first use.
func (x *indexes) file(f int) (*fileIndex, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if fi := x.files[f]; fi != nil {
		return fi, nil
	}
	fi, err := scanFile(x.path(f))
	if err != nil {
		return nil, err
	}
	x.files[f] = fi
	return fi, nil
}

// bodyStarts is the first body line of every file (1 when a file cannot be read).
func (x *indexes) bodyStarts() []int {
	out := make([]int, len(x.m.File.Files))
	for f := range out {
		out[f] = 1
		if fi, err := x.file(f); err == nil {
			out[f] = fi.body
		}
	}
	return out
}

// scanFile reads the prologue and every `***` line of a file.
func scanFile(path string) (*fileIndex, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	fi := &fileIndex{body: 0, zone: time.UTC}
	zoneSet := false
	r := newLineReader(fh, nil)
	cls := trace.NewClassifier(true)
	var sql sqlText
	for {
		ln, b, ok := r.next()
		if !ok {
			break
		}
		if sql.on {
			sql.next(b)
			continue
		}
		if bytes.HasPrefix(b, []byte("PARSING IN CURSOR #")) {
			sql.start(b)
		}
		if fi.body == 0 {
			if k := cls.Next(b); k == trace.KindHeader || k == trace.KindBlank {
				continue
			}
			fi.body = ln
		}
		if len(b) < 4 || b[0] != '*' || !bytes.HasPrefix(b, []byte("*** ")) {
			continue
		}
		mk, ok := parseMarker(b)
		if !ok {
			continue
		}
		mk.line = int32(ln)
		if mk.timed && !zoneSet {
			if t, ok := markerTime(b); ok {
				fi.zone, zoneSet = t.Location(), true
			}
		}
		fi.markers = append(fi.markers, mk)
	}
	if fi.body == 0 {
		fi.body = r.line
	}
	return fi, r.err
}

var attrPrefixes = []struct {
	p    string
	kind trace.MarkerKind
}{
	{"SESSION ID:(", trace.MarkerSessionID},
	{"CLIENT ID:(", trace.MarkerClientID},
	{"SERVICE NAME:(", trace.MarkerServiceName},
	{"MODULE NAME:(", trace.MarkerModuleName},
	{"ACTION NAME:(", trace.MarkerActionName},
	{"CLIENT DRIVER:(", trace.MarkerClientDriver},
	{"CONTAINER ID:(", trace.MarkerContainerID},
}

// parseMarker reads the `***` lines the cut cares about: session attributes,
// trcsess process switches and timestamps.
func parseMarker(b []byte) (markerLine, bool) {
	s := string(b[4:])
	for _, a := range attrPrefixes {
		if strings.HasPrefix(s, a.p) {
			rest := s[len(a.p):]
			i := strings.LastIndex(rest, ")")
			if i < 0 {
				return markerLine{}, false
			}
			return markerLine{kind: a.kind, value: rest[:i], text: string(b), timed: len(strings.TrimSpace(rest[i+1:])) > 0}, true
		}
	}
	switch {
	case strings.HasPrefix(s, "[ Unix process pid:"):
		v := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s[len("[ Unix process pid:"):]), "]"))
		return markerLine{kind: trace.MarkerProcess, value: v, text: string(b)}, true
	case strings.HasPrefix(s, "Unix process pid:"):
		return markerLine{kind: trace.MarkerProcess, value: strings.TrimSpace(s[len("Unix process pid:"):]), text: string(b)}, true
	case len(s) >= 10 && s[0] >= '0' && s[0] <= '9' && s[4] == '-':
		return markerLine{kind: trace.MarkerTimestamp, text: string(b), timed: true}, true
	}
	if _, ok := markerTime(b); ok { // CLIENT IP, CONNECTION ID and other markers with a time
		return markerLine{kind: trace.MarkerOther, text: string(b), timed: true}, true
	}
	return markerLine{}, false
}

// markerTime is the timestamp of a `***` line (attribute markers carry it after the value).
func markerTime(b []byte) (time.Time, bool) {
	s := string(b[4:])
	if i := strings.LastIndex(s, ") "); i >= 0 && strings.Contains(s[:i], ":(") {
		s = s[i+2:]
	}
	if i := strings.IndexByte(s, ' '); i >= 0 {
		s = s[:i]
	}
	for _, l := range []string{"2006-01-02T15:04:05.999999999Z07:00", "2006-01-02T15:04:05.999999999"} {
		if t, err := time.Parse(l, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// latest is the last marker of kind at or before line, with value v (any value when v is nil).
func (fi *fileIndex) latest(kind trace.MarkerKind, line int32, v *string) *markerLine {
	i := sort.Search(len(fi.markers), func(i int) bool { return fi.markers[i].line > line })
	for i--; i >= 0; i-- {
		mk := &fi.markers[i]
		if mk.kind == kind {
			if v == nil || mk.value == *v {
				return mk
			}
			return nil
		}
	}
	return nil
}

// timedBetween: a marker carrying a time lies on a line in (a, b): the
// source re-anchored its wall clock there.
func (fi *fileIndex) timedBetween(a, b int32) bool {
	i := sort.Search(len(fi.markers), func(i int) bool { return fi.markers[i].line > a })
	for ; i < len(fi.markers) && fi.markers[i].line < b; i++ {
		if fi.markers[i].timed {
			return true
		}
	}
	return false
}

// cursorAt is the cursor instance number num of file f stands for at line:
// the last one opened there at or before it (the builder's `open` map), or,
// in a file that continues a chain, the last of the files before.
func (x *indexes) cursorAt(f int, num uint64, line int32) model.ID {
	x.mu.Lock()
	if x.cursors == nil {
		x.cursors = map[int]map[uint64][]curAt{}
		m := x.m
		for i := range m.Cursors {
			cu := &m.Cursors[i]
			if cu.Context < 0 || cu.Number == 0 {
				continue
			}
			file := m.Contexts[cu.Context].FileIdx
			byNum := x.cursors[file]
			if byNum == nil {
				byNum = map[uint64][]curAt{}
				x.cursors[file] = byNum
			}
			byNum[cu.Number] = append(byNum[cu.Number], curAt{int32(cu.Line), cu.ID})
		}
		for _, byNum := range x.cursors {
			for _, l := range byNum {
				sort.SliceStable(l, func(i, j int) bool { return l[i].line < l[j].line })
			}
		}
	}
	x.mu.Unlock()
	files := x.m.File.Files
	for {
		l := x.cursors[f][num]
		i := sort.Search(len(l), func(i int) bool { return l[i].line > line })
		if i > 0 {
			return l[i-1].id
		}
		if f == 0 || len(files[f].ContinuedFrom) == 0 || files[f-1].Chain != files[f].Chain {
			return model.None
		}
		f--
		line = 1 << 30
	}
}

// restatable: the cursor has a PARSING IN CURSOR block to copy.
func (x *indexes) restatable(id model.ID) bool {
	if id < 0 {
		return false
	}
	cu := &x.m.Cursors[id]
	return !cu.Implicit && cu.Context >= 0 && x.m.Statements[cu.Statement].Kind == model.StmtSQL
}

// cursorFile is the file of the cursor's PARSING IN CURSOR block.
func (x *indexes) cursorFile(id model.ID) int {
	return x.m.Contexts[x.m.Cursors[id].Context].FileIdx
}

// readLines returns up to n lines of file f from line `from` (without terminators).
func (x *indexes) readLines(f, from, n int) ([][]byte, error) {
	var raw []byte
	var err error
	if f < len(x.lis) && x.lis[f] != nil {
		raw, err = x.lis[f].Read(from, n)
	} else {
		raw, err = readLinesSlow(x.path(f), from, n)
	}
	if err != nil {
		return nil, err
	}
	var out [][]byte
	for len(raw) > 0 && len(out) < n {
		i := bytes.IndexByte(raw, '\n')
		var l []byte
		if i < 0 {
			l, raw = raw, nil
		} else {
			l, raw = raw[:i], raw[i+1:]
		}
		out = append(out, bytes.TrimSuffix(l, []byte("\r")))
	}
	return out, nil
}

func readLinesSlow(path string, from, n int) ([]byte, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	r := newLineReader(fh, nil)
	var out []byte
	for {
		ln, b, ok := r.next()
		if !ok || ln >= from+n {
			break
		}
		if ln >= from {
			out = append(append(out, b...), '\n')
		}
	}
	return out, r.err
}

// parsingBlock is the PARSING IN CURSOR block of a cursor: the separator
// before it (when there is one) through END OF STMT, and its first line.
//
// A cursor that was open before tracing started and adopted by a later
// parse (model.Builder.adoptImplicit) has the line of its first use: its
// block is the next PARSING IN CURSOR of its number.
func (x *indexes) parsingBlock(id model.ID) (lines [][]byte, from int, err error) {
	f, at := x.cursorFile(id), x.m.Cursors[id].Line
	if !x.isParsing(f, at) {
		if at, err = x.findParsing(f, at, x.m.Cursors[id].Number); err != nil {
			return nil, 0, err
		}
	}
	from = at
	if at > 1 {
		if prev, err := x.readLines(f, at-1, 1); err == nil && len(prev) == 1 && bytes.HasPrefix(prev[0], []byte("=====")) {
			from = at - 1
		}
	}
	for chunk := 64; ; chunk *= 4 {
		ls, err := x.readLines(f, from, chunk)
		if err != nil {
			return nil, 0, err
		}
		var sql sqlText
		for i, l := range ls {
			switch {
			case !sql.on && bytes.HasPrefix(l, []byte("PARSING IN CURSOR #")):
				sql.start(l)
			case sql.on && sql.next(l):
				return ls[:i+1], from, nil
			}
		}
		if len(ls) < chunk {
			return ls, from, nil // a block cut by the end of the file
		}
	}
}

// adoption is the line of the PARSING IN CURSOR that adopted a cursor open
// before tracing started (its own line is its first use); ok false for a
// cursor parsed where it was opened.
func (x *indexes) adoption(id model.ID) (int, bool) {
	x.mu.Lock()
	at, seen := x.adopted[id]
	x.mu.Unlock()
	if !seen {
		f, line := x.cursorFile(id), x.m.Cursors[id].Line
		if !x.isParsing(f, line) {
			if l, err := x.findParsing(f, line, x.m.Cursors[id].Number); err == nil {
				at = l
			}
		}
		x.mu.Lock()
		if x.adopted == nil {
			x.adopted = map[model.ID]int{}
		}
		x.adopted[id] = at
		x.mu.Unlock()
	}
	return at, at > 0
}

func (x *indexes) isParsing(f, line int) bool {
	ls, err := x.readLines(f, line, 1)
	return err == nil && len(ls) == 1 && bytes.HasPrefix(ls[0], []byte("PARSING IN CURSOR #"))
}

// findParsing is the line of the first PARSING IN CURSOR #num after line in file f.
func (x *indexes) findParsing(f, line int, num uint64) (int, error) {
	fh, err := os.Open(x.path(f))
	if err != nil {
		return 0, err
	}
	defer fh.Close()
	var li *trace.LineIndex
	if f < len(x.lis) {
		li = x.lis[f]
	}
	r := newLineReader(fh, li)
	r.seek(line)
	want := []byte("PARSING IN CURSOR #" + strconv.FormatUint(num, 10) + " ")
	for {
		ln, b, ok := r.next()
		if !ok {
			return 0, fmt.Errorf("cursor #%d: no PARSING IN CURSOR after line %d", num, line)
		}
		if bytes.HasPrefix(b, want) {
			return ln, nil
		}
	}
}

// isStat: line of file f is a STAT line.
func (x *indexes) isStat(f, line int) bool {
	ls, err := x.readLines(f, line, 1)
	return err == nil && len(ls) == 1 && bytes.HasPrefix(ls[0], []byte("STAT #"))
}

// sqlText follows the statement text of a PARSING IN CURSOR block as the
// parser does: an END OF STMT line ends it only once len= bytes (less a
// small slack) were collected, so a statement whose text holds trace-like
// lines (an "END OF STMT", markers, calls) stays one block.
type sqlText struct {
	on               bool
	want, got, lines int
}

const lenSlack = 4 // as trace.Parser

// start begins a block at its PARSING IN CURSOR line.
func (t *sqlText) start(header []byte) {
	t.on, t.got, t.lines = true, 0, 0
	t.want = 0
	if i := bytes.Index(header, []byte(" len=")); i >= 0 {
		t.want = int(leadingInt(header[i+5:]))
	}
}

// next takes a line inside the block; end reports the END OF STMT that closes it.
func (t *sqlText) next(b []byte) (end bool) {
	if string(b) == "END OF STMT" && t.got >= t.want-lenSlack {
		t.on = false
		return true
	}
	if t.lines > 0 {
		t.got++
	}
	t.got += len(b)
	t.lines++
	return false
}

// lineReader reads the lines of a file in order; seek jumps ahead through
// the line index's checkpoints.
type lineReader struct {
	f    *os.File
	br   *bufio.Reader
	li   *trace.LineIndex
	line int // number of the next line
	buf  []byte
	err  error
}

func newLineReader(f *os.File, li *trace.LineIndex) *lineReader {
	return &lineReader{f: f, br: bufio.NewReaderSize(f, 1<<20), li: li, line: 1}
}

// seek makes line the next one, skipping (or jumping over) the lines before it.
func (r *lineReader) seek(line int) {
	if r.li != nil && line > r.line+4096 {
		if cp, off := r.li.Checkpoint(line); cp > r.line {
			if _, err := r.f.Seek(off, io.SeekStart); err == nil {
				r.br.Reset(r.f)
				r.line = cp
			}
		}
	}
	for r.line < line {
		if _, _, ok := r.next(); !ok {
			return
		}
	}
}

// next returns the next line (number, text without terminator; valid until the next call).
func (r *lineReader) next() (int, []byte, bool) {
	r.buf = r.buf[:0]
	for {
		chunk, err := r.br.ReadSlice('\n')
		r.buf = append(r.buf, chunk...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if err != io.EOF {
				r.err = err
			}
			if len(r.buf) == 0 {
				return r.line, nil, false
			}
		}
		break
	}
	b := bytes.TrimSuffix(bytes.TrimSuffix(r.buf, []byte("\n")), []byte("\r"))
	ln := r.line
	r.line++
	return ln, b, true
}
