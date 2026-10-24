package model

import (
	"fmt"
	"hash/fnv"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Options tune the builder.
type Options struct {
	MaxUnknown int  // how many unknown lines to keep verbatim (default 200)
	NoFollow   bool // BuildFiles: do not follow TRACE CONTINUES IN / CONTINUED FROM chains

	// NoFacts is the low-memory build: bind values are not retained
	// (Model.Binds and BindSets stay empty, Call.BindSet is None, Diag.BindMode
	// is "none"). Calls and waits are still kept in full: every aggregation
	// (statement stats, profiles, executions, findings, pivot) reads them, so
	// the numbers of the text report are identical with and without it. What it
	// drops is everything that needs bind values: BINDS sections, the binds
	// column of the executions tables, the bind evidence of findings,
	// binds.csv and the UI's bind views.
	NoFacts bool

	// Aggregate is the aggregation-only build for traces too big to hold their
	// facts: Model.Calls, Waits, Binds and BindSets stay empty (it implies
	// NoFacts); statements, cursors, contexts, events, plans, transactions
	// and errors are kept. Every call and wait is handed to the Sink the
	// moment the builder has settled it (waits attached, recursive children
	// subtracted), so the memory is that of the dimensions plus the sink's
	// aggregates, not of the trace. Call.ID / Transaction.Call are not
	// resolvable then (Transaction.Call is None).
	Aggregate bool
	// NewSink creates the Sink of an Aggregate build once the model exists
	// (nil: the facts are counted and dropped).
	NewSink func(m *Model) Sink
	// NewTee creates a second Sink of an Aggregate build that receives every
	// fact the first one does (internal/slice's disk spill). When it also
	// implements BindSink and SpillBinds is set, it receives the bind values.
	// The model's Agg stays the first sink.
	NewTee func(m *Model) Sink
	// SpillBinds keeps the bind handling of a full build in an Aggregate build:
	// BINDS blocks are decoded and handed to the NewTee sink (a BindSink),
	// EXEC calls carry their set id in Call.BindSet. Model.Binds and BindSets
	// stay empty. Without it an Aggregate build implies NoFacts.
	SpillBinds bool
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

	// Aggregate build (Options.Aggregate); see Sink.
	agg      bool
	sink     Sink
	nCalls   int64
	nWaits   int64
	cur      Call         // the call being completed
	openX    *Call        // the XCTEND that cursor-#0 waits can still join; completed by closeX
	xbuf     Call         // storage of openX
	pendA    [][]ChildRec // pendingDepth of an aggregate build, by depth
	pendSum  [][5]int64   // E, C, P, CR, CU of the pending calls at each depth
	waitBuf  []Wait       // waits not yet attached (pendingWaits indexes it)
	pendWait int          // how many waitBuf entries are still in pendingWaits
	bindSink BindSink     // aggregate build with SpillBinds
	nSets    int64        // bind sets handed to bindSink
	bindBuf  []Bind       // reused by Binds in a spilling build
	ext      []ctxExtent  // tim extent per context, for attachPX

	ctx      Context
	ctxDirty bool
	ctxID    ID

	curFile     int  // index into m.File.Files of the file being parsed
	multi       bool // more than one file: the header pid becomes Context.Process
	firstOffset int64

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
	if opts.Aggregate && !(opts.SpillBinds && opts.NewTee != nil) {
		opts.NoFacts = true
		opts.SpillBinds = false
	}
	b := &Builder{
		m:            &Model{File: FileInfo{Path: path, Files: []FileEntry{{Path: path, Name: filepath.Base(path)}}}},
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
	if opts.Aggregate {
		b.agg = true
		b.m.Aggregate = true
		if opts.NewSink != nil {
			b.sink = opts.NewSink(b.m)
		} else {
			b.sink = nopSink{}
		}
		b.m.Agg = b.sink
		if opts.NewTee != nil {
			tee := opts.NewTee(b.m)
			b.sink = teeSink{b.sink, tee}
			if bs, ok := tee.(BindSink); ok && opts.SpillBinds {
				b.bindSink = bs
			} else {
				b.opts.NoFacts = true
			}
		}
	}
	return b
}

// teeSink hands every fact to two sinks, the first one (the accumulator) first.
type teeSink struct{ a, b Sink }

func (t teeSink) Call(c *Call)                { t.a.Call(c); t.b.Call(c) }
func (t teeSink) Child(ch *ChildRec, p *Call) { t.a.Child(ch, p); t.b.Child(ch, p) }
func (t teeSink) Wait(w *Wait, c *Call)       { t.a.Wait(w, c); t.b.Wait(w, c) }
func (t teeSink) Adopt(cur, to ID)            { t.a.Adopt(cur, to); t.b.Adopt(cur, to) }
func (t teeSink) Finish()                     { t.a.Finish(); t.b.Finish() }

type nopSink struct{}

func (nopSink) Call(*Call)             {}
func (nopSink) Child(*ChildRec, *Call) {}
func (nopSink) Wait(*Wait, *Call)      {}
func (nopSink) Adopt(ID, ID)           {}
func (nopSink) Finish()                {}

// Reserve pre-sizes the fact tables for the given expected row counts so that
// the big slices are allocated once instead of growing by repeated copies
// (each growth step briefly holds the old and the new array and costs a
// quarter more than the table is worth, which is where most of the peak
// memory of a large parse used to go). The reservation is capped; a wrong
// guess costs a growth step, never a failure, and untouched capacity is not
// resident memory.
func (b *Builder) Reserve(calls, waits, binds, bindSets int64) {
	const capBytes = 24 << 30
	room := func(n, elem int64) int {
		if n < 0 {
			n = 0
		}
		if n*elem > capBytes {
			n = capBytes / elem
		}
		return int(n)
	}
	m := b.m
	if b.agg {
		return
	}
	if len(m.Calls) == 0 {
		m.Calls = make([]Call, 0, room(calls, int64(unsafe.Sizeof(Call{}))))
	}
	if len(m.Waits) == 0 {
		m.Waits = make([]Wait, 0, room(waits, int64(unsafe.Sizeof(Wait{}))))
	}
	if len(m.Binds) == 0 && !b.opts.NoFacts {
		m.Binds = make([]Bind, 0, room(binds, int64(unsafe.Sizeof(Bind{}))))
		m.BindSets = make([]BindSet, 0, room(bindSets, int64(unsafe.Sizeof(BindSet{}))))
	}
}

// Build parses the single file at path into a Model; chains are not followed
// (see BuildFiles).
func Build(path string, opts Options) (*Model, error) {
	opts.NoFollow = true
	return BuildFiles([]string{path}, opts)
}

// NextFile switches the builder to the next file of the set. A continuation
// (same process, trace file split by Oracle) keeps all cursor and call state,
// so calls after the split still belong to the cursors opened before it. An
// independent file starts a new session: cursor numbers, pending waits and
// binds and the context are reset. Either way the next record opens a new
// Context carrying the file index.
func (b *Builder) NextFile(path string, continuation bool) {
	if !continuation {
		b.flushPending()
		b.open = make(map[uint64]ID)
		b.pendingWaits = make(map[uint64][]ID)
		b.pendingBinds = make(map[uint64]ID)
		b.pendingDepth = nil
		b.synthCursor = make(map[string]ID)
		b.curPlan = None
		b.lastXctend = None
		b.ctx = Context{}
		b.ctxID = None
	}
	b.m.File.Files = append(b.m.File.Files, FileEntry{Idx: len(b.m.File.Files), Path: path, Name: filepath.Base(path)})
	b.curFile = len(b.m.File.Files) - 1
	b.ctxDirty = true
	b.anchorValid = false
	b.needAnchor = false
}

// EndFile records the parser statistics of the file just parsed.
func (b *Builder) EndFile(st trace.Stats) {
	fe := &b.m.File.Files[b.curFile]
	fe.Lines, fe.Size = st.Lines, st.Bytes
}

// flushPending accounts for what is still waiting for a parent or a call.
func (b *Builder) flushPending() {
	m := b.m
	if b.agg {
		b.flushAgg()
		return
	}
	for d := 1; d < len(b.pendingDepth); d++ {
		for _, id := range b.pendingDepth[d] {
			m.Calls[id].Orphan = true
			m.Diag.OrphanCalls++
		}
		b.pendingDepth[d] = nil
	}
	for num, ids := range b.pendingWaits {
		m.Diag.UnattributedWaits += len(ids)
		b.pendingWaits[num] = nil
	}
}

// Finish completes the model after the parser has delivered every record.
func (b *Builder) Finish(st trace.Stats) *Model {
	m := b.m
	b.flushPending()
	if b.agg {
		m.AggCalls, m.AggWaits, m.aggExt = b.nCalls, b.nWaits, b.ext
		if b.opts.NewTee != nil {
			m.Diag.Notes = append(m.Diag.Notes, "spill mode: calls, waits and binds were folded into aggregates and spilled to disk; drill-downs are answered by scanning the spill files")
		} else {
			m.Diag.Notes = append(m.Diag.Notes, "aggregate mode: calls and waits were folded into aggregates, not retained; per-execution tables, bind values and the drill-down fact tables are not available")
		}
	}
	m.Diag.Lines = st.Lines
	m.Diag.Bytes = st.Bytes
	m.Diag.UnknownLines = st.Unknown
	m.Diag.BindMode = BindsKeep.String()
	if b.opts.NoFacts {
		m.Diag.BindMode = BindsNone.String()
		m.Diag.Notes = append(m.Diag.Notes, "bind values not retained (low-memory mode)")
	}
	for k := trace.Kind(0); int(k) < len(st.Kinds); k++ {
		if st.Kinds[k] > 0 {
			m.Diag.LineKinds[k.String()] = st.Kinds[k]
		}
	}
	if len(m.File.Files) == 1 {
		fe := &m.File.Files[0]
		fe.Lines, fe.Size = st.Lines, st.Bytes
	}
	if b.offsetSet {
		m.Span.LastWallUs = m.Span.LastTim + b.offsetUs
		if len(m.File.Files) > 1 {
			// the earliest tim may belong to a later file than the first anchor:
			// anchor it with the offset of the file that holds it
			m.Span.FirstWallUs = m.Span.FirstTim + b.firstOffset
			for i := range m.File.Files {
				if fe := &m.File.Files[i]; fe.FirstTim == m.Span.FirstTim && fe.offsetSet {
					m.Span.FirstWallUs = m.Span.FirstTim + fe.offsetUs
					break
				}
			}
		}
	}
	if len(m.File.Files) > 1 {
		b.checkClocks()
		attachPX(m)
	}
	if b.agg {
		b.sink.Finish()
	}
	return m
}

// checkClocks notes files whose wall-clock/tim relation differs: tim values
// of independent files are only comparable when they come from one host.
func (b *Builder) checkClocks() {
	files := b.m.File.Files
	var lo, hi int64
	n := 0
	for i := range files {
		if !files[i].offsetSet {
			continue
		}
		if n == 0 || files[i].offsetUs < lo {
			lo = files[i].offsetUs
		}
		if n == 0 || files[i].offsetUs > hi {
			hi = files[i].offsetUs
		}
		n++
	}
	if n > 1 && hi-lo > 2_000_000 {
		b.m.Diag.Notes = append(b.m.Diag.Notes, fmt.Sprintf("files disagree on the tim clock by %.1f s (traces from different hosts?); cross-file ordering and PX matching are unreliable", float64(hi-lo)/1e6))
	}
}

// ---- context & time -------------------------------------------------------

func (b *Builder) context() ID {
	if b.ctxDirty || b.ctxID == None {
		c := b.ctx
		c.ID = ID(len(b.m.Contexts))
		c.FileIdx = b.curFile
		c.PX = b.m.File.Files[b.curFile].PX
		c.Parent = None
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
	fe := &m.File.Files[b.curFile]
	if fe.FirstTim == 0 || tim < fe.FirstTim {
		fe.FirstTim = tim
	}
	if tim > fe.LastTim {
		fe.LastTim = tim
	}
	if b.needAnchor && b.anchorValid {
		b.offsetUs = b.anchorWall.UnixMicro() - tim
		b.needAnchor = false
		m.Diag.Anchors++
		m.anchors = append(m.anchors, wallAnchor{file: int32(b.curFile), line: int32(line), off: b.offsetUs})
		if !fe.offsetSet {
			fe.offsetSet, fe.offsetUs = true, b.offsetUs
		}
		if !b.offsetSet {
			b.offsetSet = true
			b.firstOffset = b.offsetUs
			m.Span.FirstWallUs = m.Span.FirstTim + b.offsetUs
		}
	}
	if b.offsetSet {
		wall := tim + b.offsetUs
		if fe.FirstWallUs == 0 || wall < fe.FirstWallUs {
			fe.FirstWallUs = wall
		}
		if wall > fe.LastWallUs {
			fe.LastWallUs = wall
		}
		return wall
	}
	return 0
}

func clamp32(v int64) int32 {
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	return int32(v)
}

func clampU8(v int) uint8 {
	if v < 0 {
		return 0
	}
	if v > math.MaxUint8 {
		return math.MaxUint8
	}
	return uint8(v)
}

// ---- trace.Handler --------------------------------------------------------

func (b *Builder) HeaderLine(h trace.Header) {
	f := &b.m.File
	fe := &f.Files[b.curFile]
	switch h.Key {
	case "Trace file":
		fe.TraceFile = h.Value
		if isPXName(h.Value) {
			fe.PX = true
		}
	case "Instance name":
		fe.Instance = h.Value
	case "Unix process pid", "Windows thread id":
		fe.ProcessPID = h.Value
		if isPXImage(h.Value) {
			fe.PX = true
		}
		if b.multi {
			b.setCtx(&b.ctx.Process, leadingDigits(h.Value), h.Line)
		}
	}
	if b.curFile > 0 {
		return // File describes the first file; Files[i] the others
	}
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
		fe := &b.m.File.Files[b.curFile]
		fe.ContinuedFrom = append(fe.ContinuedFrom, mk.Value)
		b.m.Markers = append(b.m.Markers, Marker{Line: mk.Line, Kind: mk.Kind, Text: mk.Value})
	case trace.MarkerTraceContinuesIn:
		b.m.File.ContinuesIn = append(b.m.File.ContinuesIn, mk.Value)
		fe := &b.m.File.Files[b.curFile]
		fe.ContinuesIn = append(fe.ContinuesIn, mk.Value)
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
			OCT: c.OCT, Command: ref.CommandName(c.OCT), UID: c.UID, LID: c.LID, MinDep: c.Dep, FirstLine: c.Line}
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
	if b.agg {
		b.sink.Adopt(curID, sid)
		for _, ids := range b.pendingWaits {
			for _, wid := range ids {
				if w := &b.waitBuf[wid]; w.Cursor == curID {
					w.Statement = sid
				}
			}
		}
	}
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
		ID: ID(len(b.m.Calls)), Line: int32(c.Line), Kind: c.Kind, Cursor: curID, Statement: cur.Statement,
		C: c.C, E: c.E, P: c.P, CR: c.CR, CU: c.CU, Mis: clamp32(c.Mis), R: c.R, Dep: clampU8(c.Dep), OG: clampU8(c.OG), PLH: uint32(c.PLH),
		Tim: c.Tim, Type: clampU8(c.Type), Parent: None, SelfE: c.E, SelfC: c.C, SelfP: c.P, SelfCR: c.CR, SelfCU: c.CU, Context: b.context(), BindSet: None,
	}
	b.observeTim(c.Tim, c.Line)
	if b.agg {
		b.aggCall(&call, c, curID, cur)
		return
	}
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
	b.attachWaits(c.Cursor, &b.m.Calls[id], curID)
	b.attachChildren(&b.m.Calls[id], c.Dep)
}

// attachWaits links the waits pending for a cursor number to call id.
func (b *Builder) attachWaits(num uint64, call *Call, curID ID) {
	ids := b.pendingWaits[num]
	if len(ids) == 0 {
		return
	}
	for _, wid := range ids {
		var w *Wait
		if b.agg {
			w = &b.waitBuf[wid]
		} else {
			w = &b.m.Waits[wid]
		}
		if w.Cursor != curID && w.Cursor != None {
			// the cursor number was re-parsed in between: the wait belongs to
			// the previous instance; keep it there but do not pretend it was
			// inside this call
			w.Between = true
			if b.agg {
				b.foldWait(w, nil)
			}
			continue
		}
		b.attachWait(w, call)
		if b.agg {
			b.foldWait(w, call)
		}
	}
	if b.agg {
		b.pendWait -= len(ids)
	}
	b.pendingWaits[num] = ids[:0]
}

// attachWait links one wait to a call and classifies it as inside the call
// or between calls (think time).
func (b *Builder) attachWait(w *Wait, call *Call) {
	w.Call = call.ID
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
func (b *Builder) attachChildren(call *Call, dep int) {
	if b.agg {
		b.attachChildrenAgg(call, dep)
		return
	}
	id := call.ID
	for len(b.pendingDepth) <= dep {
		b.pendingDepth = append(b.pendingDepth, nil)
	}
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
		ID: ID(len(b.m.Waits)), Line: int32(w.Line), Cursor: curID, Statement: stmt, Call: None, Event: eid,
		Ela: w.Ela, P1: w.Params[0].Value, P2: w.Params[1].Value, P3: w.Params[2].Value,
		ObjID: w.ObjID, Tim: w.Tim, Context: b.context(), Idle: ev.Idle, Number: w.Cursor,
	}
	if !w.HasObj {
		wait.ObjID = -1
	}
	b.observeTim(w.Tim, w.Line)
	if b.agg {
		b.aggWait(wait, w.Cursor)
		return
	}
	b.m.Waits = append(b.m.Waits, wait)
	if w.Cursor == 0 && b.lastXctend != None {
		b.attachWait(&b.m.Waits[wait.ID], &b.m.Calls[b.lastXctend])
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
	if b.opts.NoFacts {
		return
	}
	var curID, stmt ID = None, None
	if bs.IsRPC {
		curID = b.syntheticCursor("rpc", StmtRPC, "RPC EXEC (remote procedure call)", bs.Line)
	} else {
		curID = b.cursorFor(bs.Cursor, 0, bs.Line)
	}
	stmt = b.m.Cursors[curID].Statement
	set := BindSet{ID: ID(len(b.m.BindSets)), Line: bs.Line, Cursor: curID, Statement: stmt, Call: None, First: int32(len(b.m.Binds)), IsRPC: bs.IsRPC}
	if b.bindSink != nil {
		set.ID = ID(b.nSets)
		b.bindBuf = b.bindBuf[:0]
	}
	for i := range bs.Binds {
		tb := &bs.Binds[i]
		bind := Bind{Set: set.ID, Pos: int32(tb.Pos), Dty: int32(tb.Dty), NoDef: tb.NoOacdef, IsDump: tb.IsDump,
			Mal: int32(tb.Mal), Mxl: int32(tb.Mxl), Avl: int32(tb.Avl), Scl: int32(tb.Scl), Pre: int32(tb.Pre), Csi: int32(tb.Csi)}
		if tb.HasValue {
			bind.Value = decodeValue(tb)
			if tb.IsDump {
				// a dump of a type we can read becomes its value (no longer a dump)
				if v, ok := decodeBindDump(tb.Dty, tb.Scl, tb.Value); ok {
					bind.Value, bind.IsDump = v, false
				}
			}
		} else if !tb.NoOacdef {
			bind.IsNull = true
		}
		if b.bindSink != nil {
			b.bindBuf = append(b.bindBuf, bind)
		} else {
			b.m.Binds = append(b.m.Binds, bind)
		}
		set.N++
	}
	if b.bindSink != nil {
		b.bindSink.BindSet(&set, b.bindBuf)
		b.nSets++
	} else {
		b.m.BindSets = append(b.m.BindSets, set)
	}
	if !bs.IsRPC {
		b.pendingBinds[bs.Cursor] = set.ID
	}
}

// decodeValue strips the quoting Oracle puts around character values.
func decodeValue(tb *trace.Bind) string {
	v := tb.Value
	if tb.IsDump {
		return v
	}
	if n := len(v); n >= 2 && v[0] == '"' && v[n-1] == '"' {
		return v[1 : n-1]
	}
	if tb.Dty == 23 && len(v) < 2*tb.Avl && isHexString(v) {
		// 19c prints one byte fewer than avl of a RAW value; mark the cut
		return v + "…"
	}
	return v
}

func isHexString(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// ---- transactions & errors -----------------------------------------------

func (b *Builder) Xctend(x trace.Xctend) {
	kind, key, text := StmtCommit, "commit", "COMMIT (XCTEND rlbk=0)"
	if x.Rlbk != 0 {
		kind, key, text = StmtRollback, "rollback", "ROLLBACK (XCTEND rlbk=1)"
	}
	curID := b.syntheticCursor(key, kind, text, x.Line)
	cur := b.m.Cursors[curID]
	if b.agg {
		b.aggXctend(x, curID)
		return
	}
	call := Call{ID: ID(len(b.m.Calls)), Line: int32(x.Line), Kind: trace.CallXctend, Cursor: curID, Statement: cur.Statement,
		Dep: 1, Tim: x.Tim, Parent: None, Context: b.context(), BindSet: None, Synthetic: true}
	wall := b.observeTim(x.Tim, x.Line)
	b.m.Calls = append(b.m.Calls, call)
	b.attachWaits(0, &b.m.Calls[call.ID], curID) // waits logged on #0 before the XCTEND
	b.lastXctend = call.ID                       // ... and the ones after it (log file sync)
	b.attachChildren(&b.m.Calls[call.ID], 1)
	c := &b.m.Calls[call.ID]
	t := Transaction{ID: ID(len(b.m.Transactions)), Line: x.Line, Rlbk: x.Rlbk, RdOnly: x.RdOnly, Tim: x.Tim, WallUs: wall, Call: call.ID, Context: c.Context}
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
		return Statement{Kind: StmtParseError, Text: p.Text, Len: p.Len, OCT: p.OCT, Command: ref.CommandName(p.OCT), UID: p.UID, LID: p.LID, MinDep: p.Dep, FirstLine: p.Line}
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
		var w *Wait
		if b.agg {
			w = &b.waitBuf[wid]
		} else {
			w = &b.m.Waits[wid]
		}
		if w.Cursor == None {
			w.Cursor = curID
			w.Statement = b.m.Cursors[curID].Statement
		}
	}
}

func (b *Builder) RPCCall(r trace.RPCCall) {
	b.m.Markers = append(b.m.Markers, Marker{Line: r.Line, Kind: trace.MarkerOther, Text: "RPC CALL: " + r.Text})
}
