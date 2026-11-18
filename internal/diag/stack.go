package diag

import (
	"bytes"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The reading of a diagnostic dump (docs/PLAN-DIAG.md § The readings; the format is docs/trace-format-diag.md §
// A diagnostic dump): what an errorstack, a deadlock or an incident writes first, read as facts. It has
// seven parts, each found by the title of the dump's own section ("----- Title -----") and each read once:
// the first occurrence of a title wins, because a process state nested in the dump repeats several of them
// (the current SQL statement, the PL/SQL call stack).
//
//	start      "dbkedDefDump(): Starting a non-incident diagnostic dump (flags=0x0, level=2, mask=0x0)"
//	error      the ORA- lines under "Error Stack Dump" and in the "error stack dump with barriers" block of an
//	           incident, the "<error barrier>" lines, "about to signal N" + "Name:", and for an incident file
//	           its problem key
//	statement  "Current SQL Statement for this session (sql_id=...)" and the text under it
//	plsql      "PL/SQL Call Stack": handle, line number, object per row, innermost first
//	frames     "Binary Stack Dump": "========== FRAME [n] (caller()+off -> callee()) ==========" and the
//	           "CALL TYPE: call   ERROR SIGNALED: no   COMPONENT: KSE" line under it; or, when the dump has
//	           no binary stack dump, the table under "Call Stack Trace" (names that wrap are joined)
//	cursors    "Dump Cursor sql_id=... " of the session's open and cached cursors, with the statement's first
//	           line and the "Bind Info (kkscoacd)" block: Bind#, oacdty, avl, value
//	links      the nested process state and heap dumps of this dump (the children of its node)
//
// Both frame sources are always read; the list is the binary one when there is one and the table's else, and
// the reading says which (FramesSource) and whether the table agrees with the binary list (TableAgrees).

// Bounds of a call stack reading.
const (
	// StatementLines and StatementBytes bound the text of the current statement.
	StatementLines = 60
	StatementBytes = 16 << 10
	// CursorCap is how many cursors are listed (CursorsTotal counts them all); BindCap how many binds per cursor
	// (DumpCursor.BindCount counts them all); a value is cut at ValueCap bytes.
	CursorCap    = 100
	BindCap      = 32
	ValueCap     = 2000
	StatementCut = 200 // a cursor's statement (its first line) is cut here
	errorCap     = 20
	plsqlCap     = 200
	frameCap     = 1000
)

// CallStack is the reading of a diagnostic dump.
type CallStack struct {
	Kind  string `json:"kind"` // "callstack"
	Node  string `json:"node"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"`

	// Start are the facts of the dump's start line. Line is 0 when the node holds none (an incident file
	// without one).
	Start DumpStart `json:"start"`
	// Error is what the dump says about the error that caused it. Absent when it names none: a dump taken on
	// request (an errorstack command, an oradebug) has no ORA- line, and a dump written by an event on an error
	// names it only by the "about to signal" line at its end.
	Error *DumpError `json:"error,omitempty"`
	// Barriers are the "<error barrier> at 0x... placed dbkda.c@298" lines of the Error Stack Dump and of an
	// incident's "error stack dump with barriers": where the error stack is rooted. A dump taken on request has
	// one and no error.
	Barriers  []DumpLine     `json:"barriers"`
	Statement *DumpStatement `json:"statement,omitempty"`
	// PLSQL is the PL/SQL call stack, innermost first; PLSQLLine its title's line (0 when the dump has none).
	PLSQL     []PLSQLFrame `json:"plsql"`
	PLSQLLine int          `json:"plsqlLine,omitempty"`

	// Frames are the call stack, innermost first. FramesSource is "binary" (the frame headers of the Binary
	// Stack Dump), "table" (the Call Stack Trace table) or "none"; FramesLine the line of the title of that
	// source. BinaryFrames and TableFrames count what each source holds; TableAgrees, set when both exist, is
	// whether the table has the same functions and callees in the same order.
	Frames       []StackFrame `json:"frames"`
	FramesSource string       `json:"framesSource"`
	FramesLine   int          `json:"framesLine,omitempty"`
	BinaryFrames int          `json:"binaryFrames"`
	TableFrames  int          `json:"tableFrames"`
	TableAgrees  *bool        `json:"tableAgrees,omitempty"`
	// Own is how many leading frames belong to the dump itself (Frames[:Own], each marked own); the rule is in
	// stackrules.go.
	Own int `json:"own"`
	// ShortStack is the stack in the form oradebug short_stack prints, "f1()+off<-f2()+off<-...", innermost first;
	// ShortStackNoOwn the same without the dump's own frames.
	ShortStack      string `json:"shortStack"`
	ShortStackNoOwn string `json:"shortStackNoOwn"`

	// Cursors are the session cursor dump's cursors in file order, at most CursorCap; CursorsTotal counts them.
	Cursors      []DumpCursor `json:"cursors"`
	CursorsTotal int          `json:"cursorsTotal"`
	// Links are the process state and heap dumps nested in this dump, in file order, by node: ask api/diag/reading
	// for each.
	Links []DumpLink `json:"links"`
	Notes []string   `json:"notes"`
}

// ReadingKind is "callstack".
func (*CallStack) ReadingKind() string { return ReadingCallStack }

// DumpStart is the dump's start line.
type DumpStart struct {
	Line     int    `json:"line"`
	Incident bool   `json:"incident"` // "Starting incident default dumps" (an incident), else "Starting a non-incident diagnostic dump"
	Level    int    `json:"level"`
	Flags    string `json:"flags"` // as printed: "0x0", "0x2"
	Mask     string `json:"mask"`
	Text     string `json:"text,omitempty"` // the line, when it is not the usual one
}

// DumpLine is a line of the file with its number.
type DumpLine struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

// DumpError is what a dump says about its error.
type DumpError struct {
	// Lines are the ORA- lines, as printed ("ORA-27102: out of memory"), at most errorCap.
	Lines []DumpLine `json:"lines"`
	// Signal is the "about to signal 942" line (and the "Name:" line after it) that an event-written dump
	// ends with.
	Signal *DumpSignal `json:"signal,omitempty"`
	// Incident is set for an incident file.
	Incident *DumpIncident `json:"incident,omitempty"`
}

// DumpSignal is "about to signal 942" and "Name: MTK_NO_SUCH_TABLE".
type DumpSignal struct {
	Line int    `json:"line"`
	Code int    `json:"code"`           // 942
	ORA  string `json:"ora"`            // "ORA-00942"
	Name string `json:"name,omitempty"` // the "Name:" line after it
}

// DumpIncident is what an incident file says about its problem.
type DumpIncident struct {
	ID      string `json:"id"`      // "199651"
	Problem string `json:"problem"` // the problem key: "ORA 6544 [pevm_peruws_callback-1]"
	// Args are the bracketed arguments of the "ORA-6544 [pevm_peruws_callback-1] [27102] [] ..." line that opens
	// the file's error stack, trailing empty ones dropped: ["pevm_peruws_callback-1", "27102"].
	Args []string `json:"args"`
	Line int      `json:"line"` // that line; 0 when not found
}

// DumpStatement is the "Current SQL Statement for this session" section.
type DumpStatement struct {
	SQLID string `json:"sqlId"`
	// Text is the statement as printed (lines joined with a newline), at most StatementLines lines and
	// StatementBytes bytes; Truncated says it was cut.
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
	Title     int    `json:"title"` // the title's line
	From      int    `json:"from"`  // the first and last line of the text (From > To: the section is empty)
	To        int    `json:"to"`
}

// PLSQLFrame is a row of the PL/SQL call stack.
type PLSQLFrame struct {
	N      int    `json:"n"`      // 1 = innermost
	Handle string `json:"handle"` // "0x7b3c9620"
	Line   int    `json:"line"`   // the line number in the object
	Object string `json:"object"` // as printed: "procedure MTK.MTK_DIAG_INNER", "anonymous block"
	Type   string `json:"type"`   // "procedure", "anonymous block"
	Name   string `json:"name"`   // "MTK.MTK_DIAG_INNER"; "" for an anonymous block
	At     int    `json:"at"`     // the line of this row in the file
}

// StackFrame is a frame of the call stack.
type StackFrame struct {
	N        int    `json:"n"` // 1 = innermost
	Function string `json:"function"`
	Offset   *int   `json:"offset,omitempty"` // "+95"; absent when the frame prints none (__sighandler())
	Text     string `json:"text"`             // "ksedst1()+95" as printed
	Callee   string `json:"callee"`           // "kgdsdst()"
	Line     int    `json:"line"`             // the frame's header line (binary source) or its first line in the table
	// TableLine is the frame's line in the Call Stack Trace table, when the list is the binary one and the table
	// has the frame too.
	TableLine int  `json:"tableLine,omitempty"`
	Own       bool `json:"own,omitempty"` // a frame of the dump itself
	// Component and ErrorSignaled are the facts of the frame's "CALL TYPE: call   ERROR SIGNALED: no
	// COMPONENT: KSE" line (binary source only; "(null)" is not kept).
	Component     string `json:"component,omitempty"`
	ErrorSignaled bool   `json:"errorSignaled,omitempty"`
}

// DumpCursor is a cursor of the session cursor dump.
type DumpCursor struct {
	SQLID string `json:"sqlId"`
	// Group is "open" (Session Open Cursors) or "cached" (the Session Cached Cursor Dump).
	Group  string `json:"group"`
	Number int    `json:"number,omitempty"`    // "Cursor#3" of an open cursor
	State  string `json:"state,omitempty"`     // "BOUND", "ROW" ...
	Text   string `json:"statement,omitempty"` // the first line of the statement, at most StatementCut bytes
	From   int    `json:"from"`                // the "Dump Cursor" title's line
	To     int    `json:"to"`
	// BindCount is how many Bind# entries the cursor prints; Binds lists the first BindCap of them.
	BindCount int        `json:"bindCount"`
	Binds     []DumpBind `json:"binds"`
}

// DumpBind is a bind of a cursor ("Bind#0" under "Bind Info (kkscoacd)").
type DumpBind struct {
	Pos   int    `json:"pos"`            // the number printed after "Bind#", from 0
	Dty   int    `json:"dty"`            // oacdty
	Type  string `json:"type,omitempty"` // its name: VARCHAR2, NUMBER, DATE, ... (DTY<n> when unknown)
	NoDef bool   `json:"noDef,omitempty"`
	// Avl is the actual length ("avl=66" under kxsbbbfp); absent when not printed.
	Avl *int `json:"avl,omitempty"`
	// Value is the text after "value=" as printed (a string value keeps its quotes), cut at ValueCap bytes; Line
	// the line of the value (0: the bind prints none), LineTo its last line when it spans several.
	Value  string `json:"value,omitempty"`
	Line   int    `json:"line,omitempty"`
	LineTo int    `json:"lineTo,omitempty"`
}

// DumpLink is a dump nested in this one.
type DumpLink struct {
	Kind  string `json:"kind"` // "procstate" or "heap"
	Node  string `json:"node"`
	Title string `json:"title"`
	From  int    `json:"from"`
	To    int    `json:"to"`
}

type stackMode uint8

const (
	smNone stackMode = iota
	smErr
	smStmt
	smPLSQL
	smTable
	smBinary
	smCursor
	smBinds
)

// callStack reads the dump of a node of kind diagdump, incident or toc.
func (r *Reader) callStack(id, kind string, from, to int) (*CallStack, error) {
	cs := &CallStack{Kind: ReadingCallStack, Node: id, From: from, To: to, Lines: to - from + 1,
		PLSQL: []PLSQLFrame{}, Barriers: []DumpLine{}, Frames: []StackFrame{}, Cursors: []DumpCursor{}, Links: []DumpLink{}, Notes: []string{},
		FramesSource: "none"}
	if kind == "toc" {
		raw, err := r.src.Read(from, min(3, to-from+1))
		if err != nil {
			return nil, err
		}
		if !bytes.Contains(raw, []byte("Dump for incident ")) {
			return nil, ErrNoReading
		}
	}
	p := &stackParser{cs: cs, kind: kind, group: "open"}
	err := scanLines(r.src, from, to, func(n int, prev, line, next []byte) { p.line(n, line) })
	if err != nil {
		return nil, err
	}
	p.finish()
	cs.Links = r.dumpLinks(id, kind, cs.Start.Line, to)
	return cs, nil
}

// dumpLinks lists the process state and heap dumps nested in the lines of a dump: its children of those
// kinds. For an incident file (whose own children are its table of contents) the lines from the dump's start
// line are read as a diagnostic dump, which gives ids that api/diag/reading accepts.
func (r *Reader) dumpLinks(id, kind string, start, to int) []DumpLink {
	out := []DumpLink{}
	cid := id
	if kind != "diagdump" {
		if start == 0 {
			return out
		}
		cid = nodeID("diagdump", start, to, 1, ownProfile("diagdump"))
	}
	after := 0
	for page := 0; page < 20; page++ {
		o, err := r.children(cid, after, Cap)
		if err != nil {
			break
		}
		for _, c := range o.Children {
			if c.Kind == "procstate" || c.Kind == "heap" {
				out = append(out, DumpLink{Kind: c.Kind, Node: c.ID, Title: c.Title, From: c.From, To: c.To})
			}
		}
		if o.More == 0 {
			break
		}
		after = o.Next
	}
	return out
}

type stackParser struct {
	cs   *CallStack
	kind string

	started bool
	mode    stackMode

	// first occurrence wins
	gotErr, gotStmt, gotPLSQL, gotTable bool

	errInfo  *DumpError
	barriers bool // inside "start error stack dump with barriers" ... "end   error stack dump"
	sigNext  bool

	stmt    *DumpStatement
	stmtLen int

	plsqlN int

	// the call stack table
	cols           [4]int
	haveCols       bool
	tableHdr       int
	table          []StackFrame
	tableCaller    string
	tableCallee    string
	tableRowLine   int
	tableRowActive bool

	binary    []StackFrame
	binaryHdr int // the line of the first frame header's section title

	// cursors
	group    string
	pendNum  int
	pendSt   string
	cur      *DumpCursor
	curDone  []DumpCursor
	inValue  bool
	valBind  *DumpBind
	valQuote bool
}

func (p *stackParser) errs() *DumpError {
	if p.errInfo == nil {
		p.errInfo = &DumpError{Lines: []DumpLine{}}
	}
	return p.errInfo
}

func oraLine(t []byte) bool {
	return len(t) >= 5 && string(t[:4]) == "ORA-" && t[4] >= '0' && t[4] <= '9'
}

func (p *stackParser) line(n int, l []byte) {
	// a value that spans lines continues first
	if p.inValue {
		p.valueMore(n, l)
		return
	}
	if len(l) == 0 {
		if p.mode == smPLSQL && p.plsqlN > 0 {
			p.mode = smNone
		}
		if p.mode == smStmt && p.stmt != nil {
			p.stmtLine(n, l)
		}
		return
	}
	c := l[0]
	if c == '[' && hasPrefix(l, "[TOC") { // a marker of an incident file's table of contents
		if _, _, _, alone, ok := tocMarker(l); ok && alone {
			return
		}
	}
	if c == 'd' && !p.started && hasPrefix(l, "dbkedDefDump(): Starting") {
		p.started = true
		p.cs.Start = parseDumpStart(n, l)
		return
	}
	if c == '-' {
		if t, ok := dashTitle(l); ok {
			p.title(n, t)
			return
		}
	}
	if c == '=' && p.kind != "diagdump" && hasPrefix(l, "========= Dump for incident") {
		var f sectionFacts
		f.absorb(trace.SectionIncident, l)
		if f.incID != "" {
			e := p.errs()
			if e.Incident == nil {
				e.Incident = &DumpIncident{Args: []string{}}
			}
			e.Incident.ID, e.Incident.Problem = f.incID, f.problem
		}
		return
	}
	t := bytes.TrimLeft(l, " \t")
	// the error: ORA- lines before the start of an incident's dump (the error stack that opens the file), and
	// the lines of the barriers dump
	if !p.started && p.kind != "diagdump" && oraLine(t) {
		e := p.errs()
		if e.Incident == nil {
			e.Incident = &DumpIncident{Args: []string{}}
		}
		if e.Incident.Line == 0 {
			e.Incident.Line = n
			e.Incident.Args = bracketArgs(t)
		}
		if len(e.Lines) < errorCap {
			e.Lines = append(e.Lines, DumpLine{n, string(bytes.TrimRight(t, " \t\r"))})
		}
		return
	}
	if len(t) > 20 && t[0] == '-' && bytes.Contains(t, []byte("error stack dump with barriers")) {
		p.barriers = bytes.Contains(t, []byte("start error stack dump"))
		return
	}
	if p.sigNext {
		p.sigNext = false
		if hasPrefix(l, "Name:") && p.errInfo != nil && p.errInfo.Signal != nil {
			p.errInfo.Signal.Name = strings.TrimSpace(string(l[5:]))
			return
		}
	}
	if c == 'a' && hasPrefix(l, "about to signal ") {
		if p.errInfo == nil || p.errInfo.Signal == nil {
			if code, k := digits(l[len("about to signal "):]); k > 0 {
				e := p.errs()
				e.Signal = &DumpSignal{Line: n, Code: code, ORA: "ORA-" + pad5(code)}
				p.sigNext = true
			}
		}
		return
	}
	if p.barriers || p.mode == smErr {
		if oraLine(t) {
			if e := p.errs(); len(e.Lines) < errorCap {
				e.Lines = append(e.Lines, DumpLine{n, string(bytes.TrimRight(t, " \t\r"))})
			}
			return
		}
		if hasPrefix(t, "<error barrier>") {
			if len(p.cs.Barriers) < errorCap {
				p.cs.Barriers = append(p.cs.Barriers, DumpLine{n, string(bytes.TrimRight(t, " \t\r"))})
			}
			return
		}
	}
	if c == 'C' && hasPrefix(l, "Cursor#") {
		p.closeCursor(n - 1)
		p.pendNum, p.pendSt = 0, ""
		if num, k := digits(l[len("Cursor#"):]); k > 0 {
			p.pendNum = num
			if i := bytes.Index(l, []byte(" state=")); i >= 0 {
				rest := l[i+len(" state="):]
				j := bytes.IndexByte(rest, ' ')
				if j < 0 {
					j = len(rest)
				}
				p.pendSt = string(rest[:j])
			}
		}
		return
	}
	switch p.mode {
	case smStmt:
		p.stmtLine(n, l)
	case smPLSQL:
		p.plsqlLine(n, l)
	case smTable:
		p.tableLine(n, l)
	case smBinary:
		p.binaryLine(n, l)
	case smCursor:
		if p.cur != nil && p.cur.Text == "" && hasPrefix(t, "ObjectName:") {
			if i := bytes.Index(t, []byte("Name=")); i >= 0 {
				p.cur.Text = trunc(string(bytes.TrimRight(t[i+5:], " \t\r")), StatementCut)
			}
		}
	case smBinds:
		p.bindLine(n, l, t)
	}
}

func pad5(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 5 {
		s = "0" + s
	}
	return s
}

// bracketArgs reads the arguments of "ORA-6544 [pevm_peruws_callback-1] [27102] [] [] ...": the text in
// brackets, trailing empty ones dropped.
func bracketArgs(t []byte) []string {
	args := []string{}
	for {
		i := bytes.IndexByte(t, '[')
		if i < 0 {
			break
		}
		j := bytes.IndexByte(t[i:], ']')
		if j < 0 {
			break
		}
		args = append(args, string(t[i+1:i+j]))
		t = t[i+j+1:]
	}
	for len(args) > 0 && args[len(args)-1] == "" {
		args = args[:len(args)-1]
	}
	return args
}

// parseDumpStart reads "dbkedDefDump(): Starting a non-incident diagnostic dump (flags=0x0, level=2, mask=0x0)".
func parseDumpStart(n int, l []byte) DumpStart {
	s := DumpStart{Line: n, Incident: bytes.Contains(l, []byte("Starting incident"))}
	val := func(key string) string {
		i := bytes.Index(l, []byte(key))
		if i < 0 {
			return ""
		}
		rest := l[i+len(key):]
		j := 0
		for j < len(rest) && rest[j] != ',' && rest[j] != ')' && rest[j] != ' ' {
			j++
		}
		return string(rest[:j])
	}
	s.Flags, s.Mask = val("flags="), val("mask=")
	if lv := val("level="); lv != "" {
		s.Level, _ = strconv.Atoi(lv)
	}
	if !bytes.HasPrefix(l, []byte("dbkedDefDump(): Starting a non-incident diagnostic dump (")) &&
		!bytes.HasPrefix(l, []byte("dbkedDefDump(): Starting incident default dumps (")) {
		s.Text = trunc(string(bytes.TrimRight(l, " \r")), 200)
	}
	return s
}

// title handles a "----- Title -----" line of the dump.
func (p *stackParser) title(n int, t string) {
	cs := p.cs
	switch {
	case t == "Error Stack Dump":
		p.closeCursor(n - 1)
		p.mode = smNone
		if !p.gotErr {
			p.gotErr = true
			p.mode = smErr
		}
	case strings.HasPrefix(t, "Current SQL Statement"):
		p.closeCursor(n - 1)
		p.mode = smNone
		if !p.gotStmt {
			p.gotStmt = true
			p.mode = smStmt
			p.stmt = &DumpStatement{Title: n, From: n + 1, To: n}
			if i := strings.Index(t, "sql_id="); i >= 0 {
				id := t[i+len("sql_id="):]
				if j := strings.IndexAny(id, ") "); j >= 0 {
					id = id[:j]
				}
				p.stmt.SQLID = id
			}
			cs.Statement = p.stmt
		}
	case t == "PL/SQL Call Stack":
		p.closeCursor(n - 1)
		p.mode = smNone
		if !p.gotPLSQL {
			p.gotPLSQL = true
			p.mode = smPLSQL
			cs.PLSQLLine = n
		}
	case t == "Call Stack Trace":
		p.closeCursor(n - 1)
		p.mode = smNone
		if !p.gotTable {
			p.gotTable = true
			p.mode = smTable
			p.tableHdr = n
		}
	case t == "Binary Stack Dump":
		p.closeCursor(n - 1)
		p.mode = smNone
		if p.binaryHdr == 0 {
			p.mode = smBinary
			p.binaryHdr = n
		}
	case t == "Session Open Cursors":
		p.closeCursor(n - 1)
		p.group, p.mode = "open", smNone
	case strings.Contains(t, "Session Cached Cursor Dump"):
		p.closeCursor(n - 1)
		p.group, p.mode = "cached", smNone
	case strings.HasPrefix(t, "Dump Cursor "):
		p.closeCursor(n - 1)
		p.openCursor(n, t)
	case strings.HasPrefix(t, "Bind Info"):
		if p.cur != nil {
			p.mode = smBinds
		}
	case strings.HasPrefix(t, "Bind Byte Code"):
		if p.cur != nil {
			p.mode = smCursor
		}
	default:
		p.closeCursor(n - 1)
		p.mode = smNone
	}
}

func (p *stackParser) openCursor(n int, t string) {
	c := &DumpCursor{Group: p.group, From: n, To: n, Binds: []DumpBind{}}
	if p.group == "open" {
		c.Number, c.State = p.pendNum, p.pendSt
	}
	p.pendNum, p.pendSt = 0, ""
	// "Dump Cursor sql_id=9zg9qd9bm4spu xsc=0x7f89b1895f58 cur=0x7f89b20c2538"
	for _, f := range strings.Fields(t) {
		if strings.HasPrefix(f, "sql_id=") {
			c.SQLID = f[len("sql_id="):]
		}
	}
	p.cur = c
	p.mode = smCursor
}

// closeCursor ends the open cursor at line to.
func (p *stackParser) closeCursor(to int) {
	if p.cur == nil {
		return
	}
	p.cur.To = max(to, p.cur.From)
	p.cs.CursorsTotal++
	if len(p.curDone) < CursorCap {
		p.curDone = append(p.curDone, *p.cur)
	}
	p.cur = nil
	p.inValue = false
}

func (p *stackParser) stmtLine(n int, l []byte) {
	st := p.stmt
	st.To = n
	if st.Truncated {
		return
	}
	if p.stmtLen >= StatementLines || len(st.Text)+len(l) > StatementBytes {
		st.Truncated = true
		return
	}
	if p.stmtLen > 0 {
		st.Text += "\n"
	}
	st.Text += string(bytes.TrimRight(l, "\r"))
	p.stmtLen++
}

func (p *stackParser) plsqlLine(n int, l []byte) {
	f := bytes.Fields(l)
	if len(f) < 3 || len(f[0]) < 3 || f[0][0] != '0' || f[0][1] != 'x' {
		return // the two header lines, anything else
	}
	line, err := strconv.Atoi(string(f[1]))
	if err != nil || len(p.cs.PLSQL) >= plsqlCap {
		return
	}
	obj := strings.Join(strings.Fields(string(bytes.Join(f[2:], []byte(" ")))), " ")
	typ, name := obj, ""
	if obj != "anonymous block" {
		if i := strings.LastIndexByte(obj, ' '); i > 0 {
			typ, name = obj[:i], obj[i+1:]
		}
	}
	p.plsqlN++
	p.cs.PLSQL = append(p.cs.PLSQL, PLSQLFrame{N: p.plsqlN, Handle: string(f[0]), Line: line, Object: obj, Type: typ, Name: name, At: n})
}

// the call stack table

func (p *stackParser) tableLine(n int, l []byte) {
	if !p.haveCols {
		// the underline of the header: runs of dashes, "-------------------- -------- -------------------- ----"
		if hasPrefix(l, "-------------------- --------") {
			k := 0
			for i := 0; i < len(l) && k < 4; i++ {
				if l[i] == '-' && (i == 0 || l[i-1] == ' ') {
					p.cols[k] = i
					k++
				}
			}
			if k == 4 {
				p.haveCols = true
			}
		}
		return
	}
	// a blank line, or the timestamp marker the trace writes into the middle of a table
	// ("*** 2026-11-17T21:34:27.435785+00:00 (PDB1(3))", diag_in_10046:188), is not a row
	if len(bytes.TrimSpace(l)) == 0 || hasPrefix(l, "*** ") {
		return
	}
	cell := func(a, b int) string {
		if a >= len(l) {
			return ""
		}
		return strings.TrimSpace(string(l[a:min(b, len(l))]))
	}
	typ := cell(p.cols[1], p.cols[2])
	caller, callee := cell(p.cols[0], p.cols[1]), cell(p.cols[2], p.cols[3])
	if typ != "" {
		p.flushRow()
		p.tableCaller, p.tableCallee, p.tableRowLine, p.tableRowActive = caller, callee, n, true
		return
	}
	if p.tableRowActive {
		p.tableCaller += caller
		p.tableCallee += callee
	}
}

func (p *stackParser) flushRow() {
	if !p.tableRowActive {
		return
	}
	p.tableRowActive = false
	if len(p.table) >= frameCap {
		return
	}
	f := frameOf(len(p.table)+1, p.tableCaller, p.tableCallee, p.tableRowLine)
	p.table = append(p.table, f)
}

// frameOf makes a frame from its caller text ("ksedst1()+95"), its callee and its line.
func frameOf(n int, caller, callee string, line int) StackFrame {
	fn, off := splitFrameText(caller)
	return StackFrame{N: n, Function: fn, Offset: off, Text: caller, Callee: callee, Line: line}
}

// splitFrameText splits "ksedst1()+95" into the function name and the offset; "__sighandler()" has none.
func splitFrameText(s string) (string, *int) {
	fn := s
	if i := strings.IndexByte(s, '('); i >= 0 {
		fn = s[:i]
	}
	if i := strings.LastIndexByte(s, '+'); i >= 0 && i > strings.IndexByte(s, ')') {
		if v, err := strconv.Atoi(strings.TrimSpace(s[i+1:])); err == nil {
			return fn, &v
		}
	}
	return fn, nil
}

// the binary stack dump

func (p *stackParser) binaryLine(n int, l []byte) {
	if l[0] == '=' && hasPrefix(l, "========== FRAME [") {
		rest := l[len("========== FRAME ["):]
		num, k := digits(rest)
		if k == 0 || len(p.binary) >= frameCap {
			return
		}
		text := strings.TrimSpace(strings.Trim(string(rest[k:]), "= \t\r"))
		text = strings.TrimSpace(strings.TrimPrefix(text, "]"))
		if strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")") {
			text = text[1 : len(text)-1]
		}
		caller, callee, _ := strings.Cut(text, " -> ")
		f := frameOf(num, strings.TrimSpace(caller), strings.TrimSpace(callee), n)
		p.binary = append(p.binary, f)
		return
	}
	if l[0] == 'C' && hasPrefix(l, "CALL TYPE:") && len(p.binary) > 0 {
		f := &p.binary[len(p.binary)-1]
		if f.Component != "" || f.ErrorSignaled {
			return
		}
		s := string(l)
		f.ErrorSignaled = strings.Contains(s, "ERROR SIGNALED: yes")
		if i := strings.Index(s, "COMPONENT:"); i >= 0 {
			if c := strings.TrimSpace(s[i+len("COMPONENT:"):]); c != "(null)" {
				f.Component = c
			}
		}
	}
}

// the binds of a cursor

func (p *stackParser) bindLine(n int, l, t []byte) {
	c := p.cur
	if c == nil {
		return
	}
	switch {
	case hasPrefix(l, " Incarnation"):
		p.mode = smCursor
	case hasPrefix(t, "Bind#"):
		pos, k := digits(t[len("Bind#"):])
		if k == 0 {
			return
		}
		c.BindCount++
		if len(c.Binds) < BindCap {
			c.Binds = append(c.Binds, DumpBind{Pos: pos})
			p.valBind = &c.Binds[len(c.Binds)-1]
		} else {
			p.valBind = nil
		}
	case p.valBind == nil:
	case hasPrefix(t, "No oacdef"):
		p.valBind.NoDef = true
	case hasPrefix(t, "oacdty="):
		d, k := digits(t[len("oacdty="):])
		if k > 0 {
			p.valBind.Dty, p.valBind.Type = d, ref.BindTypeName(d)
		}
	case hasPrefix(t, "kxsbbbfp="):
		if i := bytes.Index(t, []byte(" avl=")); i >= 0 {
			if d, k := digits(t[i+5:]); k > 0 {
				p.valBind.Avl = &d
			}
		}
	case hasPrefix(t, "value="):
		v := string(bytes.TrimRight(t[len("value="):], " \t\r"))
		b := p.valBind
		b.Line, b.Value = n, cutValue(v)
		if strings.HasPrefix(v, `"`) && oddQuotes(v) {
			p.inValue = true
		}
	}
}

// valueMore reads the lines of a string value that spans several, up to the line that closes the quote.
func (p *stackParser) valueMore(n int, l []byte) {
	b := p.valBind
	if b == nil {
		p.inValue = false
		return
	}
	s := string(bytes.TrimRight(l, "\r"))
	if len(b.Value) < ValueCap {
		b.Value = cutValue(b.Value + "\n" + s)
	}
	b.LineTo = n
	if oddQuotes(s) {
		p.inValue = false
	}
}

func cutValue(v string) string {
	if len(v) > ValueCap {
		return v[:ValueCap]
	}
	return v
}

// oddQuotes: the text holds an odd number of double quotes (a quoted value that is not closed yet, or the line
// that closes it).
func oddQuotes(s string) bool { return strings.Count(s, `"`)%2 == 1 }

// finish puts the parts together once all lines are read.
func (p *stackParser) finish() {
	cs := p.cs
	p.flushRow()
	p.closeCursor(cs.To)
	cs.Cursors = p.curDone
	if cs.Cursors == nil {
		cs.Cursors = []DumpCursor{}
	}
	cs.Error = p.errInfo
	if st := cs.Statement; st != nil && st.To < st.From {
		st.To = st.From - 1
	}
	cs.BinaryFrames, cs.TableFrames = len(p.binary), len(p.table)
	switch {
	case len(p.binary) > 0:
		cs.Frames, cs.FramesSource, cs.FramesLine = p.binary, "binary", p.binaryHdr
		if len(p.table) > 0 {
			ag := len(p.table) == len(p.binary)
			for i := 0; ag && i < len(p.binary); i++ {
				ag = p.table[i].Function == p.binary[i].Function && p.table[i].Callee == p.binary[i].Callee
			}
			cs.TableAgrees = &ag
			if len(p.table) == len(p.binary) {
				for i := range cs.Frames {
					cs.Frames[i].TableLine = p.table[i].Line
				}
			}
		}
	case len(p.table) > 0:
		cs.Frames, cs.FramesSource, cs.FramesLine = p.table, "table", p.tableHdr
	}
	fns := make([]string, len(cs.Frames))
	for i, f := range cs.Frames {
		fns[i] = f.Function
	}
	cs.Own = leadingOwn(fns)
	var all, rest []string
	for i := range cs.Frames {
		if i < cs.Own {
			cs.Frames[i].Own = true
		} else {
			rest = append(rest, cs.Frames[i].Text)
		}
		all = append(all, cs.Frames[i].Text)
	}
	cs.ShortStack, cs.ShortStackNoOwn = strings.Join(all, "<-"), strings.Join(rest, "<-")
	if cs.Start.Line == 0 {
		cs.Notes = append(cs.Notes, "no \"dbkedDefDump(): Starting\" line in this part")
	}
	if cs.FramesSource == "none" {
		cs.Notes = append(cs.Notes, "this dump has no call stack")
	}
	if cs.FramesSource == "table" {
		cs.Notes = append(cs.Notes, "frames are read from the Call Stack Trace table (the dump has no Binary Stack Dump); names that wrap there are joined")
	}
	if cs.TableAgrees != nil && !*cs.TableAgrees {
		cs.Notes = append(cs.Notes, "the Call Stack Trace table and the Binary Stack Dump list different frames")
	}
	if st := cs.Statement; st != nil {
		st.Text = strings.TrimRight(st.Text, "\n")
	}
}
