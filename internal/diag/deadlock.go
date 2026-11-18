package diag

import (
	"bytes"
	"strconv"
	"strings"
)

// The reading of a deadlock graph (docs/PLAN-DIAG.md § The readings; the format is docs/trace-format-diag.md §
// Deadlock graph): the graph's rows as printed, the cycle they make, the information about the waiting sessions
// and the rows they wait on. Fixture: diag_deadlock (ORA-00060 between two sessions).
//
// One pass over the section's lines (the section has no end line: it holds the whole diagnostic dump the instance
// writes after the graph, so the pass skips that dump's lines cheaply). What is read, and from which lines:
//
//	start     "DEADLOCK DETECTED ( ORA-00060 )" and "[Transaction Deadlock]"
//	graph     "Deadlock graph:", the two header lines (their column positions are the table's) and a row per resource,
//	          "TX-000A0009-00004D46-ED94F66A-00000000         61     255     X        52110       6      61           X  27430"
//	sessions  "----- Information for waiting sessions -----", per session "Session 255:", "Holds resource TX-... acquired
//	          5 seconds ago.", "sid: 255 ser: 52110 audsid: 4273372 user: 165/MTK", "pdb: 3/PDB1", "pid: 61 O/S info:
//	          user: oracle, term: UNKNOWN, ospid: 13878", "image:", "client details:" with its "O/S info:", "machine: M
//	          program: P", "application name: A, hash value=N", "action name: A, hash value=N", "current SQL:" and the
//	          statement; "----- End of information for waiting sessions -----"
//	rows      "Rows waited on:" with "Session 255: obj - rowid = 0001A841 - AAAahBAAMAAApUZAAD" and "(dictionary objn -
//	          108609, file - 12, block - 169241, slot - 3)", in the dump that follows the graph (diag_deadlock:4124)
//
// The graph is a table of fixed columns with empty cells: a blocker may print no "waits", a waiter no "holds". The
// header's column words give the positions; each cell of a row goes to the column whose right edge is nearest to the
// end of the cell (the numbers and the lock modes are right-aligned in the lab's rows; the waiter's group sits one
// character to the left of its header, which the nearest-edge rule absorbs).
//
// The cycle: each row is an edge from the waiter to the blocker (the waiter waits for what the blocker holds). The
// reading follows the edges from the victim (or from the first row's waiter) until a session repeats. The victim is
// the session that wrote the trace: ORA-00060 is raised in one of the sessions of the cycle and its process writes
// the dump, so the "*** SESSION ID:(sid.serial)" marker in force at the start of the section names it (the file the
// other session writes holds no deadlock graph).

// Bounds of a deadlock reading.
const (
	// DeadlockRowCap is how many rows of the graph are listed (RowsTotal counts all).
	DeadlockRowCap = 200
	// DeadlockSessionCap is how many session blocks are listed.
	DeadlockSessionCap = 100
	// DeadlockSQLLines and DeadlockSQLBytes bound a session's current statement.
	DeadlockSQLLines = 50
	DeadlockSQLBytes = 8000
	// DeadlockRowsWaitedCap is how many "Rows waited on" entries are listed.
	DeadlockRowsWaitedCap = 100
)

// Deadlock is the reading of a deadlock graph.
type Deadlock struct {
	Kind  string `json:"kind"` // "deadlock"
	Node  string `json:"node"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"`

	// ORA is "ORA-00060" of "DEADLOCK DETECTED ( ORA-00060 )", Line its line; Type the "[Transaction Deadlock]" line's text.
	ORA  string `json:"ora"`
	Line int    `json:"line"`
	Type string `json:"type,omitempty"`

	Graph DeadlockGraph `json:"graph"`
	Cycle DeadlockCycle `json:"cycle"`
	// Sessions are the "Information for waiting sessions" blocks, in order.
	Sessions      []DeadlockSession `json:"sessions"`
	SessionsTotal int               `json:"sessionsTotal"`
	// SessionsLine is the "Information for waiting sessions" line (0 when the section has none); SessionsEnded: its end line was reached.
	SessionsLine  int  `json:"sessionsLine,omitempty"`
	SessionsEnded bool `json:"sessionsEnded"`

	// Victim is the session that wrote the trace; absent when the file has no session marker before the section.
	Victim *DeadlockVictim `json:"victim,omitempty"`
	// RowsWaited is the "Rows waited on" block, absent when the dump prints none.
	RowsWaited *DeadlockRowsWaited `json:"rowsWaited,omitempty"`
	// Dump is the diagnostic dump that follows the graph (its callstack reading), absent when there is none.
	Dump *DeadlockDump `json:"dump,omitempty"`

	Notes []string `json:"notes"`
}

// ReadingKind is "deadlock".
func (*Deadlock) ReadingKind() string { return ReadingDeadlock }

// DeadlockGraph is the table.
type DeadlockGraph struct {
	Line int `json:"line"` // "Deadlock graph:"; 0 when the section has none
	// Header are the two header lines as printed (the "Blocker(s)" / "Waiter(s)" rule and the column names).
	Header []string      `json:"header"`
	Rows   []DeadlockRow `json:"rows"`
	Total  int           `json:"rowsTotal"`
}

// DeadlockRow is a row of the graph: a resource, the session that holds it and the one that waits for it.
type DeadlockRow struct {
	Line int `json:"line"`
	// Resource is the name as printed ("TX-000A0009-00004D46-ED94F66A-00000000"); Type its first part ("TX").
	Resource string        `json:"resource"`
	Type     string        `json:"type"`
	Blocker  DeadlockParty `json:"blocker"`
	Waiter   DeadlockParty `json:"waiter"`
}

// DeadlockParty is one side of a row. A cell the dump leaves empty is absent (Holds, Waits ""; the numbers nil).
type DeadlockParty struct {
	Process *int   `json:"process,omitempty"`
	Session *int   `json:"session,omitempty"`
	Holds   string `json:"holds,omitempty"` // the mode held ("X")
	Waits   string `json:"waits,omitempty"` // the mode waited for
	Serial  *int   `json:"serial,omitempty"`
	// Key is "sid.serial" when both are printed.
	Key string `json:"key,omitempty"`
}

// DeadlockCycle is the cycle of the rows seen as edges between sessions.
type DeadlockCycle struct {
	// Closed: the edges lead from a session back to it.
	Closed bool `json:"closed"`
	// Sessions are the sessions of the cycle in the order of the edges (each waits for the next, the last for the first).
	Sessions []string       `json:"sessions"`
	Edges    []DeadlockEdge `json:"edges"`
}

// rotateTo makes the cycle start at the session key when it is on it (the victim: its edge first).
func (c *DeadlockCycle) rotateTo(key string) {
	for i, s := range c.Sessions {
		if s == key && i > 0 && c.Closed {
			c.Sessions = append(append([]string{}, c.Sessions[i:]...), c.Sessions[:i]...)
			c.Edges = append(append([]DeadlockEdge{}, c.Edges[i:]...), c.Edges[:i]...)
			return
		}
	}
}

// DeadlockEdge: Waiter waits for Resource, which Blocker holds.
type DeadlockEdge struct {
	Waiter   string `json:"waiter"`
	Blocker  string `json:"blocker"`
	Resource string `json:"resource"`
	// Mode is the mode the waiter waits for, as printed in the waiter's "waits" cell.
	Mode string `json:"mode,omitempty"`
	Line int    `json:"line"`
}

// DeadlockSession is a block of "Information for waiting sessions".
type DeadlockSession struct {
	Line int `json:"line"` // "Session 255:"
	From int `json:"from"`
	To   int `json:"to"`
	// Number is the number after "Session" (the session id).
	Number int `json:"number"`
	// HeldResource and Acquired: "Holds resource TX-... acquired 5 seconds ago."; AcquiredSec the seconds (absent
	// when the text is not in that form).
	HeldResource string `json:"heldResource,omitempty"`
	Acquired     string `json:"acquired,omitempty"`
	AcquiredSec  *int   `json:"acquiredSec,omitempty"`

	Sid       int    `json:"sid"`
	Serial    int    `json:"serial"`
	Key       string `json:"key"`
	AudSid    *int64 `json:"audsid,omitempty"`
	UserID    *int   `json:"userId,omitempty"`
	User      string `json:"user,omitempty"`
	Container string `json:"container,omitempty"` // "3/PDB1" of "pdb:" split
	// ContainerID and ContainerName: "pdb: 3/PDB1".
	ContainerID   *int   `json:"containerId,omitempty"`
	ContainerName string `json:"containerName,omitempty"`
	Pid           *int   `json:"pid,omitempty"`
	OSUser        string `json:"osUser,omitempty"`
	OSPid         string `json:"ospid,omitempty"`
	Image         string `json:"image,omitempty"`
	// The client's: "client details:" then "O/S info:", "machine:", "program:", "application name:", "action name:".
	ClientOSUser string `json:"clientOsUser,omitempty"`
	ClientOSPid  string `json:"clientOspid,omitempty"`
	Machine      string `json:"machine,omitempty"`
	Program      string `json:"program,omitempty"`
	Module       string `json:"module,omitempty"` // "application name:"
	Action       string `json:"action,omitempty"` // "action name:"

	// SqlText is "current SQL:" and the lines after it (at most DeadlockSQLLines lines and DeadlockSQLBytes bytes,
	// SqlCut says it was cut); SqlLine is the first line of the text.
	SqlText string `json:"sqlText,omitempty"`
	SqlLine int    `json:"sqlLine,omitempty"`
	SqlCut  bool   `json:"sqlCut,omitempty"`
	// InGraph: the session is in a row of the graph.
	InGraph bool `json:"inGraph"`
}

// DeadlockVictim is the session that wrote the trace.
type DeadlockVictim struct {
	Session string `json:"session"` // "sid.serial"
	// Line is the "*** SESSION ID" marker that says so; InGraph: the session is in the graph; Statement the session's
	// current SQL of the "Information for waiting sessions" when it has a block there.
	Line    int  `json:"line"`
	InGraph bool `json:"inGraph"`
}

// DeadlockRowsWaited is the "Rows waited on" block.
type DeadlockRowsWaited struct {
	Line  int                `json:"line"`
	Rows  []DeadlockRowWaits `json:"rows"`
	Total int                `json:"total"`
}

// DeadlockRowWaits is "Session 255: obj - rowid = 0001A841 - AAAahBAAMAAApUZAAD" with its "(dictionary objn - ...)" line.
type DeadlockRowWaits struct {
	Line    int    `json:"line"`
	Session int    `json:"session"` // the session id
	NoRow   bool   `json:"noRow,omitempty"`
	Obj     string `json:"obj,omitempty"`   // "0001A841" as printed
	RowID   string `json:"rowid,omitempty"` // "AAAahBAAMAAApUZAAD"
	// Objn, File, Block and Slot of the dictionary line.
	Objn  *int64 `json:"objn,omitempty"`
	File  *int64 `json:"file,omitempty"`
	Block *int64 `json:"block,omitempty"`
	Slot  *int64 `json:"slot,omitempty"`
}

// DeadlockDump is the diagnostic dump nested in the section.
type DeadlockDump struct {
	Node  string `json:"node"` // its id: ask api/diag/reading for its callstack reading
	From  int    `json:"from"`
	To    int    `json:"to"`
	Title string `json:"title"`
}

type dlColumns struct {
	ends  [10]int // right edges of process session holds waits serial, blocker then waiter
	known bool
}

type deadlockParser struct {
	d *Deadlock

	mode     int // below
	cols     dlColumns
	hdr      []string
	ses      *DeadlockSession
	sqlOpen  bool
	sqlBuf   []byte
	sqlLines int
	rowWait  *DeadlockRowWaits
	rowsDone bool
}

const (
	dlNone = iota
	dlGraph
	dlSessions
	dlRows
)

// deadlockReading reads the lines of a node of kind deadlock.
func (r *Reader) deadlockReading(id string, from, to int) (*Deadlock, error) {
	d := &Deadlock{Kind: ReadingDeadlock, Node: id, From: from, To: to, Lines: to - from + 1,
		Graph:    DeadlockGraph{Header: []string{}, Rows: []DeadlockRow{}},
		Cycle:    DeadlockCycle{Sessions: []string{}, Edges: []DeadlockEdge{}},
		Sessions: []DeadlockSession{}, Notes: []string{}}
	p := &deadlockParser{d: d}
	err := scanLines(r.src, from, to, func(n int, prev, line, next []byte) { p.line(n, line) })
	if err != nil {
		return nil, err
	}
	p.endSession(to)
	p.finish()
	// the one who wrote the trace
	if ml, key := r.Scan.SessionAt(from); key != "" {
		d.Victim = &DeadlockVictim{Session: key, Line: ml}
		for _, row := range d.Graph.Rows {
			if row.Blocker.Key == key || row.Waiter.Key == key {
				d.Victim.InGraph = true
			}
		}
		d.Cycle.rotateTo(key)
	}
	// the dump that follows
	if o, err := r.children(id, 0, Cap); err == nil {
		for _, c := range o.Children {
			if c.Kind == "diagdump" {
				d.Dump = &DeadlockDump{Node: c.ID, From: c.From, To: c.To, Title: c.Title}
				break
			}
		}
	}
	p.notes(d)
	return d, nil
}

// tokens of a line with the position of the end of each.
type tok struct {
	s   string
	end int
}

func dlTokens(l []byte) []tok {
	var out []tok
	i := 0
	for i < len(l) {
		for i < len(l) && (l[i] == ' ' || l[i] == '\t') {
			i++
		}
		j := i
		for j < len(l) && l[j] != ' ' && l[j] != '\t' {
			j++
		}
		if j > i {
			out = append(out, tok{string(l[i:j]), j})
		}
		i = j
	}
	return out
}

// columns reads the column positions from the header line ("Resource Name   process session holds waits serial  process ...").
func (p *deadlockParser) columns(l []byte) {
	ts := dlTokens(l)
	// "Resource", "Name", then ten words
	if len(ts) < 12 {
		return
	}
	var c dlColumns
	for i := 0; i < 10; i++ {
		c.ends[i] = ts[2+i].end
	}
	c.known = true
	p.cols = c
}

// row parses a row of the graph with the column positions; a cell goes to the column with the nearest right edge.
func (p *deadlockParser) row(n int, l []byte) (DeadlockRow, bool) {
	ts := dlTokens(l)
	if len(ts) < 3 || !strings.Contains(ts[0].s, "-") {
		return DeadlockRow{}, false
	}
	row := DeadlockRow{Line: n, Resource: ts[0].s, Type: ts[0].s}
	if i := strings.IndexByte(ts[0].s, '-'); i > 0 {
		row.Type = ts[0].s[:i]
	}
	cells := [10]string{}
	cols := p.cols
	if !cols.known {
		// the lab's positions
		cols.ends = [10]int{49, 57, 63, 69, 76, 85, 93, 99, 105, 112}
	}
	for _, t := range ts[1:] {
		best, bd := -1, 1<<30
		for i, e := range cols.ends {
			dd := t.end - e
			if dd < 0 {
				dd = -dd
			}
			if dd < bd {
				best, bd = i, dd
			}
		}
		if best >= 0 && cells[best] == "" {
			cells[best] = t.s
		}
	}
	fill := func(pt *DeadlockParty, c []string) {
		if v, err := strconv.Atoi(c[0]); err == nil {
			pt.Process = &v
		}
		if v, err := strconv.Atoi(c[1]); err == nil {
			pt.Session = &v
		}
		pt.Holds, pt.Waits = c[2], c[3]
		if v, err := strconv.Atoi(c[4]); err == nil {
			pt.Serial = &v
		}
		if pt.Session != nil && pt.Serial != nil {
			pt.Key = strconv.Itoa(*pt.Session) + "." + strconv.Itoa(*pt.Serial)
		}
	}
	fill(&row.Blocker, cells[0:5])
	fill(&row.Waiter, cells[5:10])
	return row, true
}

func (p *deadlockParser) line(n int, l []byte) {
	d := p.d
	if len(l) == 0 {
		return
	}
	if p.mode == dlNone && d.Line == 0 {
		if l[0] == 'D' && hasPrefix(l, "DEADLOCK DETECTED") {
			d.Line = n
			s := string(l)
			if i := strings.Index(s, "ORA-"); i >= 0 {
				j := i + 4
				for j < len(s) && s[j] >= '0' && s[j] <= '9' {
					j++
				}
				d.ORA = s[i:j]
			}
		}
		return
	}
	// after the start: the lines the reading is after are few; the rest (the dump that follows) is skipped by its first byte
	t := bytes.TrimSpace(l)
	if len(t) == 0 {
		if p.mode == dlGraph && len(d.Graph.Rows) > 0 {
			p.mode = dlNone
		}
		if p.sqlOpen {
			p.endSQL()
		}
		if p.mode == dlRows && d.RowsWaited != nil && len(d.RowsWaited.Rows) > 0 {
			p.mode = dlNone
			p.rowsDone = true
			p.rowWait = nil
		}
		return
	}
	switch {
	case l[0] == '[' && d.Type == "" && bytes.HasSuffix(t, []byte("]")) && n <= d.Line+4:
		d.Type = string(t[1 : len(t)-1])
		return
	case l[0] == 'D' && hasPrefix(l, "Deadlock graph:"):
		d.Graph.Line = n
		p.mode = dlGraph
		return
	case l[0] == '-' && hasPrefix(l, "----- Information for waiting sessions"):
		d.SessionsLine = n
		p.endSession(n - 1)
		p.mode = dlSessions
		return
	case l[0] == '-' && hasPrefix(l, "----- End of information for waiting sessions"):
		p.endSession(n - 1)
		d.SessionsEnded = true
		p.mode = dlNone
		return
	case l[0] == 'R' && hasPrefix(l, "Rows waited on:") && !p.rowsDone && d.RowsWaited == nil:
		p.endSession(n - 1)
		d.RowsWaited = &DeadlockRowsWaited{Line: n, Rows: []DeadlockRowWaits{}}
		p.mode = dlRows
		return
	}
	switch p.mode {
	case dlGraph:
		s := string(t)
		switch {
		case strings.HasPrefix(s, "---"):
			d.Graph.Header = append(d.Graph.Header, string(bytes.TrimRight(l, " ")))
		case strings.HasPrefix(s, "Resource Name"):
			d.Graph.Header = append(d.Graph.Header, string(bytes.TrimRight(l, " ")))
			p.columns(l)
		default:
			if row, ok := p.row(n, l); ok {
				d.Graph.Total++
				if len(d.Graph.Rows) < DeadlockRowCap {
					d.Graph.Rows = append(d.Graph.Rows, row)
				}
			}
		}
	case dlSessions:
		p.sessionLine(n, l, t)
	case dlRows:
		p.rowsLine(n, string(t))
	}
}

func (p *deadlockParser) sessionLine(n int, l, t []byte) {
	d := p.d
	s := string(t)
	if hasPrefix(t, "Session ") && bytes.HasSuffix(t, []byte(":")) {
		if num, ok := atoiOK(strings.TrimSuffix(s[len("Session "):], ":")); ok {
			p.endSession(n - 1)
			d.SessionsTotal++
			p.ses = &DeadlockSession{Line: n, From: n, To: n, Number: num}
			p.sqlOpen = false
			return
		}
	}
	ss := p.ses
	if ss == nil {
		return
	}
	ss.To = n
	if p.sqlOpen {
		// the statement runs to the blank line
		if p.sqlLines < DeadlockSQLLines && len(p.sqlBuf) < DeadlockSQLBytes {
			if len(p.sqlBuf) > 0 {
				p.sqlBuf = append(p.sqlBuf, '\n')
			}
			p.sqlBuf = append(p.sqlBuf, t...)
			p.sqlLines++
		} else {
			ss.SqlCut = true
		}
		return
	}
	switch {
	case strings.HasPrefix(s, "Holds resource "):
		rest := s[len("Holds resource "):]
		if i := strings.Index(rest, " acquired "); i >= 0 {
			ss.HeldResource, ss.Acquired = rest[:i], strings.TrimSuffix(strings.TrimSpace(rest[i+len(" acquired "):]), ".")
			if f := strings.Fields(ss.Acquired); len(f) > 0 {
				if v, ok := atoiOK(f[0]); ok {
					ss.AcquiredSec = &v
				}
			}
		} else {
			ss.HeldResource = strings.TrimSuffix(strings.TrimSpace(rest), ".")
		}
	case strings.HasPrefix(s, "sid: "):
		if v, ok := kvInt(s, "sid: "); ok {
			ss.Sid = v
		}
		if v, ok := kvInt(s, "ser: "); ok {
			ss.Serial = v
		}
		ss.Key = strconv.Itoa(ss.Sid) + "." + strconv.Itoa(ss.Serial)
		if v, ok := kvTok(s, "audsid: "); ok {
			if x, err := strconv.ParseInt(v, 10, 64); err == nil {
				ss.AudSid = &x
			}
		}
		if v, ok := kvTok(s, "user: "); ok {
			if a, b, ok := strings.Cut(v, "/"); ok {
				if id, err := strconv.Atoi(a); err == nil {
					ss.UserID = &id
				}
				ss.User = b
			} else {
				ss.User = v
			}
		}
	case strings.HasPrefix(s, "pdb: "):
		v := strings.TrimSpace(s[len("pdb: "):])
		ss.Container = v
		if a, b, ok := strings.Cut(v, "/"); ok {
			if id, err := strconv.Atoi(a); err == nil {
				ss.ContainerID = &id
			}
			ss.ContainerName = b
		}
	case strings.HasPrefix(s, "pid: "):
		if v, ok := kvInt(s, "pid: "); ok {
			ss.Pid = &v
		}
		if v, ok := kvTok(s, "user: "); ok {
			ss.OSUser = v
		}
		if v, ok := kvTok(s, "ospid: "); ok {
			ss.OSPid = v
		}
	case strings.HasPrefix(s, "image: "):
		ss.Image = strings.TrimSpace(s[len("image: "):])
	case strings.HasPrefix(s, "O/S info:") && ss.ClientOSPid == "":
		if v, ok := kvTok(s, "user: "); ok {
			ss.ClientOSUser = v
		}
		if v, ok := kvTok(s, "ospid: "); ok {
			ss.ClientOSPid = v
		}
	case strings.HasPrefix(s, "machine: "):
		rest := s[len("machine: "):]
		if i := strings.Index(rest, " program: "); i >= 0 {
			ss.Machine, ss.Program = strings.TrimSpace(rest[:i]), strings.TrimSpace(rest[i+len(" program: "):])
		} else {
			ss.Machine = strings.TrimSpace(rest)
		}
	case strings.HasPrefix(s, "application name: "):
		ss.Module = nameBeforeHash(s[len("application name: "):])
	case strings.HasPrefix(s, "action name: "):
		ss.Action = nameBeforeHash(s[len("action name: "):])
	case strings.HasPrefix(s, "current SQL:"):
		p.sqlOpen = true
		p.sqlBuf = p.sqlBuf[:0]
		p.sqlLines = 0
		ss.SqlLine = n + 1
		if rest := strings.TrimSpace(s[len("current SQL:"):]); rest != "" {
			p.sqlBuf = append(p.sqlBuf, rest...)
			p.sqlLines++
			ss.SqlLine = n
		}
	}
}

func atoiOK(s string) (int, bool) {
	v, err := strconv.Atoi(strings.TrimSpace(s))
	return v, err == nil
}

func (p *deadlockParser) endSQL() {
	if p.sqlOpen && p.ses != nil {
		p.ses.SqlText = string(p.sqlBuf)
	}
	p.sqlOpen = false
}

func (p *deadlockParser) endSession(to int) {
	if p.ses == nil {
		return
	}
	p.endSQL()
	s := p.ses
	p.ses = nil
	if s.To < s.From {
		s.To = s.From
	}
	if len(p.d.Sessions) < DeadlockSessionCap {
		p.d.Sessions = append(p.d.Sessions, *s)
	}
}

// rowsLine reads a line of the "Rows waited on" block.
func (p *deadlockParser) rowsLine(n int, s string) {
	rw := p.d.RowsWaited
	if rw == nil {
		return
	}
	switch {
	case strings.HasPrefix(s, "Session "):
		// "Session 255: obj - rowid = 0001A841 - AAAahBAAMAAApUZAAD"  or "Session 255: no row"
		rest := s[len("Session "):]
		i := strings.IndexByte(rest, ':')
		if i < 0 {
			return
		}
		num, ok := atoiOK(rest[:i])
		if !ok {
			return
		}
		rw.Total++
		p.rowWait = nil
		if len(rw.Rows) >= DeadlockRowsWaitedCap {
			return
		}
		e := DeadlockRowWaits{Line: n, Session: num}
		body := strings.TrimSpace(rest[i+1:])
		if strings.HasPrefix(body, "no row") {
			e.NoRow = true
		} else if j := strings.Index(body, "rowid = "); j >= 0 {
			v := body[j+len("rowid = "):]
			if a, b, ok := strings.Cut(v, " - "); ok {
				e.Obj, e.RowID = strings.TrimSpace(a), strings.TrimSpace(b)
			}
		}
		rw.Rows = append(rw.Rows, e)
		p.rowWait = &rw.Rows[len(rw.Rows)-1]
	case strings.HasPrefix(s, "(dictionary objn"):
		e := p.rowWait
		if e == nil {
			return
		}
		get := func(key string) *int64 {
			if v, ok := kvTok(s, key); ok {
				if x, err := strconv.ParseInt(strings.TrimRight(v, ",)"), 10, 64); err == nil {
					return &x
				}
			}
			return nil
		}
		e.Objn, e.File, e.Block, e.Slot = get("objn - "), get("file - "), get("block - "), get("slot - ")
	default:
		// the block is over at the first line that is neither
		if p.d.RowsWaited != nil && len(rw.Rows) > 0 {
			p.mode = dlNone
			p.rowsDone = true
			p.rowWait = nil
		}
	}
}

// finish makes the cycle out of the rows.
func (p *deadlockParser) finish() {
	d := p.d
	// edges: waiter -> blocker
	type edge struct {
		w, b, res, mode string
		line            int
	}
	var edges []edge
	for _, r := range d.Graph.Rows {
		if r.Waiter.Key == "" || r.Blocker.Key == "" {
			continue
		}
		edges = append(edges, edge{r.Waiter.Key, r.Blocker.Key, r.Resource, r.Waiter.Waits, r.Line})
	}
	if len(edges) == 0 {
		return
	}
	next := map[string][]edge{}
	for _, e := range edges {
		next[e.w] = append(next[e.w], e)
	}
	// start at the first row's waiter; the victim is set by the caller after this, so the cycle is the one a walk
	// from the first row finds
	start := edges[0].w
	visited := map[string]int{}
	var path []edge
	cur := start
	for step := 0; step <= len(edges)+1; step++ {
		if i, ok := visited[cur]; ok {
			// the cycle is path[i:]
			for _, e := range path[i:] {
				d.Cycle.Sessions = append(d.Cycle.Sessions, e.w)
				d.Cycle.Edges = append(d.Cycle.Edges, DeadlockEdge{Waiter: e.w, Blocker: e.b, Resource: e.res, Mode: e.mode, Line: e.line})
			}
			d.Cycle.Closed = true
			break
		}
		visited[cur] = len(path)
		es := next[cur]
		if len(es) == 0 {
			break
		}
		path = append(path, es[0])
		cur = es[0].b
	}
	if !d.Cycle.Closed {
		// no cycle: the edges are listed as they are
		for _, e := range edges {
			d.Cycle.Edges = append(d.Cycle.Edges, DeadlockEdge{Waiter: e.w, Blocker: e.b, Resource: e.res, Mode: e.mode, Line: e.line})
		}
	}
	// the sessions of the information blocks that are in the graph
	in := map[string]bool{}
	for _, e := range edges {
		in[e.w], in[e.b] = true, true
	}
	for i := range d.Sessions {
		d.Sessions[i].InGraph = in[d.Sessions[i].Key]
	}
}

// notes adds what the reading cannot say, in plain words.
func (p *deadlockParser) notes(d *Deadlock) {
	if d.Line == 0 {
		d.Notes = append(d.Notes, "no \"DEADLOCK DETECTED\" line in this part")
	}
	if d.Graph.Line == 0 {
		d.Notes = append(d.Notes, "the dump prints no \"Deadlock graph:\"")
	} else if len(d.Graph.Rows) == 0 {
		d.Notes = append(d.Notes, "the deadlock graph has no row")
	}
	if len(d.Graph.Rows) > 0 && !d.Cycle.Closed {
		d.Notes = append(d.Notes, "the rows of the graph do not close a cycle between sessions")
	}
	if d.SessionsLine > 0 && !d.SessionsEnded {
		d.Notes = append(d.Notes, "the information for waiting sessions is cut short")
	}
	if d.SessionsTotal > len(d.Sessions) {
		d.Notes = append(d.Notes, "only the first "+strconv.Itoa(len(d.Sessions))+" session blocks are listed")
	}
	if d.Victim == nil {
		d.Notes = append(d.Notes, "the file has no \"*** SESSION ID\" marker before the deadlock, so the session that wrote the trace is not known")
	} else if !d.Victim.InGraph && len(d.Graph.Rows) > 0 {
		d.Notes = append(d.Notes, "the session of the trace ("+d.Victim.Session+") is not in the graph")
	}
	if d.RowsWaited == nil {
		d.Notes = append(d.Notes, "the dump prints no \"Rows waited on\" block")
	}
}
