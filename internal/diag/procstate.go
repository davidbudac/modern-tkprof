package diag

import (
	"bytes"
	"sort"
	"strconv"
	"strings"
)

// The reading of a process state (docs/PLAN-DIAG.md § The readings; the format is docs/trace-format-diag.md §
// Process state): the state object tree of one Oracle process, as the "PROCESS STATE" dump prints it or as a
// system state prints it under "PROCESS n: name". Who the process and its session are, what the session waits
// for and who blocks it, and what the process holds.
//
// The tree is read by its state object lines, "SO: 0x<addr>, type: <name> (<n>), map: 0x<addr>", at any
// indentation (a system state prints them at the left margin, a process state indented two blanks per level); a
// state object's own text runs to the next such line, and the tree ends at the first rule of "=" or titled
// "----- X -----" line after it (the instantiation state and the cursor dumps that follow a process state are
// not part of it). The owner of an object is the "owner: 0x<addr>" line under its SO line, which gives the
// depth of the tree and which session an object belongs to. Kinds that are not read stay counted by type.
//
// What is read, and from which lines (every line of the dump named is in a fixture):
//
//	process      "(process) Oracle pid:6, ser:35", "flags : (0xe) SYSTEM", "O/S info: user: oracle, term: UNKNOWN, ospid: 13832",
//	             "Short stack dump:" and the line after it
//	session      "(session) sid: 61 ser: 21652", "user#/name: 165/MTK", "con_id/con_uid/con_name: 3/3985962602/PDB1",
//	             "oct: 47, prv: 0, sql: 0x79a02048, psql: 0x799d7ea0", "service name:", "client details:" with "O/S info:",
//	             "machine: M program: P", "application name: A, hash value=", "action name: A, hash value="
//	wait         "Current Wait Stack:" with " 0: waiting for 'event'", the parameter line, "wait times: snap= exc= total=";
//	             "Not in wait; last wait ended 0.001319 sec ago"; "There is at least one session blocking this session.",
//	             "Dumping 1 direct blocker(s):", "Dumping final blocker:", each followed by "inst: 1, sid: 52, ser: 41898";
//	             "There are 1 sessions blocked by this session.", "Dumping one waiter:" with "wait event:", "p1:" lines,
//	             "row_wait_obj#:", "min_blocked_time:"; "Session Wait History:" with " 0: waited for 'event'"
//	holds        "Enqueue Dump (enqueue) TX-... " with the "mode: X, lock_flag:" or "req: X, lock_flag:" line after it;
//	             the transaction ("env [...]: (scn: ... xid: 0x0005.016.00005a54", "Undo blks: 1 recs: 3", "Begin scn: ... ts:...[date]")
//	             with its Block List rows ("index itli rdba sql_id obj# savepoint"); DML lock ("DML LOCK: tab=108609 flg=11",
//	             "his[0]: mod=3"); LIBRARY OBJECT LOCK and PIN ("LibraryObjectLock:  Address= Handle= Mode=",
//	             "LibraryObjectPin: Address= Handle= Mode= Lock=", "Count=", then the handle's "ObjectName:  Name=",
//	             "Namespace= SqlId= Type=")
//
// What the session's statement is: the session object prints only "sql: 0x79a02048", the address of the library
// handle of its top-level statement. The session holds a library object lock on that handle, whose text prints
// the handle's "SqlId=f3j90cdzgg7d2" and the statement ("ObjectName:  Name=begin mtk_diag_outer(:ev, :cid); end;"):
// the reading matches the two. A dump that prints no child state objects (a system state of level 1) has no
// such lock and gives the address alone. The statement a session is running inside that call is not in the
// session object: a diagnostic dump names it in its own "Current SQL Statement" section (the call stack reading).

// Bounds of a process state reading.
const (
	// ProcSessionCap is how many sessions a process lists.
	ProcSessionCap = 20
	// HoldCap is how many library object locks and how many pins are listed (the totals count all).
	HoldCap = 30
	// EnqueueCap, TransactionCap, DMLCap bound the other lists of holds.
	EnqueueCap     = 50
	TransactionCap = 20
	DMLCap         = 50
	// BlockRowCap is how many Block List rows a transaction lists.
	BlockRowCap = 10
	// HistoryCap is how many entries of the wait history are listed.
	HistoryCap = 30
	// WaiterCap bounds the waiters a session lists.
	WaiterCap = 10
	// BlockerCap bounds the blockers a session lists.
	BlockerCap = 20
	// StackCap bounds the entries of a current wait stack.
	StackCap = 10
	// TypeCap bounds the types counted.
	TypeCap = 100
)

// ProcState is the reading of a process state.
type ProcState struct {
	Kind  string `json:"kind"` // "procstate"
	Node  string `json:"node"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"`
	// Scope is "process state" for a PROCESS STATE dump and "process" for a PROCESS n: name of a system state.
	Scope string `json:"scope"`

	// Process is the process's own object; absent when the lines hold none.
	Process *ProcInfo `json:"process,omitempty"`
	// Sessions are the sessions the process owns, in file order, at most ProcSessionCap; SessionsTotal counts
	// them. A user process has one; a background process may have none or several.
	Sessions      []ProcSession `json:"sessions"`
	SessionsTotal int           `json:"sessionsTotal"`

	// Objects counts the state objects by the type name printed; the counts sum to Total.
	Objects ProcObjects `json:"objects"`

	// What the process holds. Each list is in file order and bounded; the Total says how many there are.
	// A held enqueue is a resource with the mode held ("mode:") or requested ("req:").
	Enqueues      []ProcEnqueue `json:"enqueues"`
	EnqueuesTotal int           `json:"enqueuesTotal"`
	// EnqueuesOther counts the "Enqueue Dump" lines that name no resource ("released enqueue or enqueue in flux",
	// "<no resource>").
	EnqueuesOther     int               `json:"enqueuesOther,omitempty"`
	Transactions      []ProcTransaction `json:"transactions"`
	TransactionsTotal int               `json:"transactionsTotal"`
	DMLLocks          []ProcDMLLock     `json:"dmlLocks"`
	DMLLocksTotal     int               `json:"dmlLocksTotal"`
	Locks             []ProcLibObject   `json:"locks"` // library object locks
	LocksTotal        int               `json:"locksTotal"`
	Pins              []ProcLibObject   `json:"pins"` // library object pins
	PinsTotal         int               `json:"pinsTotal"`

	// ShortStack is the process's short stack when the dump prints one ("Short stack dump:" and the line after
	// it), innermost first, as printed; ShortStackNoOwn the same without the entries of the signal handler that
	// took it (the leading ksedsts ... __sighandler); ShortStackOwn how many entries those are.
	ShortStack      string   `json:"shortStack,omitempty"`
	ShortStackNoOwn string   `json:"shortStackNoOwn,omitempty"`
	ShortStackOwn   int      `json:"shortStackOwn,omitempty"`
	ShortStackLine  int      `json:"shortStackLine,omitempty"`
	Notes           []string `json:"notes"`
}

// ReadingKind is "procstate".
func (*ProcState) ReadingKind() string { return ReadingProcState }

// ProcInfo is the process's state object.
type ProcInfo struct {
	Line    int    `json:"line"`    // its SO line
	Address string `json:"address"` // "0xa2eec2a0"
	Pid     *int   `json:"pid,omitempty"`
	Serial  *int   `json:"serial,omitempty"`
	OSPid   string `json:"ospid,omitempty"`
	OSUser  string `json:"osUser,omitempty"`
	// Name is the process name a system state prints ("PMON"); "" for a PROCESS STATE dump and for a user process.
	Name string `json:"name,omitempty"`
	// Flags are the process flags as printed ("SYSTEM" for a background process, "-" for none).
	Flags string `json:"flags,omitempty"`
	// Program is the program of the first session that prints one (a process prints none itself).
	Program string `json:"program,omitempty"`
}

// ProcSession is a session state object with what its text says.
type ProcSession struct {
	Address string `json:"address"`
	Line    int    `json:"line"` // the "(session) sid:" line; the SO line when it has none
	From    int    `json:"from"` // the session's own text: its SO line to the line before the next SO line
	To      int    `json:"to"`
	Sid     int    `json:"sid"`
	Serial  int    `json:"serial"`
	Key     string `json:"key"` // "sid.serial", as the 10046 session id

	UserID       *int   `json:"userId,omitempty"`
	User         string `json:"user,omitempty"`
	ContainerID  *int   `json:"containerId,omitempty"`
	ContainerUID string `json:"containerUid,omitempty"`
	Container    string `json:"container,omitempty"`
	Machine      string `json:"machine,omitempty"`
	Program      string `json:"program,omitempty"`
	ClientOSUser string `json:"clientOsUser,omitempty"`
	ClientOSPid  string `json:"clientOspid,omitempty"`
	Module       string `json:"module,omitempty"` // "application name:"
	Action       string `json:"action,omitempty"` // "action name:"
	Service      string `json:"service,omitempty"`
	Command      *int   `json:"command,omitempty"`     // oct
	CommandName  string `json:"commandName,omitempty"` // only for the codes a fixture shows (3 SELECT, 47 PL/SQL EXECUTE)
	CommandLine  int    `json:"commandLine,omitempty"`
	Sql          string `json:"sql,omitempty"` // the address printed after "sql:", "" for (nil)
	SqlID        string `json:"sqlId,omitempty"`
	SqlText      string `json:"sqlText,omitempty"` // the first line of the statement, at most StatementCut bytes
	SqlLine      int    `json:"sqlLine,omitempty"` // the line of the library handle that names it
	// PrevSql is the address after "psql:" and PrevSqlID, PrevSqlText and PrevSqlLine the statement it names, found
	// the same way: the session's previous statement (fixture big/diag_sysstate_l266: sid 45, action
	// s2_holds_302_waits_301, sql: "... id = 301 for update wait 60", psql: "... id = 302 for update").
	PrevSql     string    `json:"prevSql,omitempty"`
	PrevSqlID   string    `json:"prevSqlId,omitempty"`
	PrevSqlText string    `json:"prevSqlText,omitempty"`
	PrevSqlLine int       `json:"prevSqlLine,omitempty"`
	Wait        *ProcWait `json:"wait,omitempty"`
}

// ProcWait is what the session's text says about its wait.
type ProcWait struct {
	// InWait: the current wait stack has an entry. Line is the "Current Wait Stack:" line (0 when the session prints none).
	InWait bool `json:"inWait"`
	Line   int  `json:"line,omitempty"`
	// Stack are the wait stack's entries, outermost first (entry 0 is the one waited for now).
	Stack []WaitEntry `json:"stack"`
	// LastEndedSec is set for a session not in wait: "Not in wait; last wait ended 0.001319 sec ago".
	LastEndedSec *float64 `json:"lastEndedSec,omitempty"`
	// Blocked: "There is at least one session blocking this session." Blockers are the "Dumping N direct blocker(s)"
	// the dump names (BlockersCount is N), FinalBlocker the one under "Dumping final blocker:".
	Blocked       bool         `json:"blocked"`
	Blockers      []SessionRef `json:"blockers"`
	BlockersCount int          `json:"blockersCount,omitempty"`
	FinalBlocker  *SessionRef  `json:"finalBlocker,omitempty"`
	// BlockedCount is N of "There are N sessions blocked by this session."; Waiters the ones the dump describes
	// ("Dumping one waiter:": the dump prints one however many there are).
	BlockedCount int          `json:"blockedCount"`
	BlockedLine  int          `json:"blockedLine,omitempty"`
	Waiters      []ProcWaiter `json:"waiters"`
	// History is the "Session Wait History:", latest first, at most HistoryCap; HistoryTotal counts them. ElapsedSec
	// is "elapsed time of N sec since last wait".
	History      []WaitHistory `json:"history"`
	HistoryTotal int           `json:"historyTotal"`
	HistoryLine  int           `json:"historyLine,omitempty"`
	ElapsedSec   *float64      `json:"elapsedSec,omitempty"`
}

// WaitEntry is an entry of the current wait stack.
type WaitEntry struct {
	Level int    `json:"level"`
	Event string `json:"event"`
	// Params is the parameter line as printed ("name|mode=0x54580006, usn<<16 | slot=0x80005, sequence=0x5817").
	Params string `json:"params,omitempty"`
	// Seconds is "total=" of the entry's "wait times:" line: the time in wait so far.
	Seconds *float64 `json:"seconds,omitempty"`
	Line    int      `json:"line"`
}

// SessionRef names a session the dump names ("inst: 1, sid: 52, ser: 41898").
type SessionRef struct {
	Inst   int    `json:"inst"`
	Sid    int    `json:"sid"`
	Serial int    `json:"serial"`
	Key    string `json:"key"` // "sid.serial"
	Line   int    `json:"line"`
}

// ProcWaiter is a session blocked by this one that the dump describes.
type ProcWaiter struct {
	SessionRef
	Event string `json:"event,omitempty"`
	// Params are the "p1: 'name|mode'=0x54580006" lines as printed.
	Params        []string `json:"params"`
	RowWait       *RowWait `json:"rowWait,omitempty"`
	MinBlockedSec *int     `json:"minBlockedSec,omitempty"`
}

// RowWait is "row_wait_obj#: 108609, block#: 169252, row#: 6, file# 12".
type RowWait struct {
	Obj   int64 `json:"obj"`
	Block int64 `json:"block"`
	Row   int64 `json:"row"`
	File  int64 `json:"file"`
	Line  int   `json:"line"`
}

// WaitHistory is an entry of the Session Wait History.
type WaitHistory struct {
	N       int      `json:"n"`
	Event   string   `json:"event"`
	Params  string   `json:"params,omitempty"`
	Seconds *float64 `json:"seconds,omitempty"` // "total=" of its first "wait times:" line
	Line    int      `json:"line"`
}

// ProcObjects counts the state objects.
type ProcObjects struct {
	Total  int          `json:"total"`
	Depth  int          `json:"depth"` // the deepest level of the tree by owner links; the process is 1
	ByType []ObjectType `json:"byType"`
	// TypesOther counts the types beyond TypeCap (0 normally).
	TypesOther int `json:"typesOther,omitempty"`
}

// ObjectType is a count of state objects of one type.
type ObjectType struct {
	Type   string `json:"type"`   // as printed: "LIBRARY OBJECT LOCK", "enqueue"
	Number int    `json:"number"` // the number in parentheses
	Count  int    `json:"count"`
}

// ProcEnqueue is an "Enqueue Dump" of the state objects.
type ProcEnqueue struct {
	Resource  string `json:"resource"` // "TX-00050016-00005A54-ED94F66A-00000000"
	Type      string `json:"type"`     // "TX"
	Mode      string `json:"mode"`     // NULL, SS, SX, S, SSX, X as printed
	Requested bool   `json:"requested,omitempty"`
	Flag      string `json:"flag,omitempty"`    // lock_flag
	In        string `json:"in,omitempty"`      // the type of the state object whose text holds the dump
	Session   string `json:"session,omitempty"` // "sid.serial" of the session that object belongs to
	Line      int    `json:"line"`
}

// ProcTransaction is a transaction state object.
type ProcTransaction struct {
	Address string `json:"address"`
	Session string `json:"session,omitempty"`
	Line    int    `json:"line"`
	Xid     string `json:"xid,omitempty"` // "0x0005.016.00005a54"
	// UndoBlocks and UndoRecords are "Undo blks: 1 recs: 3"; Begin the time of "Begin scn: ... ts:...[...]".
	UndoBlocks  *int       `json:"undoBlocks,omitempty"`
	UndoRecords *int       `json:"undoRecords,omitempty"`
	Begin       string     `json:"begin,omitempty"`
	Blocks      []BlockRow `json:"blocks"` // the Block List under it, at most BlockRowCap
	BlocksTotal int        `json:"blocksTotal"`
}

// BlockRow is a row of a Block List.
type BlockRow struct {
	Itli  int    `json:"itli"`
	RDBA  string `json:"rdba"`
	SQLID string `json:"sqlId"`
	Obj   int64  `json:"obj"`
	Line  int    `json:"line"`
}

// ProcDMLLock is a DML lock state object.
type ProcDMLLock struct {
	Address string `json:"address"`
	Session string `json:"session,omitempty"`
	Line    int    `json:"line"`
	Table   int64  `json:"table"` // "tab=108609": the object id
	Flags   string `json:"flags,omitempty"`
	Mode    *int   `json:"mode,omitempty"` // "mod=3" of the first history entry
	// ModeName is the name of that lock mode, 1 NULL 2 SS 3 SX 4 S 5 SSX 6 X: fixture: mod=3 beside a TM enqueue of mode SX.
	ModeName string `json:"modeName,omitempty"`
}

// ProcLibObject is a library object lock or pin.
type ProcLibObject struct {
	Address string `json:"address"`
	Session string `json:"session,omitempty"`
	Line    int    `json:"line"`
	Handle  string `json:"handle"`
	Mode    string `json:"mode"` // as printed: N, S, X
	// Namespace and Type of the handle without their numbers ("SQL AREA", "CURSOR", "TABLE/PROCEDURE", "PROCEDURE").
	Namespace string `json:"namespace,omitempty"`
	Type      string `json:"type,omitempty"`
	// Name is the handle's "ObjectName:  Name=" (the first line of the text for a cursor); SQLID its "SqlId=" or the
	// "Parent Cursor: sql_id=" of its text.
	Name  string `json:"name,omitempty"`
	SQLID string `json:"sqlId,omitempty"`
	// Count is the "Count=" of a pin.
	Count *int `json:"count,omitempty"`
}

// soRec is a state object while the node's lines are read.
type soRec struct {
	typ   string
	num   int
	addr  string
	owner string
	line  int
	to    int

	sess *ProcSession // a session object
	lib  *ProcLibObject
	pin  bool
	tx   *ProcTransaction
	dml  *ProcDMLLock

	handleSeen bool
	nameOpen   bool
	nameDone   bool
	session    string // resolved from the owner chain
}

// commandNames are the command numbers a fixture shows by name: the "Cmd:" lines of the process summary of a
// system state next to the "oct:" of the session (testdata/diag/19c/diag_sysstate_l1: sid 45 oct 3 "Cmd: SELECT",
// sid 52 oct 47 "Cmd: PL/SQL EXECUTE"; the same in the level 2, 258 and 266 dumps).
var commandNames = map[int]string{3: "SELECT", 47: "PL/SQL EXECUTE"}

// lockModeNames name the numbers of a DML lock's "mod=": the numbering of v$lock (fixture: diag_procstate:767-776,
// "mod=3" and the TM enqueue "mode: SX" of the same object).
var lockModeNames = map[int]string{0: "none", 1: "NULL", 2: "SS", 3: "SX", 4: "S", 5: "SSX", 6: "X"}

type waitMode uint8

const (
	wmNone waitMode = iota
	wmCur
	wmHist
)

type blockMode uint8

const (
	bmNone blockMode = iota
	bmDirect
	bmFinal
	bmWaiter
)

type procParser struct {
	ps    *ProcState
	scope string

	seenSO bool
	done   bool
	cur    *soRec
	all    []*soRec
	byAddr map[string]*soRec

	proc    *ProcInfo
	sess    *ProcSession // the session whose text is being read (cur.sess, kept for the wait lines)
	wm      waitMode
	bm      blockMode
	wait    *ProcWait
	waiter  *ProcWaiter
	pendEv  *string // where the parameter line of an event line goes
	pendSec *WaitEntry
	histCur *WaitHistory
	histSec bool

	stackNext int // the line after "Short stack dump:" is the stack
	enq       *ProcEnqueue
	enqLeft   int

	enqDone   []ProcEnqueue
	enqSO     []*soRec // the object each of enqDone was dumped under
	blockRows []blockRow
	types     map[string]*ObjectType
	order     []string
}

// procState reads the lines of a node of kind procstate or process.
func (r *Reader) procState(id, kind string, from, to int) (*ProcState, error) {
	ps := &ProcState{Kind: ReadingProcState, Node: id, From: from, To: to, Lines: to - from + 1, Scope: "process state",
		// every list is allocated at its bound: the parser keeps pointers into them while it reads
		Sessions: make([]ProcSession, 0, ProcSessionCap), Enqueues: []ProcEnqueue{}, Transactions: make([]ProcTransaction, 0, TransactionCap),
		DMLLocks: make([]ProcDMLLock, 0, DMLCap), Locks: make([]ProcLibObject, 0, HoldCap), Pins: make([]ProcLibObject, 0, HoldCap),
		Notes: []string{}, Objects: ProcObjects{ByType: []ObjectType{}}}
	if kind == "process" {
		ps.Scope = "process"
	}
	p := &procParser{ps: ps, scope: ps.Scope, byAddr: map[string]*soRec{}, types: map[string]*ObjectType{}}
	p.enqDone = make([]ProcEnqueue, 0, EnqueueCap)
	name := ""
	pid := 0
	err := scanLines(r.src, from, to, func(n int, prev, line, next []byte) {
		if n == from && kind == "process" {
			// "PROCESS 6: " or "PROCESS 2: PMON"
			if len(line) > 8 && string(line[:8]) == "PROCESS " {
				num, k := digits(line[8:])
				pid = num
				if k > 0 && 8+k < len(line) && line[8+k] == ':' {
					name = strings.TrimSpace(string(line[8+k+1:]))
				}
			}
			return
		}
		p.line(n, line)
	})
	if err != nil {
		return nil, err
	}
	p.finish(name, pid)
	return ps, nil
}

func isSOLine(t []byte) (typ string, num int, addr string, ok bool) {
	if len(t) < 14 || t[0] != 'S' || t[1] != 'O' || t[2] != ':' || t[3] != ' ' || t[4] != '0' || t[5] != 'x' {
		return
	}
	i := bytes.Index(t, []byte(", type: "))
	if i < 0 {
		return
	}
	addr = string(t[4:i])
	rest := string(t[i+len(", type: "):])
	if j := strings.Index(rest, ", map"); j >= 0 {
		rest = rest[:j]
	}
	rest = strings.TrimSpace(rest)
	typ = rest
	if k := strings.LastIndexByte(rest, '('); k > 0 && strings.HasSuffix(rest, ")") {
		num, _ = strconv.Atoi(rest[k+1 : len(rest)-1])
		typ = strings.TrimSpace(rest[:k])
	}
	return typ, num, addr, true
}

func (p *procParser) line(n int, l []byte) {
	if p.done {
		return
	}
	if len(l) == 0 {
		return
	}
	c := l[0]
	if p.seenSO {
		if c == '=' && len(l) >= 5 && l[1] == '=' && l[2] == '=' || c == '-' && func() bool { _, ok := dashTitle(l); return ok }() || exact(l, "END OF PROCESS STATE") {
			p.done = true
			p.endSO(n - 1)
			return
		}
	}
	t := bytes.TrimSpace(l)
	if typ, num, addr, ok := isSOLine(t); ok {
		p.seenSO = true
		p.endSO(n - 1)
		so := &soRec{typ: typ, num: num, addr: addr, line: n, to: n}
		p.cur = so
		p.all = append(p.all, so)
		p.byAddr[addr] = so
		tt := p.types[typ+"\x00"+strconv.Itoa(num)]
		if tt == nil {
			tt = &ObjectType{Type: typ, Number: num}
			p.types[typ+"\x00"+strconv.Itoa(num)] = tt
			p.order = append(p.order, typ+"\x00"+strconv.Itoa(num))
		}
		tt.Count++
		p.wm, p.bm, p.wait, p.waiter, p.pendEv, p.pendSec, p.histCur = wmNone, bmNone, nil, nil, nil, nil, nil
		p.enq = nil
		p.sess = nil
		switch typ {
		case "session":
			p.ps.SessionsTotal++
			if len(p.ps.Sessions) < ProcSessionCap {
				p.ps.Sessions = append(p.ps.Sessions, ProcSession{Address: addr, Line: n, From: n, To: n})
				so.sess = &p.ps.Sessions[len(p.ps.Sessions)-1]
				p.sess = so.sess
				// the slice may move when it grows: keep the pointer only while reading this object
			}
		case "transaction":
			p.ps.TransactionsTotal++
			if len(p.ps.Transactions) < TransactionCap {
				p.ps.Transactions = append(p.ps.Transactions, ProcTransaction{Address: addr, Line: n, Blocks: []BlockRow{}})
				so.tx = &p.ps.Transactions[len(p.ps.Transactions)-1]
			}
		case "DML lock":
			p.ps.DMLLocksTotal++
			if len(p.ps.DMLLocks) < DMLCap {
				p.ps.DMLLocks = append(p.ps.DMLLocks, ProcDMLLock{Address: addr, Line: n})
				so.dml = &p.ps.DMLLocks[len(p.ps.DMLLocks)-1]
			}
		case "LIBRARY OBJECT LOCK":
			p.ps.LocksTotal++
			if len(p.ps.Locks) < HoldCap {
				p.ps.Locks = append(p.ps.Locks, ProcLibObject{Address: addr, Line: n})
				so.lib = &p.ps.Locks[len(p.ps.Locks)-1]
			}
		case "LIBRARY OBJECT PIN":
			p.ps.PinsTotal++
			so.pin = true
			if len(p.ps.Pins) < HoldCap {
				p.ps.Pins = append(p.ps.Pins, ProcLibObject{Address: addr, Line: n})
				so.lib = &p.ps.Pins[len(p.ps.Pins)-1]
			}
		}
		return
	}
	if p.cur == nil {
		return
	}
	p.cur.to = n
	if p.cur.sess != nil {
		p.cur.sess.To = n
	}
	// the owner line under the SO line
	if p.cur.owner == "" && n-p.cur.line <= 4 && hasPrefix(t, "owner: ") {
		o := string(t[len("owner: "):])
		if i := strings.IndexByte(o, ','); i >= 0 {
			o = o[:i]
		}
		p.cur.owner = o
		return
	}
	// an enqueue dump (any object's text may hold one)
	if p.enqLine(n, l) {
		return
	}
	if p.enq != nil {
		p.enqFollow(n, t)
	}
	if p.stackNext > 0 {
		p.stackNext--
		if len(t) > 0 && (bytes.Contains(t, []byte("()")) || bytes.Contains(t, []byte("<-"))) && p.ps.ShortStack == "" {
			p.ps.ShortStack, p.ps.ShortStackLine = string(t), n
			p.stackNext = 0
		}
	}
	if hasPrefix(t, "Short stack dump:") {
		p.stackNext = 2
		return
	}
	switch p.cur.typ {
	case "process":
		p.processLine(n, t)
	case "session":
		if p.cur.sess != nil {
			p.sessionLine(n, t)
		}
	case "transaction":
		p.txLine(n, t)
	case "DML lock":
		p.dmlLine(n, t)
	case "Block List":
		p.blockLine(n, t)
	case "LIBRARY OBJECT LOCK", "LIBRARY OBJECT PIN":
		p.libLine(n, t)
	}
}

func (p *procParser) endSO(to int) {
	if p.cur != nil && to >= p.cur.line {
		p.cur.to = to
		if p.cur.sess != nil {
			p.cur.sess.To = to
		}
	}
}

// kvTok gives the token after key up to the next blank or comma ("pid:6," -> "6").
func kvTok(s, key string) (string, bool) {
	i := strings.Index(s, key)
	if i < 0 {
		return "", false
	}
	rest := s[i+len(key):]
	j := 0
	for j < len(rest) && rest[j] != ' ' && rest[j] != ',' && rest[j] != '\t' {
		j++
	}
	return rest[:j], true
}

func kvInt(s, key string) (int, bool) {
	v, ok := kvTok(s, key)
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	return n, err == nil
}

func (p *procParser) processLine(n int, t []byte) {
	if p.proc == nil {
		p.proc = &ProcInfo{Line: p.cur.line, Address: p.cur.addr}
		p.ps.Process = p.proc
	}
	if p.proc.Line != p.cur.line { // another process object: the first is the process
		return
	}
	s := string(t)
	switch {
	case hasPrefix(t, "(process) Oracle pid:"):
		if v, ok := kvInt(s, "pid:"); ok {
			p.proc.Pid = &v
		}
		if v, ok := kvInt(s, "ser:"); ok {
			p.proc.Serial = &v
		}
	case hasPrefix(t, "flags :") && p.proc.Flags == "":
		// "flags : (0xe) SYSTEM  icon_uid:0 logon_pdbid=0"
		if i := strings.IndexByte(s, ')'); i >= 0 {
			f := s[i+1:]
			if j := strings.Index(f, "icon_uid"); j >= 0 {
				f = f[:j]
			}
			p.proc.Flags = strings.TrimSpace(f)
		}
	case hasPrefix(t, "O/S info:") && p.proc.OSPid == "":
		// "O/S info: user: oracle, term: UNKNOWN, ospid: 13832"
		if v, ok := kvTok(s, "user: "); ok {
			p.proc.OSUser = v
		}
		if v, ok := kvTok(s, "ospid: "); ok {
			p.proc.OSPid = v
		}
	}
}

func fnum(s string) (float64, bool) {
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

// secondsOf reads "total=7.175594" (else "snap=") of a "wait times:" line.
func secondsOf(s string) *float64 {
	for _, key := range []string{"total=", "snap="} {
		if v, ok := kvTok(s, key); ok {
			if f, ok := fnum(v); ok {
				return &f
			}
		}
	}
	return nil
}

func quoted(s string) (string, bool) {
	i := strings.IndexByte(s, '\'')
	j := strings.LastIndexByte(s, '\'')
	if i < 0 || j <= i {
		return "", false
	}
	return s[i+1 : j], true
}

// refOf reads "inst: 1, sid: 52, ser: 41898".
func refOf(n int, s string) (SessionRef, bool) {
	inst, ok1 := kvInt(s, "inst: ")
	sid, ok2 := kvInt(s, "sid: ")
	ser, ok3 := kvInt(s, "ser: ")
	if !ok2 || !ok3 {
		return SessionRef{}, false
	}
	_ = ok1
	return SessionRef{Inst: inst, Sid: sid, Serial: ser, Key: strconv.Itoa(sid) + "." + strconv.Itoa(ser), Line: n}, true
}

func (p *procParser) sessionLine(n int, t []byte) {
	ss := p.cur.sess
	if ss == nil {
		return
	}
	s := string(t)
	switch {
	case hasPrefix(t, "(session) sid: "):
		if sid, ok := kvInt(s, "sid: "); ok {
			ss.Sid = sid
		}
		if ser, ok := kvInt(s, "ser: "); ok {
			ss.Serial = ser
		}
		ss.Key = strconv.Itoa(ss.Sid) + "." + strconv.Itoa(ss.Serial)
		ss.Line = n
		return
	case hasPrefix(t, "con_id/con_uid/con_name:"):
		parts := strings.Split(strings.TrimSpace(s[len("con_id/con_uid/con_name:"):]), "/")
		if len(parts) == 3 {
			if v, err := strconv.Atoi(parts[0]); err == nil {
				ss.ContainerID = &v
			}
			ss.ContainerUID, ss.Container = parts[1], parts[2]
		}
		return
	case strings.Contains(s, "user#/name:"):
		if v, ok := kvTok(s, "user#/name: "); ok {
			if a, b, ok := strings.Cut(v, "/"); ok {
				if id, err := strconv.Atoi(a); err == nil {
					ss.UserID = &id
				}
				ss.User = b
			}
		}
		return
	case hasPrefix(t, "oct: "):
		if v, ok := kvInt(s, "oct: "); ok {
			ss.Command = &v
			ss.CommandName = commandNames[v]
			ss.CommandLine = n
		}
		if v, ok := kvTok(s, "sql: "); ok && v != "(nil)" {
			ss.Sql = v
		}
		if v, ok := kvTok(s, "psql: "); ok && v != "(nil)" {
			ss.PrevSql = v
		}
		return
	case hasPrefix(t, "service name:") && ss.Service == "":
		ss.Service = strings.TrimSpace(s[len("service name:"):])
		return
	case hasPrefix(t, "O/S info:") && ss.ClientOSPid == "":
		if v, ok := kvTok(s, "user: "); ok {
			ss.ClientOSUser = v
		}
		if v, ok := kvTok(s, "ospid: "); ok {
			ss.ClientOSPid = v
		}
		return
	case hasPrefix(t, "machine: ") && ss.Machine == "":
		rest := s[len("machine: "):]
		if i := strings.Index(rest, " program: "); i >= 0 {
			ss.Machine, ss.Program = strings.TrimSpace(rest[:i]), strings.TrimSpace(rest[i+len(" program: "):])
		} else {
			ss.Machine = strings.TrimSpace(rest)
		}
		return
	case hasPrefix(t, "application name: ") && ss.Module == "":
		ss.Module = nameBeforeHash(s[len("application name: "):])
		return
	case hasPrefix(t, "action name: ") && ss.Action == "":
		ss.Action = nameBeforeHash(s[len("action name: "):])
		return
	}
	p.waitLine(n, s, t)
}

// nameBeforeHash cuts ", hash value=123" off "mtk_diag_procstate, hash value=2206927072".
func nameBeforeHash(s string) string {
	if i := strings.LastIndex(s, ", hash value="); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

func (p *procParser) waitLine(n int, s string, t []byte) {
	ss := p.cur.sess
	switch {
	case s == "Current Wait Stack:":
		p.wm = wmCur
		p.bm = bmNone
		p.wait = newProcWait(n)
		ss.Wait = p.wait
		p.pendEv, p.pendSec = nil, nil
		return
	case s == "Wait State:":
		p.wm, p.bm, p.pendEv = wmNone, bmNone, nil
		return
	case s == "Session Wait History:":
		if p.wait == nil {
			p.wait = newProcWait(0)
			ss.Wait = p.wait
		}
		p.wm, p.bm, p.pendEv = wmHist, bmNone, nil
		p.wait.HistoryLine = n
		return
	}
	w := p.wait
	if w == nil {
		return
	}
	if p.wm == wmHist {
		p.histLine(n, s)
		return
	}
	if p.wm != wmCur {
		return
	}
	switch {
	case strings.HasPrefix(s, "Not in wait; last wait ended "):
		rest := s[len("Not in wait; last wait ended "):]
		if i := strings.Index(rest, " sec"); i >= 0 {
			if f, ok := fnum(rest[:i]); ok {
				w.LastEndedSec = &f
			}
		}
		return
	case strings.HasPrefix(s, "There is at least one session blocking this session"):
		w.Blocked = true
		return
	case strings.HasPrefix(s, "Dumping ") && strings.Contains(s, "direct blocker"):
		p.bm = bmDirect
		if v, err := strconv.Atoi(strings.Fields(s)[1]); err == nil {
			w.BlockersCount = v
		}
		return
	case strings.HasPrefix(s, "Dumping final blocker"):
		p.bm = bmFinal
		return
	case strings.HasPrefix(s, "There are ") && strings.Contains(s, "sessions blocked by this session"):
		if v, err := strconv.Atoi(strings.Fields(s)[2]); err == nil {
			w.BlockedCount = v
			w.BlockedLine = n
		}
		p.bm = bmNone
		return
	case strings.HasPrefix(s, "Dumping ") && strings.Contains(s, "waiter"):
		p.bm = bmWaiter
		if len(w.Waiters) < WaiterCap {
			w.Waiters = append(w.Waiters, ProcWaiter{Params: []string{}})
			p.waiter = &w.Waiters[len(w.Waiters)-1]
		} else {
			p.waiter = nil
		}
		return
	}
	if p.bm != bmNone {
		if strings.HasPrefix(s, "inst: ") {
			if ref, ok := refOf(n, s); ok {
				switch p.bm {
				case bmDirect:
					if len(w.Blockers) < BlockerCap {
						w.Blockers = append(w.Blockers, ref)
					}
				case bmFinal:
					if w.FinalBlocker == nil {
						r := ref
						w.FinalBlocker = &r
					}
				case bmWaiter:
					if p.waiter != nil {
						p.waiter.SessionRef = ref
					}
				}
			}
			return
		}
		if p.bm == bmWaiter && p.waiter != nil {
			switch {
			case strings.HasPrefix(s, "wait event:"):
				if e, ok := quoted(s); ok {
					p.waiter.Event = e
				}
			case len(s) > 3 && s[0] == 'p' && s[1] >= '0' && s[1] <= '9' && s[2] == ':':
				p.waiter.Params = append(p.waiter.Params, s)
			case strings.HasPrefix(s, "row_wait_obj#:"):
				rw := RowWait{Line: n}
				rw.Obj = int64(kvNum(s, "row_wait_obj#: "))
				rw.Block = int64(kvNum(s, "block#: "))
				rw.Row = int64(kvNum(s, "row#: "))
				rw.File = int64(kvNum(s, "file# "))
				p.waiter.RowWait = &rw
			case strings.HasPrefix(s, "min_blocked_time:"):
				if v, ok := kvInt(s, "min_blocked_time: "); ok {
					p.waiter.MinBlockedSec = &v
				}
			}
			return
		}
	}
	// the wait stack's entries
	if k := strings.Index(s, ": waiting for '"); k > 0 && isDigits(s[:k]) {
		lvl, _ := strconv.Atoi(s[:k])
		ev, _ := quoted(s[k:])
		w.InWait = true
		if len(w.Stack) < StackCap {
			w.Stack = append(w.Stack, WaitEntry{Level: lvl, Event: ev, Line: n})
			p.pendSec = &w.Stack[len(w.Stack)-1]
			p.pendEv = &w.Stack[len(w.Stack)-1].Params
		} else {
			p.pendSec, p.pendEv = nil, nil
		}
		return
	}
	if p.pendEv != nil {
		first := !strings.HasPrefix(s, "wait_id=") && !strings.HasPrefix(s, "wait times:") && !strings.HasPrefix(s, "wait counts:") && !strings.HasPrefix(s, "in_wait=")
		if first {
			*p.pendEv = s
		}
		p.pendEv = nil
		if first {
			return
		}
	}
	if strings.HasPrefix(s, "wait times:") && p.pendSec != nil && p.pendSec.Seconds == nil {
		p.pendSec.Seconds = secondsOf(s)
	}
}

// newProcWait makes a wait with every list allocated at its bound (the parser keeps pointers into them).
func newProcWait(line int) *ProcWait {
	return &ProcWait{Line: line, Stack: make([]WaitEntry, 0, StackCap), Blockers: make([]SessionRef, 0, BlockerCap),
		Waiters: make([]ProcWaiter, 0, WaiterCap), History: make([]WaitHistory, 0, HistoryCap)}
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func kvNum(s, key string) int {
	v, _ := kvInt(s, key)
	return v
}

// histLine reads one line of the Session Wait History.
func (p *procParser) histLine(n int, s string) {
	w := p.wait
	switch {
	case strings.HasPrefix(s, "elapsed time of "):
		rest := s[len("elapsed time of "):]
		if i := strings.IndexByte(rest, ' '); i > 0 {
			if f, ok := fnum(rest[:i]); ok {
				w.ElapsedSec = &f
			}
		}
		return
	case s == "":
		return
	}
	if k := strings.Index(s, ": waited for '"); k > 0 && isDigits(s[:k]) {
		num, _ := strconv.Atoi(s[:k])
		ev, _ := quoted(s[k:])
		w.HistoryTotal++
		p.histCur, p.pendEv = nil, nil
		p.histSec = false
		if len(w.History) < HistoryCap {
			w.History = append(w.History, WaitHistory{N: num, Event: ev, Line: n})
			p.histCur = &w.History[len(w.History)-1]
			p.pendEv = &p.histCur.Params
		}
		return
	}
	if p.pendEv != nil {
		first := !strings.HasPrefix(s, "wait_id=") && !strings.HasPrefix(s, "wait times:") && !strings.HasPrefix(s, "wait counts:") && !strings.HasPrefix(s, "occurred after")
		if first {
			*p.pendEv = s
		}
		p.pendEv = nil
		if first {
			return
		}
	}
	switch {
	case strings.HasPrefix(s, "wait times:"):
		if p.histCur != nil && !p.histSec {
			if f := secondsOf(s); f != nil {
				p.histCur.Seconds = f
				p.histSec = true
			}
		}
	case strings.HasPrefix(s, "wait_id="), strings.HasPrefix(s, "wait counts:"), strings.HasPrefix(s, "occurred after"):
	default:
		p.wm = wmNone // the history ended
	}
}

// enqLine reads an "Enqueue Dump" line: "2026-11-17 21:34:27.097*:ksq.c@10827:ksqdmc(): Enqueue Dump      (enqueue)
// TX-00050016-00005A54-ED94F66A-00000000  DID: ksqlkdid: 0001-0006-00000053". It reports whether the line was one.
func (p *procParser) enqLine(n int, l []byte) bool {
	i := bytes.Index(l, []byte("Enqueue Dump"))
	if i < 0 {
		return false
	}
	j := bytes.Index(l[i:], []byte("(enqueue) "))
	if j < 0 {
		return false
	}
	rest := bytes.TrimSpace(l[i+j+len("(enqueue) "):])
	f := bytes.Fields(rest)
	p.enq, p.enqLeft = nil, 0
	if len(f) == 0 || string(f[0]) == "released" || f[0][0] == '<' {
		p.ps.EnqueuesOther++
		return true
	}
	res := string(f[0])
	typ := res
	if k := strings.IndexByte(res, '-'); k > 0 {
		typ = res[:k]
	}
	p.ps.EnqueuesTotal++
	if len(p.enqDone) >= EnqueueCap {
		return true
	}
	p.enqDone = append(p.enqDone, ProcEnqueue{Resource: res, Type: typ, In: p.cur.typ, Line: n})
	p.enqSO = append(p.enqSO, p.cur)                   // its session is resolved at the end
	p.enq, p.enqLeft = &p.enqDone[len(p.enqDone)-1], 8 // the mode line follows
	return true
}

func (p *procParser) enqFollow(n int, t []byte) {
	p.enqLeft--
	if p.enqLeft < 0 {
		p.enq = nil
		return
	}
	var mode string
	switch {
	case hasPrefix(t, "mode: "):
		mode = string(t[len("mode: "):])
	case hasPrefix(t, "req: "):
		mode = string(t[len("req: "):])
		p.enq.Requested = true
	default:
		return
	}
	if i := strings.IndexByte(mode, ','); i >= 0 {
		mode = mode[:i]
	}
	p.enq.Mode = strings.TrimSpace(mode)
	if v, ok := kvTok(string(t), "lock_flag: "); ok {
		p.enq.Flag = v
	}
	p.enq = nil
}

func (p *procParser) txLine(n int, t []byte) {
	tx := p.cur.tx
	if tx == nil {
		return
	}
	s := string(t)
	switch {
	case hasPrefix(t, "env ["):
		if v, ok := kvTok(s, "xid: "); ok && tx.Xid == "" {
			tx.Xid = v
		}
	case hasPrefix(t, "Undo blks:"):
		if v, ok := kvInt(s, "blks: "); ok {
			tx.UndoBlocks = &v
		}
		if v, ok := kvInt(s, "recs: "); ok {
			tx.UndoRecords = &v
		}
	case hasPrefix(t, "Begin scn:"):
		if i := strings.Index(s, "ts:"); i >= 0 {
			if a := strings.IndexByte(s[i:], '['); a >= 0 {
				if b := strings.IndexByte(s[i+a:], ']'); b > 0 {
					tx.Begin = s[i+a+1 : i+a+b]
				}
			}
		}
	}
}

func (p *procParser) dmlLine(n int, t []byte) {
	d := p.cur.dml
	if d == nil {
		return
	}
	s := string(t)
	switch {
	case hasPrefix(t, "DML LOCK:"):
		if v, ok := kvTok(s, "tab="); ok {
			d.Table, _ = strconv.ParseInt(v, 10, 64)
		}
		if v, ok := kvTok(s, "flg="); ok {
			d.Flags = v
		}
	case hasPrefix(t, "his[") && d.Mode == nil:
		if v, ok := kvInt(s, "mod="); ok {
			d.Mode = &v
			d.ModeName = lockModeNames[v]
		}
	}
}

func (p *procParser) blockLine(n int, t []byte) {
	f := bytes.Fields(t)
	if len(f) < 6 || len(f[2]) < 3 || f[2][0] != '0' || f[2][1] != 'x' {
		return
	}
	itli, err := strconv.Atoi(string(f[1]))
	if err != nil {
		return
	}
	if _, err := strconv.Atoi(string(f[0])); err != nil {
		return
	}
	obj, _ := strconv.ParseInt(string(f[4]), 10, 64)
	p.blockRows = append(p.blockRows, blockRow{owner: p.cur.owner, row: BlockRow{Itli: itli, RDBA: string(f[2]), SQLID: string(f[3]), Obj: obj, Line: n}})
}

type blockRow struct {
	owner string
	row   BlockRow
}

func (p *procParser) libLine(n int, t []byte) {
	lo := p.cur.lib
	if lo == nil {
		return
	}
	s := string(t)
	switch {
	case hasPrefix(t, "LibraryObjectLock:") || hasPrefix(t, "LibraryObjectPin:"):
		if v, ok := kvTok(s, "Handle="); ok {
			lo.Handle = v
		}
		if v, ok := kvTok(s, "Mode="); ok {
			lo.Mode = v
		}
	case hasPrefix(t, "User=") && p.cur.pin:
		if v, ok := kvInt(s, "Count="); ok {
			lo.Count = &v
		}
	case hasPrefix(t, "LibraryHandle:") && !p.cur.handleSeen:
		p.cur.handleSeen = true
	case !p.cur.handleSeen:
	case hasPrefix(t, "ObjectName:") && !p.cur.nameDone:
		if i := strings.Index(s, "Name="); i >= 0 {
			lo.Name = trunc(strings.TrimSpace(s[i+5:]), StatementCut)
		}
		p.cur.nameDone = true
	case hasPrefix(t, "FullHashValue=") && lo.Namespace == "":
		lo.Namespace, lo.Type, lo.SQLID = nsOf(s)
	case hasPrefix(t, "Name:") && lo.Namespace == "" && p.cur.handleSeen:
		lo.Namespace, lo.Type, _ = nsOf(s)
	case hasPrefix(t, "Parent Cursor:") && lo.SQLID == "":
		if v, ok := kvTok(s, "sql_id="); ok {
			lo.SQLID = v
		}
	}
}

// nsOf reads "Namespace=SQL AREA(00) SqlId=f3j90cdzgg7d2 Type=CURSOR(00)" of a handle line: the namespace and
// type without their numbers, and the sql_id.
func nsOf(s string) (ns, typ, sqlid string) {
	field := func(key string, ends ...string) string {
		i := strings.Index(s, key)
		if i < 0 {
			return ""
		}
		rest := s[i+len(key):]
		cut := len(rest)
		for _, e := range ends {
			if j := strings.Index(rest, e); j >= 0 && j < cut {
				cut = j
			}
		}
		v := strings.TrimSpace(rest[:cut])
		if k := strings.LastIndexByte(v, '('); k > 0 && strings.HasSuffix(v, ")") {
			v = strings.TrimSpace(v[:k])
		}
		return v
	}
	ns = field("Namespace=", " SqlId=", " Type=", " ContainerId=")
	typ = field("Type=", " ContainerId=", " ContainerUid=", " Identifier=")
	sqlid = field("SqlId=", " Type=", " ContainerId=")
	return
}

// finish resolves the owners, counts and matches the session's statement.
func (p *procParser) finish(name string, pid int) {
	ps := p.ps
	if ps.Process != nil {
		if name != "" {
			ps.Process.Name = name
		}
		for _, s := range ps.Sessions {
			if s.Program != "" {
				ps.Process.Program = s.Program
				break
			}
		}
	} else if name != "" || pid > 0 {
		// a process node whose lines hold no process object (the header only)
		if p.seenSO {
			ps.Process = &ProcInfo{Name: name}
		}
	}
	// the depth of the tree and the session each object belongs to
	depth := map[*soRec]int{}
	var depthOf func(so *soRec, hops int) int
	depthOf = func(so *soRec, hops int) int {
		if d, ok := depth[so]; ok {
			return d
		}
		d := 1
		if o := p.byAddr[so.owner]; o != nil && o != so && hops < 64 {
			d = depthOf(o, hops+1) + 1
		}
		depth[so] = d
		return d
	}
	for _, so := range p.all {
		ps.Objects.Total++
		if d := depthOf(so, 0); d > ps.Objects.Depth {
			ps.Objects.Depth = d
		}
		so.session = p.sessionOf(so)
	}
	keys := append([]string{}, p.order...)
	sort.SliceStable(keys, func(i, j int) bool {
		a, b := p.types[keys[i]], p.types[keys[j]]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Type < b.Type
	})
	for i, k := range keys {
		if i >= TypeCap {
			ps.Objects.TypesOther += p.types[k].Count
			continue
		}
		ps.Objects.ByType = append(ps.Objects.ByType, *p.types[k])
	}
	// per-object sessions
	for i := range ps.Locks {
		if so := p.byAddr[ps.Locks[i].Address]; so != nil {
			ps.Locks[i].Session = so.session
		}
	}
	for i := range ps.Pins {
		if so := p.byAddr[ps.Pins[i].Address]; so != nil {
			ps.Pins[i].Session = so.session
		}
	}
	for i := range ps.Transactions {
		if so := p.byAddr[ps.Transactions[i].Address]; so != nil {
			ps.Transactions[i].Session = so.session
		}
	}
	for i := range ps.DMLLocks {
		if so := p.byAddr[ps.DMLLocks[i].Address]; so != nil {
			ps.DMLLocks[i].Session = so.session
		}
	}
	// the Block List rows go to the transaction that owns the list
	for _, br := range p.blockRows {
		for i := range ps.Transactions {
			if ps.Transactions[i].Address == br.owner {
				tx := &ps.Transactions[i]
				tx.BlocksTotal++
				if len(tx.Blocks) < BlockRowCap {
					tx.Blocks = append(tx.Blocks, br.row)
				}
			}
		}
	}
	ps.Enqueues = append(ps.Enqueues, p.enqDone...)
	for i := range ps.Enqueues {
		if i < len(p.enqSO) {
			ps.Enqueues[i].Session = p.enqSO[i].session
		}
	}
	// the session's statement: the library handle its "sql:" address names
	handles := map[string]*ProcLibObject{}
	for i := range ps.Locks {
		handles[ps.Locks[i].Handle] = &ps.Locks[i]
	}
	for i := range ps.Pins {
		if _, ok := handles[ps.Pins[i].Handle]; !ok {
			handles[ps.Pins[i].Handle] = &ps.Pins[i]
		}
	}
	for i := range ps.Sessions {
		s := &ps.Sessions[i]
		if s.Sql != "" {
			if h := handles[s.Sql]; h != nil {
				s.SqlID, s.SqlText, s.SqlLine = h.SQLID, h.Name, h.Line
			}
		}
		if s.PrevSql != "" {
			if h := handles[s.PrevSql]; h != nil {
				s.PrevSqlID, s.PrevSqlText, s.PrevSqlLine = h.SQLID, h.Name, h.Line
			}
		}
	}
	if ps.ShortStack != "" {
		fns := []string{}
		var rest []string
		for _, e := range strings.Split(ps.ShortStack, "<-") {
			fn, _ := splitFrameText(e)
			fns = append(fns, fn)
		}
		ps.ShortStackOwn = ownShortStack(fns)
		if ps.ShortStackOwn > 0 {
			ents := strings.Split(ps.ShortStack, "<-")
			rest = ents[min(ps.ShortStackOwn, len(ents)):]
			ps.ShortStackNoOwn = strings.Join(rest, "<-")
		} else {
			ps.ShortStackNoOwn = ps.ShortStack
		}
	}
	// notes
	only := 0
	for _, so := range p.all {
		if so.typ == "process" || so.typ == "session" {
			only++
		}
	}
	if ps.Objects.Total == 0 {
		ps.Notes = append(ps.Notes, "no state object lines in this part")
	} else if only == ps.Objects.Total {
		ps.Notes = append(ps.Notes, "this dump prints the process and its sessions only (a system state of level 1): no child state objects, so no holds")
	}
	for _, s := range ps.Sessions {
		if s.Sql != "" && s.SqlID == "" {
			ps.Notes = append(ps.Notes, "session "+s.Key+": the statement is the library handle "+s.Sql+", which this dump does not describe (no lock on it among the state objects), so its sql_id is not known")
		}
	}
	if ps.SessionsTotal == 0 && ps.Objects.Total > 0 {
		ps.Notes = append(ps.Notes, "this process prints no session state object")
	}
	if ps.SessionsTotal > len(ps.Sessions) {
		ps.Notes = append(ps.Notes, "only the first "+strconv.Itoa(ProcSessionCap)+" sessions are listed")
	}
}

// sessionOf gives the "sid.serial" of the session an object belongs to, following the owner links.
func (p *procParser) sessionOf(so *soRec) string {
	cur := so
	for hops := 0; cur != nil && hops < 16; hops++ {
		if cur.typ == "session" {
			for i := range p.ps.Sessions {
				if p.ps.Sessions[i].Address == cur.addr {
					return p.ps.Sessions[i].Key
				}
			}
			return ""
		}
		next := p.byAddr[cur.owner]
		if next == cur {
			return ""
		}
		cur = next
	}
	return ""
}
