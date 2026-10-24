// Package model turns the record stream of package trace into a dimensional
// model: fact tables (calls, waits, binds, plan lines, transactions, errors)
// that reference dimension tables (statements, cursor instances, session
// contexts, wait events) by index.
package model

import (
	"time"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// ID indexes a slice of the Model. None (-1) means "no such row".
type ID int32

const None ID = -1

// KV is an ordered header key/value.
type KV struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// FileInfo holds what the trace prologue and notices say about the file.
type FileInfo struct {
	Path          string   `json:"path"`
	Headers       []KV     `json:"headers"`
	TraceFile     string   `json:"traceFile"`
	Version       string   `json:"version"`
	Instance      string   `json:"instance"`
	Node          string   `json:"node"`
	Machine       string   `json:"machine"`
	SystemName    string   `json:"systemName"`
	ProcessPID    string   `json:"processPid"`
	ContinuedFrom []string `json:"continuedFrom,omitempty"`
	ContinuesIn   []string `json:"continuesIn,omitempty"`
	DumpSizeLimit int64    `json:"dumpSizeLimit,omitempty"`
	Truncated     bool     `json:"truncated"`
}

// StatementKind distinguishes real SQL from synthetic statements.
type StatementKind uint8

const (
	StmtSQL        StatementKind = iota // from PARSING IN CURSOR
	StmtUnknown                         // calls for a cursor never parsed in this file
	StmtCommit                          // XCTEND rlbk=0
	StmtRollback                        // XCTEND rlbk=1
	StmtLob                             // LOB* calls
	StmtRPC                             // RPC EXEC
	StmtParseError                      // PARSE ERROR text
)

var stmtKindNames = [...]string{"sql", "unknown", "commit", "rollback", "lob", "rpc", "parse-error"}

func (k StatementKind) String() string {
	if int(k) < len(stmtKindNames) {
		return stmtKindNames[k]
	}
	return "stmt?"
}

// Statement is the SQL dimension: one row per distinct sql_id (or synthetic op).
type Statement struct {
	ID        ID            `json:"id"`
	Kind      StatementKind `json:"kind"`
	SQLID     string        `json:"sqlId"`
	HV        uint64        `json:"hashValue"`
	Text      string        `json:"text"`
	Len       int           `json:"len"`
	OCT       int           `json:"commandType"`
	Command   string        `json:"commandName"`
	UID       int           `json:"parsingUserId"`
	LID       int           `json:"privilegeUserId"`
	MinDep    int           `json:"minDepth"`
	FirstLine int           `json:"firstLine"`
	Cursors   []ID          `json:"cursors"`
	RefPlan   string        `json:"refPlan,omitempty"` // DBMS_XPLAN text from a reference bundle (see ApplyRef)
}

// Cursor is one cursor instance: a PARSING IN CURSOR block, or an implicit
// instance created for a cursor number that was never parsed in the file.
type Cursor struct {
	ID        ID     `json:"id"`
	Number    uint64 `json:"number"`
	Statement ID     `json:"statement"`
	Line      int    `json:"line"`
	Dep       int    `json:"depth"`
	Tim       int64  `json:"tim"`
	Addr      string `json:"address,omitempty"`
	PLH       uint64 `json:"planHash"`
	Context   ID     `json:"context"`
	Implicit  bool   `json:"implicit"` // never parsed in this file (unknown statement)
	Assumed   bool   `json:"assumed"`  // calls before the first PARSING IN CURSOR of this number were attributed to it
	Execs     int32  `json:"execs"`
	Closed    bool   `json:"closed"`
}

// Call is one database call line, or a synthetic XCTEND call.
type Call struct {
	ID        ID             `json:"id"`
	Line      int            `json:"line"`
	Kind      trace.CallKind `json:"kind"`
	Cursor    ID             `json:"cursor"`
	Statement ID             `json:"statement"`
	C         int64          `json:"cpu"`
	E         int64          `json:"ela"`
	P         int64          `json:"disk"`
	CR        int64          `json:"query"`
	CU        int64          `json:"current"`
	Mis       int64          `json:"misses"`
	R         int64          `json:"rows"`
	Dep       int            `json:"depth"`
	OG        int            `json:"optGoal"`
	PLH       uint64         `json:"planHash"`
	Tim       int64          `json:"tim"`
	WallUs    int64          `json:"wallUs"` // microseconds since Unix epoch, 0 if unknown
	Type      int            `json:"closeType"`
	Parent    ID             `json:"parent"`
	SelfE     int64          `json:"selfEla"` // ela minus attached recursive children
	SelfC     int64          `json:"selfCpu"`
	SelfP     int64          `json:"selfDisk"`
	SelfCR    int64          `json:"selfQuery"`
	SelfCU    int64          `json:"selfCurrent"`
	Context   ID             `json:"context"`
	ExecNo    int32          `json:"execNo"`
	BindSet   ID             `json:"bindSet"`
	WaitEla   int64          `json:"waitEla"`   // sum of attributed in-call waits
	IdleEla   int64          `json:"idleEla"`   // sum of attributed between-call (idle/think) waits
	NWaits    int32          `json:"waits"`     // attributed waits (both kinds)
	Orphan    bool           `json:"orphan"`    // dep>0 call that found no parent
	Synthetic bool           `json:"synthetic"` // XCTEND pseudo call
	LobType   string         `json:"lobType,omitempty"`
	Bytes     int64          `json:"bytes,omitempty"`
	Op        string         `json:"op,omitempty"`
}

// Wait is one WAIT line.
type Wait struct {
	ID        ID     `json:"id"`
	Line      int    `json:"line"`
	Cursor    ID     `json:"cursor"`
	Statement ID     `json:"statement"`
	Call      ID     `json:"call"`
	Event     ID     `json:"event"`
	Ela       int64  `json:"ela"`
	P1        int64  `json:"p1"`
	P2        int64  `json:"p2"`
	P3        int64  `json:"p3"`
	ObjID     int64  `json:"obj"`
	Tim       int64  `json:"tim"`
	WallUs    int64  `json:"wallUs"`
	Context   ID     `json:"context"`
	Dep       int    `json:"depth"`
	Between   bool   `json:"between"` // ended before the attributed call started (think time)
	Idle      bool   `json:"idle"`    // event belongs to the Idle wait class
	Number    uint64 `json:"number"`  // raw cursor number (#n) on the line
}

// Event is the wait-event dimension.
type Event struct {
	ID     ID     `json:"id"`
	Name   string `json:"name"`
	Class  string `json:"class"`
	P1Name string `json:"p1Name"`
	P2Name string `json:"p2Name"`
	P3Name string `json:"p3Name"`
	Idle   bool   `json:"idle"`
}

// Context is a snapshot of the session attributes announced by "*** " markers.
type Context struct {
	ID           ID     `json:"id"`
	Line         int    `json:"line"`
	SessionID    string `json:"sessionId"`
	ClientID     string `json:"clientId"`
	Service      string `json:"service"`
	Module       string `json:"module"`
	Action       string `json:"action"`
	ClientDriver string `json:"clientDriver"`
	ContainerID  string `json:"containerId"`
	Process      string `json:"process"` // server process pid (trcsess "*** [ Unix process pid: n ]")
}

// BindSet is one BINDS block, attached to the EXEC that followed it.
type BindSet struct {
	ID        ID    `json:"id"`
	Line      int   `json:"line"`
	Cursor    ID    `json:"cursor"`
	Statement ID    `json:"statement"`
	Call      ID    `json:"call"`
	First     int32 `json:"first"` // index into Model.Binds
	N         int32 `json:"n"`
	IsRPC     bool  `json:"rpc"`
}

// Bind is one bind value.
type Bind struct {
	Set      ID     `json:"set"`
	Pos      int    `json:"pos"`
	Dty      int    `json:"dty"`
	TypeName string `json:"type"`
	Value    string `json:"value"`
	IsNull   bool   `json:"null"`
	NoDef    bool   `json:"noDef"` // "No oacdef for this bind." (repeated bind name)
	IsDump   bool   `json:"dump"`
	Mal      int    `json:"maxArrayLen"`
	Mxl      int    `json:"maxLen"`
	Avl      int    `json:"actualLen"`
	Scl      int    `json:"scale"`
	Pre      int    `json:"precision"`
	Csi      int    `json:"charsetId"`
}

// Plan is one STAT block (row source statistics dumped at cursor close).
type Plan struct {
	ID        ID     `json:"id"`
	Line      int    `json:"line"`
	Cursor    ID     `json:"cursor"`
	Statement ID     `json:"statement"`
	PLH       uint64 `json:"planHash"`
	First     int32  `json:"first"` // index into Model.PlanLines
	N         int32  `json:"n"`
}

// PlanLine is one STAT line.
type PlanLine struct {
	Plan     ID     `json:"plan"`
	ID       int    `json:"id"`
	ParentID int    `json:"parentId"`
	Pos      int    `json:"pos"`
	Depth    int    `json:"depth"`
	Obj      int64  `json:"obj"`
	Op       string `json:"op"`
	Object   string `json:"object"`
	Cnt      int64  `json:"rows"`
	Str      int64  `json:"starts"`
	CR       int64  `json:"cr"`
	PR       int64  `json:"pr"`
	PW       int64  `json:"pw"`
	TimeUs   int64  `json:"timeUs"`
	Cost     int64  `json:"cost"`
	Size     int64  `json:"size"`
	Card     int64  `json:"card"`
	HasStats bool   `json:"hasStats"`
}

// Transaction is one XCTEND.
type Transaction struct {
	ID      ID    `json:"id"`
	Line    int   `json:"line"`
	Rlbk    int   `json:"rollback"`
	RdOnly  int   `json:"readOnly"`
	Tim     int64 `json:"tim"`
	WallUs  int64 `json:"wallUs"`
	Call    ID    `json:"call"`
	Context ID    `json:"context"`
}

// ErrorEvent is an ERROR or PARSE ERROR line.
type ErrorEvent struct {
	ID         ID     `json:"id"`
	Line       int    `json:"line"`
	Cursor     ID     `json:"cursor"`
	Statement  ID     `json:"statement"`
	Err        int    `json:"err"`
	Tim        int64  `json:"tim"`
	WallUs     int64  `json:"wallUs"`
	ParseError bool   `json:"parseError"`
	Text       string `json:"text,omitempty"`
	Context    ID     `json:"context"`
}

// Marker is a timeline notice (timestamps and file notices; context changes
// live in Contexts).
type Marker struct {
	Line    int              `json:"line"`
	Kind    trace.MarkerKind `json:"kind"`
	Text    string           `json:"text"`
	Time    time.Time        `json:"time"`
	HasTime bool             `json:"hasTime"`
}

// UnknownLine is a line the parser did not recognise (capped sample).
type UnknownLine struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

// Span is the time extent of the trace.
type Span struct {
	FirstTim    int64 `json:"firstTim"`
	LastTim     int64 `json:"lastTim"`
	FirstWallUs int64 `json:"firstWallUs"`
	LastWallUs  int64 `json:"lastWallUs"`
	FirstLine   int   `json:"firstLine"`
	LastLine    int   `json:"lastLine"`
}

// Microseconds of trace span (0 if unknown).
func (s Span) Us() int64 {
	if s.LastTim <= s.FirstTim {
		return 0
	}
	return s.LastTim - s.FirstTim
}

// Diagnostics collects parser/builder observations.
type Diagnostics struct {
	Lines             int            `json:"lines"`
	Bytes             int64          `json:"bytes"`
	UnknownLines      int            `json:"unknownLines"`
	ImplicitCursors   int            `json:"implicitCursors"`
	AssumedCursors    int            `json:"assumedCursors"`
	OrphanCalls       int            `json:"orphanCalls"`
	UnattributedWaits int            `json:"unattributedWaits"`
	Anchors           int            `json:"timeAnchors"`
	LineKinds         map[string]int `json:"lineKinds"`
	Notes             []string       `json:"notes,omitempty"`
	BindMode          string         `json:"bindMode"` // kept|redacted|none (see RedactBinds)
}

// Model is the complete in-memory representation of one trace file.
type Model struct {
	File         FileInfo      `json:"file"`
	Span         Span          `json:"span"`
	Statements   []Statement   `json:"statements"`
	Cursors      []Cursor      `json:"cursors"`
	Calls        []Call        `json:"calls"`
	Waits        []Wait        `json:"waits"`
	Events       []Event       `json:"events"`
	Contexts     []Context     `json:"contexts"`
	BindSets     []BindSet     `json:"bindSets"`
	Binds        []Bind        `json:"binds"`
	Plans        []Plan        `json:"plans"`
	PlanLines    []PlanLine    `json:"planLines"`
	Transactions []Transaction `json:"transactions"`
	Errors       []ErrorEvent  `json:"errors"`
	Markers      []Marker      `json:"markers"`
	Unknown      []UnknownLine `json:"unknown"`
	Diag         Diagnostics   `json:"diag"`

	// Reference-bundle dimensions, filled by ApplyRef (empty without -ref).
	Objects []RefObject `json:"objects,omitempty"`
	Files   []RefFile   `json:"files,omitempty"`
	Users   []RefUser   `json:"users,omitempty"`

	objIdx, fileIdx, userIdx map[int64]int
}

// WallOf converts a tim value to wall-clock microseconds using the span anchor.
func (m *Model) WallOf(tim int64) int64 {
	if m.Span.FirstWallUs == 0 || tim == 0 {
		return 0
	}
	return m.Span.FirstWallUs + (tim - m.Span.FirstTim)
}

// Children returns the direct recursive children of a call (one pass over Calls).
func (m *Model) Children(id ID) []ID {
	var out []ID
	for i := range m.Calls {
		if m.Calls[i].Parent == id {
			out = append(out, ID(i))
		}
	}
	return out
}
