package model

import (
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

const sample = `Trace file /u01/x.trc
Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
Version 19.27.0.0.0
Instance name: cdb1
Node name:      host1

*** 2026-10-22T13:14:15.000000+02:00 (PDB1(3))
*** SESSION ID:(254.49185) 2026-10-22T13:14:15.000000+02:00
*** MODULE NAME:(SQL*Plus) 2026-10-22T13:14:15.000000+02:00
*** CONTAINER ID:(3) 2026-10-22T13:14:15.000000+02:00

=====================
PARSING IN CURSOR #10 len=25 dep=0 uid=107 oct=47 lid=107 tim=1000000 hv=111 ad='a1' sqlid='blk000000001'
BEGIN mtk_proc(:n); END;
END OF STMT
PARSE #10:c=100,e=150,p=0,cr=0,cu=0,mis=1,r=0,dep=0,og=1,plh=0,tim=1000150
BINDS #10:
 Bind#0
  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0
  kxsbbbfp=7f8b1c0a0e68  bln=22  avl=02  flg=05
  value=7
=====================
PARSING IN CURSOR #11 len=38 dep=1 uid=107 oct=3 lid=107 tim=1000300 hv=222 ad='a2' sqlid='sel000000001'
SELECT NAME FROM MTK_CUST WHERE ID=:B1
END OF STMT
PARSE #11:c=50,e=60,p=0,cr=0,cu=0,mis=0,r=0,dep=1,og=1,plh=333,tim=1000360
EXEC #11:c=10,e=20,p=0,cr=0,cu=0,mis=0,r=0,dep=1,og=1,plh=333,tim=1000400
WAIT #11: nam='db file sequential read' ela= 500 file#=4 block#=100 blocks=1 obj#=73512 tim=1000900
FETCH #11:c=100,e=700,p=1,cr=3,cu=0,mis=0,r=1,dep=1,og=1,plh=333,tim=1001100
STAT #11 id=1 cnt=1 pid=0 pos=1 obj=73512 op='TABLE ACCESS BY INDEX ROWID MTK_CUST (cr=3 pr=1 pw=0 str=1 time=690 us cost=2 size=25 card=1)'
STAT #11 id=2 cnt=1 pid=1 pos=1 obj=73513 op='INDEX UNIQUE SCAN MTK_CUST_PK (cr=2 pr=0 pw=0 str=1 time=20 us cost=1 size=0 card=1)'
CLOSE #11:c=0,e=5,dep=1,type=3,tim=1001110
EXEC #10:c=400,e=2000,p=1,cr=3,cu=0,mis=0,r=1,dep=0,og=1,plh=0,tim=1002200
WAIT #10: nam='SQL*Net message to client' ela= 3 driver id=1650815232 #bytes=1 p3=0 obj#=-1 tim=1002210
WAIT #10: nam='SQL*Net message from client' ela= 100000 driver id=1650815232 #bytes=1 p3=0 obj#=-1 tim=1102210
XCTEND rlbk=0, rd_only=0, tim=1102300
WAIT #0: nam='log file sync' ela= 800 buffer#=1 sync scn=2 p3=0 obj#=-1 tim=1103100
CLOSE #10:c=0,e=10,dep=0,type=0,tim=1103200
EXEC #99:c=5,e=8,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1103300
*** 2026-10-22T13:14:17.000000+02:00
WAIT #10: nam='SQL*Net message from client' ela= 50 driver id=1650815232 #bytes=1 p3=0 obj#=-1 tim=1103400
`

func build(t *testing.T, s string) *Model {
	t.Helper()
	b := NewBuilder("test.trc", Options{})
	st, err := trace.Parse(strings.NewReader(s), b)
	if err != nil {
		t.Fatal(err)
	}
	return b.Finish(st)
}

func TestBuilderBasics(t *testing.T) {
	m := build(t, sample)
	if m.File.Version != "19.27.0.0.0" || m.File.Instance != "cdb1" || m.File.Node != "host1" {
		t.Errorf("file info: %+v", m.File)
	}
	// statements: block, select, commit, unknown #99
	if len(m.Statements) != 4 {
		t.Fatalf("statements: %d %+v", len(m.Statements), m.Statements)
	}
	blk, sel := m.Statements[0], m.Statements[1]
	if blk.SQLID != "blk000000001" || blk.OCT != 47 || blk.MinDep != 0 || sel.MinDep != 1 || sel.HV != 222 {
		t.Errorf("stmts: %+v %+v", blk, sel)
	}
	if m.Statements[2].Kind != StmtCommit || m.Statements[3].Kind != StmtUnknown {
		t.Errorf("synthetic stmts: %+v", m.Statements[2:])
	}
	if m.Diag.ImplicitCursors != 1 {
		t.Errorf("implicit cursors: %d", m.Diag.ImplicitCursors)
	}
	// context
	if len(m.Contexts) != 1 {
		t.Fatalf("contexts: %+v", m.Contexts)
	}
	if c := m.Contexts[0]; c.SessionID != "254.49185" || c.Module != "SQL*Plus" || c.ContainerID != "3" {
		t.Errorf("context: %+v", c)
	}
}

func TestHierarchyAndSelfTime(t *testing.T) {
	m := build(t, sample)
	byKind := func(stmt ID, k trace.CallKind) *Call {
		for i := range m.Calls {
			if m.Calls[i].Statement == stmt && m.Calls[i].Kind == k {
				return &m.Calls[i]
			}
		}
		t.Fatalf("no %v call for stmt %d", k, stmt)
		return nil
	}
	blkExec := byKind(0, trace.CallExec)
	selParse := byKind(1, trace.CallParse)
	selExec := byKind(1, trace.CallExec)
	selFetch := byKind(1, trace.CallFetch)
	selClose := byKind(1, trace.CallClose)
	for _, c := range []*Call{selParse, selExec, selFetch, selClose} {
		if c.Parent != blkExec.ID {
			t.Errorf("call %v line %d parent=%d want %d", c.Kind, c.Line, c.Parent, blkExec.ID)
		}
	}
	// 2000 - (60+20+700+5) = 1215
	if blkExec.SelfE != 1215 || blkExec.SelfC != 400-(50+10+100+0) {
		t.Errorf("self time: e=%d c=%d", blkExec.SelfE, blkExec.SelfC)
	}
	if blkExec.Parent != None || blkExec.Orphan {
		t.Errorf("top-level exec: %+v", blkExec)
	}
	// the XCTEND is a synthetic dep=1 call attached to the next dep-0 call (CLOSE #10)
	x := byKind(2, trace.CallXctend)
	blkClose := byKind(0, trace.CallClose)
	if x.Parent != blkClose.ID || !x.Synthetic || x.E != 800 || x.WaitEla != 800 {
		t.Errorf("xctend call: %+v", x)
	}
	if len(m.Transactions) != 1 || m.Transactions[0].Call != x.ID {
		t.Errorf("transactions: %+v", m.Transactions)
	}
}

func TestWaitAttribution(t *testing.T) {
	m := build(t, sample)
	if len(m.Waits) != 5 {
		t.Fatalf("waits: %d", len(m.Waits))
	}
	w := m.Waits[0] // db file sequential read -> FETCH #11, inside the call
	if m.Calls[w.Call].Kind != trace.CallFetch || w.Between || w.Idle || w.Statement != 1 || m.Events[w.Event].Name != "db file sequential read" {
		t.Errorf("wait 0: %+v", w)
	}
	if f := m.Calls[w.Call]; f.WaitEla != 500 || f.NWaits != 1 {
		t.Errorf("fetch wait sums: %+v", f)
	}
	w = m.Waits[1] // SQL*Net message to client -> CLOSE #10; ended before the close started => between
	if m.Calls[w.Call].Kind != trace.CallClose || !w.Between {
		t.Errorf("wait 1: %+v", w)
	}
	w = m.Waits[2] // SQL*Net message from client (idle)
	if !w.Idle || !w.Between || m.Calls[w.Call].IdleEla != 100003 {
		t.Errorf("wait 2: %+v call=%+v", w, m.Calls[w.Call])
	}
	w = m.Waits[3] // log file sync on #0 -> xctend; adopts the synthetic commit cursor
	if m.Calls[w.Call].Kind != trace.CallXctend || w.Between || w.Cursor != m.Calls[w.Call].Cursor || w.Statement != 2 {
		t.Errorf("wait 3: %+v", w)
	}
	w = m.Waits[4] // trailing wait, never attributed
	if w.Call != None || m.Diag.UnattributedWaits != 1 {
		t.Errorf("wait 4: %+v diag=%+v", w, m.Diag)
	}
	if len(m.Events) != 4 || !m.Events[2].Idle || m.Events[0].Idle {
		t.Errorf("events: %+v", m.Events)
	}
}

func TestBindsAndPlans(t *testing.T) {
	m := build(t, sample)
	if len(m.BindSets) != 1 || len(m.Binds) != 1 {
		t.Fatalf("binds: %+v %+v", m.BindSets, m.Binds)
	}
	bs := m.BindSets[0]
	exec := m.Calls[bs.Call]
	if exec.Kind != trace.CallExec || exec.Statement != 0 || exec.BindSet != bs.ID || exec.ExecNo != 1 {
		t.Errorf("bind set call: %+v", exec)
	}
	if b := m.Binds[0]; b.Value != "7" || b.TypeName() != "NUMBER" || b.IsNull {
		t.Errorf("bind: %+v", b)
	}
	if len(m.Plans) != 1 || m.Plans[0].N != 2 || m.Plans[0].Statement != 1 || m.Plans[0].PLH != 333 {
		t.Fatalf("plans: %+v", m.Plans)
	}
	l0, l1 := m.PlanLines[0], m.PlanLines[1]
	if l0.Op != "TABLE ACCESS BY INDEX ROWID" || l0.Object != "MTK_CUST" || l0.Depth != 0 || l0.Cnt != 1 || l0.TimeUs != 690 {
		t.Errorf("plan line 0: %+v", l0)
	}
	if l1.Op != "INDEX UNIQUE SCAN" || l1.Object != "MTK_CUST_PK" || l1.Depth != 1 || l1.ParentID != 1 {
		t.Errorf("plan line 1: %+v", l1)
	}
}

func TestSpanAndWallClock(t *testing.T) {
	m := build(t, sample)
	if m.Span.FirstTim != 1000000 || m.Span.LastTim != 1103400 {
		t.Errorf("span: %+v", m.Span)
	}
	// first anchor: marker 13:14:15 +02:00 followed by PARSING IN CURSOR tim=1000000
	if m.Span.FirstWallUs == 0 {
		t.Fatalf("no wall clock")
	}
	first := m.Calls[0] // PARSE #10 tim=1000150
	wantUs := m.Span.FirstWallUs + 150
	if m.CallWall(&first) != wantUs {
		t.Errorf("wall: got %d want %d", m.CallWall(&first), wantUs)
	}
	if m.Diag.Anchors != 2 {
		t.Errorf("anchors: %d", m.Diag.Anchors)
	}
}

func TestCursorReuse(t *testing.T) {
	s := `PARSING IN CURSOR #5 len=8 dep=0 uid=1 oct=3 lid=1 tim=100 hv=1 ad='a' sqlid='s1'
select 1
END OF STMT
EXEC #5:c=0,e=10,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=1,tim=110
WAIT #5: nam='SQL*Net message from client' ela= 50 driver id=1 #bytes=1 p3=0 obj#=-1 tim=160
CLOSE #5:c=0,e=1,dep=0,type=0,tim=161
WAIT #5: nam='SQL*Net message from client' ela= 50 driver id=1 #bytes=1 p3=0 obj#=-1 tim=211
PARSING IN CURSOR #5 len=8 dep=0 uid=1 oct=3 lid=1 tim=212 hv=2 ad='b' sqlid='s2'
select 2
END OF STMT
PARSE #5:c=0,e=10,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=2,tim=222
`
	m := build(t, s)
	if len(m.Cursors) != 2 || len(m.Statements) != 2 {
		t.Fatalf("cursors=%d stmts=%d", len(m.Cursors), len(m.Statements))
	}
	if !m.Cursors[0].Closed {
		t.Errorf("first instance should be closed")
	}
	w := m.Waits[1]
	if w.Cursor != 0 || w.Statement != 0 || w.Call != None || !w.Between {
		t.Errorf("wait across instances: %+v", w)
	}
}

// An aggregation-only build keeps no calls, waits or binds, but the builder's
// call-stack logic still runs: the counts and diagnostics are those of the
// full build, and a sink sees every call and wait exactly once.
type countSink struct {
	calls, waits, children, orphans, attached int
	selfE                                     int64
}

func (s *countSink) Call(c *Call) {
	s.calls++
	s.selfE += c.SelfE
}
func (s *countSink) Child(_ *ChildRec, parent *Call) {
	if parent == nil {
		s.orphans++
	} else {
		s.children++
	}
}
func (s *countSink) Wait(_ *Wait, c *Call) {
	s.waits++
	if c != nil {
		s.attached++
	}
}
func (*countSink) Adopt(ID, ID) {}
func (*countSink) Finish()      {}

func TestAggregateKeepsNoFacts(t *testing.T) {
	full := build(t, sample)
	sink := &countSink{}
	b := NewBuilder("test.trc", Options{Aggregate: true, NewSink: func(*Model) Sink { return sink }})
	st, err := trace.Parse(strings.NewReader(sample), b)
	if err != nil {
		t.Fatal(err)
	}
	m := b.Finish(st)
	if len(m.Calls) != 0 || len(m.Waits) != 0 || len(m.Binds) != 0 || len(m.BindSets) != 0 {
		t.Fatalf("facts retained: %d calls %d waits %d binds %d bind sets", len(m.Calls), len(m.Waits), len(m.Binds), len(m.BindSets))
	}
	if !m.Aggregate || m.Diag.BindMode != BindsNone.String() {
		t.Errorf("aggregate %v, bind mode %q", m.Aggregate, m.Diag.BindMode)
	}
	if m.CallCount() != int64(len(full.Calls)) || m.WaitCount() != int64(len(full.Waits)) {
		t.Errorf("counts %d/%d, want %d/%d", m.CallCount(), m.WaitCount(), len(full.Calls), len(full.Waits))
	}
	if sink.calls != len(full.Calls) || sink.waits != len(full.Waits) {
		t.Errorf("sink saw %d calls %d waits, want %d / %d", sink.calls, sink.waits, len(full.Calls), len(full.Waits))
	}
	var selfE int64
	attached, children := 0, 0
	for i := range full.Calls {
		selfE += full.Calls[i].SelfE
		if full.Calls[i].Parent != None {
			children++
		}
	}
	for i := range full.Waits {
		if full.Waits[i].Call != None {
			attached++
		}
	}
	if sink.selfE != selfE || sink.attached != attached || sink.children != children {
		t.Errorf("self time %d/%d, attached waits %d/%d, children %d/%d (sink/full)", sink.selfE, selfE, sink.attached, attached, sink.children, children)
	}
	if m.Diag.OrphanCalls != full.Diag.OrphanCalls || m.Diag.UnattributedWaits != full.Diag.UnattributedWaits || sink.orphans != full.Diag.OrphanCalls {
		t.Errorf("orphans %d/%d, unattributed waits %d/%d (aggregate/full)", m.Diag.OrphanCalls, full.Diag.OrphanCalls, m.Diag.UnattributedWaits, full.Diag.UnattributedWaits)
	}
	if len(m.Statements) != len(full.Statements) || len(m.Cursors) != len(full.Cursors) || len(m.Transactions) != len(full.Transactions) ||
		len(m.Plans) != len(full.Plans) || len(m.Contexts) != len(full.Contexts) {
		t.Errorf("dimensions differ: %d/%d statements, %d/%d cursors, %d/%d transactions", len(m.Statements), len(full.Statements), len(m.Cursors), len(full.Cursors), len(m.Transactions), len(full.Transactions))
	}
}
