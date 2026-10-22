// Package trace is a streaming parser for Oracle SQL trace files (event 10046,
// DBMS_MONITOR / sql_trace). It turns the raw text into typed records and hands
// them to a Handler; it does not interpret them (see package model for that).
//
// The parser targets the Oracle 19c+ format but is lenient: unknown lines are
// reported through Handler.Unknown and never abort the parse.
package trace

import "time"

// Kind classifies a physical line for diagnostics and statistics.
type Kind uint8

const (
	KindUnknown Kind = iota
	KindBlank
	KindHeader
	KindSeparator
	KindMarker
	KindParsingInCursor
	KindSQLText
	KindEndOfStmt
	KindCall
	KindWait
	KindStat
	KindBinds
	KindBindLine
	KindXctend
	KindError
	KindParseError
	KindLob
	KindRPC
	kindCount
)

var kindNames = [...]string{
	KindUnknown:         "unknown",
	KindBlank:           "blank",
	KindHeader:          "header",
	KindSeparator:       "separator",
	KindMarker:          "marker",
	KindParsingInCursor: "parsing-in-cursor",
	KindSQLText:         "sql-text",
	KindEndOfStmt:       "end-of-stmt",
	KindCall:            "call",
	KindWait:            "wait",
	KindStat:            "stat",
	KindBinds:           "binds",
	KindBindLine:        "bind-line",
	KindXctend:          "xctend",
	KindError:           "error",
	KindParseError:      "parse-error",
	KindLob:             "lob",
	KindRPC:             "rpc",
}

func (k Kind) String() string {
	if int(k) < len(kindNames) {
		return kindNames[k]
	}
	return "kind?"
}

// CallKind identifies the database call a Call record describes.
type CallKind uint8

const (
	CallUnknown CallKind = iota
	CallParse
	CallExec
	CallFetch
	CallClose
	CallLobRead
	CallLobWrite
	CallLobGetLen
	CallLobPgSize
	CallLobAppend
	CallLobTmpFre
	CallLobArrTmpFre
	CallLobArrRead
	CallLobArrWrite
	CallLobTrim
	CallLobOther // any other LOB* op; see Call.Op
	CallRPCExec
	CallUnmap // legacy UNMAP / SORT UNMAP
	CallXctend
	callKindCount
)

var callKindNames = [...]string{
	CallUnknown:      "UNKNOWN",
	CallParse:        "PARSE",
	CallExec:         "EXEC",
	CallFetch:        "FETCH",
	CallClose:        "CLOSE",
	CallLobRead:      "LOBREAD",
	CallLobWrite:     "LOBWRITE",
	CallLobGetLen:    "LOBGETLEN",
	CallLobPgSize:    "LOBPGSIZE",
	CallLobAppend:    "LOBAPPEND",
	CallLobTmpFre:    "LOBTMPFRE",
	CallLobArrTmpFre: "LOBARRTMPFRE",
	CallLobArrRead:   "LOBARRREAD",
	CallLobArrWrite:  "LOBARRWRITE",
	CallLobTrim:      "LOBTRIM",
	CallLobOther:     "LOB",
	CallRPCExec:      "RPC EXEC",
	CallUnmap:        "UNMAP",
	CallXctend:       "XCTEND",
}

func (k CallKind) String() string {
	if int(k) < len(callKindNames) {
		return callKindNames[k]
	}
	return "CALL?"
}

// IsLob reports whether the call is a LOB operation (pseudo cursor #0).
func (k CallKind) IsLob() bool { return k >= CallLobRead && k <= CallLobOther }

// IsCursorCall reports whether the call is one of the classic cursor calls.
func (k CallKind) IsCursorCall() bool { return k >= CallParse && k <= CallClose }

// Header is a "key: value" line from the file prologue (before the first marker).
type Header struct {
	Line  int
	Key   string
	Value string
}

// MarkerKind classifies "*** ..." lines.
type MarkerKind uint8

const (
	MarkerOther MarkerKind = iota
	MarkerTimestamp
	MarkerSessionID
	MarkerClientID
	MarkerServiceName
	MarkerModuleName
	MarkerActionName
	MarkerClientDriver
	MarkerContainerID
	MarkerTraceContinuedFrom // "*** TRACE CONTINUED FROM FILE x ***"
	MarkerTraceContinuesIn   // "*** TRACE DUMP CONTINUES IN FILE x ***"
	MarkerDumpSizeLimit      // "*** DUMP FILE SIZE IS LIMITED TO n BYTES ***"
	MarkerFileRecreated      // "*** TRACE FILE RECREATED AFTER BEING REMOVED ***"
	MarkerProcess            // "*** [ Unix process pid: 133531 ]" (trcsess session switch)
)

var markerKindNames = [...]string{
	MarkerOther:              "other",
	MarkerTimestamp:          "timestamp",
	MarkerSessionID:          "SESSION ID",
	MarkerClientID:           "CLIENT ID",
	MarkerServiceName:        "SERVICE NAME",
	MarkerModuleName:         "MODULE NAME",
	MarkerActionName:         "ACTION NAME",
	MarkerClientDriver:       "CLIENT DRIVER",
	MarkerContainerID:        "CONTAINER ID",
	MarkerTraceContinuedFrom: "TRACE CONTINUED FROM FILE",
	MarkerTraceContinuesIn:   "TRACE DUMP CONTINUES IN FILE",
	MarkerDumpSizeLimit:      "DUMP FILE SIZE IS LIMITED",
	MarkerFileRecreated:      "TRACE FILE RECREATED",
	MarkerProcess:            "PROCESS",
}

func (k MarkerKind) String() string {
	if int(k) < len(markerKindNames) {
		return markerKindNames[k]
	}
	return "marker?"
}

// Marker is a "*** ..." line: a wall-clock timestamp, a session attribute
// change (session id, client id, service, module, action, client driver,
// container) or a file-level notice.
type Marker struct {
	Line      int
	Kind      MarkerKind
	Key       string    // e.g. "SESSION ID"; empty for pure timestamps
	Value     string    // text inside the parentheses, or the file name / byte limit for notices
	Time      time.Time // wall clock, if the line carries one
	HasTime   bool
	Container string // trailing "(PDB1(3))" on 12.2+ timestamp lines, without parentheses
	Text      string // raw text after "*** " for MarkerOther
}

// CursorHeader is a "PARSING IN CURSOR #n ... END OF STMT" block.
type CursorHeader struct {
	Line     int // line of the PARSING IN CURSOR header
	TextLine int // first line of the SQL text
	Cursor   uint64
	Len      int    // declared statement length (bytes)
	Dep      int    // recursive depth
	UID      int    // parsing schema id
	OCT      int    // Oracle command type (v$sqlcommand)
	LID      int    // privilege (login) user id
	Tim      int64  // microseconds
	HV       uint64 // hash value
	Addr     string // library cache address
	SQLID    string
	Text     string // the statement text, lines joined with "\n" (no trailing newline)
}

// Call is one PARSE / EXEC / FETCH / CLOSE / LOB* / RPC EXEC line.
type Call struct {
	Line   int
	Kind   CallKind
	Op     string // raw operation name for LOB calls (e.g. "LOBREAD")
	Cursor uint64 // 0 for LOB and RPC calls
	C      int64  // CPU microseconds
	E      int64  // elapsed microseconds
	P      int64  // physical reads (blocks)
	CR     int64  // consistent gets
	CU     int64  // current gets
	Mis    int64  // library cache misses
	R      int64  // rows
	Dep    int    // recursive depth
	OG     int    // optimizer goal
	PLH    uint64 // plan hash value (0 if absent)
	Tim    int64  // completion timestamp, microseconds
	Type   int    // CLOSE: type= (0 hard close, 1 cached, 2/3 cached variants)
	// LOB-specific (12c+ prints type and bytes)
	LobType string
	Bytes   int64
}

// Param is one named wait parameter (p1..p3 with their v$event_name names).
type Param struct {
	Name  string
	Value int64
	Raw   string // only set when the value was not numeric
}

// Wait is one WAIT line.
type Wait struct {
	Line    int
	Cursor  uint64
	Name    string // event name (interned)
	Ela     int64  // microseconds
	Params  [3]Param
	NParams int
	ObjID   int64
	HasObj  bool
	Tim     int64
}

// Stat is one STAT line (row source execution statistics).
type Stat struct {
	Line     int
	Cursor   uint64
	ID       int
	ParentID int
	Pos      int
	Obj      int64
	Cnt      int64  // rows produced
	Op       string // operation text without the trailing "(cr=... )" statistics
	HasStats bool
	CR       int64
	PR       int64
	PW       int64
	Str      int64 // starts
	TimeUs   int64
	Cost     int64
	Size     int64
	Card     int64
}

// Bind is one "Bind#n" entry of a BINDS block.
type Bind struct {
	Line      int
	Pos       int    // Bind#n
	Dty       int    // oacdty: Oracle internal datatype code
	Mxl       int    // max length
	MxlP      int    // the value in parentheses after mxl (private/actual max length)
	Mxlc      int    // mxlc
	Mal       int    // max array length (>0 for array binds)
	Scl       int    // scale
	Pre       int    // precision
	Oacflg    string // raw flags (hex)
	Fl2       string // raw flags (hex)
	Frm       int    // character set form
	Csi       int    // character set id
	Siz       int
	Off       int
	Bfp       string // kxsbbbfp (buffer address)
	Bln       int    // buffer length
	Avl       int    // actual value length (0 => NULL)
	Flg       int
	Value     string // as printed after "value=" (quotes kept); joined with "\n" when multi-line
	HasValue  bool   // a "value=" line was present
	IsDump    bool   // value was a memory / toid hex dump
	Truncated bool   // value was cut by Oracle (printed as "..."...)
	NoOacdef  bool   // "No oacdef for this bind." (definition reused from previous bind)
}

// BindSet is a full BINDS block for one cursor.
type BindSet struct {
	Line   int
	Cursor uint64
	IsRPC  bool // "RPC BINDS:" block
	Binds  []Bind
}

// Xctend is a transaction end marker.
type Xctend struct {
	Line   int
	Rlbk   int // 1 = rollback, 0 = commit
	RdOnly int // 1 = read-only transaction
	Tim    int64
}

// Error is an "ERROR #n:err=... tim=..." line.
type Error struct {
	Line   int
	Cursor uint64
	Err    int
	Tim    int64
}

// ParseError is a "PARSE ERROR #n:len=... err=..." line plus the statement text.
type ParseError struct {
	Line   int
	Cursor uint64
	Len    int
	Dep    int
	UID    int
	OCT    int
	LID    int
	Tim    int64
	Err    int
	Text   string
}

// RPCCall is an "RPC CALL:" line (remote procedure call from a client).
type RPCCall struct {
	Line int
	Text string
}

// Handler receives parsed records in file order.
type Handler interface {
	HeaderLine(h Header)
	Marker(m Marker)
	Cursor(c CursorHeader)
	Call(c Call)
	Wait(w Wait)
	Stat(s Stat)
	Binds(b BindSet)
	Xctend(x Xctend)
	Error(e Error)
	ParseError(p ParseError)
	RPCCall(r RPCCall)
	Separator(line int)
	Unknown(line int, text []byte)
}

// NopHandler implements Handler with no-ops; embed it to implement a subset.
type NopHandler struct{}

func (NopHandler) HeaderLine(Header)     {}
func (NopHandler) Marker(Marker)         {}
func (NopHandler) Cursor(CursorHeader)   {}
func (NopHandler) Call(Call)             {}
func (NopHandler) Wait(Wait)             {}
func (NopHandler) Stat(Stat)             {}
func (NopHandler) Binds(BindSet)         {}
func (NopHandler) Xctend(Xctend)         {}
func (NopHandler) Error(Error)           {}
func (NopHandler) ParseError(ParseError) {}
func (NopHandler) RPCCall(RPCCall)       {}
func (NopHandler) Separator(int)         {}
func (NopHandler) Unknown(int, []byte)   {}
