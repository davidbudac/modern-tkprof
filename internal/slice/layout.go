package slice

import (
	"encoding/binary"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// On-disk layout of the spill files (see spill.go): fixed-width little-endian
// records, one file per fact table, addressed by row number. The statement of
// a row is not stored: it is the statement of the row's cursor, which can
// still change while the trace is read (a cursor in use before tracing
// started is adopted by the statement parsed later).

var le = binary.LittleEndian

// Call record: 14 measures (int64), 9 ids and counts (int32), 5 codes (byte).
const (
	callRec = 154

	cOffCursor = 112 // int32 ids and counts follow the 14 int64 measures
	cOffParent = 116
	cOffCtx    = 120
	cOffBind   = 124
	cOffLine   = 128
	cOffExecNo = 132
	cOffNWaits = 136
	cOffMis    = 140
	cOffPLH    = 144 // uint32
	cOffKind   = 148
	cOffDep    = 149
	cOffOG     = 150
	cOffType   = 151
	cOffSynth  = 152
	cOffOrphan = 153
)

func putCall(b []byte, c *model.Call) {
	le.PutUint64(b[0:], uint64(c.Tim))
	le.PutUint64(b[8:], uint64(c.C))
	le.PutUint64(b[16:], uint64(c.E))
	le.PutUint64(b[24:], uint64(c.P))
	le.PutUint64(b[32:], uint64(c.CR))
	le.PutUint64(b[40:], uint64(c.CU))
	le.PutUint64(b[48:], uint64(c.R))
	le.PutUint64(b[56:], uint64(c.SelfE))
	le.PutUint64(b[64:], uint64(c.SelfC))
	le.PutUint64(b[72:], uint64(c.SelfP))
	le.PutUint64(b[80:], uint64(c.SelfCR))
	le.PutUint64(b[88:], uint64(c.SelfCU))
	le.PutUint64(b[96:], uint64(c.WaitEla))
	le.PutUint64(b[104:], uint64(c.IdleEla))
	le.PutUint32(b[cOffCursor:], uint32(c.Cursor))
	le.PutUint32(b[cOffParent:], uint32(c.Parent))
	le.PutUint32(b[cOffCtx:], uint32(c.Context))
	le.PutUint32(b[cOffBind:], uint32(c.BindSet))
	le.PutUint32(b[cOffLine:], uint32(c.Line))
	le.PutUint32(b[cOffExecNo:], uint32(c.ExecNo))
	le.PutUint32(b[cOffNWaits:], uint32(c.NWaits))
	le.PutUint32(b[cOffMis:], uint32(c.Mis))
	le.PutUint32(b[cOffPLH:], c.PLH)
	b[cOffKind], b[cOffDep], b[cOffOG], b[cOffType] = byte(c.Kind), c.Dep, c.OG, c.Type
	b[cOffSynth] = b2u8(c.Synthetic)
	b[cOffOrphan] = b2u8(c.Orphan)
}

// getCall decodes a record; ID and Statement are the caller's to set.
func getCall(b []byte, c *model.Call) {
	c.Tim = int64(le.Uint64(b[0:]))
	c.C = int64(le.Uint64(b[8:]))
	c.E = int64(le.Uint64(b[16:]))
	c.P = int64(le.Uint64(b[24:]))
	c.CR = int64(le.Uint64(b[32:]))
	c.CU = int64(le.Uint64(b[40:]))
	c.R = int64(le.Uint64(b[48:]))
	c.SelfE = int64(le.Uint64(b[56:]))
	c.SelfC = int64(le.Uint64(b[64:]))
	c.SelfP = int64(le.Uint64(b[72:]))
	c.SelfCR = int64(le.Uint64(b[80:]))
	c.SelfCU = int64(le.Uint64(b[88:]))
	c.WaitEla = int64(le.Uint64(b[96:]))
	c.IdleEla = int64(le.Uint64(b[104:]))
	c.Cursor = model.ID(int32(le.Uint32(b[cOffCursor:])))
	c.Parent = model.ID(int32(le.Uint32(b[cOffParent:])))
	c.Context = model.ID(int32(le.Uint32(b[cOffCtx:])))
	c.BindSet = model.ID(int32(le.Uint32(b[cOffBind:])))
	c.Line = int32(le.Uint32(b[cOffLine:]))
	c.ExecNo = int32(le.Uint32(b[cOffExecNo:]))
	c.NWaits = int32(le.Uint32(b[cOffNWaits:]))
	c.Mis = int32(le.Uint32(b[cOffMis:]))
	c.PLH = le.Uint32(b[cOffPLH:])
	c.Kind, c.Dep, c.OG, c.Type = trace.CallKind(b[cOffKind]), b[cOffDep], b[cOffOG], b[cOffType]
	c.Synthetic = b[cOffSynth] != 0
	c.Orphan = b[cOffOrphan] != 0
}

// Wait record: 6 int64, 5 int32, 2 bytes.
const (
	waitRec = 70

	wOffCursor = 48
	wOffCall   = 52
	wOffEvent  = 56
	wOffCtx    = 60
	wOffLine   = 64
	wOffDep    = 68
	wOffFlags  = 69 // 1 = between calls, 2 = idle
)

func putWait(b []byte, w *model.Wait) {
	le.PutUint64(b[0:], uint64(w.Tim))
	le.PutUint64(b[8:], uint64(w.Ela))
	le.PutUint64(b[16:], uint64(w.P1))
	le.PutUint64(b[24:], uint64(w.P2))
	le.PutUint64(b[32:], uint64(w.P3))
	le.PutUint64(b[40:], uint64(w.ObjID))
	le.PutUint32(b[wOffCursor:], uint32(w.Cursor))
	le.PutUint32(b[wOffCall:], uint32(w.Call))
	le.PutUint32(b[wOffEvent:], uint32(w.Event))
	le.PutUint32(b[wOffCtx:], uint32(w.Context))
	le.PutUint32(b[wOffLine:], uint32(w.Line))
	b[wOffDep] = w.Dep
	b[wOffFlags] = b2u8(w.Between) | b2u8(w.Idle)<<1
}

// getWait decodes a record; ID and Statement are the caller's to set (Number,
// the raw cursor number of the line, is not kept).
func getWait(b []byte, w *model.Wait) {
	w.Tim = int64(le.Uint64(b[0:]))
	w.Ela = int64(le.Uint64(b[8:]))
	w.P1 = int64(le.Uint64(b[16:]))
	w.P2 = int64(le.Uint64(b[24:]))
	w.P3 = int64(le.Uint64(b[32:]))
	w.ObjID = int64(le.Uint64(b[40:]))
	w.Cursor = model.ID(int32(le.Uint32(b[wOffCursor:])))
	w.Call = model.ID(int32(le.Uint32(b[wOffCall:])))
	w.Event = model.ID(int32(le.Uint32(b[wOffEvent:])))
	w.Context = model.ID(int32(le.Uint32(b[wOffCtx:])))
	w.Line = int32(le.Uint32(b[wOffLine:]))
	w.Dep = b[wOffDep]
	w.Between = b[wOffFlags]&1 != 0
	w.Idle = b[wOffFlags]&2 != 0
}

// Bind set record and bind record. A set points at its binds by first row
// and count; the values of one set are adjacent in the value heap.
const (
	setRec  = 21
	bindRec = 45
)

func putSet(b []byte, s *model.BindSet, first int64) {
	le.PutUint32(b[0:], uint32(s.Line))
	le.PutUint32(b[4:], uint32(s.Cursor))
	le.PutUint64(b[8:], uint64(first))
	le.PutUint32(b[16:], uint32(s.N))
	b[20] = b2u8(s.IsRPC)
}

func putBind(b []byte, x *model.Bind, valOff int64) {
	for i, v := range [8]int32{x.Pos, x.Dty, x.Mal, x.Mxl, x.Avl, x.Scl, x.Pre, x.Csi} {
		le.PutUint32(b[4*i:], uint32(v))
	}
	b[32] = b2u8(x.IsNull) | b2u8(x.NoDef)<<1 | b2u8(x.IsDump)<<2
	le.PutUint64(b[33:], uint64(valOff))
	le.PutUint32(b[41:], uint32(len(x.Value)))
}

func b2u8(v bool) byte {
	if v {
		return 1
	}
	return 0
}
