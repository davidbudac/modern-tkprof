// Package model turns the record stream of package trace into a dimensional
// model: fact tables (calls, waits, binds, plan lines, transactions, errors)
// that reference dimension tables (statements, cursor instances, session
// contexts, wait events) by index.
package model

import (
	"sort"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/ref"
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
	// Files lists every file of the trace set in parse order (one entry for a
	// single-file trace). The fields above describe the first file.
	Files []FileEntry `json:"files"`
}

// FileEntry describes one input file of the trace set.
type FileEntry struct {
	Idx           int      `json:"idx"`
	Path          string   `json:"path"`
	Name          string   `json:"name"`
	Size          int64    `json:"size"`
	Lines         int      `json:"lines"`
	FirstTim      int64    `json:"firstTim"`
	LastTim       int64    `json:"lastTim"`
	FirstWallUs   int64    `json:"firstWallUs"`
	LastWallUs    int64    `json:"lastWallUs"`
	ProcessPID    string   `json:"processPid"`
	Instance      string   `json:"instance"`
	TraceFile     string   `json:"traceFile"`
	PX            bool     `json:"px"`       // trace of a parallel execution slave (P000...)
	Chain         int      `json:"chain"`    // files of one TRACE CONTINUES IN chain share the number
	Followed      bool     `json:"followed"` // pulled in by following a chain, not named by the user
	ContinuedFrom []string `json:"continuedFrom,omitempty"`
	ContinuesIn   []string `json:"continuesIn,omitempty"`

	offsetUs  int64 // wall µs - tim of the first anchor in this file
	offsetSet bool
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

// Call is one database call line, or a synthetic XCTEND call. A trace of 1 GB
// holds several million of them, so the struct is laid out for size: 64-bit
// measures first, then 32-bit ids and line numbers, then one-byte codes and
// flags (168 bytes). Line numbers are per file and int32 (2 billion lines, far
// beyond any trace file); wall-clock time is not stored, see Model.CallWall.
type Call struct {
	Tim     int64 `json:"tim"`
	C       int64 `json:"cpu"`
	E       int64 `json:"ela"`
	P       int64 `json:"disk"`
	CR      int64 `json:"query"`
	CU      int64 `json:"current"`
	R       int64 `json:"rows"`
	SelfE   int64 `json:"selfEla"` // ela minus attached recursive children
	SelfC   int64 `json:"selfCpu"`
	SelfP   int64 `json:"selfDisk"`
	SelfCR  int64 `json:"selfQuery"`
	SelfCU  int64 `json:"selfCurrent"`
	WaitEla int64 `json:"waitEla"` // sum of attributed in-call waits
	IdleEla int64 `json:"idleEla"` // sum of attributed between-call (idle/think) waits

	ID        ID     `json:"id"`
	Cursor    ID     `json:"cursor"`
	Statement ID     `json:"statement"`
	Parent    ID     `json:"parent"`
	Context   ID     `json:"context"`
	BindSet   ID     `json:"bindSet"`
	Line      int32  `json:"line"`
	ExecNo    int32  `json:"execNo"`
	NWaits    int32  `json:"waits"` // attributed waits (both kinds)
	Mis       int32  `json:"misses"`
	PLH       uint32 `json:"planHash"` // plh= is a ub4

	Kind      trace.CallKind `json:"kind"`
	Dep       uint8          `json:"depth"`
	OG        uint8          `json:"optGoal"`
	Type      uint8          `json:"closeType"`
	Orphan    bool           `json:"orphan"`    // dep>0 call that found no parent
	Synthetic bool           `json:"synthetic"` // XCTEND pseudo call
}

// Wait is one WAIT line (88 bytes; wall-clock time: see Model.WaitWall).
type Wait struct {
	Tim    int64  `json:"tim"`
	Ela    int64  `json:"ela"`
	P1     int64  `json:"p1"`
	P2     int64  `json:"p2"`
	P3     int64  `json:"p3"`
	ObjID  int64  `json:"obj"`
	Number uint64 `json:"number"` // raw cursor number (#n) on the line

	ID        ID    `json:"id"`
	Cursor    ID    `json:"cursor"`
	Statement ID    `json:"statement"`
	Call      ID    `json:"call"`
	Event     ID    `json:"event"`
	Context   ID    `json:"context"`
	Line      int32 `json:"line"`

	Dep     uint8 `json:"depth"`
	Between bool  `json:"between"` // ended before the attributed call started (think time)
	Idle    bool  `json:"idle"`    // event belongs to the Idle wait class
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
	Process      string `json:"process"` // server process pid (trcsess "*** [ Unix process pid: n ]"; the file header's pid when several files are built)
	FileIdx      int    `json:"fileIdx"` // index into File.Files of the file the context was announced in
	PX           bool   `json:"px"`      // belongs to a parallel execution slave trace
	Parent       ID     `json:"parent"`  // PX slave: the query coordinator's context, else None
}

// PXChild reports whether context id is a PX slave attached to its query
// coordinator: its calls and waits are accounted separately (analyze.PX*)
// and kept out of the coordinator's statement totals.
func (m *Model) PXChild(id ID) bool {
	return id >= 0 && int(id) < len(m.Contexts) && m.Contexts[id].PX && m.Contexts[id].Parent != None
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

// Bind is one bind value (56 bytes; the type name is derived, see TypeName).
type Bind struct {
	Value  string `json:"value"`
	Set    ID     `json:"set"`
	Pos    int32  `json:"pos"`
	Dty    int32  `json:"dty"`
	Mal    int32  `json:"maxArrayLen"`
	Mxl    int32  `json:"maxLen"`
	Avl    int32  `json:"actualLen"`
	Scl    int32  `json:"scale"`
	Pre    int32  `json:"precision"`
	Csi    int32  `json:"charsetId"`
	IsNull bool   `json:"null"`
	NoDef  bool   `json:"noDef"` // "No oacdef for this bind." (repeated bind name)
	IsDump bool   `json:"dump"`
}

// TypeName is the datatype name of the bind ("" for a NoDef bind, which has no
// definition of its own). It is derived from Dty so the Bind does not carry a
// string header per value.
func (b *Bind) TypeName() string {
	if b.NoDef {
		return ""
	}
	return ref.BindTypeName(int(b.Dty))
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
	// XPlanMatched: a ref-bundle DBMS_XPLAN of the same plan hash was overlaid on the lines (ApplyRef).
	XPlanMatched bool `json:"xPlanMatched,omitempty"`
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
	// Overlaid by ApplyRef from a ref-bundle DBMS_XPLAN of the same plan hash.
	Access string `json:"access,omitempty"`
	Filter string `json:"filter,omitempty"`
	Alias  string `json:"alias,omitempty"`
	QBlock string `json:"qblock,omitempty"`
	ERows  int64  `json:"eRows,omitempty"` // DBMS_XPLAN estimate, set only where STAT has no card; 0 = none
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

	// wall-clock anchors in parse order: from (file, line) on, wall = tim + off
	anchors []wallAnchor
}

type wallAnchor struct {
	file, line int32
	off        int64
}

// wallAt converts a tim seen at (file, line) to wall-clock microseconds with the
// offset in force there: the offset of the last `*** timestamp` anchor applied
// at or before that line (0 when there is none yet or tim is 0). Calls and
// waits do not store it: they are in file order, so (context file, line) finds
// the anchor.
func (m *Model) wallAt(file int32, line int32, tim int64) int64 {
	if tim == 0 {
		return 0
	}
	a := m.anchors
	i := sort.Search(len(a), func(i int) bool {
		return a[i].file > file || (a[i].file == file && a[i].line > line)
	})
	if i == 0 {
		return 0
	}
	return tim + a[i-1].off
}

// CallWall is the wall clock of a call's completion (microseconds since the
// Unix epoch, 0 if unknown).
func (m *Model) CallWall(c *Call) int64 {
	if len(m.anchors) == 0 || c.Tim == 0 {
		return 0
	}
	return m.wallAt(m.fileOf(c.Context), c.Line, c.Tim)
}

func (m *Model) fileOf(ctx ID) int32 {
	if ctx < 0 || int(ctx) >= len(m.Contexts) {
		return 0
	}
	return int32(m.Contexts[ctx].FileIdx)
}

// WaitWall is the wall clock of the end of a wait (0 if unknown).
func (m *Model) WaitWall(w *Wait) int64 {
	if len(m.anchors) == 0 || w.Tim == 0 {
		return 0
	}
	return m.wallAt(m.fileOf(w.Context), w.Line, w.Tim)
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
