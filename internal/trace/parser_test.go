package trace

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// recorder collects every record for assertions.
type recorder struct {
	headers []Header
	markers []Marker
	cursors []CursorHeader
	calls   []Call
	waits   []Wait
	stats   []Stat
	binds   []BindSet
	xctends []Xctend
	errors  []Error
	perrs   []ParseError
	rpcs    []RPCCall
	seps    []int
	unknown []string
}

func (r *recorder) HeaderLine(h Header)        { r.headers = append(r.headers, h) }
func (r *recorder) Marker(m Marker)            { r.markers = append(r.markers, m) }
func (r *recorder) Cursor(c CursorHeader)      { r.cursors = append(r.cursors, c) }
func (r *recorder) Call(c Call)                { r.calls = append(r.calls, c) }
func (r *recorder) Wait(w Wait)                { r.waits = append(r.waits, w) }
func (r *recorder) Stat(s Stat)                { r.stats = append(r.stats, s) }
func (r *recorder) Binds(b BindSet)            { r.binds = append(r.binds, b) }
func (r *recorder) Xctend(x Xctend)            { r.xctends = append(r.xctends, x) }
func (r *recorder) Error(e Error)              { r.errors = append(r.errors, e) }
func (r *recorder) ParseError(p ParseError)    { r.perrs = append(r.perrs, p) }
func (r *recorder) RPCCall(c RPCCall)          { r.rpcs = append(r.rpcs, c) }
func (r *recorder) Separator(line int)         { r.seps = append(r.seps, line) }
func (r *recorder) Unknown(line int, t []byte) { r.unknown = append(r.unknown, string(t)) }

const sample = `Trace file /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_12345_mtk.trc
Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
Version 19.27.0.0.0
Build label:    RDBMS_19.27.0.0.0DBRU_LINUX.X64_250408
ORACLE_HOME:    /u01/app/oracle/product/19.0.0/dbhome_1
System name:    Linux
Node name:      ol9-19-dg1.localdomain
Release:        5.15.0-300.el9.x86_64
Version:        #1 SMP PREEMPT_DYNAMIC
Machine:        x86_64
Instance name: cdb1
Redo thread mounted by this instance: 1
Oracle process number: 59
Unix process pid: 12345, image: oracle@ol9-19-dg1.localdomain (TNS V1-V3)


*** 2026-10-22T13:14:15.123456+02:00 (PDB1(3))
*** SESSION ID:(254.49185) 2026-10-22T13:14:15.123456+02:00
*** CLIENT ID:() 2026-10-22T13:14:15.123456+02:00
*** SERVICE NAME:(pdb1) 2026-10-22T13:14:15.123456+02:00
*** MODULE NAME:(SQL*Plus) 2026-10-22T13:14:15.123456+02:00
*** ACTION NAME:(act (one)) 2026-10-22T13:14:15.123456+02:00
*** CLIENT DRIVER:(SQL*PLUS) 2026-10-22T13:14:15.123456+02:00
*** CONTAINER ID:(3) 2026-10-22T13:14:15.123456+02:00
 
=====================
PARSING IN CURSOR #140169830640712 len=67 dep=0 uid=107 oct=3 lid=107 tim=1761131655123456 hv=3351120423 ad='7f8b1c0a0e68' sqlid='8nq4y2z3kvw27'
select /* WAIT #1: nam='fake' */ name
from mtk_cust
where id = :b1
END OF STMT
PARSE #140169830640712:c=3000,e=3175,p=0,cr=0,cu=0,mis=1,r=0,dep=0,og=1,plh=2102008689,tim=1761131655123500
BINDS #140169830640712:
 Bind#0
  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0
  kxsbbbfp=7f8b1c0a0e68  bln=22  avl=02  flg=05
  value=1
 Bind#1
  oacdty=01 mxl=32(05) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000010 frm=01 csi=873 siz=32 off=24
  kxsbbbfp=7f8b1c0a0e80  bln=32  avl=11  flg=01
  value="first
second"
 Bind#2
  No oacdef for this bind.
 Bind#3
  oacdty=180 mxl=11(11) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=16 off=0
  kxsbbbfp=7f8b1c0a0ea0  bln=11  avl=07  flg=01
  value=
Dump of memory from 0x00007F8B1C0A0EA0 to 0x00007F8B1C0A0EA7
7F8B1C0A0EA0 0E7E7C1A 00000A0B                    [.~|.....]
 Bind#4
  oacdty=01 mxl=32(00) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000010 frm=01 csi=873 siz=32 off=24
  kxsbbbfp=7f8b1c0a0e80  bln=32  avl=00  flg=01
EXEC #140169830640712:c=0,e=807,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=2102008689,tim=1761131655124500
WAIT #140169830640712: nam='db file sequential read' ela= 213 file#=4 block#=1779172 blocks=1 obj#=114178 tim=1761131655124900
WAIT #140169830640712: nam='SQL*Net message from client' ela= 1234 driver id=1650815232 #bytes=1 p3=0 obj#=-1 tim=1761131655126000
WAIT #0: nam='log file sync' ela= 4499 buffer#=2423 sync scn=12345678 p3=0 obj#=-1 tim=1761131655127000
FETCH #140169830640712:c=0,e=2195,p=1,cr=51,cu=0,mis=0,r=1,dep=0,og=1,plh=2102008689,tim=1761131655128000
STAT #140169830640712 id=1 cnt=1 pid=0 pos=1 obj=0 op='SORT AGGREGATE  (cr=51 pr=1 pw=0 str=1 time=2170 us)'
STAT #140169830640712 id=2 cnt=1 pid=1 pos=1 obj=73512 op='TABLE ACCESS BY INDEX ROWID BATCHED MTK_CUST (cr=51 pr=1 pw=0 str=1 time=2100 us cost=3 size=25 card=1)'
CLOSE #140169830640712:c=0,e=6,dep=0,type=1,tim=1761131655129000
XCTEND rlbk=0, rd_only=0, tim=1761131655130000
PARSE ERROR #140169830640713:len=27 dep=0 uid=107 oct=3 lid=107 tim=1761131655131000 err=942
select * from no_such_table
ERROR #140169830640714:err=1722 tim=1761131655132000
LOBREAD: type=PERSISTENT LOB,bytes=4000,c=1000,e=2915,p=8,cr=5,cu=0,tim=1761131655133000
LOBGETLEN: c=0,e=14,p=0,cr=0,cu=0,tim=1761131655134000
Received ORADEBUG command (#1) 'close_trace' from process '4242'
*** DUMP FILE SIZE IS LIMITED TO 307200 BYTES ***
*** TRACE DUMP CONTINUES IN FILE /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_12345_mtk_1.trc ***
`

func parseSample(t *testing.T, s string) (*recorder, Stats) {
	t.Helper()
	r := &recorder{}
	st, err := Parse(strings.NewReader(s), r)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return r, st
}

func TestHeaderAndMarkers(t *testing.T) {
	r, st := parseSample(t, sample)
	if st.Lines != strings.Count(sample, "\n") {
		t.Errorf("lines: got %d want %d", st.Lines, strings.Count(sample, "\n"))
	}
	hk := map[string]string{}
	for _, h := range r.headers {
		hk[h.Key] = h.Value
	}
	if hk["Trace file"] != "/u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_12345_mtk.trc" {
		t.Errorf("trace file header: %q", hk["Trace file"])
	}
	if hk["Oracle Version"] != "19.27.0.0.0" || hk["Instance name"] != "cdb1" || hk["Node name"] != "ol9-19-dg1.localdomain" {
		t.Errorf("headers: %+v", hk)
	}
	if !strings.HasPrefix(hk["Unix process pid"], "12345, image:") {
		t.Errorf("pid header: %q", hk["Unix process pid"])
	}

	if len(r.markers) != 10 {
		t.Fatalf("markers: got %d", len(r.markers))
	}
	m0 := r.markers[0]
	if m0.Kind != MarkerTimestamp || !m0.HasTime || m0.Container != "PDB1(3)" {
		t.Errorf("timestamp marker: %+v", m0)
	}
	want := time.Date(2026, 10, 22, 13, 14, 15, 123456000, time.FixedZone("", 2*3600))
	if !m0.Time.Equal(want) {
		t.Errorf("time: got %v want %v", m0.Time, want)
	}
	if m := r.markers[1]; m.Kind != MarkerSessionID || m.Value != "254.49185" || !m.HasTime {
		t.Errorf("session marker: %+v", m)
	}
	if m := r.markers[2]; m.Kind != MarkerClientID || m.Value != "" {
		t.Errorf("client id marker: %+v", m)
	}
	if m := r.markers[5]; m.Kind != MarkerActionName || m.Value != "act (one)" {
		t.Errorf("action marker: %+v", m)
	}
	if m := r.markers[7]; m.Kind != MarkerContainerID || m.Value != "3" {
		t.Errorf("container marker: %+v", m)
	}
	if m := r.markers[8]; m.Kind != MarkerDumpSizeLimit || m.Value != "307200" {
		t.Errorf("dump size marker: %+v", m)
	}
	if m := r.markers[9]; m.Kind != MarkerTraceContinuesIn || !strings.HasSuffix(m.Value, "cdb1_ora_12345_mtk_1.trc") {
		t.Errorf("continues marker: %+v", m)
	}
}

func TestCursorAndCalls(t *testing.T) {
	r, _ := parseSample(t, sample)
	if len(r.cursors) != 1 {
		t.Fatalf("cursors: %d", len(r.cursors))
	}
	c := r.cursors[0]
	if c.Cursor != 140169830640712 || c.Len != 67 || c.Dep != 0 || c.UID != 107 || c.OCT != 3 || c.HV != 3351120423 || c.SQLID != "8nq4y2z3kvw27" || c.Addr != "7f8b1c0a0e68" {
		t.Errorf("cursor header: %+v", c)
	}
	wantText := "select /* WAIT #1: nam='fake' */ name\nfrom mtk_cust\nwhere id = :b1"
	if c.Text != wantText {
		t.Errorf("sql text: %q", c.Text)
	}
	if len(r.seps) != 1 {
		t.Errorf("separators: %d", len(r.seps))
	}

	kinds := []CallKind{CallParse, CallExec, CallFetch, CallClose, CallLobRead, CallLobGetLen}
	if len(r.calls) != len(kinds) {
		t.Fatalf("calls: got %d want %d: %+v", len(r.calls), len(kinds), r.calls)
	}
	for i, k := range kinds {
		if r.calls[i].Kind != k {
			t.Errorf("call %d: kind %v want %v", i, r.calls[i].Kind, k)
		}
	}
	p := r.calls[0]
	if p.C != 3000 || p.E != 3175 || p.Mis != 1 || p.OG != 1 || p.PLH != 2102008689 || p.Tim != 1761131655123500 {
		t.Errorf("parse call: %+v", p)
	}
	f := r.calls[2]
	if f.P != 1 || f.CR != 51 || f.R != 1 {
		t.Errorf("fetch call: %+v", f)
	}
	if cl := r.calls[3]; cl.Type != 1 || cl.E != 6 {
		t.Errorf("close call: %+v", cl)
	}
	if l := r.calls[4]; l.Op != "LOBREAD" || l.LobType != "PERSISTENT LOB" || l.Bytes != 4000 || l.C != 1000 || l.P != 8 || l.Cursor != 0 {
		t.Errorf("lobread: %+v", l)
	}
}

func TestWaits(t *testing.T) {
	r, _ := parseSample(t, sample)
	if len(r.waits) != 3 {
		t.Fatalf("waits: %d", len(r.waits))
	}
	w := r.waits[0]
	if w.Name != "db file sequential read" || w.Ela != 213 || w.NParams != 3 || w.ObjID != 114178 || !w.HasObj || w.Tim != 1761131655124900 {
		t.Errorf("wait 0: %+v", w)
	}
	if w.Params[0].Name != "file#" || w.Params[0].Value != 4 || w.Params[1].Name != "block#" || w.Params[1].Value != 1779172 || w.Params[2].Name != "blocks" {
		t.Errorf("wait 0 params: %+v", w.Params)
	}
	w = r.waits[1]
	if w.Params[0].Name != "driver id" || w.Params[0].Value != 1650815232 || w.Params[1].Name != "#bytes" || w.ObjID != -1 {
		t.Errorf("wait 1: %+v", w)
	}
	w = r.waits[2]
	if w.Cursor != 0 || w.Name != "log file sync" || w.Params[1].Name != "sync scn" || w.Params[1].Value != 12345678 {
		t.Errorf("wait 2: %+v", w)
	}
}

func TestStats(t *testing.T) {
	r, _ := parseSample(t, sample)
	if len(r.stats) != 2 {
		t.Fatalf("stats: %d", len(r.stats))
	}
	s := r.stats[0]
	if s.ID != 1 || s.Cnt != 1 || s.ParentID != 0 || s.Pos != 1 || s.Obj != 0 || s.Op != "SORT AGGREGATE" || !s.HasStats || s.CR != 51 || s.PR != 1 || s.TimeUs != 2170 || s.Str != 1 || s.Cost != -1 {
		t.Errorf("stat 0: %+v", s)
	}
	s = r.stats[1]
	if s.Op != "TABLE ACCESS BY INDEX ROWID BATCHED MTK_CUST" || s.Obj != 73512 || s.Cost != 3 || s.Size != 25 || s.Card != 1 {
		t.Errorf("stat 1: %+v", s)
	}
}

func TestBinds(t *testing.T) {
	r, _ := parseSample(t, sample)
	if len(r.binds) != 1 {
		t.Fatalf("bind sets: %d", len(r.binds))
	}
	bs := r.binds[0]
	if bs.Cursor != 140169830640712 || len(bs.Binds) != 5 {
		t.Fatalf("bind set: %+v", bs)
	}
	b := bs.Binds[0]
	if b.Pos != 0 || b.Dty != 2 || b.Mxl != 22 || b.MxlP != 22 || b.Mxlc != 0 || b.Oacflg != "03" || b.Fl2 != "1000000" || b.Siz != 24 || b.Bln != 22 || b.Avl != 2 || b.Flg != 5 || b.Value != "1" || !b.HasValue {
		t.Errorf("bind 0: %+v", b)
	}
	b = bs.Binds[1]
	if b.Dty != 1 || b.Mxl != 32 || b.MxlP != 5 || b.Csi != 873 || b.Frm != 1 || b.Value != "\"first\nsecond\"" {
		t.Errorf("bind 1: %+v", b)
	}
	if b = bs.Binds[2]; !b.NoOacdef || b.HasValue {
		t.Errorf("bind 2: %+v", b)
	}
	b = bs.Binds[3]
	if b.Dty != 180 || !b.IsDump || !strings.Contains(b.Value, "7F8B1C0A0EA0 0E7E7C1A") {
		t.Errorf("bind 3: %+v", b)
	}
	if b = bs.Binds[4]; b.HasValue || b.Avl != 0 {
		t.Errorf("bind 4 (null): %+v", b)
	}
}

func TestErrorsXctendLobUnknown(t *testing.T) {
	r, st := parseSample(t, sample)
	if len(r.xctends) != 1 || r.xctends[0].Rlbk != 0 || r.xctends[0].RdOnly != 0 || r.xctends[0].Tim != 1761131655130000 {
		t.Errorf("xctend: %+v", r.xctends)
	}
	if len(r.perrs) != 1 {
		t.Fatalf("parse errors: %+v", r.perrs)
	}
	pe := r.perrs[0]
	if pe.Cursor != 140169830640713 || pe.Len != 27 || pe.Err != 942 || pe.Text != "select * from no_such_table" {
		t.Errorf("parse error: %+v", pe)
	}
	if len(r.errors) != 1 || r.errors[0].Err != 1722 || r.errors[0].Cursor != 140169830640714 {
		t.Errorf("errors: %+v", r.errors)
	}
	if len(r.unknown) != 1 || !strings.HasPrefix(r.unknown[0], "Received ORADEBUG") {
		t.Errorf("unknown: %+v", r.unknown)
	}
	if st.Unknown != 1 || st.Count(KindWait) != 3 || st.Count(KindCall) != 4 || st.Count(KindLob) != 2 {
		t.Errorf("stats: %+v", st)
	}
}

func TestCRLFAndOldTimestamp(t *testing.T) {
	s := "Trace file x.trc\r\n*** 2016-03-01 10:20:30.123\r\n=====================\r\nPARSING IN CURSOR #5 len=8 dep=1 uid=0 oct=3 lid=0 tim=1 hv=2 ad='3' sqlid='abc'\r\nselect 1\r\nEND OF STMT\r\nEXEC #5:c=0,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=1,og=4,plh=0,tim=2\r\n"
	r, _ := parseSample(t, s)
	if len(r.markers) != 1 || !r.markers[0].HasTime || r.markers[0].Time.Year() != 2016 {
		t.Errorf("old timestamp: %+v", r.markers)
	}
	if len(r.cursors) != 1 || r.cursors[0].Text != "select 1" {
		t.Errorf("cursor: %+v", r.cursors)
	}
	if len(r.calls) != 1 || r.calls[0].Dep != 1 || r.calls[0].OG != 4 {
		t.Errorf("calls: %+v", r.calls)
	}
}

func TestParseErrorTerminatedByTraceLine(t *testing.T) {
	// len claims more bytes than the text has (e.g. trailing newline counted)
	s := "PARSE ERROR #1:len=100 dep=0 uid=1 oct=3 lid=1 tim=5 err=942\nselect * from nope\nWAIT #1: nam='SQL*Net break/reset to client' ela= 3 driver id=1 break?=0 p3=0 obj#=-1 tim=6\n"
	r, _ := parseSample(t, s)
	if len(r.perrs) != 1 || r.perrs[0].Text != "select * from nope" {
		t.Errorf("perr: %+v", r.perrs)
	}
	if len(r.waits) != 1 || r.waits[0].Name != "SQL*Net break/reset to client" || r.waits[0].Params[1].Name != "break?" {
		t.Errorf("wait after perr: %+v", r.waits)
	}
}

func TestVeryLongLine(t *testing.T) {
	long := strings.Repeat("x", 3<<20)
	s := "PARSING IN CURSOR #1 len=10 dep=0 uid=1 oct=3 lid=1 tim=5 hv=1 ad='a' sqlid='b'\nselect '" + long + "' from dual\nEND OF STMT\n"
	r, st := parseSample(t, s)
	if len(r.cursors) != 1 || len(r.cursors[0].Text) != len(long)+len("select '' from dual") {
		t.Errorf("long line not preserved: %d", len(r.cursors[0].Text))
	}
	if st.MaxLine < 3<<20 {
		t.Errorf("maxline: %d", st.MaxLine)
	}
}

func BenchmarkWaitLine(b *testing.B) {
	line := []byte("#140169830640712: nam='db file sequential read' ela= 213 file#=4 block#=1779172 blocks=1 obj#=114178 tim=1761131655124900")
	p := New(NopHandler{})
	b.SetBytes(int64(len(line)))
	for i := 0; i < b.N; i++ {
		p.wait(line)
	}
}

func BenchmarkCallLine(b *testing.B) {
	line := []byte("#140169830640712:c=0,e=807,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=2102008689,tim=1761131655124500")
	p := New(NopHandler{})
	b.SetBytes(int64(len(line)))
	for i := 0; i < b.N; i++ {
		p.call(CallExec, line)
	}
}

func TestEndOfStmtInsideText(t *testing.T) {
	text := "begin\n  dbms_output.put_line('PARSING IN CURSOR #1 len=5 dep=0\nEND OF STMT\nWAIT #1: nam=''x'' ela= 1');\nend;"
	s := "PARSING IN CURSOR #7 len=" + itoa(len(text)+1) + " dep=0 uid=1 oct=47 lid=1 tim=5 hv=1 ad='a' sqlid='b'\n" + text + "\nEND OF STMT\nPARSE #7:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=6\n"
	r, st := parseSample(t, s)
	if len(r.cursors) != 1 || r.cursors[0].Text != text {
		t.Fatalf("cursor text: %+v", r.cursors)
	}
	if len(r.calls) != 1 || st.Unknown != 0 {
		t.Errorf("calls=%d unknown=%d", len(r.calls), st.Unknown)
	}
}

func TestParseErrorTrailingSpace(t *testing.T) {
	// len= is one byte short of the printed text (trailing space)
	s := "PARSE ERROR #1:len=24 dep=0 uid=1 oct=3 lid=1 tim=5 err=936\nselect id, from mtk_cust \nWAIT #1: nam='SQL*Net break/reset to client' ela= 1 driver id=1 break?=1 p3=0 obj#=-1 tim=6\nPARSE ERROR #2:len=31 dep=0 uid=1 oct=3 lid=1 tim=7 err=942\nselect * from mtk_no_such_table\nWAIT #2: nam='SQL*Net break/reset to client' ela= 1 driver id=1 break?=1 p3=0 obj#=-1 tim=8\n"
	r, _ := parseSample(t, s)
	if len(r.perrs) != 2 || r.perrs[0].Text != "select id, from mtk_cust " || r.perrs[1].Text != "select * from mtk_no_such_table" {
		t.Errorf("perrs: %+v", r.perrs)
	}
	if len(r.waits) != 2 {
		t.Errorf("waits: %+v", r.waits)
	}
}

func TestBindDumpsAndTruncation(t *testing.T) {
	s := `BINDS #5:

 Bind#0
  oacdty=180 mxl=11(11) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1400000 frm=00 csi=00 siz=32 off=0
  kxsbbbfp=7f713ee967a0  bln=11  avl=11  flg=05
  value=
Dumping '' addr=0x7f713ee967a0 size=11 bytes
Dump of memory from 0x7f713ee967a0 to 0x7f713ee967ac
7F713EE967A0 03000080 AF424140 00402F07           [....@AB../@.]
 Bind#1
  oacdty=01 mxl=2000(1500) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000010 frm=01 csi=873 siz=2000 off=0
  kxsbbbfp=7f713eea0208  bln=2000  avl=1500  flg=05
  value="Long text, ong text, ong "...
 Bind#2
  oacdty=123 mxl=656(656) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=656 off=0
  kxsbbbfp=7f713eea0a00  bln=656  avl=16  flg=05
  value=
toid ptr value=61F11290 length=16
86B64B66F23D012EE053F706E80A06
 Bind#3
  oacdty=183 mxl=11(11) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1400000 frm=00 csi=00 siz=32 off=0
  kxsbbbfp=7f713ee967b0  bln=11  avl=11  flg=05
  value=Unhandled datatype (-73) found in kxsbndinf
EXEC #5:c=0,e=147,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=0,tim=10804210460
`
	r, st := parseSample(t, s)
	if len(r.binds) != 1 || len(r.binds[0].Binds) != 4 || st.Unknown != 0 {
		t.Fatalf("binds: %+v unknown=%d", r.binds, st.Unknown)
	}
	b := r.binds[0].Binds
	if !b[0].IsDump || !strings.Contains(b[0].Value, "7F713EE967A0 03000080") || !strings.HasPrefix(b[0].Value, "\nDumping") && !strings.HasPrefix(b[0].Value, "Dumping") {
		t.Errorf("bind 0: %+v", b[0])
	}
	if !b[1].Truncated || b[1].Value != "\"Long text, ong text, ong \"..." {
		t.Errorf("bind 1: %+v", b[1])
	}
	if !b[2].IsDump || !strings.Contains(b[2].Value, "86B64B66F23D012EE053F706E80A06") {
		t.Errorf("bind 2: %+v", b[2])
	}
	if b[3].Value != "Unhandled datatype (-73) found in kxsbndinf" {
		t.Errorf("bind 3: %+v", b[3])
	}
	if len(r.calls) != 1 {
		t.Errorf("calls: %+v", r.calls)
	}
}

func TestTrcsessProcessMarker(t *testing.T) {
	r, _ := parseSample(t, "*** [ Unix process pid: 133531 ]\n*** 2026-10-22T11:35:39.957522+00:00\n")
	if len(r.markers) != 2 || r.markers[0].Kind != MarkerProcess || r.markers[0].Value != "133531" || r.markers[0].Key != "Unix process pid" {
		t.Errorf("markers: %+v", r.markers)
	}
}

// 23ai: trcsess copies the multi-line 23ai pid header without brackets.
func TestTrcsessProcessMarker23ai(t *testing.T) {
	r, st := parseSample(t, "*** Unix process pid:       2013\n*** CLIENT IP:(127.0.0.1) 2026-10-24T10:36:00.136145+00:00\n*** CONNECTION ID:(XpSprEWLB9HgYwIAEayK9g==) 2026-10-24T10:36:00.136152+00:00\n")
	if len(r.markers) != 3 || st.Unknown != 0 {
		t.Fatalf("markers: %+v unknown=%d", r.markers, st.Unknown)
	}
	if m := r.markers[0]; m.Kind != MarkerProcess || m.Value != "2013" || m.Key != "Unix process pid" {
		t.Errorf("process: %+v", m)
	}
	if m := r.markers[1]; m.Kind != MarkerClientIP || m.Value != "127.0.0.1" || !m.HasTime {
		t.Errorf("client ip: %+v", m)
	}
	if m := r.markers[2]; m.Kind != MarkerConnectionID || m.Value != "XpSprEWLB9HgYwIAEayK9g==" {
		t.Errorf("connection id: %+v", m)
	}
}

// 23ai prints the unprintable-datatype value line with one leading space (not two)
// and the memory dump rows with extra padding; the following binds must still parse.
func TestBindUnhandledOneSpace23ai(t *testing.T) {
	const s = `BINDS #5:

 Bind#0
  oacdty=183 mxl=11(11) mxlc=00 mal=00 scl=06 pre=02
  oacflg=01 fl2=9206001 frm=02 csi=06 siz=0 off=72
  kxsbbbfp=759c1013dd48  bln=11  avl=11  flg=01
 value=Unhandled datatype (-73) found in kxsbndinf
Dumping '' addr=0x759c1013dd48 size=11 bytes
Dump of memory from 0x759c1013dd48 to 0x759c1013dd54
759C1013DD40                   03000080 AF424140          [....@AB.]
759C1013DD50 00402F07                             [./@.]            
 Bind#1
  oacdty=02 mxl=22(21) mxlc=00 mal=00 scl=00 pre=00
  oacflg=13 fl2=206001 frm=00 csi=00 siz=0 off=128
  kxsbbbfp=759c1013dd80  bln=22  avl=02  flg=01
  value=8
EXEC #5:c=0,e=147,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=0,tim=10804210460
`
	r, st := parseSample(t, s)
	if st.Unknown != 0 || len(r.binds) != 1 || len(r.binds[0].Binds) != 2 {
		t.Fatalf("binds: %+v unknown=%d (%v)", r.binds, st.Unknown, r.unknown)
	}
	b := r.binds[0].Binds
	if !strings.HasPrefix(b[0].Value, "Unhandled datatype (-73)") || !b[0].IsDump || !strings.Contains(b[0].Value, "00402F07") {
		t.Errorf("bind 0: %+v", b[0])
	}
	if b[1].Value != "8" {
		t.Errorf("bind 1: %+v", b[1])
	}
}

// 23ai renamed the banner ("Oracle AI Database 26ai Free Release 23.26.3.0.0 ...").
func TestBanner23ai(t *testing.T) {
	r, _ := parseSample(t, "Trace file /x.trc\nOracle AI Database 26ai Free Release 23.26.3.0.0 - Develop, Learn, and Run for Free\nVersion 23.26.3.0.0\n")
	if len(r.headers) != 3 || r.headers[1].Key != "Oracle Database" || r.headers[2].Value != "23.26.3.0.0" {
		t.Errorf("headers: %+v", r.headers)
	}
}

func itoa(n int) string { return fmt.Sprint(n) }

// A wall-clock marker can land inside a BINDS block; it must not end it.
func TestMarkerInsideBinds(t *testing.T) {
	const s = `PARSING IN CURSOR #5 len=6 dep=0 uid=1 oct=3 lid=1 tim=1 hv=1 ad='0' sqlid='a'
select
END OF STMT
BINDS #5:
*** 2026-10-22T11:39:57.866870+00:00 (PDB1(3))
 Bind#0
  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0
  kxsbbbfp=7f8b1c0a0e68  bln=22  avl=02  flg=05
  value=1
 Bind#1
*** 2026-10-22T11:39:58.000000+00:00 (PDB1(3))
  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0
  kxsbbbfp=7f8b1c0a0e80  bln=22  avl=02  flg=05
  value=2
EXEC #5:c=0,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=5
`
	r, _ := parseSample(t, s)
	if len(r.unknown) != 0 {
		t.Errorf("unknown lines: %q", r.unknown)
	}
	if len(r.markers) != 2 {
		t.Errorf("markers: %d", len(r.markers))
	}
	if len(r.binds) != 1 || len(r.binds[0].Binds) != 2 {
		t.Fatalf("bind sets: %+v", r.binds)
	}
	for i, b := range r.binds[0].Binds {
		if want := fmt.Sprint(i + 1); b.Value != want || !b.HasValue || b.Dty != 2 {
			t.Errorf("bind %d: %+v", i, b)
		}
	}
	if len(r.calls) != 1 {
		t.Errorf("calls: %d", len(r.calls))
	}
}

func TestBigLoopNoUnknown(t *testing.T) {
	f, err := os.Open("../../testdata/big/big_loop.trc")
	if err != nil {
		t.Skip("big_loop.trc not present")
	}
	defer f.Close()
	r := &recorder{}
	if _, err := Parse(f, r); err != nil {
		t.Fatal(err)
	}
	if len(r.unknown) != 0 {
		t.Errorf("%d unknown lines, first: %q", len(r.unknown), r.unknown[0])
	}
}
