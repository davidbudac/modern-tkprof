package trace

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"strings"
	"unsafe"
)

// Stats summarises one parse run.
type Stats struct {
	Lines   int
	Bytes   int64
	Kinds   [kindCount]int
	Unknown int
	MaxLine int // longest physical line in bytes
}

// Add accumulates o into s (summing the runs of several files).
func (s *Stats) Add(o Stats) {
	s.Lines += o.Lines
	s.Bytes += o.Bytes
	s.Unknown += o.Unknown
	for i := range s.Kinds {
		s.Kinds[i] += o.Kinds[i]
	}
	if o.MaxLine > s.MaxLine {
		s.MaxLine = o.MaxLine
	}
}

// Count returns the number of lines of the given kind.
func (s *Stats) Count(k Kind) int { return s.Kinds[k] }

// Parser is the streaming state machine. Create one per file with New.
type Parser struct {
	h     Handler
	stats Stats
	line  int

	inHeader bool

	// PARSING IN CURSOR text collection
	cur       *CursorHeader
	textBuf   []byte
	textLines int

	// PARSE ERROR text collection
	perr    *ParseError
	perrGot int

	// BINDS collection
	binds   *BindSet
	inValue bool // the previous bind line was a value (continuations may follow)

	crlf    bool // file uses CRLF line endings (decided on the first line)
	textGot int  // bytes of statement text collected so far (PARSING IN CURSOR)
	intern  map[string]string
	bindBuf BindSet
	arena   []byte // chunk that bind values are copied into (see str)
}

// lenSlack is how many bytes short of len= the collected statement text may
// be for an "END OF STMT" line to count as the terminator. Oracle's len=
// often exceeds the printed text by one byte (a terminator), so a literal
// "END OF STMT" line inside the statement text is only mistaken for the real
// one if it sits within the last few bytes of the statement.
const lenSlack = 4

// New returns a parser that reports records to h.
func New(h Handler) *Parser {
	return &Parser{h: h, inHeader: true, intern: make(map[string]string, 256)}
}

// Parse reads a whole trace file from r.
func Parse(r io.Reader, h Handler) (Stats, error) {
	p := New(h)
	return p.Run(r)
}

// ParseFile parses the file at path.
func ParseFile(path string, h Handler) (Stats, error) {
	f, err := os.Open(path)
	if err != nil {
		return Stats{}, err
	}
	defer f.Close()
	return Parse(f, h)
}

// Run consumes r until EOF. It returns the first I/O error, if any.
func (p *Parser) Run(r io.Reader) (Stats, error) {
	br := bufio.NewReaderSize(r, 1<<20)
	var long []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			long = append(long[:0], chunk...)
			for err == bufio.ErrBufferFull {
				chunk, err = br.ReadSlice('\n')
				long = append(long, chunk...)
			}
			chunk = long
		}
		if len(chunk) > 0 {
			p.stats.Bytes += int64(len(chunk))
			p.stats.Lines++
			p.line++
			if len(chunk) > p.stats.MaxLine {
				p.stats.MaxLine = len(chunk)
			}
			line := chunk
			if n := len(line); n > 0 && line[n-1] == '\n' {
				line = line[:n-1]
			}
			if p.line == 1 {
				p.crlf = len(line) > 0 && line[len(line)-1] == '\r'
			}
			if p.crlf {
				line = trimCR(line)
			}
			p.processLine(line)
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			return p.stats, err
		}
	}
	p.finish()
	return p.stats, nil
}

// Line returns the current 1-based line number (valid inside handler callbacks).
func (p *Parser) Line() int { return p.line }

func (p *Parser) count(k Kind) { p.stats.Kinds[k]++ }

func (p *Parser) unknown(line []byte) {
	p.count(KindUnknown)
	p.stats.Unknown++
	p.h.Unknown(p.line, line)
}

func (p *Parser) processLine(line []byte) {
	if p.cur != nil {
		if string(line) == "END OF STMT" && len(p.textBuf) >= p.cur.Len-lenSlack {
			p.count(KindEndOfStmt)
			p.finishCursor()
			return
		}
		p.count(KindSQLText)
		if p.textLines > 0 {
			p.textBuf = append(p.textBuf, '\n')
		}
		p.textBuf = append(p.textBuf, line...)
		p.textLines++
		return
	}
	if p.perr != nil {
		if p.perrConsume(line) {
			return
		}
	}
	if p.binds != nil {
		if hasPrefix(line, "*** ") {
			// a wall-clock marker can land inside a BINDS block (between
			// "BINDS #" and " Bind#0", or between " Bind#0" and its oacdty):
			// handle it as a marker and keep collecting binds
			p.inHeader = false
			p.marker(line[4:])
			return
		}
		if p.bindLine(line) {
			return
		}
		p.flushBinds()
	}
	p.classify(line)
}

func (p *Parser) finishCursor() {
	c := *p.cur
	c.Text = string(p.textBuf)
	p.cur = nil
	p.textBuf = p.textBuf[:0]
	p.textLines = 0
	p.h.Cursor(c)
}

// perrConsume collects PARSE ERROR statement text. Oracle prints the text
// without an END OF STMT terminator, so we stop after len= bytes or when a
// line is unmistakably a trace line.
func (p *Parser) perrConsume(line []byte) bool {
	if looksLikeTraceLine(line) {
		p.finishPerr()
		return false
	}
	p.count(KindSQLText)
	if p.textLines > 0 {
		p.textBuf = append(p.textBuf, '\n')
		p.perrGot++
	}
	p.textBuf = append(p.textBuf, line...)
	p.perrGot += len(line)
	p.textLines++
	if p.perrGot > p.perr.Len {
		p.finishPerr()
	}
	return true
}

func (p *Parser) finishPerr() {
	e := *p.perr
	e.Text = string(bytes.TrimRight(p.textBuf, "\n"))
	p.perr = nil
	p.perrGot = 0
	p.textBuf = p.textBuf[:0]
	p.textLines = 0
	p.h.ParseError(e)
}

func (p *Parser) finish() {
	if p.cur != nil {
		p.finishCursor()
	}
	if p.perr != nil {
		p.finishPerr()
	}
	if p.binds != nil {
		p.flushBinds()
	}
}

// looksLikeTraceLine is a conservative check used only to terminate free-text
// sections (PARSE ERROR text, bind value continuations).
func looksLikeTraceLine(line []byte) bool {
	if len(line) == 0 {
		return false
	}
	switch line[0] {
	case '*':
		return hasPrefix(line, "*** ")
	case '=':
		return hasPrefix(line, "=====")
	case 'P':
		return hasPrefix(line, "PARSE #") || hasPrefix(line, "PARSING IN CURSOR #") || hasPrefix(line, "PARSE ERROR #")
	case 'E':
		return hasPrefix(line, "EXEC #") || hasPrefix(line, "ERROR #") || string(line) == "END OF STMT"
	case 'F':
		return hasPrefix(line, "FETCH #")
	case 'C':
		return hasPrefix(line, "CLOSE #")
	case 'W':
		return hasPrefix(line, "WAIT #")
	case 'S':
		return hasPrefix(line, "STAT #")
	case 'B':
		return hasPrefix(line, "BINDS #")
	case 'X':
		return hasPrefix(line, "XCTEND ")
	case 'L':
		return isLobLine(line)
	case 'R':
		return hasPrefix(line, "RPC CALL:") || hasPrefix(line, "RPC BINDS:") || hasPrefix(line, "RPC EXEC:")
	}
	return false
}

// isLobLine matches "LOB<UPPER>:" at the start of the line.
func isLobLine(line []byte) bool {
	if !hasPrefix(line, "LOB") {
		return false
	}
	for i := 3; i < len(line); i++ {
		c := line[i]
		if c == ':' {
			return i > 3
		}
		if c < 'A' || c > 'Z' {
			return false
		}
	}
	return false
}

func (p *Parser) classify(line []byte) {
	if len(bytes.TrimSpace(line)) == 0 {
		p.count(KindBlank)
		return
	}
	switch line[0] {
	case '*':
		if hasPrefix(line, "*** ") {
			p.inHeader = false
			p.marker(line[4:])
			return
		}
	case '=':
		if hasPrefix(line, "=====") {
			p.inHeader = false
			p.count(KindSeparator)
			p.h.Separator(p.line)
			return
		}
	case 'P':
		switch {
		case hasPrefix(line, "PARSING IN CURSOR #"):
			p.parsingInCursor(line[18:])
			return
		case hasPrefix(line, "PARSE ERROR #"):
			p.parseError(line[12:])
			return
		case hasPrefix(line, "PARSE #"):
			p.call(CallParse, line[6:])
			return
		}
	case 'E':
		switch {
		case hasPrefix(line, "EXEC #"):
			p.call(CallExec, line[5:])
			return
		case hasPrefix(line, "ERROR #"):
			p.errorLine(line[6:])
			return
		}
	case 'F':
		if hasPrefix(line, "FETCH #") {
			p.call(CallFetch, line[6:])
			return
		}
	case 'C':
		if hasPrefix(line, "CLOSE #") {
			p.call(CallClose, line[6:])
			return
		}
	case 'W':
		if hasPrefix(line, "WAIT #") {
			p.wait(line[5:])
			return
		}
	case 'S':
		if hasPrefix(line, "STAT #") {
			p.stat(line[5:])
			return
		}
		if hasPrefix(line, "SORT UNMAP #") {
			p.call(CallUnmap, line[11:])
			return
		}
	case 'B':
		if hasPrefix(line, "BINDS #") {
			p.startBinds(line[6:], false)
			return
		}
	case 'X':
		if hasPrefix(line, "XCTEND ") {
			p.xctend(line[7:])
			return
		}
	case 'L':
		if isLobLine(line) {
			p.lob(line)
			return
		}
	case 'R':
		switch {
		case hasPrefix(line, "RPC CALL:"):
			p.count(KindRPC)
			p.h.RPCCall(RPCCall{Line: p.line, Text: string(bytes.TrimSpace(line[9:]))})
			return
		case hasPrefix(line, "RPC BINDS:"):
			p.count(KindRPC)
			p.newBinds(BindSet{Line: p.line, IsRPC: true})
			p.inValue = false
			return
		case hasPrefix(line, "RPC EXEC:"):
			p.count(KindRPC)
			c := Call{Line: p.line, Kind: CallRPCExec}
			p.callFields(&c, bytes.TrimSpace(line[9:]))
			p.h.Call(c)
			return
		}
	case 'U':
		if hasPrefix(line, "UNMAP #") {
			p.call(CallUnmap, line[6:])
			return
		}
	}
	if p.inHeader {
		p.header(line)
		return
	}
	p.unknown(line)
}

// header handles the prologue lines ("Trace file ...", "Node name: ...").
func (p *Parser) header(line []byte) {
	p.count(KindHeader)
	h := Header{Line: p.line}
	switch {
	case hasPrefix(line, "Trace file "):
		h.Key, h.Value = "Trace file", string(bytes.TrimSpace(line[11:]))
	case hasPrefix(line, "Oracle Database "), hasPrefix(line, "Oracle AI Database "): // 23ai+ renamed the banner
		h.Key, h.Value = "Oracle Database", string(line)
	case hasPrefix(line, "Version ") && !bytes.Contains(line, []byte(":")):
		h.Key, h.Value = "Oracle Version", string(bytes.TrimSpace(line[8:]))
	default:
		if i := bytes.IndexByte(line, ':'); i > 0 {
			h.Key = string(bytes.TrimSpace(line[:i]))
			h.Value = string(bytes.TrimSpace(line[i+1:]))
		} else {
			h.Key = string(bytes.TrimSpace(line))
		}
	}
	p.h.HeaderLine(h)
}

func (p *Parser) marker(rest []byte) {
	p.count(KindMarker)
	m := Marker{Line: p.line}
	if len(rest) > 0 && isDigit(rest[0]) {
		n := timestampEnd(rest)
		if t, ok := parseTimestamp(rest[:n]); ok {
			m.Kind = MarkerTimestamp
			m.Time, m.HasTime = t, true
			tail := bytes.TrimSpace(rest[n:])
			if len(tail) >= 2 && tail[0] == '(' && tail[len(tail)-1] == ')' {
				m.Container = string(tail[1 : len(tail)-1])
			}
			p.h.Marker(m)
			return
		}
	}
	if i := bytes.Index(rest, []byte(":(")); i > 0 {
		key := rest[:i]
		m.Key = string(key)
		m.Kind = markerKindFor(key)
		body := rest[i+2:]
		if sp := bytes.LastIndexByte(body, ' '); sp >= 0 {
			if t, ok := parseTimestamp(body[sp+1:]); ok {
				m.Time, m.HasTime = t, true
				body = body[:sp]
			}
		}
		body = bytes.TrimSpace(body)
		if n := len(body); n > 0 && body[n-1] == ')' {
			body = body[:n-1]
		}
		m.Value = string(body)
		p.h.Marker(m)
		return
	}
	text := bytes.TrimSpace(rest)
	if hasPrefix(text, "Unix process pid:") {
		// trcsess from 23ai: "*** Unix process pid:       2013" (no brackets)
		m.Kind = MarkerProcess
		m.Key = "Unix process pid"
		m.Value = string(bytes.TrimSpace(text[len("Unix process pid:"):]))
		m.Text = string(text)
		p.h.Marker(m)
		return
	}
	if hasPrefix(text, "[ ") && bytes.HasSuffix(text, []byte(" ]")) {
		// trcsess session switch: "*** [ Unix process pid: 133531 ]"
		inner := bytes.TrimSpace(text[2 : len(text)-2])
		m.Kind = MarkerProcess
		if i := bytes.LastIndexByte(inner, ':'); i >= 0 {
			m.Key = string(bytes.TrimSpace(inner[:i]))
			m.Value = string(bytes.TrimSpace(inner[i+1:]))
		} else {
			m.Value = string(inner)
		}
		m.Text = string(text)
		p.h.Marker(m)
		return
	}
	stripStars := func(b []byte) string {
		b = bytes.TrimSuffix(b, []byte("***"))
		return string(bytes.TrimSpace(b))
	}
	switch {
	case bytes.Contains(text, []byte("CONTINUED FROM FILE ")):
		m.Kind = MarkerTraceContinuedFrom
		m.Value = stripStars(text[bytes.Index(text, []byte("FROM FILE "))+10:])
	case bytes.Contains(text, []byte("CONTINUES IN FILE ")):
		m.Kind = MarkerTraceContinuesIn
		m.Value = stripStars(text[bytes.Index(text, []byte("IN FILE "))+8:])
	case hasPrefix(text, "DUMP FILE SIZE IS LIMITED TO "):
		m.Kind = MarkerDumpSizeLimit
		v := text[29:]
		if sp := bytes.IndexByte(v, ' '); sp > 0 {
			v = v[:sp]
		}
		m.Value = string(v)
	case hasPrefix(text, "TRACE FILE RECREATED"):
		m.Kind = MarkerFileRecreated
	default:
		m.Kind = MarkerOther
	}
	m.Text = string(text)
	p.h.Marker(m)
}

func markerKindFor(key []byte) MarkerKind {
	switch string(key) {
	case "SESSION ID":
		return MarkerSessionID
	case "CLIENT ID":
		return MarkerClientID
	case "SERVICE NAME":
		return MarkerServiceName
	case "MODULE NAME":
		return MarkerModuleName
	case "ACTION NAME":
		return MarkerActionName
	case "CLIENT DRIVER":
		return MarkerClientDriver
	case "CONTAINER ID":
		return MarkerContainerID
	case "CLIENT IP":
		return MarkerClientIP
	case "CONNECTION ID":
		return MarkerConnectionID
	}
	return MarkerOther
}

func unquote(v []byte) []byte {
	if n := len(v); n >= 2 && v[0] == '\'' && v[n-1] == '\'' {
		return v[1 : n-1]
	}
	return v
}

func (p *Parser) parsingInCursor(b []byte) {
	num, rest, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	p.count(KindParsingInCursor)
	c := CursorHeader{Line: p.line, TextLine: p.line + 1, Cursor: num}
	eachKV(rest, ' ', func(k, v []byte) {
		switch string(k) {
		case "len":
			n, _ := atoi(v)
			c.Len = int(n)
		case "dep":
			n, _ := atoi(v)
			c.Dep = int(n)
		case "uid":
			n, _ := atoi(v)
			c.UID = int(n)
		case "oct":
			n, _ := atoi(v)
			c.OCT = int(n)
		case "lid":
			n, _ := atoi(v)
			c.LID = int(n)
		case "tim":
			c.Tim, _ = atoi(v)
		case "hv":
			c.HV, _ = atou(v)
		case "ad":
			c.Addr = string(unquote(v))
		case "sqlid":
			c.SQLID = p.internBytes(unquote(v))
		}
	})
	p.cur = &c
	p.textBuf = p.textBuf[:0]
	p.textLines = 0
}

func (p *Parser) parseError(b []byte) {
	num, rest, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	p.count(KindParseError)
	if len(rest) > 0 && rest[0] == ':' {
		rest = rest[1:]
	}
	e := ParseError{Line: p.line, Cursor: num}
	eachKV(rest, ' ', func(k, v []byte) {
		n, _ := atoi(v)
		switch string(k) {
		case "len":
			e.Len = int(n)
		case "dep":
			e.Dep = int(n)
		case "uid":
			e.UID = int(n)
		case "oct":
			e.OCT = int(n)
		case "lid":
			e.LID = int(n)
		case "tim":
			e.Tim = n
		case "err":
			e.Err = int(n)
		}
	})
	p.perr = &e
	p.perrGot = 0
	p.textBuf = p.textBuf[:0]
	p.textLines = 0
}

func (p *Parser) call(kind CallKind, b []byte) {
	num, rest, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	p.count(KindCall)
	if len(rest) > 0 && rest[0] == ':' {
		rest = rest[1:]
	}
	c := Call{Line: p.line, Kind: kind, Cursor: num}
	p.callFields(&c, rest)
	p.h.Call(c)
}

func (p *Parser) callFields(c *Call, rest []byte) {
	eachKV(rest, ',', func(k, v []byte) {
		switch string(k) {
		case "c":
			c.C, _ = atoi(v)
		case "e":
			c.E, _ = atoi(v)
		case "p":
			c.P, _ = atoi(v)
		case "cr":
			c.CR, _ = atoi(v)
		case "cu":
			c.CU, _ = atoi(v)
		case "mis":
			c.Mis, _ = atoi(v)
		case "r":
			c.R, _ = atoi(v)
		case "dep":
			n, _ := atoi(v)
			c.Dep = int(n)
		case "og":
			n, _ := atoi(v)
			c.OG = int(n)
		case "plh":
			c.PLH, _ = atou(v)
		case "tim":
			c.Tim, _ = atoi(v)
		case "type":
			if n, ok := atoi(v); ok {
				c.Type = int(n)
			} else {
				c.LobType = p.internBytes(v)
			}
		case "bytes":
			c.Bytes, _ = atoi(v)
		}
	})
}

func (p *Parser) errorLine(b []byte) {
	num, rest, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	p.count(KindError)
	if len(rest) > 0 && rest[0] == ':' {
		rest = rest[1:]
	}
	e := Error{Line: p.line, Cursor: num}
	eachKV(rest, ' ', func(k, v []byte) {
		n, _ := atoi(v)
		switch string(k) {
		case "err":
			e.Err = int(n)
		case "tim":
			e.Tim = n
		}
	})
	p.h.Error(e)
}

func (p *Parser) xctend(rest []byte) {
	p.count(KindXctend)
	x := Xctend{Line: p.line}
	eachKV(rest, ',', func(k, v []byte) {
		n, _ := atoi(v)
		switch string(k) {
		case "rlbk":
			x.Rlbk = int(n)
		case "rd_only":
			x.RdOnly = int(n)
		case "tim":
			x.Tim = n
		}
	})
	p.h.Xctend(x)
}

func (p *Parser) wait(b []byte) {
	num, rest, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	i := bytes.Index(rest, []byte("nam='"))
	if i < 0 {
		p.unknown(b)
		return
	}
	rest = rest[i+5:]
	j := bytes.Index(rest, []byte("' ela="))
	if j < 0 {
		p.unknown(b)
		return
	}
	p.count(KindWait)
	w := Wait{Line: p.line, Cursor: num, Name: p.internBytes(rest[:j])}
	rest = bytes.TrimLeft(rest[j+6:], " ")
	k := bytes.IndexByte(rest, ' ')
	if k < 0 {
		w.Ela, _ = atoi(rest)
		p.h.Wait(w)
		return
	}
	w.Ela, _ = atoi(rest[:k])
	rest = rest[k+1:]
	for len(rest) > 0 {
		eq := bytes.IndexByte(rest, '=')
		if eq < 0 {
			break
		}
		key := bytes.TrimSpace(rest[:eq])
		var val []byte
		if sp := bytes.IndexByte(rest[eq+1:], ' '); sp < 0 {
			val = rest[eq+1:]
			rest = nil
		} else {
			val = rest[eq+1 : eq+1+sp]
			rest = rest[eq+1+sp+1:]
		}
		switch string(key) {
		case "obj#":
			w.ObjID, _ = atoi(val)
			w.HasObj = true
		case "tim":
			w.Tim, _ = atoi(val)
		default:
			if w.NParams < 3 {
				prm := Param{Name: p.internBytes(key)}
				if n, ok := atoi(val); ok {
					prm.Value = n
				} else {
					prm.Raw = string(val)
				}
				w.Params[w.NParams] = prm
				w.NParams++
			}
		}
	}
	p.h.Wait(w)
}

func (p *Parser) stat(b []byte) {
	num, rest, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	opIdx := bytes.Index(rest, []byte(" op='"))
	if opIdx < 0 {
		p.unknown(b)
		return
	}
	p.count(KindStat)
	s := Stat{Line: p.line, Cursor: num}
	eachKV(rest[:opIdx], ' ', func(k, v []byte) {
		n, _ := atoi(v)
		switch string(k) {
		case "id":
			s.ID = int(n)
		case "cnt":
			s.Cnt = n
		case "pid":
			s.ParentID = int(n)
		case "pos":
			s.Pos = int(n)
		case "obj":
			s.Obj = n
		}
	})
	op := rest[opIdx+5:]
	if n := len(op); n > 0 && op[n-1] == '\'' {
		op = op[:n-1]
	}
	if n := len(op); n > 0 && op[n-1] == ')' {
		if k := bytes.LastIndexByte(op, '('); k >= 0 {
			inner := op[k+1 : n-1]
			if bytes.HasPrefix(inner, []byte("cr=")) {
				s.HasStats = true
				s.Cost, s.Size, s.Card = -1, -1, -1
				eachKV(inner, ' ', func(key, val []byte) {
					v, _ := atoi(val)
					switch string(key) {
					case "cr":
						s.CR = v
					case "pr":
						s.PR = v
					case "pw":
						s.PW = v
					case "str":
						s.Str = v
					case "time":
						s.TimeUs = v
					case "cost":
						s.Cost = v
					case "size":
						s.Size = v
					case "card":
						s.Card = v
					}
				})
				op = bytes.TrimRight(op[:k], " ")
			}
		}
	}
	s.Op = string(op)
	p.h.Stat(s)
}

func (p *Parser) lob(line []byte) {
	colon := bytes.IndexByte(line, ':')
	op := line[:colon]
	p.count(KindLob)
	c := Call{Line: p.line, Kind: lobKind(op), Op: p.internBytes(op)}
	p.callFields(&c, bytes.TrimSpace(line[colon+1:]))
	p.h.Call(c)
}

func lobKind(op []byte) CallKind {
	switch string(op) {
	case "LOBREAD":
		return CallLobRead
	case "LOBWRITE":
		return CallLobWrite
	case "LOBGETLEN":
		return CallLobGetLen
	case "LOBPGSIZE":
		return CallLobPgSize
	case "LOBAPPEND":
		return CallLobAppend
	case "LOBTMPFRE":
		return CallLobTmpFre
	case "LOBARRTMPFRE":
		return CallLobArrTmpFre
	case "LOBARRREAD":
		return CallLobArrRead
	case "LOBARRWRITE":
		return CallLobArrWrite
	case "LOBTRIM":
		return CallLobTrim
	}
	return CallLobOther
}

func (p *Parser) startBinds(b []byte, rpc bool) {
	num, _, ok := cursorNumber(b)
	if !ok {
		p.unknown(b)
		return
	}
	p.count(KindBinds)
	p.newBinds(BindSet{Line: p.line, Cursor: num, IsRPC: rpc})
	p.inValue = false
}

// newBinds starts a BINDS block in the parser's reusable BindSet: the Binds
// slice keeps its capacity from block to block (the handler gets a view that
// is only valid during the Binds callback, see Handler).
func (p *Parser) newBinds(bs BindSet) {
	bs.Binds = p.bindBuf.Binds[:0]
	p.bindBuf = bs
	p.binds = &p.bindBuf
}

func (p *Parser) flushBinds() {
	bs := p.binds
	p.binds = nil
	p.inValue = false
	p.h.Binds(*bs)
}

func (p *Parser) curBind() *Bind {
	if n := len(p.binds.Binds); n > 0 {
		return &p.binds.Binds[n-1]
	}
	return nil
}

// bindLine consumes one line of a BINDS block; it returns false when the line
// does not belong to the block (which is how the block ends).
func (p *Parser) bindLine(line []byte) bool {
	switch {
	case hasPrefix(line, " Bind#"):
		n, _ := atoi(line[6:])
		p.binds.Binds = append(p.binds.Binds, Bind{Line: p.line, Pos: int(n)})
		p.inValue = false
		p.count(KindBindLine)
		return true
	case hasPrefix(line, " bind "): // legacy "bind 0: dty=..." (RPC binds, pre-11g)
		rest := line[6:]
		b := Bind{Line: p.line}
		if c := bytes.IndexByte(rest, ':'); c > 0 {
			n, _ := atoi(rest[:c])
			b.Pos = int(n)
			rest = rest[c+1:]
		}
		p.binds.Binds = append(p.binds.Binds, b)
		p.bindFields(p.curBind(), rest)
		p.inValue = false
		p.count(KindBindLine)
		return true
	case hasPrefix(line, "  oacdty="), hasPrefix(line, "  oacflg="), hasPrefix(line, "  kxsbbbfp="):
		if b := p.curBind(); b != nil {
			p.bindFields(b, line)
		}
		p.inValue = false
		p.count(KindBindLine)
		return true
	case hasPrefix(line, "  value="), hasPrefix(line, " value=Unhandled datatype"): // 23ai indents the latter by one space
		if b := p.curBind(); b != nil {
			off := 8
			if line[1] != ' ' {
				off = 7
			}
			b.Value = p.str(line[off:])
			b.HasValue = true
			if strings.HasSuffix(b.Value, `"...`) {
				b.Truncated = true
			}
			p.inValue = true
		}
		p.count(KindBindLine)
		return true
	case hasPrefix(line, "  No oacdef for this bind."):
		if b := p.curBind(); b != nil {
			b.NoOacdef = true
		}
		p.inValue = false
		p.count(KindBindLine)
		return true
	case string(line) == "kkscoacd":
		p.count(KindBindLine)
		return true
	case hasPrefix(line, "Dump of memory from "), hasPrefix(line, "Dumping "), hasPrefix(line, "toid ptr value="):
		// memory dumps of TIMESTAMP / INTERVAL / collection bind values
		if b := p.curBind(); b != nil {
			b.IsDump = true
			b.HasValue = true
			b.Value = appendLine(b.Value, line)
			p.inValue = true
			p.count(KindBindLine)
			return true
		}
	case len(line) == 0:
		if b := p.curBind(); b != nil && p.inValue && !b.IsDump && openQuoted(b.Value) {
			b.Value += "\n"
			p.count(KindBindLine)
			return true
		}
		return true // blank lines inside bind blocks are noise
	}
	if p.inValue {
		if looksLikeTraceLine(line) {
			return false
		}
		b := p.curBind()
		if b == nil {
			return false
		}
		if b.IsDump && isHexDumpLine(line) {
			b.Value = appendLine(b.Value, line)
			p.count(KindBindLine)
			return true
		}
		if !b.IsDump && openQuoted(b.Value) {
			b.Value = appendLine(b.Value, line)
			p.count(KindBindLine)
			return true
		}
	}
	return false
}

func appendLine(s string, line []byte) string {
	if s == "" {
		return string(line)
	}
	return s + "\n" + string(line)
}

// openQuoted reports whether a printed value started with a double quote
// that has not been closed yet (multi-line character value). Oracle cuts long
// values and prints `"...` after the closing quote.
func openQuoted(v string) bool {
	if len(v) == 0 || v[0] != '"' {
		return false
	}
	if strings.HasSuffix(v, `"...`) {
		return false
	}
	return len(v) == 1 || v[len(v)-1] != '"'
}

func isHexDumpLine(line []byte) bool {
	if len(line) < 8 {
		return false
	}
	for i := 0; i < 8; i++ {
		c := line[i]
		if !(isDigit(c) || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func (p *Parser) bindFields(b *Bind, line []byte) {
	// a hand-rolled scan of "key=value key=value ..." (a bind block has about
	// ten such lines per bind, so this is the hottest loop of a bind-heavy trace)
	for len(line) > 0 {
		i := 0
		for i < len(line) && line[i] == ' ' {
			i++
		}
		line = line[i:]
		j := 0
		for j < len(line) && line[j] != ' ' {
			j++
		}
		tok := line[:j]
		line = line[j:]
		eq := bytes.IndexByte(tok, '=')
		if eq <= 0 {
			continue
		}
		k, v := tok[:eq], tok[eq+1:]
		switch string(k) {
		case "oacdty", "dty":
			n, _ := atoi(v)
			b.Dty = int(n)
		case "mxl":
			if i := bytes.IndexByte(v, '('); i >= 0 {
				n, _ := atoi(v[:i])
				b.Mxl = int(n)
				if j := bytes.IndexByte(v[i:], ')'); j > 0 {
					m, _ := atoi(v[i+1 : i+j])
					b.MxlP = int(m)
				}
			} else {
				n, _ := atoi(v)
				b.Mxl = int(n)
			}
		case "mxlc":
			n, _ := atoi(v)
			b.Mxlc = int(n)
		case "mal":
			n, _ := atoi(v)
			b.Mal = int(n)
		case "scl":
			n, _ := atoi(v)
			b.Scl = int(n)
		case "pre":
			n, _ := atoi(v)
			b.Pre = int(n)
		case "oacflg":
			b.Oacflg = p.internBytes(v)
		case "fl2", "oacfl2":
			b.Fl2 = p.internBytes(v)
		case "frm":
			n, _ := atoi(v)
			b.Frm = int(n)
		case "csi":
			n, _ := atoi(v)
			b.Csi = int(n)
		case "siz", "size":
			n, _ := atoi(v)
			b.Siz = int(n)
		case "off", "offset":
			n, _ := atoi(v)
			b.Off = int(n)
		case "kxsbbbfp", "bfp":
			// the buffer address is distinct per bind and nothing reads it: not kept
		case "bln":
			n, _ := atoi(v)
			b.Bln = int(n)
		case "avl":
			n, _ := atoi(v)
			b.Avl = int(n)
		case "flg":
			n, _ := atoi(v)
			b.Flg = int(n)
		}
	}
}

// arenaChunk is the size of the chunks bind values are packed into: one
// allocation per ~64 KB of values instead of one per value.
const arenaChunk = 64 << 10

// str copies b into the current arena chunk and returns it as a string. The
// chunk is never reused, so the string stays valid; values that outlive the
// parse keep their chunk alive, which is what a retained bind value costs
// anyway.
func (p *Parser) str(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	if len(b) > arenaChunk/4 {
		return string(b)
	}
	if cap(p.arena)-len(p.arena) < len(b) {
		p.arena = make([]byte, 0, arenaChunk)
	}
	n := len(p.arena)
	p.arena = append(p.arena, b...)
	return unsafe.String(&p.arena[n], len(b))
}

func (p *Parser) internBytes(b []byte) string {
	if s, ok := p.intern[string(b)]; ok {
		return s
	}
	s := string(b)
	p.intern[s] = s
	return s
}
