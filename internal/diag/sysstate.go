package diag

import (
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// The reading of a system state (docs/PLAN-DIAG.md § The readings; the format is docs/trace-format-diag.md §
// System state): one row per process, the blockers the dump names as a tree, and the counts.
//
// One pass over the section's lines, with bounded memory. What is read, and from which lines (all in the
// fixtures diag_sysstate_l1 and, not in git, diag_sysstate_l2, _l258, _l266):
//
//	the header      "SYSTEM STATE (level=10, with short stacks)"; before the section, "Processing Oradebug command
//	                'dump systemstate 266'" and the caller's stack ("System state caller's stack:", "Short stack
//	                dump:" and the line after it), which are outside the section: the twelve lines before it are looked at
//	the summary     "Dumping the Process Summary": per process "6: USER ospid 13945 sid 52 ser 41898, waiting for 'PL/SQL
//	                lock timer'", "1: PSEUDO process", "35: D000 ospid 2365 sid 0 ser 0," (no session, no wait), and under it
//	                "Cmd: PL/SQL EXECUTE", "Blocked by inst: 1, sid: 45, ser: 12004", "Final Blocker inst: 1, sid: 52, ser: 41898"
//	                (the lines of a blocked session: the summary prints the direct blocker and the final one, at every level)
//	the bodies      "PROCESS 6: " / "PROCESS 2: PMON", each read by the process state parser (procstate.go): the session's
//	                user, module, action, program, its current wait and the time in wait, "There is at least one session
//	                blocking this session", "Dumping 1 direct blocker(s):", "Dumping final blocker:", "There are N sessions
//	                blocked by this session", and, where the level prints the library object locks (2, 258, 266), the
//	                statement (sql_id and the first line of its text)
//
// A process is idle when its wait event has the class Idle in the engine's event reference (internal/ref, the data
// the 10046 side uses: event_name_19c.csv) or when the summary gives it no session (sid 0 ser 0, or the pseudo
// process); an event the reference does not know is not idle. Each row says idle and background; the counts add up.
//
// The blocker tree is a forest whose roots are the final blockers. Each session is the child of its first direct
// blocker (the summary's "Blocked by" or the body's "Dumping N direct blocker(s)"; the others are listed on the node as
// alsoBlockedBy), so no session stands twice. A blocker that is not a session of this dump (another instance, a
// stale serial) is a node marked foreign. A cycle of blockers is cut at the session that closes it, which is marked.
//
// Bounds: the table lists SysRowCap rows (every row of a blocked or blocking session beyond that comes after, up
// to SysRowCap more) and counts the rest; the tree lists SysTreeCap nodes and counts the rest. The summary is
// remembered up to sysSummaryHard entries; a process body is read for the rows that are listed.

const (
	// SysRowCap is how many rows of the process table a system state reading lists.
	SysRowCap = 3000
	// SysTreeCap is how many nodes of the blocker tree a system state reading lists.
	SysTreeCap = 300
	// sysSummaryHard is how many summary entries are remembered (the rest are counted).
	sysSummaryHard = 100000
	// sysNodeLimit is how many process nodes are looked up in the outline of the section for the node ids.
	sysNodeLimit = 20000
	// sysLookback is how many lines before the section are read for the caller's stack and the oradebug command.
	sysLookback = 24
)

// Process kinds of a row.
const (
	ProcForeground = "foreground" // the summary's name USER
	ProcBackground = "background" // any other name
	ProcPseudo     = "pseudo"     // "PSEUDO process"
)

// SysState is the reading of a system state.
type SysState struct {
	Kind  string `json:"kind"` // "sysstate"
	Node  string `json:"node"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"`

	// Level is the text in the parentheses of the title as printed ("level=10, with short stacks"); LevelNum the
	// number after "level="; ShortStacks: the title says "with short stacks".
	Level       string `json:"level"`
	LevelNum    *int   `json:"levelNum,omitempty"`
	ShortStacks bool   `json:"shortStacks"`
	TitleLine   int    `json:"titleLine"`
	// Command is the oradebug command that took the dump ("dump systemstate 266"), from the line before the section
	// when it prints one; absent for a dump taken any other way.
	Command     string `json:"command,omitempty"`
	CommandLine int    `json:"commandLine,omitempty"`
	// Caller is the short stack of the process that took the dump, printed before the section ("System state caller's
	// stack:"); absent when there is none. Session is the session that wrote the trace ("sid.serial" of the
	// "*** SESSION ID" marker in force at the section), when the file has one.
	Caller  *SysCaller `json:"caller,omitempty"`
	Session string     `json:"session,omitempty"`

	// SummaryLine is the line of "Dumping the Process Summary" (0 when the section has none).
	SummaryLine int `json:"summaryLine,omitempty"`
	// SummaryMarks: the summary prints "Blocked by" / "Final Blocker" lines for some process (every level of the lab does).
	SummaryMarks bool `json:"summaryMarks"`
	// BodyMarks: the process bodies print "Dumping N direct blocker(s)" (every level of the lab does).
	BodyMarks bool `json:"bodyMarks"`

	Counts SysCounts `json:"counts"`

	// Processes are the rows of the process table in the summary's order: the first SysRowCap, then the rows of the
	// sessions that block or are blocked beyond them; ProcessesOmitted counts the processes not listed.
	Processes        []SysProc `json:"processes"`
	ProcessesOmitted int       `json:"processesOmitted"`

	// Tree is the blocker forest, the largest root first; TreeNodes counts the nodes listed, TreeOmitted those left
	// out for the bound. Blocked counts the sessions that name a direct blocker (also one cut for a cycle), Roots the
	// roots (listed or not).
	Tree        []SysTreeNode `json:"tree"`
	TreeNodes   int           `json:"treeNodes"`
	TreeOmitted int           `json:"treeOmitted"`
	Blocked     int           `json:"blocked"`
	Roots       int           `json:"roots"`

	// Ended: the section's "END OF SYSTEM STATE" was reached.
	Ended bool     `json:"ended"`
	Notes []string `json:"notes"`
}

// ReadingKind is "sysstate".
func (*SysState) ReadingKind() string { return ReadingSysState }

// SysCaller is the caller's short stack.
type SysCaller struct {
	Line  int    `json:"line"`  // the line of the stack
	Stack string `json:"stack"` // as printed, innermost first
	// StackNoOwn is the stack without the leading functions of the signal handler that took it (the ksedsts...
	// entries); Own counts them.
	StackNoOwn string `json:"stackNoOwn"`
	Own        int    `json:"own"`
}

// SysCounts count the processes of the summary (all of them, listed or not).
type SysCounts struct {
	Processes  int `json:"processes"`
	User       int `json:"user"`       // foreground (USER)
	Background int `json:"background"` // named processes
	Pseudo     int `json:"pseudo"`     // the pseudo process
	// Idle counts the idle processes of every kind, IdleBackground those that are background ones (hidden in the
	// text digest and by default in a client); WithoutSession those with no session (sid 0 ser 0 or the pseudo process).
	Idle           int `json:"idle"`
	IdleBackground int `json:"idleBackground"`
	WithoutSession int `json:"withoutSession"`
	// Omitted: summary entries past the bound of the memory kept for the summary (sysSummaryHard), 0 normally.
	Omitted int `json:"omitted,omitempty"`
}

// SysProc is a row of the process table.
type SysProc struct {
	Pid  int    `json:"pid"`  // the Oracle process number: "6:" of the summary and "PROCESS 6:" of the body
	Name string `json:"name"` // "PMON", "USER"; "PSEUDO" for the pseudo process
	Kind string `json:"kind"` // foreground, background, pseudo
	// OSPid is as printed ("2188", or "2299_2300" for a thread of a multithreaded process); absent for the pseudo process.
	OSPid string `json:"ospid,omitempty"`
	Sid   int    `json:"sid"`
	// Serial is the session serial; 0 with sid 0 for a process the summary gives no session.
	Serial int `json:"serial"`
	// Session is "sid.serial"; absent for a process with no session.
	Session string `json:"session,omitempty"`
	Line    int    `json:"line"` // the summary line

	// Event is what the summary says the process waits for; absent when it prints none (the process that took the
	// dump, a process not in a wait). Class is the wait class in the event reference, "" for an event it does not know.
	Event string `json:"event,omitempty"`
	Class string `json:"class,omitempty"`
	// BodyEvent is the event of the body's current wait stack when it is not the summary's: the summary is written
	// first and the bodies later, on a live system, so a process can have moved on (fixture big/diag_sysstate_l266:
	// process 60 is "waiting for 'enq: JG - queue lock'" in the summary and in 'rdbms ipc message' in its body). WaitSec
	// is the body's time in wait, so it belongs to BodyEvent when that is set. Idle and Class follow the summary.
	BodyEvent string `json:"bodyEvent,omitempty"`
	// Idle: the class is Idle, or the process has no session. Background: Kind is background.
	Idle       bool `json:"idle"`
	Background bool `json:"background"`
	// Caller: the session of the process is the one that took the dump.
	Caller bool `json:"caller,omitempty"`

	// Cmd is the summary's "Cmd:" line.
	Cmd string `json:"cmd,omitempty"`
	// Marks of the summary: the direct blockers ("Blocked by") and the final blocker ("Final Blocker").
	BlockedBy    []SessionRef `json:"blockedBy"`
	FinalBlocker *SessionRef  `json:"finalBlocker,omitempty"`

	// Node is the id of the PROCESS n node of the outline (its procstate reading is the process's state objects);
	// NodeLine is its first line. Absent when the section's outline has no node for it.
	Node     string `json:"node,omitempty"`
	NodeLine int    `json:"nodeLine,omitempty"`
	// Body: the process's body was read for this row (the next fields come from it).
	Body bool `json:"body"`

	Flags     string `json:"flags,omitempty"` // the process's flags as printed ("SYSTEM")
	User      string `json:"user,omitempty"`
	Container string `json:"container,omitempty"`
	Module    string `json:"module,omitempty"`
	Action    string `json:"action,omitempty"`
	Program   string `json:"program,omitempty"`
	Machine   string `json:"machine,omitempty"`
	Command   *int   `json:"command,omitempty"` // oct

	// InWait: the session's current wait stack has an entry; WaitSec is its "total=" (the time in wait so far).
	// LastWaitEndedSec: "Not in wait; last wait ended N sec ago".
	InWait           bool     `json:"inWait"`
	WaitSec          *float64 `json:"waitSec,omitempty"`
	LastWaitEndedSec *float64 `json:"lastWaitEndedSec,omitempty"`
	// Blocks is N of "There are N sessions blocked by this session." (0 when the body prints none); Blocked: "There is
	// at least one session blocking this session."
	Blocks  int  `json:"blocks"`
	Blocked bool `json:"blocked"`

	// The session's top-level statement, as the process state reading finds it: SqlID and SqlText (the first line,
	// cut) where the level prints the library object lock of its handle (2, 258, 266), SqlLine the line of that
	// lock; SqlHandle is the address the session prints after "sql:" (absent for none), the only thing a level 1
	// dump says.
	SqlID     string `json:"sqlId,omitempty"`
	SqlText   string `json:"sqlText,omitempty"`
	SqlLine   int    `json:"sqlLine,omitempty"`
	SqlHandle string `json:"sqlHandle,omitempty"`
	// SessionLine is the "(session) sid:" line of the body.
	SessionLine int `json:"sessionLine,omitempty"`
}

// SysTreeNode is a session of the blocker tree.
type SysTreeNode struct {
	Session string `json:"session"` // "sid.serial"
	Sid     int    `json:"sid"`
	Serial  int    `json:"serial"`
	// Inst is the instance a blocker line prints ("inst: 1").
	Inst *int `json:"inst,omitempty"`
	// Foreign: the session is not one of this dump's processes (another instance, or a stale serial); only the
	// dump's mention of it is known (Line).
	Foreign bool `json:"foreign,omitempty"`
	// Cycle: the direct blockers of this session lead back to it; the tree is cut here, the session is a root.
	Cycle bool `json:"cycle,omitempty"`
	Pid   *int `json:"pid,omitempty"`

	User    string   `json:"user,omitempty"`
	Module  string   `json:"module,omitempty"`
	Action  string   `json:"action,omitempty"`
	Event   string   `json:"event,omitempty"`
	WaitSec *float64 `json:"waitSec,omitempty"`
	InWait  bool     `json:"inWait"`
	SqlID   string   `json:"sqlId,omitempty"`
	SqlText string   `json:"sqlText,omitempty"`
	Cmd     string   `json:"cmd,omitempty"`

	// Blocks is N of "There are N sessions blocked by this session." when the dump prints it for this session, else
	// the number of sessions below this one in the tree; Descendants is the latter, always.
	Blocks      int `json:"blocks"`
	Descendants int `json:"descendants"`
	// FinalBlocker is the final blocker the dump names for this session ("sid.serial"); absent for a root.
	FinalBlocker string `json:"finalBlocker,omitempty"`
	// AlsoBlockedBy are the other direct blockers of the session (the tree has it under the first).
	AlsoBlockedBy []string `json:"alsoBlockedBy,omitempty"`

	// Node is the id of the session's process node (a procstate reading); Line the line of the session ("(session)
	// sid:" of the body, else the summary line, else the line that names a foreign session).
	Node     string        `json:"node,omitempty"`
	Line     int           `json:"line"`
	Children []SysTreeNode `json:"children"`
}

// sumEntry is a summary entry while the summary is read.
type sumEntry struct {
	pid     int
	name    string
	kind    string
	ospid   string
	sid     int
	serial  int
	event   string
	line    int
	cmd     string
	blocked []SessionRef
	final   *SessionRef
}

func (e *sumEntry) key() string {
	if e.sid == 0 && e.serial == 0 {
		return ""
	}
	return strconv.Itoa(e.sid) + "." + strconv.Itoa(e.serial)
}

// parseSummaryEntry reads "6: USER ospid 13945 sid 52 ser 41898, waiting for 'PL/SQL lock timer'" (leading blanks cut).
func parseSummaryEntry(n int, t string) (*sumEntry, bool) {
	k := 0
	for k < len(t) && t[k] >= '0' && t[k] <= '9' && k < 9 {
		k++
	}
	if k == 0 || k >= len(t) || t[k] != ':' {
		return nil, false
	}
	pid, _ := strconv.Atoi(t[:k])
	rest := strings.TrimSpace(t[k+1:])
	e := &sumEntry{pid: pid, line: n}
	if strings.HasPrefix(rest, "PSEUDO") {
		e.name, e.kind = "PSEUDO", ProcPseudo
		return e, true
	}
	name := rest
	if i := strings.IndexByte(rest, ' '); i >= 0 {
		name = rest[:i]
	}
	e.name = name
	e.kind = ProcBackground
	if name == "USER" {
		e.kind = ProcForeground
	}
	if v, ok := kvTok(rest, "ospid "); ok {
		e.ospid = v
	}
	e.sid, _ = kvInt(rest, " sid ")
	e.serial, _ = kvInt(rest, " ser ")
	if i := strings.Index(rest, "waiting for '"); i >= 0 {
		ev := rest[i+len("waiting for '"):]
		if j := strings.LastIndexByte(ev, '\''); j >= 0 {
			ev = ev[:j]
		}
		e.event = ev
	}
	return e, true
}

// sysParser reads the lines of a system state.
type sysParser struct {
	r  *Reader
	st *SysState

	phase   int // 0 before the summary, 1 in the summary, 2 after it
	entries []sumEntry
	byPid   map[int]int // pid -> index in rows
	rows    []SysProc
	cur     *sumEntry // the entry the continuation lines belong to

	// the body being read
	ps    *ProcState
	pp    *procParser
	row   int // index in rows, -1 for a body that is skipped
	pname string
	ppid  int

	nodes map[int]Node // the process nodes of the outline, by pid
}

// sysState reads the lines of a node of kind sysstate.
func (r *Reader) sysState(id string, from, to int) (*SysState, error) {
	st := &SysState{Kind: ReadingSysState, Node: id, From: from, To: to, Lines: to - from + 1,
		Processes: []SysProc{}, Tree: []SysTreeNode{}, Notes: []string{}}
	p := &sysParser{r: r, st: st, byPid: map[int]int{}, row: -1}
	p.header(from)
	err := scanLines(r.src, from, to, func(n int, prev, line, next []byte) { p.line(n, line) })
	if err != nil {
		return nil, err
	}
	p.endBody()
	if p.phase == 1 { // the section ends inside the summary
		p.startBodies()
	}
	p.finish()
	return st, nil
}

// header reads the lines before the section: the oradebug command and the caller's stack.
func (p *sysParser) header(from int) {
	if _, key := p.r.Scan.SessionAt(from); key != "" {
		p.st.Session = key
	}
	if from <= 1 {
		return
	}
	lo := max(1, from-sysLookback)
	raw, err := p.r.src.Read(lo, from-lo)
	if err != nil {
		return
	}
	lines := splitLines(raw)
	for i, l := range lines {
		s := strings.TrimSpace(string(l))
		switch {
		case strings.HasPrefix(s, "Processing Oradebug command '"):
			cmd := s[len("Processing Oradebug command '"):]
			if j := strings.LastIndexByte(cmd, '\''); j >= 0 {
				cmd = cmd[:j]
			}
			p.st.Command, p.st.CommandLine = strings.TrimSpace(cmd), lo+i
		case strings.HasPrefix(s, "System state caller's stack"):
			// "Short stack dump:" then the stack
			for j := i + 1; j < len(lines) && j <= i+3; j++ {
				t := strings.TrimSpace(string(lines[j]))
				if t == "" || strings.HasPrefix(t, "Short stack dump") {
					continue
				}
				stack := t
				fns := []string{}
				for _, e := range strings.Split(stack, "<-") {
					fn, _ := splitFrameText(e)
					fns = append(fns, fn)
				}
				own := ownShortStack(fns)
				no := stack
				if own > 0 {
					ents := strings.Split(stack, "<-")
					no = strings.Join(ents[min(own, len(ents)):], "<-")
				}
				p.st.Caller = &SysCaller{Line: lo + j, Stack: stack, StackNoOwn: no, Own: own}
				break
			}
		}
	}
}

func (p *sysParser) line(n int, l []byte) {
	if len(l) == 0 {
		return
	}
	if l[0] == 'S' && p.st.TitleLine == 0 && hasPrefix(l, "SYSTEM STATE (") {
		s := string(l)
		i := strings.IndexByte(s, '(')
		if j := strings.LastIndexByte(s, ')'); j > i {
			lv := s[i+1 : j]
			p.st.Level = lv
			if v, ok := kvInt(lv, "level="); ok {
				p.st.LevelNum = &v
			}
			p.st.ShortStacks = strings.Contains(lv, "with short stacks")
		}
		p.st.TitleLine = n
		return
	}
	if p.phase == 0 {
		if l[0] == 'D' && exact(l, "Dumping the Process Summary") {
			p.phase = 1
			p.st.SummaryLine = n
		} else if l[0] == 'P' {
			if _, _, ok := procHeader(l); ok {
				p.phase = 2
				p.startBodies()
				p.bodyLine(n, l)
			}
		}
		return
	}
	if p.phase == 1 {
		p.summaryLine(n, l)
		return
	}
	if l[0] == 'E' && exact(l, "END OF SYSTEM STATE") {
		p.endBody()
		p.st.Ended = true
		return
	}
	p.bodyLine(n, l)
}

// summaryLine reads a line of the summary; the first line that is not an entry nor one of its lines ends it.
func (p *sysParser) summaryLine(n int, l []byte) {
	if l[0] != ' ' {
		// "System global information:" or the first "PROCESS n:"
		p.phase = 2
		p.startBodies()
		p.bodyLine(n, l)
		return
	}
	t := strings.TrimSpace(string(l))
	if t == "" {
		return
	}
	if t[0] >= '0' && t[0] <= '9' {
		e, ok := parseSummaryEntry(n, t)
		if !ok {
			return
		}
		if len(p.entries) >= sysSummaryHard {
			p.st.Counts.Omitted++
			p.cur = nil
			return
		}
		p.entries = append(p.entries, *e)
		p.cur = &p.entries[len(p.entries)-1]
		return
	}
	if p.cur == nil {
		return
	}
	switch {
	case strings.HasPrefix(t, "Cmd:"):
		p.cur.cmd = strings.TrimSpace(t[len("Cmd:"):])
	case strings.HasPrefix(t, "Blocked by "):
		if ref, ok := refOf(n, t[len("Blocked by "):]); ok {
			p.cur.blocked = append(p.cur.blocked, ref)
			p.st.SummaryMarks = true
		}
	case strings.HasPrefix(t, "Final Blocker "):
		if ref, ok := refOf(n, t[len("Final Blocker "):]); ok {
			p.cur.final = &ref
			p.st.SummaryMarks = true
		}
	}
}

// startBodies is called when the summary is over: it counts the processes, picks the rows to list and finds the
// process nodes of the outline.
func (p *sysParser) startBodies() {
	st := p.st
	c := &st.Counts
	named := map[string]bool{}
	for i := range p.entries {
		e := &p.entries[i]
		for _, b := range e.blocked {
			named[b.Key] = true
		}
		if e.final != nil {
			named[e.final.Key] = true
		}
	}
	rowOf := func(e *sumEntry) SysProc {
		row := SysProc{Pid: e.pid, Name: e.name, Kind: e.kind, OSPid: e.ospid, Sid: e.sid, Serial: e.serial, Session: e.key(), Line: e.line,
			Event: e.event, Cmd: e.cmd, BlockedBy: append([]SessionRef{}, e.blocked...), FinalBlocker: e.final,
			Background: e.kind == ProcBackground}
		if e.event != "" {
			ei := ref.Event(e.event)
			row.Class = ei.Class
			row.Idle = ei.Idle
		}
		if row.Session == "" {
			row.Idle = true
		}
		if row.Session != "" && row.Session == st.Session {
			row.Caller = true
		}
		return row
	}
	extra := 0
	for i := range p.entries {
		e := &p.entries[i]
		c.Processes++
		switch e.kind {
		case ProcForeground:
			c.User++
		case ProcBackground:
			c.Background++
		case ProcPseudo:
			c.Pseudo++
		}
		row := rowOf(e)
		if row.Session == "" {
			c.WithoutSession++
		}
		if row.Idle {
			c.Idle++
			if row.Background {
				c.IdleBackground++
			}
		}
		keep := len(p.rows) < SysRowCap
		if !keep && extra < SysRowCap && (len(e.blocked) > 0 || e.final != nil || (row.Session != "" && named[row.Session])) {
			keep = true
			extra++
		}
		if !keep {
			st.ProcessesOmitted++
			continue
		}
		p.byPid[e.pid] = len(p.rows)
		p.rows = append(p.rows, row)
	}
	c.Processes += c.Omitted
	st.ProcessesOmitted += c.Omitted
	p.entries = nil
	// the nodes of the outline
	if len(p.rows) > 0 {
		if nodes, err := p.r.processNodes(st.Node, sysNodeLimit); err == nil {
			p.nodes = nodes
		}
	}
}

// processNodes finds the PROCESS n children of a system state node: pid -> node, at most limit of them.
func (r *Reader) processNodes(id string, limit int) (map[int]Node, error) {
	o, err := r.scanChildren(id, 0, limit)
	if err != nil {
		return nil, err
	}
	out := map[int]Node{}
	for _, c := range o.Children {
		if c.Kind == "process" {
			if _, ok := out[c.N]; !ok {
				out[c.N] = c
			}
		}
	}
	return out, nil
}

// bodyLine feeds a line after the summary: a PROCESS line starts a body, any other goes to the body being read.
func (p *sysParser) bodyLine(n int, l []byte) {
	if l[0] == 'P' {
		if pid, name, ok := procHeader(l); ok {
			p.endBody()
			p.ppid, p.pname = pid, name
			p.row = -1
			if i, ok := p.byPid[pid]; ok {
				p.row = i
				p.ps, p.pp = newProcParser("", "process", n, n)
			}
			return
		}
	}
	if p.pp != nil {
		p.pp.line(n, l)
	}
}

// endBody finishes the body being read: the process state parser's result goes into its row.
func (p *sysParser) endBody() {
	if p.pp == nil {
		p.row = -1
		return
	}
	p.pp.finish(p.pname, p.ppid)
	p.fillRow(&p.rows[p.row], p.ps)
	p.ps, p.pp, p.row = nil, nil, -1
}

// fillRow completes a row from the reading of its process.
func (p *sysParser) fillRow(row *SysProc, ps *ProcState) {
	row.Body = true
	if nd, ok := p.nodes[row.Pid]; ok {
		row.Node, row.NodeLine = nd.ID, nd.From
	}
	if ps.Process != nil {
		row.Flags = ps.Process.Flags
	}
	var s *ProcSession
	for i := range ps.Sessions {
		if row.Session != "" && ps.Sessions[i].Key == row.Session {
			s = &ps.Sessions[i]
			break
		}
	}
	if s == nil && row.Session == "" && len(ps.Sessions) > 0 {
		s = &ps.Sessions[0]
	}
	if s == nil {
		return
	}
	row.SessionLine = s.Line
	row.User, row.Container, row.Module, row.Action, row.Program, row.Machine = s.User, s.Container, s.Module, s.Action, s.Program, s.Machine
	row.Command = s.Command
	row.SqlID, row.SqlText, row.SqlLine, row.SqlHandle = s.SqlID, s.SqlText, s.SqlLine, s.Sql
	if w := s.Wait; w != nil {
		row.InWait = w.InWait
		if w.InWait && len(w.Stack) > 0 {
			row.WaitSec = w.Stack[0].Seconds
			switch be := w.Stack[0].Event; {
			case row.Event == "":
				row.Event = be
				ei := ref.Event(row.Event)
				row.Class = ei.Class
				row.Idle = row.Idle || ei.Idle
			case be != row.Event:
				row.BodyEvent = be
			}
		}
		row.LastWaitEndedSec = w.LastEndedSec
		row.Blocked = w.Blocked
		row.Blocks = w.BlockedCount
		if len(w.Blockers) > 0 {
			p.st.BodyMarks = true
			// the direct blockers of the body complete those of the summary (the same session is not listed twice)
			for _, b := range w.Blockers {
				dup := false
				for _, x := range row.BlockedBy {
					dup = dup || x.Key == b.Key
				}
				if !dup {
					row.BlockedBy = append(row.BlockedBy, b)
				}
			}
		}
		if row.FinalBlocker == nil && w.FinalBlocker != nil {
			f := *w.FinalBlocker
			row.FinalBlocker = &f
		}
	}
}

// finish makes the tree and the notes.
func (p *sysParser) finish() {
	st := p.st
	st.Processes = p.rows
	if st.Processes == nil {
		st.Processes = []SysProc{}
	}
	p.tree()
	if st.TitleLine == 0 {
		st.Notes = append(st.Notes, "no \"SYSTEM STATE (level=...)\" line in this part")
	}
	if st.SummaryLine == 0 {
		st.Notes = append(st.Notes, "no process summary in this part")
	}
	if !st.Ended {
		st.Notes = append(st.Notes, "the dump is cut short: its \"END OF SYSTEM STATE\" line was not reached")
	}
	if st.ProcessesOmitted > 0 {
		st.Notes = append(st.Notes, strconv.Itoa(st.ProcessesOmitted)+" processes are not listed (the table holds "+strconv.Itoa(SysRowCap)+" rows and the rows of blocked and blocking sessions beyond them)")
	}
	if st.Counts.Omitted > 0 {
		st.Notes = append(st.Notes, strconv.Itoa(st.Counts.Omitted)+" summary entries were not remembered (the bound is "+strconv.Itoa(sysSummaryHard)+")")
	}
	bodies, moved := 0, 0
	for _, r := range p.rows {
		if r.Body {
			bodies++
		}
		if r.BodyEvent != "" {
			moved++
		}
	}
	if moved > 0 {
		st.Notes = append(st.Notes, strconv.Itoa(moved)+" processes wait for another event in their bodies than in the summary (the summary is written first, the bodies later: bodyEvent)")
	}
	if len(p.rows) > 0 && bodies < len(p.rows) {
		st.Notes = append(st.Notes, strconv.Itoa(len(p.rows)-bodies)+" listed processes have no body in this dump (only the summary line is known)")
	}
	if len(p.rows) > 0 && bodies == len(p.rows) && st.LevelNum != nil && *st.LevelNum == 1 {
		st.Notes = append(st.Notes, "level 1 prints the process and its sessions only: no library object locks, so a statement is the address of its library handle")
	}
}

// tnode is a session of the forest while it is built.
type tnode struct {
	key      string
	sid, ser int
	inst     *int
	row      *SysProc
	line     int
	foreign  bool
	cycle    bool
	blockers []string // direct blockers (keys), in the order named
	finalKey string
	parent   *tnode
	kids     []*tnode
	order    int
	desc     int
}

// tree builds the blocker forest from the rows.
func (p *sysParser) tree() {
	st := p.st
	nodes := map[string]*tnode{}
	var order []*tnode
	get := func(r SessionRef, row *SysProc) *tnode {
		if t, ok := nodes[r.Key]; ok {
			return t
		}
		t := &tnode{key: r.Key, sid: r.Sid, ser: r.Serial, line: r.Line, order: len(order)}
		if r.Inst != 0 {
			v := r.Inst
			t.inst = &v
		}
		nodes[r.Key] = t
		order = append(order, t)
		return t
	}
	// the sessions of the table that take part: those with a blocker and those named as one
	byKey := map[string]*SysProc{}
	for i := range p.rows {
		if p.rows[i].Session != "" {
			byKey[p.rows[i].Session] = &p.rows[i]
		}
	}
	// pass 1: the sessions that have blockers, in table order
	for i := range p.rows {
		r := &p.rows[i]
		if r.Session == "" || (len(r.BlockedBy) == 0 && r.FinalBlocker == nil) {
			continue
		}
		t := get(SessionRef{Sid: r.Sid, Serial: r.Serial, Key: r.Session, Line: r.sessionLine()}, r)
		t.row = r
		for _, b := range r.BlockedBy {
			t.blockers = append(t.blockers, b.Key)
		}
		if r.FinalBlocker != nil {
			t.finalKey = r.FinalBlocker.Key
			if len(t.blockers) == 0 {
				t.blockers = append(t.blockers, r.FinalBlocker.Key)
			}
		}
	}
	// pass 2: the blockers, each its node (a foreign one when the dump has no such session)
	for i := range p.rows {
		r := &p.rows[i]
		if r.Session == "" {
			continue
		}
		t := nodes[r.Session]
		if t == nil {
			continue
		}
		refs := append([]SessionRef{}, r.BlockedBy...)
		if r.FinalBlocker != nil {
			refs = append(refs, *r.FinalBlocker)
		}
		for _, b := range refs {
			bt := get(b, nil)
			if bt.row == nil {
				if row, ok := byKey[b.Key]; ok {
					bt.row = row
					bt.line = row.sessionLine()
				} else {
					bt.foreign = true
				}
			}
		}
	}
	// parents: the first direct blocker
	for _, t := range order {
		if len(t.blockers) == 0 {
			continue
		}
		par := nodes[t.blockers[0]]
		if par != nil && par != t {
			t.parent = par
		}
	}
	// cycles: walking up from a node must end
	for _, t := range order {
		seen := map[*tnode]bool{}
		for c := t; c != nil; c = c.parent {
			if seen[c] {
				// c is on a cycle: cut it at c
				c.parent = nil
				c.cycle = true
				break
			}
			seen[c] = true
		}
	}
	var roots []*tnode
	for _, t := range order {
		if t.parent == nil {
			roots = append(roots, t)
		} else {
			t.parent.kids = append(t.parent.kids, t)
		}
	}
	var count func(t *tnode) int
	count = func(t *tnode) int {
		n := 0
		for _, k := range t.kids {
			n += 1 + count(k)
		}
		t.desc = n
		return n
	}
	for _, t := range roots {
		count(t)
	}
	sort.SliceStable(roots, func(i, j int) bool {
		if roots[i].desc != roots[j].desc {
			return roots[i].desc > roots[j].desc
		}
		return roots[i].order < roots[j].order
	})
	st.Roots = len(roots)
	for _, t := range order {
		if len(t.blockers) > 0 {
			st.Blocked++
		}
	}
	shown := 0
	var conv func(t *tnode) (SysTreeNode, bool)
	conv = func(t *tnode) (SysTreeNode, bool) {
		if shown >= SysTreeCap {
			return SysTreeNode{}, false
		}
		shown++
		n := SysTreeNode{Session: t.key, Sid: t.sid, Serial: t.ser, Inst: t.inst, Foreign: t.foreign, Cycle: t.cycle,
			Descendants: t.desc, Line: t.line, Children: []SysTreeNode{}}
		n.Blocks = t.desc
		if r := t.row; r != nil {
			pid := r.Pid
			n.Pid = &pid
			n.User, n.Module, n.Action, n.Event, n.WaitSec, n.InWait = r.User, r.Module, r.Action, r.Event, r.WaitSec, r.InWait
			if r.BodyEvent != "" { // the time in wait is the body's
				n.Event = r.BodyEvent
			}
			n.SqlID, n.SqlText, n.Cmd = r.SqlID, r.SqlText, r.Cmd
			n.Node = r.Node
			if r.Blocks > 0 {
				n.Blocks = r.Blocks
			}
		}
		if t.finalKey != "" && t.parent != nil {
			n.FinalBlocker = t.finalKey
		}
		if len(t.blockers) > 1 {
			n.AlsoBlockedBy = append([]string{}, t.blockers[1:]...)
		}
		for _, k := range t.kids {
			if c, ok := conv(k); ok {
				n.Children = append(n.Children, c)
			}
		}
		return n, true
	}
	for _, t := range roots {
		if n, ok := conv(t); ok {
			st.Tree = append(st.Tree, n)
		}
	}
	st.TreeNodes = shown
	st.TreeOmitted = len(order) - shown
	// the dump's final blocker against where the chain of direct blockers ends
	for _, t := range order {
		if t.finalKey == "" {
			continue
		}
		top := t
		for hops := 0; top.parent != nil && hops < 1000; hops++ {
			top = top.parent
		}
		if top.key != t.finalKey {
			st.Notes = append(st.Notes, "session "+t.key+": the dump names "+t.finalKey+" as its final blocker, the chain of direct blockers ends at "+top.key)
		}
	}
	for _, t := range order {
		if t.cycle {
			st.Notes = append(st.Notes, "session "+t.key+": its direct blockers lead back to it; the tree is cut there")
		}
	}
}

// sessionLine is the line of the session of a row: the "(session) sid:" line of the body, else the summary line.
func (r *SysProc) sessionLine() int {
	if r.SessionLine > 0 {
		return r.SessionLine
	}
	return r.Line
}
