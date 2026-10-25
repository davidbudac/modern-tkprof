package model

import (
	"fmt"
	"io"

	"github.com/davidbudac/modern-tkprof/internal/binfmt"
)

// Persistence of an aggregation-only model for the index cache
// (docs/PLAN-DESKTOP.md § 3): Encode writes the dimension tables and the
// aggregate bookkeeping of the Model, everything but the fact tables (Calls,
// Waits, BindSets, Binds live in the spill files) and Agg (the accumulator is
// package analyze's: analyze.(*Accumulator).Encode, DecodeAccumulator).
//
// The format is explicit binary (binfmt): one codec function per struct
// lists its fields in order and serves both directions. Adding, removing or
// reordering a field changes the format: bump PersistVersion
// (TestPersistCoversEveryField counts the fields to catch a forgotten one).

// PersistVersion is the format version of Encode.
const PersistVersion = 1

const persistMagic = "MTKPDIMS"

// ErrFormat is returned (wrapped) by Decode for a file of another version or
// a corrupt one: the cache treats it as a miss and rebuilds.
var ErrFormat = binfmt.ErrFormat

// Encode writes the dimension tables of m. The fact tables must be empty (an
// aggregation-only model): they are not part of the format.
func Encode(w io.Writer, m *Model) error {
	if len(m.Calls) > 0 || len(m.Waits) > 0 || len(m.Binds) > 0 || len(m.BindSets) > 0 {
		return fmt.Errorf("model.Encode: the fact tables are not persisted (aggregation-only models only)")
	}
	bw := binfmt.NewWriter(w)
	bw.Header(persistMagic, PersistVersion)
	codeModel(binfmt.Encoder(bw), m)
	return bw.Flush()
}

// Decode reads what Encode wrote. The model has no Agg: the caller attaches
// the decoded accumulator.
func Decode(r io.Reader) (*Model, error) {
	br := binfmt.NewReader(r)
	br.Header(persistMagic, PersistVersion)
	m := &Model{}
	codeModel(binfmt.Decoder(br), m)
	if err := br.End(); err != nil {
		return nil, err
	}
	m.indexRef()
	return m, nil
}

// indexRef rebuilds the lookup maps of the reference dimensions (as ApplyRef does).
func (m *Model) indexRef() {
	if len(m.Objects) == 0 && len(m.Files) == 0 && len(m.Users) == 0 {
		return
	}
	m.objIdx, m.fileIdx, m.userIdx = map[int64]int{}, map[int64]int{}, map[int64]int{}
	for i, o := range m.Objects {
		m.objIdx[o.ID] = i
	}
	for i, f := range m.Files {
		m.fileIdx[f.File] = i
	}
	for i, u := range m.Users {
		m.userIdx[u.ID] = i
	}
}

// persistFields is the number of fields of every struct the format covers
// (TestPersistCoversEveryField compares them with the structs).
var persistFields = map[string]int{
	"Model": 29, "FileInfo": 14, "FileEntry": 19, "KV": 2, "Span": 6, "Statement": 14, "Cursor": 13,
	"Event": 7, "Context": 13, "Plan": 8, "PlanLine": 23, "Transaction": 8, "ErrorEvent": 10,
	"Marker": 5, "UnknownLine": 2, "Diagnostics": 11, "RefObject": 5, "RefFile": 4, "RefUser": 2,
	"ctxExtent": 3, "wallAnchor": 3,
}

func id(c *binfmt.Codec, p *ID) { c.I32((*int32)(p)) }

func ids(c *binfmt.Codec, p *[]ID) { binfmt.Slice(c, p, func(v *ID) { id(c, v) }) }

func codeModel(c *binfmt.Codec, m *Model) {
	codeFileInfo(c, &m.File)
	codeSpan(c, &m.Span)
	binfmt.Slice(c, &m.Statements, func(s *Statement) { codeStatement(c, s) })
	binfmt.Slice(c, &m.Cursors, func(s *Cursor) { codeCursor(c, s) })
	// Calls, Waits: spill files
	binfmt.Slice(c, &m.Events, func(e *Event) { codeEvent(c, e) })
	binfmt.Slice(c, &m.Contexts, func(x *Context) { codeContext(c, x) })
	// BindSets, Binds: spill files
	binfmt.Slice(c, &m.Plans, func(p *Plan) { codePlan(c, p) })
	binfmt.Slice(c, &m.PlanLines, func(p *PlanLine) { codePlanLine(c, p) })
	binfmt.Slice(c, &m.Transactions, func(t *Transaction) { codeTransaction(c, t) })
	binfmt.Slice(c, &m.Errors, func(e *ErrorEvent) { codeError(c, e) })
	binfmt.Slice(c, &m.Markers, func(k *Marker) { codeMarker(c, k) })
	binfmt.Slice(c, &m.Unknown, func(u *UnknownLine) { c.Int(&u.Line); c.Str(&u.Text) })
	codeDiag(c, &m.Diag)
	binfmt.Slice(c, &m.Objects, func(o *RefObject) {
		c.I64(&o.ID)
		c.Str(&o.Owner)
		c.Str(&o.Name)
		c.Str(&o.Subobject)
		c.Str(&o.Type)
	})
	binfmt.Slice(c, &m.Files, func(f *RefFile) { c.I64(&f.File); c.Str(&f.Name); c.Str(&f.Tablespace); c.Str(&f.Type) })
	binfmt.Slice(c, &m.Users, func(u *RefUser) { c.I64(&u.ID); c.Str(&u.Name) })
	// objIdx, fileIdx, userIdx: rebuilt (indexRef)
	c.Bool(&m.Aggregate)
	c.I64(&m.AggCalls)
	c.I64(&m.AggWaits)
	// Agg: package analyze
	binfmt.Slice(c, &m.aggExt, func(e *ctxExtent) { c.I64(&e.from); c.I64(&e.to); c.Bool(&e.ok) })
	binfmt.Slice(c, &m.anchors, func(a *wallAnchor) { c.I32(&a.file); c.I32(&a.line); c.I64(&a.off) })
}

func codeFileInfo(c *binfmt.Codec, f *FileInfo) {
	c.Str(&f.Path)
	binfmt.Slice(c, &f.Headers, func(kv *KV) { c.Str(&kv.Key); c.Str(&kv.Value) })
	c.Str(&f.TraceFile)
	c.Str(&f.Version)
	c.Str(&f.Instance)
	c.Str(&f.Node)
	c.Str(&f.Machine)
	c.Str(&f.SystemName)
	c.Str(&f.ProcessPID)
	c.Strings(&f.ContinuedFrom)
	c.Strings(&f.ContinuesIn)
	c.I64(&f.DumpSizeLimit)
	c.Bool(&f.Truncated)
	binfmt.Slice(c, &f.Files, func(e *FileEntry) { codeFileEntry(c, e) })
}

func codeFileEntry(c *binfmt.Codec, e *FileEntry) {
	c.Int(&e.Idx)
	c.Str(&e.Path)
	c.Str(&e.Name)
	c.I64(&e.Size)
	c.Int(&e.Lines)
	c.I64(&e.FirstTim)
	c.I64(&e.LastTim)
	c.I64(&e.FirstWallUs)
	c.I64(&e.LastWallUs)
	c.Str(&e.ProcessPID)
	c.Str(&e.Instance)
	c.Str(&e.TraceFile)
	c.Bool(&e.PX)
	c.Int(&e.Chain)
	c.Bool(&e.Followed)
	c.Strings(&e.ContinuedFrom)
	c.Strings(&e.ContinuesIn)
	c.I64(&e.offsetUs)
	c.Bool(&e.offsetSet)
}

func codeSpan(c *binfmt.Codec, s *Span) {
	c.I64(&s.FirstTim)
	c.I64(&s.LastTim)
	c.I64(&s.FirstWallUs)
	c.I64(&s.LastWallUs)
	c.Int(&s.FirstLine)
	c.Int(&s.LastLine)
}

func codeStatement(c *binfmt.Codec, s *Statement) {
	id(c, &s.ID)
	c.U8((*uint8)(&s.Kind))
	c.Str(&s.SQLID)
	c.U64(&s.HV)
	c.Str(&s.Text)
	c.Int(&s.Len)
	c.Int(&s.OCT)
	c.Str(&s.Command)
	c.Int(&s.UID)
	c.Int(&s.LID)
	c.Int(&s.MinDep)
	c.Int(&s.FirstLine)
	ids(c, &s.Cursors)
	c.Str(&s.RefPlan)
}

func codeCursor(c *binfmt.Codec, k *Cursor) {
	id(c, &k.ID)
	c.U64(&k.Number)
	id(c, &k.Statement)
	c.Int(&k.Line)
	c.Int(&k.Dep)
	c.I64(&k.Tim)
	c.Str(&k.Addr)
	c.U64(&k.PLH)
	id(c, &k.Context)
	c.Bool(&k.Implicit)
	c.Bool(&k.Assumed)
	c.I32(&k.Execs)
	c.Bool(&k.Closed)
}

func codeEvent(c *binfmt.Codec, e *Event) {
	id(c, &e.ID)
	c.Str(&e.Name)
	c.Str(&e.Class)
	c.Str(&e.P1Name)
	c.Str(&e.P2Name)
	c.Str(&e.P3Name)
	c.Bool(&e.Idle)
}

func codeContext(c *binfmt.Codec, x *Context) {
	id(c, &x.ID)
	c.Int(&x.Line)
	c.Str(&x.SessionID)
	c.Str(&x.ClientID)
	c.Str(&x.Service)
	c.Str(&x.Module)
	c.Str(&x.Action)
	c.Str(&x.ClientDriver)
	c.Str(&x.ContainerID)
	c.Str(&x.Process)
	c.Int(&x.FileIdx)
	c.Bool(&x.PX)
	id(c, &x.Parent)
}

func codePlan(c *binfmt.Codec, p *Plan) {
	id(c, &p.ID)
	c.Int(&p.Line)
	id(c, &p.Cursor)
	id(c, &p.Statement)
	c.U64(&p.PLH)
	c.I32(&p.First)
	c.I32(&p.N)
	c.Bool(&p.XPlanMatched)
}

func codePlanLine(c *binfmt.Codec, l *PlanLine) {
	id(c, &l.Plan)
	c.Int(&l.ID)
	c.Int(&l.ParentID)
	c.Int(&l.Pos)
	c.Int(&l.Depth)
	c.I64(&l.Obj)
	c.Str(&l.Op)
	c.Str(&l.Object)
	c.I64(&l.Cnt)
	c.I64(&l.Str)
	c.I64(&l.CR)
	c.I64(&l.PR)
	c.I64(&l.PW)
	c.I64(&l.TimeUs)
	c.I64(&l.Cost)
	c.I64(&l.Size)
	c.I64(&l.Card)
	c.Bool(&l.HasStats)
	c.Str(&l.Access)
	c.Str(&l.Filter)
	c.Str(&l.Alias)
	c.Str(&l.QBlock)
	c.I64(&l.ERows)
}

func codeTransaction(c *binfmt.Codec, t *Transaction) {
	id(c, &t.ID)
	c.Int(&t.Line)
	c.Int(&t.Rlbk)
	c.Int(&t.RdOnly)
	c.I64(&t.Tim)
	c.I64(&t.WallUs)
	id(c, &t.Call)
	id(c, &t.Context)
}

func codeError(c *binfmt.Codec, e *ErrorEvent) {
	id(c, &e.ID)
	c.Int(&e.Line)
	id(c, &e.Cursor)
	id(c, &e.Statement)
	c.Int(&e.Err)
	c.I64(&e.Tim)
	c.I64(&e.WallUs)
	c.Bool(&e.ParseError)
	c.Str(&e.Text)
	id(c, &e.Context)
}

func codeMarker(c *binfmt.Codec, k *Marker) {
	c.Int(&k.Line)
	c.U8((*uint8)(&k.Kind))
	c.Str(&k.Text)
	c.Time(&k.Time)
	c.Bool(&k.HasTime)
}

func codeDiag(c *binfmt.Codec, d *Diagnostics) {
	c.Int(&d.Lines)
	c.I64(&d.Bytes)
	c.Int(&d.UnknownLines)
	c.Int(&d.ImplicitCursors)
	c.Int(&d.AssumedCursors)
	c.Int(&d.OrphanCalls)
	c.Int(&d.UnattributedWaits)
	c.Int(&d.Anchors)
	binfmt.Map(c, &d.LineKinds, c.Str, c.Int)
	c.Strings(&d.Notes)
	c.Str(&d.BindMode)
}
