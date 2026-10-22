package model

import (
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Options tune the builder.
type Options struct {
	MaxUnknown int // how many unknown lines to keep verbatim (default 200)
}

// Builder implements trace.Handler and produces a Model.
type Builder struct {
	m    *Model
	opts Options

	open         map[uint64]ID // cursor number -> open cursor instance
	pendingWaits map[uint64][]ID
	pendingBinds map[uint64]ID
	pendingDepth [][]ID // calls awaiting a parent, by depth
	stmtByKey    map[string]ID
	eventByName  map[string]ID
	synthCursor  map[string]ID // synthetic cursors (XCTEND, LOB ops, RPC)
	curPlan      ID
	curPlanCur   uint64
	lastStatLine int
	lastXctend   ID // XCTEND that cursor-#0 waits (log file sync) belong to until the next call

	ctx      Context
	ctxDirty bool
	ctxID    ID

	// wall-clock anchoring
	anchorWall  time.Time
	anchorValid bool
	needAnchor  bool
	offsetUs    int64 // wall µs - tim
	offsetSet   bool
	firstWallUs int64
}

// NewBuilder returns an empty builder. Call Build when the parse is done.
func NewBuilder(path string, opts Options) *Builder {
	if opts.MaxUnknown == 0 {
		opts.MaxUnknown = 200
	}
	b := &Builder{
		m:            &Model{File: FileInfo{Path: path}},
		opts:         opts,
		open:         make(map[uint64]ID),
		pendingWaits: make(map[uint64][]ID),
		pendingBinds: make(map[uint64]ID),
		stmtByKey:    make(map[string]ID),
		eventByName:  make(map[string]ID),
		synthCursor:  make(map[string]ID),
		curPlan:      None,
		lastXctend:   None,
		ctxID:        None,
	}
	b.m.Diag.LineKinds = make(map[string]int)
	return b
}

// Build parses the file at path into a Model.
func Build(path string, opts Options) (*Model, error) {
	b := NewBuilder(path, opts)
	st, err := trace.ParseFile(path, b)
	if err != nil {
		return nil, err
	}
	return b.Finish(st), nil
}

// Finish completes the model after the parser has delivered every record.
func (b *Builder) Finish(st trace.Stats) *Model {
	m := b.m
	// orphans: dep>0 calls that never found a parent
	for d := 1; d < len(b.pendingDepth); d++ {
		for _, id := range b.pendingDepth[d] {
			m.Calls[id].Orphan = true
			m.Diag.OrphanCalls++
		}
	}
	for _, ids := range b.pendingWaits {
		m.Diag.UnattributedWaits += len(ids)
	}
	m.Diag.Lines = st.Lines
	m.Diag.Bytes = st.Bytes
	m.Diag.UnknownLines = st.Unknown
	for k := trace.Kind(0); int(k) < len(st.Kinds); k++ {
		if st.Kinds[k] > 0 {
			m.Diag.LineKinds[k.String()] = st.Kinds[k]
		}
	}
	if b.offsetSet {
		m.Span.LastWallUs = m.Span.LastTim + b.offsetUs
	}
	return m
}

// ---- context & time -------------------------------------------------------

func (b *Builder) context() ID {
	if b.ctxDirty || b.ctxID == None {
		c := b.ctx
		c.ID = ID(len(b.m.Contexts))
		b.m.Contexts = append(b.m.Contexts, c)
		b.ctxID = c.ID
		b.ctxDirty = false
	}
	return b.ctxID
}

// observeTim updates the span and the wall-clock anchor from a tim value.
func (b *Builder) observeTim(tim int64, line int) int64 {
	if tim == 0 {
		return 0
	}
	m := b.m
	if m.Span.FirstTim == 0 || tim < m.Span.FirstTim {
		m.Span.FirstTim = tim
		m.Span.FirstLine = line
	}
	if tim > m.Span.LastTim {
		m.Span.LastTim = tim
		m.Span.LastLine = line
	}
	if b.needAnchor && b.anchorValid {
		b.offsetUs = b.anchorWall.UnixMicro() - tim
		b.needAnchor = false
		m.Diag.Anchors++
		if !b.offsetSet {
			b.offsetSet = true
			m.Span.FirstWallUs = m.Span.FirstTim + b.offsetUs
		}
	}
	if b.offsetSet {
		return tim + b.offsetUs
	}
	return 0
}

// ---- trace.Handler --------------------------------------------------------

func (b *Builder) HeaderLine(h trace.Header) {
	f := &b.m.File
	f.Headers = append(f.Headers, KV{h.Key, h.Value})
	switch h.Key {
	case "Trace file":
		f.TraceFile = h.Value
	case "Oracle Version":
		f.Version = h.Value
	case "Instance name":
		f.Instance = h.Value
	case "Node name":
		f.Node = h.Value
	case "Machine":
		f.Machine = h.Value
	case "System name":
		f.SystemName = h.Value
	case "Unix process pid", "Windows thread id":
		f.ProcessPID = h.Value
	}
}

func (b *Builder) Marker(mk trace.Marker) {
	if mk.HasTime {
		b.anchorWall = mk.Time
		b.anchorValid = true
		b.needAnchor = true
	}
	switch mk.Kind {
	case trace.MarkerTimestamp:
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Container, Time: mk.Time, HasTime: true})
		return
	case trace.MarkerSessionID:
		b.setCtx(&b.ctx.SessionID, mk.Value, mk.Line)
	case trace.MarkerClientID:
		b.setCtx(&b.ctx.ClientID, mk.Value, mk.Line)
	case trace.MarkerServiceName:
		b.setCtx(&b.ctx.Service, mk.Value, mk.Line)
	case trace.MarkerModuleName:
		b.setCtx(&b.ctx.Module, mk.Value, mk.Line)
	case trace.MarkerActionName:
		b.setCtx(&b.ctx.Action, mk.Value, mk.Line)
	case trace.MarkerClientDriver:
		b.setCtx(&b.ctx.ClientDriver, mk.Value, mk.Line)
	case trace.MarkerContainerID:
		b.setCtx(&b.ctx.ContainerID, mk.Value, mk.Line)
	case trace.MarkerProcess:
		b.setCtx(&b.ctx.Process, mk.Value, mk.Line)
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Value})
	case trace.MarkerTraceContinuedFrom:
		b.m.File.ContinuedFrom = append(b.m.File.ContinuedFrom, mk.Value)
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Value})
	case trace.MarkerTraceContinuesIn:
		b.m.File.ContinuesIn = append(b.m.File.ContinuesIn, mk.Value)
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Value})
	case trace.MarkerDumpSizeLimit:
		b.m.File.DumpSizeLimit, _ = strconv.ParseInt(mk.Value, 10, 64)
		b.m.File.Truncated = true
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Text})
	default:
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Text, Time: mk.Time, HasTime: mk.HasTime})
	}
}

func (b *Builder) setCtx(field *string, v string, line int) {
	if *field != v || b.ctxID == None {
		*field = v
		b.ctx.Line = line
		b.ctxDirty = true
	}
}

func (b *Builder) Separator(int) {}

func (b *Builder) Unknown(line int, text []byte) {
	if len(b.m.Unknown) < b.opts.MaxUnknown {
		b.m.Unknown = append(b.m.Unknown, UnknownLine{Line: line, Text: string(text)})
	}
}

// ---- statements & cursors -------------------------------------------------

func (b *Builder) statement(key string, mk func() Statement) ID {
	if id, ok := b.stmtByKey[key]; ok {
		return id
	}
	s := mk()
	s.ID = ID(len(b.m.Statements))
	b.m.Statements = append(b.m.Statements, s)
	b.stmtByKey[key] = s.ID
	return s.ID
}

func textHash(text string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(text))
	return h.Sum64()
}

func (b *Builder) Cursor(c trace.CursorHeader) {
	key := c.SQLID
	if key == "" {
		key = "hv:" + strconv.FormatUint(c.HV, 10) + ":" + strconv.FormatUint(textHash(c.Text), 16)
	}
	sid := b.statement(key, func() Statement {
		return Statement{Kind: StmtSQL, SQLID: c.SQLID, HV: c.HV, Text: c.Text, Len: c.Len,
			OCT: c.OCT, UID: c.UID, LID: c.LID, MinDep: c.Dep, FirstLine: c.Line}
	})
	st := &b.m.Statements[sid]
	if c.Dep < st.MinDep {
		st.MinDep = c.Dep
	}
	wall := b.observeTim(c.Tim, c.Line)
	_ = wall
	if prev, ok := b.open[c.Cursor]; ok {
		pc := &b.m.Cursors[prev]
		if pc.Implicit && (!pc.Closed || pc.Dep == c.Dep) {
			// The number was in use before tracing started. Like tkprof, assign
			// its earlier calls to the first statement parsed under the same
			// number: certain when no CLOSE happened in between (re-parse in
			// place), assumed otherwise (clients reuse cursor handles in order).
			b.adoptImplicit(prev, sid, c, pc.Closed)
			return
		}
		pc.Closed = true
	}
	cur := Cursor{ID: ID(len(b.m.Cursors)), Number: c.Cursor, Statement: sid, Line: c.Line, Dep: c.Dep,
		Tim: c.Tim, Addr: c.Addr, Context: b.context()}
	b.m.Cursors = append(b.m.Cursors, cur)
	st.Cursors = append(st.Cursors, cur.ID)
	b.open[c.Cursor] = cur.ID
}

// adoptImplicit re-points an implicit cursor (and everything recorded against
// it) to the statement that was just parsed under the same cursor number.
func (b *Builder) adoptImplicit(curID, sid ID, c trace.CursorHeader, assumed bool) {
	m := b.m
	cur := &m.Cursors[curID]
	old := cur.Statement
	cur.Statement = sid
	cur.Implicit = false
	cur.Assumed = assumed
	cur.Addr = c.Addr
	cur.Dep = c.Dep
	cur.Closed = false
	if cur.Tim == 0 {
		cur.Tim = c.Tim
	}
	st := &m.Statements[sid]
	st.Cursors = append(st.Cursors, curID)
	if c.Dep < st.MinDep {
		st.MinDep = c.Dep
	}
	os := &m.Statements[old]
	for i, id := range os.Cursors {
		if id == curID {
			os.Cursors = append(os.Cursors[:i], os.Cursors[i+1:]...)
			break
		}
	}
	for i := range m.Calls {
		if m.Calls[i].Cursor == curID {
			m.Calls[i].Statement = sid
		}
	}
	for i := range m.Waits {
		if m.Waits[i].Cursor == curID {
			m.Waits[i].Statement = sid
		}
	}
	for i := range m.BindSets {
		if m.BindSets[i].Cursor == curID {
			m.BindSets[i].Statement = sid
		}
	}
	for i := range m.Plans {
		if m.Plans[i].Cursor == curID {
			m.Plans[i].Statement = sid
		}
	}
	for i := range m.Errors {
		if m.Errors[i].Cursor == curID {
			m.Errors[i].Statement = sid
		}
	}
	m.Diag.ImplicitCursors--
	how := "re-parsed in place"
	if assumed {
		how = "parsed again after a close"
		m.Diag.AssumedCursors++
	}
	m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("line %d: cursor #%d was open before tracing started and %s; its earlier calls are attributed to %s", c.Line, c.Cursor, how, c.SQLID))
}

// cursorFor resolves the open instance for a cursor number, creating an
// implicit one (unknown statement) when the trace never parsed it.
func (b *Builder) cursorFor(num uint64, dep int, line int) ID {
	if id, ok := b.open[num]; ok {
		return id
	}
	key := "unknown:#" + strconv.FormatUint(num, 10)
	sid := b.statement(key, func() Statement {
		return Statement{Kind: StmtUnknown, Text: fmt.Sprintf("(unknown statement: cursor #%d was opened before tracing started)", num), MinDep: dep, FirstLine: line}
	})
	cur := Cursor{ID: ID(len(b.m.Cursors)), Number: num, Statement: sid, Line: line, Dep: dep, Context: b.context(), Implicit: true}
	b.m.Cursors = append(b.m.Cursors, cur)
	b.m.Statements[sid].Cursors = append(b.m.Statements[sid].Cursors, cur.ID)
	b.open[num] = cur.ID
	b.m.Diag.ImplicitCursors++
	return cur.ID
}

// syntheticCursor returns a cursor instance for pseudo statements.
func (b *Builder) syntheticCursor(key string, kind StatementKind, text string, line int) ID {
	if id, ok := b.synthCursor[key]; ok {
		return id
	}
	sid := b.statement("synthetic:"+key, func() Statement {
		return Statement{Kind: kind, Text: text, FirstLine: line}
	})
	cur := Cursor{ID: ID(len(b.m.Cursors)), Statement: sid, Line: line, Context: b.context()}
	b.m.Cursors = append(b.m.Cursors, cur)
	b.m.Statements[sid].Cursors = append(b.m.Statements[sid].Cursors, cur.ID)
	b.synthCursor[key] = cur.ID
	return cur.ID
}

// ---- calls ----------------------------------------------------------------

func (b *Builder) Call(c trace.Call) {
	var curID ID
	switch {
	case c.Kind.IsLob():
		curID = b.syntheticCursor("lob:"+c.Op, StmtLob, c.Op+" (LOB operation)", c.Line)
	case c.Kind == trace.CallRPCExec:
		curID = b.syntheticCursor("rpc", StmtRPC, "RPC EXEC (remote procedure call)", c.Line)
	default:
		curID = b.cursorFor(c.Cursor, c.Dep, c.Line)
	}
	cur := &b.m.Cursors[curID]
	if c.PLH != 0 && cur.PLH == 0 {
		cur.PLH = c.PLH
	}
	call := Call{
		ID: ID(len(b.m.Calls)), Line: c.Line, Kind: c.Kind, Cursor: curID, Statement: cur.Statement,
		C: c.C, E: c.E, P: c.P, CR: c.CR, CU: c.CU, Mis: c.Mis, R: c.R, Dep: c.Dep, OG: c.OG, PLH: c.PLH,
		Tim: c.Tim, Type: c.Type, Parent: None, SelfE: c.E, SelfC: c.C, SelfP: c.P, SelfCR: c.CR, SelfCU: c.CU, Context: b.context(), BindSet: None,
		LobType: c.LobType, Bytes: c.Bytes, Op: c.Op,
	}
	call.WallUs = b.observeTim(c.Tim, c.Line)
	switch c.Kind {
	case trace.CallExec:
		cur.Execs++
		call.ExecNo = cur.Execs
		if bs, ok := b.pendingBinds[c.Cursor]; ok {
			delete(b.pendingBinds, c.Cursor)
			b.m.BindSets[bs].Call = call.ID
			call.BindSet = bs
		}
	case trace.CallFetch:
		call.ExecNo = cur.Execs
	case trace.CallClose:
		cur.Closed = true
	}
	b.m.Calls = append(b.m.Calls, call)
	id := call.ID
	b.lastXctend = None
	b.attachWaits(c.Cursor, id, curID)
	b.attachChildren(id, c.Dep)
}

// attachWaits links the waits pending for a cursor number to call id.
func (b *Builder) attachWaits(num uint64, id ID, curID ID) {
	ids := b.pendingWaits[num]
	if len(ids) == 0 {
		return
	}
	for _, wid := range ids {
		w := &b.m.Waits[wid]
		if w.Cursor != curID && w.Cursor != None {
			// the cursor number was re-parsed in between: the wait belongs to
			// the previous instance; keep it there but do not pretend it was
			// inside this call
			w.Between = true
			continue
		}
		b.attachWait(w, id)
	}
	b.pendingWaits[num] = ids[:0]
}

// attachWait links one wait to a call and classifies it as inside the call
// or between calls (think time).
func (b *Builder) attachWait(w *Wait, id ID) {
	call := &b.m.Calls[id]
	w.Call = id
	w.Dep = call.Dep
	if w.Cursor == None {
		// logged before the cursor was parsed (e.g. latch waits during a hard parse)
		w.Cursor = call.Cursor
		w.Statement = call.Statement
	}
	inside := true
	if call.Synthetic {
		inside = !w.Idle
	} else if call.Tim != 0 && w.Tim != 0 {
		start := call.Tim - call.E
		inside = w.Tim > start && w.Tim <= call.Tim
	}
	if !inside || w.Idle {
		w.Between = true
		call.IdleEla += w.Ela
	} else {
		call.WaitEla += w.Ela
		if call.Synthetic {
			call.E += w.Ela
			call.SelfE = call.E
		}
	}
	call.NWaits++
}

// attachChildren makes every pending deeper call a child of call id.
func (b *Builder) attachChildren(id ID, dep int) {
	for len(b.pendingDepth) <= dep {
		b.pendingDepth = append(b.pendingDepth, nil)
	}
	call := &b.m.Calls[id]
	for d := dep + 1; d < len(b.pendingDepth); d++ {
		for _, cid := range b.pendingDepth[d] {
			child := &b.m.Calls[cid]
			child.Parent = id
			call.SelfE -= child.E
			call.SelfC -= child.C
			call.SelfP -= child.P
			call.SelfCR -= child.CR
			call.SelfCU -= child.CU
		}
		b.pendingDepth[d] = b.pendingDepth[d][:0]
	}
	for _, v := range []*int64{&call.SelfE, &call.SelfC, &call.SelfP, &call.SelfCR, &call.SelfCU} {
		if *v < 0 {
			*v = 0
		}
	}
	if dep > 0 {
		b.pendingDepth[dep] = append(b.pendingDepth[dep], id)
	} else {
		// depth-0 calls never get a parent; nothing to keep
	}
}

// ---- waits ----------------------------------------------------------------

func (b *Builder) event(name string) ID {
	if id, ok := b.eventByName[name]; ok {
		return id
	}
	info := ref.Event(name)
	e := Event{ID: ID(len(b.m.Events)), Name: name, Class: info.Class, P1Name: info.P1, P2Name: info.P2, P3Name: info.P3, Idle: info.Idle}
	b.m.Events = append(b.m.Events, e)
	b.eventByName[name] = e.ID
	return e.ID
}

func (b *Builder) Wait(w trace.Wait) {
	eid := b.event(w.Name)
	ev := &b.m.Events[eid]
	if ev.P1Name == "" && w.NParams > 0 {
		ev.P1Name, ev.P2Name, ev.P3Name = w.Params[0].Name, w.Params[1].Name, w.Params[2].Name
	}
	curID, stmt := None, None
	if id, ok := b.open[w.Cursor]; ok {
		curID = id
		stmt = b.m.Cursors[id].Statement
	}
	wait := Wait{
		ID: ID(len(b.m.Waits)), Line: w.Line, Cursor: curID, Statement: stmt, Call: None, Event: eid,
		Ela: w.Ela, P1: w.Params[0].Value, P2: w.Params[1].Value, P3: w.Params[2].Value,
		ObjID: w.ObjID, Tim: w.Tim, Context: b.context(), Idle: ev.Idle, Number: w.Cursor,
	}
	if !w.HasObj {
		wait.ObjID = -1
	}
	wait.WallUs = b.observeTim(w.Tim, w.Line)
	b.m.Waits = append(b.m.Waits, wait)
	if w.Cursor == 0 && b.lastXctend != None {
		b.attachWait(&b.m.Waits[wait.ID], b.lastXctend)
		return
	}
	b.pendingWaits[w.Cursor] = append(b.pendingWaits[w.Cursor], wait.ID)
}

// ---- STAT (plans) ---------------------------------------------------------

func (b *Builder) Stat(s trace.Stat) {
	curID := b.cursorFor(s.Cursor, 0, s.Line)
	cur := &b.m.Cursors[curID]
	if b.curPlan == None || b.curPlanCur != s.Cursor || s.ID == 1 || s.Line != b.lastStatLine+1 {
		p := Plan{ID: ID(len(b.m.Plans)), Line: s.Line, Cursor: curID, Statement: cur.Statement, PLH: cur.PLH, First: int32(len(b.m.PlanLines))}
		b.m.Plans = append(b.m.Plans, p)
		b.curPlan = p.ID
		b.curPlanCur = s.Cursor
	}
	b.lastStatLine = s.Line
	p := &b.m.Plans[b.curPlan]
	op, obj := s.Op, ""
	if s.Obj != 0 {
		if i := strings.LastIndexByte(op, ' '); i > 0 {
			obj = op[i+1:]
			op = strings.TrimRight(op[:i], " ")
		}
	}
	pl := PlanLine{Plan: p.ID, ID: s.ID, ParentID: s.ParentID, Pos: s.Pos, Obj: s.Obj, Op: op, Object: obj,
		Cnt: s.Cnt, Str: s.Str, CR: s.CR, PR: s.PR, PW: s.PW, TimeUs: s.TimeUs, Cost: s.Cost, Size: s.Size, Card: s.Card, HasStats: s.HasStats}
	// depth = parent's depth + 1 (parents always precede children in STAT output)
	for i := int(p.First); i < len(b.m.PlanLines); i++ {
		if b.m.PlanLines[i].ID == s.ParentID {
			pl.Depth = b.m.PlanLines[i].Depth + 1
			break
		}
	}
	b.m.PlanLines = append(b.m.PlanLines, pl)
	p.N++
}

// ---- binds ----------------------------------------------------------------

func (b *Builder) Binds(bs trace.BindSet) {
	var curID, stmt ID = None, None
	if bs.IsRPC {
		curID = b.syntheticCursor("rpc", StmtRPC, "RPC EXEC (remote procedure call)", bs.Line)
	} else {
		curID = b.cursorFor(bs.Cursor, 0, bs.Line)
	}
	stmt = b.m.Cursors[curID].Statement
	set := BindSet{ID: ID(len(b.m.BindSets)), Line: bs.Line, Cursor: curID, Statement: stmt, Call: None, First: int32(len(b.m.Binds)), IsRPC: bs.IsRPC}
	for _, tb := range bs.Binds {
		bind := Bind{Set: set.ID, Pos: tb.Pos, Dty: tb.Dty, TypeName: ref.BindTypeName(tb.Dty), NoDef: tb.NoOacdef, IsDump: tb.IsDump,
			Mal: tb.Mal, Mxl: tb.Mxl, Avl: tb.Avl, Scl: tb.Scl, Pre: tb.Pre, Csi: tb.Csi}
		if tb.NoOacdef {
			bind.TypeName = ""
		}
		if tb.HasValue {
			bind.Value = decodeValue(tb)
		} else if !tb.NoOacdef {
			bind.IsNull = true
		}
		b.m.Binds = append(b.m.Binds, bind)
		set.N++
	}
	b.m.BindSets = append(b.m.BindSets, set)
	if !bs.IsRPC {
		b.pendingBinds[bs.Cursor] = set.ID
	}
}

// decodeValue strips the quoting Oracle puts around character values.
func decodeValue(tb trace.Bind) string {
	v := tb.Value
	if tb.IsDump {
		return v
	}
	if n := len(v); n >= 2 && v[0] == '"' && v[n-1] == '"' {
		return v[1 : n-1]
	}
	return v
}

// ---- transactions & errors -----------------------------------------------

func (b *Builder) Xctend(x trace.Xctend) {
	kind, key, text := StmtCommit, "commit", "COMMIT (XCTEND rlbk=0)"
	if x.Rlbk != 0 {
		kind, key, text = StmtRollback, "rollback", "ROLLBACK (XCTEND rlbk=1)"
	}
	curID := b.syntheticCursor(key, kind, text, x.Line)
	cur := b.m.Cursors[curID]
	call := Call{ID: ID(len(b.m.Calls)), Line: x.Line, Kind: trace.CallXctend, Cursor: curID, Statement: cur.Statement,
		Dep: 1, Tim: x.Tim, Parent: None, Context: b.context(), BindSet: None, Synthetic: true}
	call.WallUs = b.observeTim(x.Tim, x.Line)
	b.m.Calls = append(b.m.Calls, call)
	b.attachWaits(0, call.ID, curID) // waits logged on #0 before the XCTEND
	b.lastXctend = call.ID           // ... and the ones after it (log file sync)
	b.attachChildren(call.ID, 1)
	c := &b.m.Calls[call.ID]
	t := Transaction{ID: ID(len(b.m.Transactions)), Line: x.Line, Rlbk: x.Rlbk, RdOnly: x.RdOnly, Tim: x.Tim, WallUs: c.WallUs, Call: call.ID, Context: c.Context}
	b.m.Transactions = append(b.m.Transactions, t)
}

func (b *Builder) Error(e trace.Error) {
	curID, stmt := None, None
	if id, ok := b.open[e.Cursor]; ok {
		curID, stmt = id, b.m.Cursors[id].Statement
	}
	ev := ErrorEvent{ID: ID(len(b.m.Errors)), Line: e.Line, Cursor: curID, Statement: stmt, Err: e.Err, Tim: e.Tim, Context: b.context()}
	ev.WallUs = b.observeTim(e.Tim, e.Line)
	b.m.Errors = append(b.m.Errors, ev)
}

func (b *Builder) ParseError(p trace.ParseError) {
	key := "parse-error:" + strconv.FormatUint(textHash(p.Text), 16)
	sid := b.statement(key, func() Statement {
		return Statement{Kind: StmtParseError, Text: p.Text, Len: p.Len, OCT: p.OCT, UID: p.UID, LID: p.LID, MinDep: p.Dep, FirstLine: p.Line}
	})
	cur := Cursor{ID: ID(len(b.m.Cursors)), Number: p.Cursor, Statement: sid, Line: p.Line, Dep: p.Dep, Tim: p.Tim, Context: b.context()}
	b.m.Cursors = append(b.m.Cursors, cur)
	b.m.Statements[sid].Cursors = append(b.m.Statements[sid].Cursors, cur.ID)
	// a failed parse still consumed the cursor number; later calls (if any) belong to it
	b.open[p.Cursor] = cur.ID
	ev := ErrorEvent{ID: ID(len(b.m.Errors)), Line: p.Line, Cursor: cur.ID, Statement: sid, Err: p.Err, Tim: p.Tim, ParseError: true, Text: p.Text, Context: b.context()}
	ev.WallUs = b.observeTim(p.Tim, p.Line)
	b.m.Errors = append(b.m.Errors, ev)
	// waits logged against the number before the failed parse belong to it
	b.attachWaitsToCursor(p.Cursor, cur.ID)
}

func (b *Builder) attachWaitsToCursor(num uint64, curID ID) {
	ids := b.pendingWaits[num]
	for _, wid := range ids {
		w := &b.m.Waits[wid]
		if w.Cursor == None {
			w.Cursor = curID
			w.Statement = b.m.Cursors[curID].Statement
		}
	}
}

func (b *Builder) RPCCall(r trace.RPCCall) {
	b.m.Markers = append(b.m.Markers, Marker{Line: r.Line, Kind: trace.MarkerOther, Text: "RPC CALL: " + r.Text})
}
