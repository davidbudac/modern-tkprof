package trace

import (
	"bytes"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// lines of the diagnostic dumps of the 19.27 lab (docs/trace-format-diag.md)
var (
	sRule     = strings.Repeat("*", 54)
	sEq       = strings.Repeat("=", 51)
	sEq79     = strings.Repeat("=", 79)
	sEq28     = strings.Repeat("=", 28)
	sHeap     = `HEAP DUMP heap name="pga heap"  desc=0x7f952ce9a220`
	sHeap2    = `HEAP DUMP heap name="top call heap"  desc=0x7f952ce9cb40`
	sDiag     = "dbkedDefDump(): Starting a non-incident diagnostic dump (flags=0x0, level=1, mask=0x0)"
	sProc     = "PROCESS STATE"
	sProcEnd  = "END OF PROCESS STATE"
	sSys      = "SYSTEM STATE (level=10, with short stacks)"
	sSysEnd   = "END OF SYSTEM STATE"
	sHang     = "HANG ANALYSIS:"
	sHangEnd  = "END OF HANG ANALYSIS"
	sHangDump = "HANG ANALYSIS DUMPS:"
	sHangDEnd = "HANG ANALYSIS DUMPS: END"
	sDead     = "DEADLOCK DETECTED ( ORA-00060 )"
	sTop10    = "TOP 10 MEMORY USES FOR THIS PROCESS"
	sPGABegin = "Begin PGA memory detail dump"
	sPGAEnd   = "End PGA memory detail dump"
	sTOC      = "[TOC00000]"
	sCont     = "*** TRACE CONTINUES IN FILE /u01/trace/cdb1_ora_1_2.trc ***"
)

// showSections renders sections as "heap 3-9 cut" for comparisons.
func showSections(ss []Section) []string {
	out := []string{}
	for _, s := range ss {
		c := ""
		if s.Cut {
			c = " cut"
		}
		out = append(out, fmt.Sprintf("%s %d-%d%s", s.Kind, s.First, s.Last, c))
	}
	return out
}

func wantSecs(t *testing.T, name string, st Stats, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := showSections(st.Sections); !reflect.DeepEqual(got, want) {
		t.Errorf("%s: sections %v, want %v", name, got, want)
	}
}

func TestSectionStartLines(t *testing.T) {
	for _, c := range []struct {
		line string
		kind SectionKind
	}{
		{sHeap, SectionHeap},
		{`HEAP DUMP heap name="sql area"  desc=A728CAF4`, SectionHeap}, // 10.2
		{sProc, SectionProcState},
		{sProc + " ", SectionProcState},
		{sSys, SectionSysState},
		{"SYSTEM STATE (level=1)", SectionSysState},
		{sHang, SectionHang},
		{sDead, SectionDeadlock},
		{"DEADLOCK DETECTED", SectionDeadlock}, // 10.2
		{sTop10, SectionPGASummary},
		{sPGABegin, SectionPGADetail},
		{sDiag, SectionDiagDump},
		{"dbkedDefDump(): Starting incident default dumps (flags=0x2, level=3, mask=0x0)", SectionDiagDump},
		{sTOC, SectionIncident},
	} {
		if k, ok := IsSectionStart([]byte(c.line)); !ok || k != c.kind {
			t.Errorf("%q: %v %v, want %s", c.line, k, ok, c.kind)
		}
	}
	for _, line := range []string{
		"", "*** 2026-11-10T20:45:33.749920+00:00 (PDB1(3))", sRule, sEq, "HEAP DUMP", `HEAP DUMP heap name=pga`, "HEAP DUMP heap name=",
		"PROCESS STATE (2)", " PROCESS STATE", "process state", "----- Process State Dump (2)-----", "END OF PROCESS STATE",
		"SYSTEM STATE", "END OF SYSTEM STATE", "HANG ANALYSIS DUMPS:", "END OF HANG ANALYSIS", "DEADLOCK DETECTED BY", "DEADLOCKS",
		"TOP 10 MEMORY USES", "End PGA memory detail dump", "dbkedDefDump()+2434  call     ksedst()", "dbkedDefDump(): Ending",
		"[TOC00001]", "[TOC00000]-END", "Registered qb: SEL$1 0xe8eab888 (PARSER)", "PARSING IN CURSOR #1 len=1", "SESSION ID",
	} {
		if k, ok := IsSectionStart([]byte(line)); ok {
			t.Errorf("%q is a section start (%s)", line, k)
		}
	}
	if got := SectionKinds(); len(got) != 9 {
		t.Errorf("%d kinds", len(got))
	}
	for _, k := range SectionKinds() {
		if ParseSectionKind(k.String()) != k {
			t.Errorf("%s does not round trip", k)
		}
	}
	if ParseSectionKind("none") != SectionNone || ParseSectionKind("x") != SectionNone {
		t.Error("a name that is not a kind")
	}
	for k, want := range map[SectionKind]string{SectionHeap: "heap", SectionPGASummary: "pga-summary", SectionPGADetail: "pga-detail",
		SectionDiagDump: "diagdump", SectionProcState: "procstate", SectionSysState: "sysstate", SectionHang: "hang", SectionDeadlock: "deadlock", SectionIncident: "incident"} {
		if k.String() != want {
			t.Errorf("%d is %q, want %q", k, k.String(), want)
		}
	}
	if KindDiag.String() != "diagnostic" {
		t.Errorf("kind name %q", KindDiag.String())
	}
}

// A section absorbs the starts of other sections; markers and blank lines
// inside it keep their kind and do not end it; Last is the last line it holds.
func TestSectionAbsorbsStartsAndKeepsMarkers(t *testing.T) {
	lines := []string{dMarker, sDiag, "----- Error Stack Dump -----", sRule, sHeap, "Total heap size    =  4707160", sRule,
		sEq, sProc, " Bind#0", "  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00", "Dump of memory from 0x7ffc to 0x7ffd", dMarker, "", sProcEnd, "tail", "", dMarker}
	k, st, _ := kindsOf(t, lines...)
	wantKinds(t, "diagdump", k, KindMarker, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag,
		KindMarker, KindBlank, KindDiag, KindDiag, KindBlank, KindMarker)
	wantSecs(t, "diagdump", st, "diagdump 2-16")
	if st.Unknown != 0 || st.Kinds[KindBindLine] != 0 || st.Kinds[KindSeparator] != 0 {
		t.Errorf("unknown %d, bind lines %d, separators %d", st.Unknown, st.Kinds[KindBindLine], st.Kinds[KindSeparator])
	}
	if st.FileKind() != FileKindDiag {
		t.Errorf("file kind %s", st.FileKind())
	}
}

// A line of a primary format ends a section and keeps its kind: a record, the
// 10046 separator (exactly 21 "="); not a "=" rule, a marker or a blank line.
func TestSectionEndsAtPrimaryFormat(t *testing.T) {
	// a no-end kind stops at the last line it holds, not at the blank lines and markers after it
	k, st, rec := kindsOf(t, sDiag, "a", "", dMarker, dSep, dPIC, dText, "END OF STMT", dExec)
	wantKinds(t, "separator", k, KindDiag, KindDiag, KindBlank, KindMarker, KindSeparator, KindParsingInCursor, KindSQLText, KindEndOfStmt, KindCall)
	wantSecs(t, "separator", st, "diagdump 1-2")
	if len(rec.cursors) != 1 || len(rec.calls) != 1 || st.FileKind() != FileKind10046 {
		t.Errorf("cursors %d calls %d kind %s", len(rec.cursors), len(rec.calls), st.FileKind())
	}
	// a record without the separator before it
	_, st, _ = kindsOf(t, sProc, "x", sExecLine)
	wantSecs(t, "record", st, "procstate 1-2 cut")
	// every record kind ends a section (what isRecordKind accepts)
	for _, rl := range []string{dPIC, "PARSE ERROR #1:len=5 dep=0 uid=1 oct=3 lid=1 tim=1 err=942", dParse, dExec, "FETCH #1:c=0,e=0,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1",
		"WAIT #1: nam='db file sequential read' ela= 5 file#=1 block#=2 blocks=1 obj#=3 tim=1", "STAT #1 id=1 cnt=1 pid=0 pos=1 obj=1 op='SORT'", dBinds,
		"XCTEND rlbk=0, rd_only=1, tim=1", "ERROR #1:err=1 tim=1", "LOBREAD: type=1,bytes=1,c=0,e=0,p=0,cr=0,cu=0,tim=1", "RPC CALL: x"} {
		_, st, _ := kindsOf(t, sDiag, "a", "b", rl)
		wantSecs(t, rl[:min(12, len(rl))], st, "diagdump 1-3")
	}
	// an end-kind that was not at its end is cut by a record or by the separator
	_, st, _ = kindsOf(t, sHeap, "x", sExecLine)
	wantSecs(t, "heap body", st, "heap 1-2 cut")
	_, st, _ = kindsOf(t, sSys, "x", dSep, dPIC, dText, "END OF STMT")
	wantSecs(t, "sysstate and the separator", st, "sysstate 1-2 cut")
	// after its rule a heap is complete: the record does not cut it
	_, st, _ = kindsOf(t, sHeap, "x", sRule, sExecLine)
	wantSecs(t, "heap tail", st, "heap 1-3")
	// the "=" rules of a dump are not the separator; nor is a banner of another length
	k, st, _ = kindsOf(t, sDiag, sEq, "====================", "======================", "===== Redo Transport Dump (RFS)")
	wantKinds(t, "rules", k, KindDiag, KindDiag, KindDiag, KindDiag, KindDiag)
	wantSecs(t, "rules", st, "diagdump 1-5")
}

const sExecLine = "EXEC #139994073020960:c=1090,e=1071,p=0,cr=0,cu=0,mis=1,r=1,dep=1,og=4,plh=1347681019,tim=6213149971"

func TestSectionCutAtContinuesIn(t *testing.T) {
	k, st, _ := kindsOf(t, sSys, "x", sCont, "")
	wantKinds(t, "continues", k, KindDiag, KindDiag, KindMarker, KindBlank)
	wantSecs(t, "continues", st, "sysstate 1-2 cut")
	_, st, _ = kindsOf(t, sDiag, "x", "", sCont)
	wantSecs(t, "no end line", st, "diagdump 1-2")
	// a complete section before the marker is not cut
	_, st, _ = kindsOf(t, sSys, sSysEnd, sCont)
	wantSecs(t, "complete", st, "sysstate 1-2")
	// the markers of an ordinary file never end a section
	_, st, _ = kindsOf(t, sSys, "*** TRACE CONTINUED FROM FILE /u01/trace/a.trc ***", dMarker, "x", sSysEnd)
	wantSecs(t, "continued from", st, "sysstate 1-5")
}

func TestSectionKindsOfEnds(t *testing.T) {
	// no end line: to the end of the input, whatever follows
	for _, c := range []struct {
		name  string
		start string
		kind  string
	}{{"diagdump", sDiag, "diagdump"}, {"pga-summary", sTop10, "pga-summary"}, {"deadlock", sDead, "deadlock"}, {"incident", sTOC, "incident"}} {
		_, st, _ := kindsOf(t, "head", c.start, "a", sEq, sProcEnd, sSysEnd, sHangEnd, sPGAEnd, sRule, "b")
		wantSecs(t, c.name, st, c.kind+" 2-10")
	}
	// process state: END OF PROCESS STATE; the lines after it are not its
	k, st, _ := kindsOf(t, sEq, sProc, "-------------", "x", sProcEnd, "later")
	wantKinds(t, "procstate", k, KindSeparator, KindDiag, KindDiag, KindDiag, KindDiag, KindUnknown)
	wantSecs(t, "procstate", st, "procstate 2-5")
	_, st, _ = kindsOf(t, sProc, "x") // the file ends first
	wantSecs(t, "procstate cut", st, "procstate 1-2 cut")
	// system state
	_, st, _ = kindsOf(t, "Short stack dump: ", sEq, sSys, "Dumping the Process Summary", sProc, sProcEnd, "x", sSysEnd, "Oradebug command 'x' console output: <none>")
	wantSecs(t, "sysstate", st, "sysstate 3-8")
	_, st, _ = kindsOf(t, sSys, "x")
	wantSecs(t, "sysstate cut", st, "sysstate 1-2 cut")
	// PGA detail: the rule after the End line belongs to the section, another line does not
	_, st, _ = kindsOf(t, sEq28, sPGABegin, sEq28, "x", sEq28, sPGAEnd, sEq28, "", dMarker, "later")
	wantSecs(t, "pga-detail", st, "pga-detail 2-7")
	_, st, _ = kindsOf(t, sPGABegin, "x", sPGAEnd, "")
	wantSecs(t, "pga-detail without its rule", st, "pga-detail 1-3")
	_, st, _ = kindsOf(t, sPGABegin, "x", sPGAEnd, dMarker, sEq28)
	wantSecs(t, "pga-detail, marker after End", st, "pga-detail 1-3")
	_, st, _ = kindsOf(t, sPGABegin, "x")
	wantSecs(t, "pga-detail cut", st, "pga-detail 1-2 cut")
}

func TestSectionHang(t *testing.T) {
	// the analysis alone: its end line and its rule; markers, blank lines and a further rule
	// before "later" are not looked past when no dumps block follows
	k, st, _ := kindsOf(t, sEq79, sHang, "  instances (db_name.oracle_sid): cdb1.cdb1", dMarker, sEq79, sHangEnd, sEq79, "", dMarker, sEq79, "later")
	wantSecs(t, "no dumps block", st, "hang 2-10")
	if k[10] != KindUnknown || k[9] != KindDiag {
		t.Errorf("kinds %v", k)
	}
	// with the dumps block (diag_hang.trc): to its END line and the rule after it
	_, st, _ = kindsOf(t, sEq79, sHang, "x", dMarker, sEq79, sHangEnd, sEq79, "", dMarker, sEq79, sHangDump, sEq79, " ", "State of LOCAL nodes",
		"[2]/1/3/37475/0xa272a008/12239/SINGLE_NODE/", sEq79, sHangDEnd, sEq79, "", dMarker, "Oradebug command 'hanganalyze 3' console output: ")
	wantSecs(t, "dumps block", st, "hang 2-18")
	// the dumps block is cut when the input ends in it
	_, st, _ = kindsOf(t, sHang, sHangEnd, sEq79, sHangDump, "x")
	wantSecs(t, "cut in the dumps block", st, "hang 1-5 cut")
	// the analysis is cut before its end line
	_, st, _ = kindsOf(t, sHang, "x")
	wantSecs(t, "cut before the end", st, "hang 1-2 cut")
	// another section may follow the analysis at once, with its rule
	_, st, _ = kindsOf(t, sHang, sHangEnd, sEq79, "", sEq, sSys, "x", sSysEnd)
	wantSecs(t, "followed by a system state", st, "hang 1-5", "sysstate 6-8")
}

// A heap run: one section per HEAP DUMP, adjacent; the rule right above a start belongs to the heap it
// leads; the lines that glue heaps together belong to the heap before.
func TestSectionHeapRun(t *testing.T) {
	lines := []string{
		sRule, sHeap, "Total heap size    =  4707160", sRule, // 1-4   heap 1 ends at its rule
		sRule, sHeap2, "x", sRule, "SUBHEAP 3: desc=0x7f", sRule, // 5-10  its lead rule, its rule, a glue line
		sHeap2, sRule, "No stack allocations", sRule, // 11-14 no rule above this start: the line before it is a rule that closed the heap before
		"Processing Oradebug command 'x'",
	}
	k, st, rec := kindsOf(t, lines...)
	for i := 0; i < 14; i++ {
		if k[i] != KindDiag {
			t.Errorf("line %d %q: %s", i+1, lines[i], k[i])
		}
	}
	if k[14] != KindUnknown {
		t.Errorf("line 15: %s", k[14])
	}
	wantSecs(t, "run", st, "heap 1-4", "heap 5-9", "heap 10-14")
	if st.Unknown != 1 || len(rec.unknown) != 1 {
		t.Errorf("unknown %d", st.Unknown)
	}
	// markers and blank lines between heaps do not end the run; another line does
	_, st, _ = kindsOf(t, sRule, sHeap, "x", sRule, sRule, "*** 2026-11-17T21:34:24.329469+00:00", " ", sRule, sHeap2, "y", sRule, "SUBHEAP x", "z")
	wantSecs(t, "with markers", st, "heap 1-5", "heap 8-11") // the rule claimed after the blank lines leads the next heap
	// the shared rule of a heap header without extents: it leads the next heap
	_, st, _ = kindsOf(t, sRule, sHeap, " pdb id=1", sRule, sHeap2, " pdb id=1")
	wantSecs(t, "shared rule", st, "heap 1-3", "heap 4-6 cut")
	// a heap body that reaches the end of the input is cut, one that reached its rule is not
	_, st, _ = kindsOf(t, sHeap, "x")
	wantSecs(t, "cut", st, "heap 1-2 cut")
	_, st, _ = kindsOf(t, sHeap, "x", sRule)
	wantSecs(t, "complete", st, "heap 1-3")
	// the first rule after the start ends the heap: a nested HEAP DUMP before it is part of the body
	_, st, _ = kindsOf(t, sHeap, sHeap2, "x", sRule)
	wantSecs(t, "nested start", st, "heap 1-4")
}

// A line of 54 "*" is a diagnostic line only when a heap dump follows it; otherwise it is the line it was
// before sections (unknown, or a prologue line), and the handler sees it in its place.
func TestSectionStrayRule(t *testing.T) {
	run := func(lines ...string) (Stats, *unkRec, []Kind) {
		r := &unkRec{}
		p := New(r)
		kinds := make([]Kind, len(lines))
		for i := range kinds {
			kinds[i] = Kind(255)
		}
		p.kindHook = func(n int, k Kind) {
			if kinds[n-1] != Kind(255) {
				t.Errorf("line %d counted twice", n)
			}
			kinds[n-1] = k
		}
		st, err := p.Run(strings.NewReader(strings.Join(lines, "\n") + "\n"))
		if err != nil {
			t.Fatal(err)
		}
		return st, r, kinds
	}
	// not followed by a heap dump
	st, r, k := run(dMarker, sRule, "text", sRule)
	wantKinds(t, "stray", k, KindMarker, KindUnknown, KindUnknown, KindUnknown)
	if !reflect.DeepEqual(r.unk, []int{2, 3, 4}) || st.Unknown != 3 || len(st.Sections) != 0 {
		t.Errorf("unknown lines %v (%d), sections %v", r.unk, st.Unknown, st.Sections)
	}
	if r.text[0] != sRule {
		t.Errorf("the handler got %q", r.text[0])
	}
	// two rules, then a heap dump: the first is stray, the second leads it
	st, r, k = run(dMarker, sRule, sRule, sHeap)
	wantKinds(t, "two rules", k, KindMarker, KindUnknown, KindDiag, KindDiag)
	wantSecs(t, "two rules", st, "heap 3-4 cut")
	if !reflect.DeepEqual(r.unk, []int{2}) {
		t.Errorf("unknown lines %v", r.unk)
	}
	// followed by a record, an optimizer dump, a section that is not a heap, the end of the input
	st, r, k = run(dMarker, sRule, dExec)
	wantKinds(t, "record", k, KindMarker, KindUnknown, KindCall)
	st, r, k = run(dMarker, sRule, dStart, dEnd)
	wantKinds(t, "optimizer", k, KindMarker, KindUnknown, KindOpt, KindOpt)
	st, r, k = run(dMarker, sRule, sProc, sProcEnd)
	wantKinds(t, "procstate", k, KindMarker, KindUnknown, KindDiag, KindDiag)
	wantSecs(t, "procstate", st, "procstate 3-4")
	st, r, k = run(dMarker, sRule)
	wantKinds(t, "end of input", k, KindMarker, KindUnknown)
	if !reflect.DeepEqual(r.unk, []int{2}) {
		t.Errorf("unknown lines %v", r.unk)
	}
	// in the prologue (before any marker) it is a header line, and a heap dump after it starts the section
	st, r, k = run("Trace file x.trc", sRule, "Version 19.27")
	wantKinds(t, "prologue", k, KindHeader, KindHeader, KindHeader)
	if !reflect.DeepEqual(r.hdr, []int{1, 2, 3}) || len(r.unk) != 0 {
		t.Errorf("header lines %v unknown %v", r.hdr, r.unk)
	}
	st, r, k = run("Trace file x.trc", sRule, sHeap, "x", sRule)
	wantKinds(t, "prologue heap", k, KindHeader, KindDiag, KindDiag, KindDiag, KindDiag)
	wantSecs(t, "prologue heap", st, "heap 2-5")
	// a 54-star line only in a section is a diagnostic line, whatever follows it
	st, r, k = run(sDiag, sRule, "x")
	wantKinds(t, "in a section", k, KindDiag, KindDiag, KindDiag)
	wantSecs(t, "in a section", st, "diagdump 1-3")
	// not 54 characters, or not only stars
	st, r, k = run(dMarker, strings.Repeat("*", 53), sRule+"*", "*** x ***", sHeap)
	wantKinds(t, "other rules", k, KindMarker, KindUnknown, KindUnknown, KindMarker, KindDiag)
}

type unkRec struct {
	NopHandler
	unk  []int
	text []string
	hdr  []int
}

func (r *unkRec) Unknown(n int, t []byte) {
	r.unk, r.text = append(r.unk, n), append(r.text, string(t))
}
func (r *unkRec) HeaderLine(h Header) { r.hdr = append(r.hdr, h.Line) }

// Cursor text, PARSE ERROR text and a BINDS block (the parser's own states) come before a section; an
// optimizer dump comes before it too, and a dump that starts inside a section ends it.
func TestSectionPrecedence(t *testing.T) {
	text := "PARSING IN CURSOR #139994073020960 len=13 dep=0 uid=0 oct=3 lid=0 tim=6213148853 hv=2423459000 ad='91877170' sqlid='23s96rf87635s'"
	k, st, rec := kindsOf(t, dMarker, text, sProc, "END OF STMT", dExec)
	wantKinds(t, "sql text", k, KindMarker, KindParsingInCursor, KindSQLText, KindEndOfStmt, KindCall)
	if len(st.Sections) != 0 || len(rec.cursors) != 1 || rec.cursors[0].Text != sProc {
		t.Errorf("sections %v cursors %+v", st.Sections, rec.cursors)
	}
	perr := "PARSE ERROR #139994073020960:len=13 dep=0 uid=0 oct=3 lid=0 tim=6213148853 err=942"
	k, st, rec = kindsOf(t, dMarker, perr, sProc, dMarker, sDiag)
	wantKinds(t, "parse error text", k, KindMarker, KindParseError, KindSQLText, KindMarker, KindDiag)
	wantSecs(t, "parse error text", st, "diagdump 5-5")
	// a value continuation line of a BINDS block
	k, st, rec = kindsOf(t, dBinds, "", " Bind#0", "  oacdty=01 mxl=32(15) mxlc=00 mal=00 scl=00 pre=00", `  value="abc`, sHeap, `def"`, sDiag)
	wantKinds(t, "bind value", k, KindBinds, Kind(255), KindBindLine, KindBindLine, KindBindLine, KindBindLine, KindBindLine, KindDiag)
	if len(st.Sections) != 1 || st.Sections[0].First != 8 || len(rec.binds) != 1 {
		t.Errorf("sections %v binds %d", st.Sections, len(rec.binds))
	}
	// a start line after the BINDS block ends it
	k, st, _ = kindsOf(t, dBinds, " Bind#0", "  value=1", sProc, "x")
	wantKinds(t, "after binds", k, KindBinds, KindBindLine, KindBindLine, KindDiag, KindDiag)
	wantSecs(t, "after binds", st, "procstate 4-5 cut")
	// inside an optimizer dump, and in the chatter after its END banner, a start line is an optimizer line
	k, st, _ = kindsOf(t, dStart, sProc, "x", dEnd, sDiag, "y", dMarker, sProc)
	wantKinds(t, "optimizer", k, KindOpt, KindOpt, KindOpt, KindOpt, KindOpt, KindOpt, KindMarker, KindDiag)
	wantSecs(t, "optimizer", st, "procstate 8-8 cut")
	if len(st.Dumps) != 1 {
		t.Errorf("dumps %v", st.Dumps)
	}
	// a dump that starts inside a section ends it, at the line before; the dump is found
	k, st, _ = kindsOf(t, sDiag, "x", "", dStart, "y", dEnd, dMarker, sProc, "z", sProcEnd)
	wantKinds(t, "dump in a section", k, KindDiag, KindDiag, KindBlank, KindOpt, KindOpt, KindOpt, KindMarker, KindDiag, KindDiag, KindDiag)
	wantSecs(t, "dump in a section", st, "diagdump 1-2", "procstate 8-10")
	if len(st.Dumps) != 1 || st.Dumps[0].First != 4 {
		t.Errorf("dumps %v", st.Dumps)
	}
	// ... and so does a line the optimizer tracker owns once a dump was seen
	k, st, _ = kindsOf(t, dStart, dEnd, dSep, sDiag, "x", dAP, "y")
	wantKinds(t, "runtime line", k, KindOpt, KindOpt, KindSeparator, KindDiag, KindDiag, KindOpt, KindUnknown)
	wantSecs(t, "runtime line", st, "diagdump 4-5")
	// a section that is open when a held rule meets an optimizer dump: the rule is a stray line first
	k, _, _ = kindsOf(t, dMarker, sRule, dStart, dEnd)
	wantKinds(t, "rule, dump", k, KindMarker, KindUnknown, KindOpt, KindOpt)
}

// A section can start in the prologue (a trace written before the file had any marker, as 10.2 does).
func TestSectionInPrologue(t *testing.T) {
	k, st, _ := kindsOf(t, "Trace file x.trc", "Version 10.2.0.1.0", "DEADLOCK DETECTED", "x")
	wantKinds(t, "prologue", k, KindHeader, KindHeader, KindDiag, KindDiag)
	wantSecs(t, "prologue", st, "deadlock 3-4")
}

func TestSectionStatsOfAGrowingFile(t *testing.T) {
	p := New(NopHandler{})
	p.line = 9
	p.sec.begin(SectionSysState, 3)
	p.sec.cur.Last = 8
	got := showSections(p.Stats().Sections)
	if !reflect.DeepEqual(got, []string{"sysstate 3-8 cut"}) {
		t.Errorf("snapshot sections %v", got)
	}
	if len(p.stats.Sections) != 0 {
		t.Errorf("the snapshot changed the parser's sections")
	}
	// a section without an end line is not cut
	p = New(NopHandler{})
	p.line = 9
	p.sec.begin(SectionDiagDump, 3)
	p.sec.cur.Last = 8
	if got := showSections(p.Stats().Sections); !reflect.DeepEqual(got, []string{"diagdump 3-8"}) {
		t.Errorf("snapshot sections %v", got)
	}
	// a rule that waits is an unknown line so far
	p = New(NopHandler{})
	p.line, p.inHeader = 4, false
	p.sec.st, p.sec.held = secHeld, 4
	if st := p.Stats(); st.Unknown != 1 || st.Kinds[KindUnknown] != 1 {
		t.Errorf("snapshot with a held rule: %+v", st.Kinds)
	}
	// the sections reach a consumer through Run, and a second parser starts clean
	st, _ := New(NopHandler{}).Run(strings.NewReader(sSys + "\nx\n"))
	wantSecs(t, "run", st, "sysstate 1-2 cut")
}

func TestFileKinds(t *testing.T) {
	for _, c := range []struct {
		name  string
		lines []string
		want  FileKind
	}{
		{"nothing", []string{dMarker, "x"}, FileKindNone},
		{"sections only", []string{sProc, "x"}, FileKindDiag},
		{"sections and a record", []string{sProc, "x", sExecLine}, FileKind10046},
		{"a record and sections", []string{sExecLine, sProc, "x"}, FileKind10046},
		{"sections and a dump", []string{sProc, "x", dStart, dEnd}, FileKind10053},
		{"sections, a dump and a record", []string{sProc, "x", dStart, dEnd, sExecLine}, FileKindBoth},
	} {
		text := strings.Join(c.lines, "\n") + "\n"
		st, _ := Parse(strings.NewReader(text), NopHandler{})
		if st.FileKind() != c.want {
			t.Errorf("%s: parser says %s, want %s", c.name, st.FileKind(), c.want)
		}
		sn, err := SniffReader(strings.NewReader(text), SniffOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if sn.Kind != c.want {
			t.Errorf("%s: sniff says %s, want %s", c.name, sn.Kind, c.want)
		}
		if !reflect.DeepEqual(showSections(sn.Sections), showSections(st.Sections)) {
			t.Errorf("%s: sniff sections %v, parser %v", c.name, showSections(sn.Sections), showSections(st.Sections))
		}
	}
	if FileKindDiag.String() != "diag" || FileKindDiag.Has10046() || FileKindDiag.Has10053() {
		t.Error("FileKindDiag")
	}
	// a read that stops at the first record has the sections before it
	sn, _ := SniffReader(strings.NewReader(sProc+"\nx\n"+sExecLine+"\n"+sProc+"\n"), SniffOptions{StopAtRecord: true})
	if sn.Kind != FileKind10046 || sn.Complete || showSections(sn.Sections)[0] != "procstate 1-2 cut" {
		t.Errorf("stop at record: %+v", sn)
	}
}

// The stateless page classifier agrees with the parser on every line of a diag file once the
// sections are applied: the lines a page of the line endpoints marks diagnostic are the parser's.
func TestMarkSections(t *testing.T) {
	files := diagFixtures(t)
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) > 6<<20 {
			continue
		}
		kinds, lines, st := parserKinds(t, f)
		n := len(lines) - 1
		page := func(from, count int) []Kind {
			lo := max(1, from-64)
			hi := min(n, from+count-1)
			c := NewClassifier(lo == 1)
			ks := make([]Kind, 0, hi-lo+1)
			for _, l := range lines[lo : hi+1] {
				ks = append(ks, c.Next(l))
			}
			MarkSections(ks, lines[lo:hi+1], lo, st.Sections)
			return ks[from-lo:]
		}
		bad := 0
		check := func(from int, got []Kind) {
			for i, k := range got {
				ln := from + i
				pk := kinds[ln]
				if (k == KindDiag) != (pk == int(KindDiag)) {
					if bad++; bad <= 5 {
						t.Errorf("%s:%d %q: page kind %s, parser %v", filepath.Base(f), ln, lines[ln], k, Kind(max(pk, 0)))
					}
				}
			}
		}
		check(1, page(1, n))
		for from := 1; from <= n; from += 997 {
			check(from, page(from, 150))
		}
		for _, s := range st.Sections { // pages that start and end at the edges of every section
			for _, from := range []int{s.First - 1, s.First, s.Last - 1, s.Last, s.Last + 1} {
				if from >= 1 && from <= n {
					check(from, page(from, 3))
				}
			}
		}
		if bad > 0 {
			t.Errorf("%s: %d lines differ", filepath.Base(f), bad)
		}
	}
	// a section applies to a page that starts inside it, and leaves the lines outside alone
	ks := []Kind{KindUnknown, KindBindLine, KindSeparator, KindSeparator, KindMarker, KindBlank, KindParsingInCursor, KindUnknown}
	ls := [][]byte{[]byte("a"), []byte(" Bind#0"), []byte("====== x"), []byte(dSep), []byte("*** x"), nil, []byte("PARSING"), []byte("z")}
	MarkSections(ks, ls, 10, []Section{{Kind: SectionDiagDump, First: 2, Last: 15}})
	want := []Kind{KindDiag, KindDiag, KindDiag, KindSeparator, KindMarker, KindBlank, KindParsingInCursor, KindUnknown}
	// lines 10..17: 10-15 are inside; the 21 "=" separator (line 13) keeps its kind
	want[3], want[6], want[7] = KindSeparator, KindParsingInCursor, KindUnknown
	if !reflect.DeepEqual(ks, want) {
		t.Errorf("marked %v, want %v", ks, want)
	}
}

// ---- the fixtures ----

func diagFixtures(t testing.TB) []string {
	t.Helper()
	var files []string
	for _, g := range []string{"diag/19c/*.trc", "traces/19c/diag_in_10046.trc", "big/diag/*.trc"} {
		fs, _ := filepath.Glob(filepath.Join("..", "..", "testdata", g))
		files = append(files, fs...)
	}
	if len(files) < 16 {
		t.Skipf("only %d diag fixtures", len(files))
	}
	return files
}

type wantSection struct {
	kind        SectionKind
	first, last int
}

// The sections of each committed fixture (and the lines no section took: what is left unknown).
// Everything else about a file's sections is checked by TestSectionInvariants.
var diagWant = map[string]struct {
	sections []wantSection
	unknown  int
	kind     FileKind
}{
	"diag_deadlock.trc":          {[]wantSection{{SectionDeadlock, 33, 10477}}, 1, FileKindDiag},
	"diag_errorstack_l1.trc":     {[]wantSection{{SectionDiagDump, 32, 5050}}, 0, FileKindDiag},
	"diag_errorstack_l2.trc":     {[]wantSection{{SectionDiagDump, 32, 36651}}, 0, FileKindDiag},
	"diag_hang.trc":              {[]wantSection{{SectionHang, 42, 275}}, 5, FileKindDiag},
	"diag_hang_event.trc":        {[]wantSection{{SectionHang, 33, 305}}, 0, FileKindDiag},
	"diag_heap_contents.trc":     {[]wantSection{{SectionHeap, 32, 17213}, {SectionHeap, 17214, 17808}, {SectionHeap, 17809, 26247}}, 0, FileKindDiag},
	"diag_heap_large.trc":        {[]wantSection{{SectionHeap, 32, 39}, {SectionHeap, 40, 82}}, 0, FileKindDiag},
	"diag_heap_large_pdb.trc":    {[]wantSection{{SectionHeap, 32, 39}, {SectionHeap, 40, 72}}, 0, FileKindDiag},
	"diag_heap_pga.trc":          {[]wantSection{{SectionHeap, 32, 923}, {SectionHeap, 924, 1034}, {SectionHeap, 1035, 1486}}, 0, FileKindDiag},
	"diag_heap_uga.trc":          {[]wantSection{{SectionHeap, 32, 1480}, {SectionHeap, 1483, 2920}, {SectionHeap, 2921, 3816}, {SectionHeap, 3817, 3939}, {SectionHeap, 3940, 4404}}, 0, FileKindDiag},
	"diag_in_10046.trc":          {[]wantSection{{SectionDiagDump, 114, 29753}}, 0, FileKind10046},
	"diag_pga_detail.trc":        {[]wantSection{{SectionPGADetail, 46, 1001}}, 8, FileKindDiag},
	"diag_pga_summary.trc":       {[]wantSection{{SectionPGASummary, 33, 776}}, 0, FileKindDiag},
	"diag_procstate.trc":         {[]wantSection{{SectionProcState, 33, 10394}}, 0, FileKindDiag},
	"diag_sysstate_l1.trc":       {[]wantSection{{SectionSysState, 40, 26088}}, 5, FileKindDiag},
	"diag_heap_sub.trc":          {nil, 0, FileKindDiag}, // 80 heaps: see TestSectionInvariants and the count below
	"diag_oom.trc":               {nil, 2, FileKindNone},
	"diag_oom_session_exp10.trc": {nil, 3, FileKindNone},
}

func TestSectionFixtures(t *testing.T) {
	for _, f := range diagFixtures(t) {
		name := filepath.Base(f)
		want, ok := diagWant[name]
		if !ok {
			continue // the big set: TestSectionInvariants only
		}
		st, err := ParseFile(f, NopHandler{})
		if err != nil {
			t.Fatal(err)
		}
		if name == "diag_heap_sub.trc" {
			if len(st.Sections) != 80 || st.Sections[0].First != 32 || st.Sections[0].Last != 933 || st.Sections[79].Last != 18635 {
				t.Errorf("%s: %d sections %v ...", name, len(st.Sections), showSections(st.Sections[:min(3, len(st.Sections))]))
			}
			continue
		}
		var got []wantSection
		for _, s := range st.Sections {
			got = append(got, wantSection{s.Kind, s.First, s.Last})
			if s.Cut {
				t.Errorf("%s: section %+v is cut", name, s)
			}
		}
		if !reflect.DeepEqual(got, want.sections) {
			t.Errorf("%s: sections %v, want %v", name, got, want.sections)
		}
		if st.Unknown != want.unknown {
			t.Errorf("%s: %d unknown lines, want %d", name, st.Unknown, want.unknown)
		}
		if st.FileKind() != want.kind {
			t.Errorf("%s: file kind %s, want %s", name, st.FileKind(), want.kind)
		}
	}
}

// parseKinds parses data and returns the kind counted for each line (-1: none), counting how
// often a line was counted.
func parseKinds(t testing.TB, data []byte) (kinds []int, st Stats, dups int) {
	t.Helper()
	p := New(NopHandler{})
	kinds = []int{-1}
	p.kindHook = func(n int, k Kind) {
		for len(kinds) <= n {
			kinds = append(kinds, -1)
		}
		if kinds[n] != -1 {
			dups++
		}
		kinds[n] = int(k)
	}
	st, err := p.Run(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for len(kinds) <= st.Lines {
		kinds = append(kinds, -1)
	}
	return kinds, st, dups
}

// checkSections holds what must be true of the sections of any file: the arithmetic of the ranges
// and what the parser counted inside and outside them.
func checkSections(t testing.TB, name string, data []byte) {
	t.Helper()
	kinds, st, dups := parseKinds(t, data)
	if dups > 0 {
		t.Errorf("%s: %d lines counted twice", name, dups)
	}
	inside := make([]bool, st.Lines+2)
	prev := 0
	for _, s := range st.Sections {
		if s.Kind <= SectionNone || s.Kind >= sectionKindCount || s.First < 1 || s.Last < s.First || s.Last > st.Lines || s.First <= prev {
			t.Errorf("%s: section %+v after line %d (%d lines)", name, s, prev, st.Lines)
			return
		}
		if s.Cut && !s.Kind.hasEnd() {
			t.Errorf("%s: section %+v is cut and its kind has no end line", name, s)
		}
		for n := s.First; n <= s.Last; n++ {
			inside[n] = true
			switch Kind(kinds[n]) {
			case KindDiag, KindBlank, KindMarker:
			default:
				t.Errorf("%s: line %d of section %+v counted as %s", name, n, s, Kind(max(kinds[n], 0)))
			}
		}
		if Kind(kinds[s.First]) != KindDiag || Kind(kinds[s.Last]) != KindDiag {
			t.Errorf("%s: section %+v starts or ends on a line that is not diagnostic (%d, %d)", name, s, kinds[s.First], kinds[s.Last])
		}
		prev = s.Last
	}
	diag := 0
	for n := 1; n <= st.Lines; n++ {
		if Kind(kinds[n]) == KindDiag {
			diag++
			if !inside[n] {
				t.Errorf("%s: line %d is diagnostic and in no section", name, n)
				return
			}
		}
	}
	if diag != st.Kinds[KindDiag] {
		t.Errorf("%s: %d diagnostic lines, statistics say %d", name, diag, st.Kinds[KindDiag])
	}
}

// The structure every fixture's sections must have, from the lines themselves.
func TestSectionInvariants(t *testing.T) {
	for _, f := range diagFixtures(t) {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Base(f)
		checkSections(t, name, raw)
		st, _ := Parse(bytes.NewReader(raw), NopHandler{})
		lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
		heapStarts := 0
		for i, s := range st.Sections {
			first := []byte(lines[s.First-1])
			if k, ok := IsSectionStart(first); ok {
				if k != s.Kind {
					t.Errorf("%s: section %+v starts with a %s line", name, s, k)
				}
			} else if !(s.Kind == SectionHeap && isStarRule(first) && s.First < len(lines)) {
				t.Errorf("%s: section %+v does not start with a start line or a heap's rule: %q", name, s, lines[s.First-1])
			} else if k, ok := IsSectionStart([]byte(lines[s.First])); !ok || k != SectionHeap {
				t.Errorf("%s: section %+v starts with a rule that no heap dump follows", name, s)
			}
			starts := 0
			for _, l := range lines[s.First-1 : s.Last] {
				if k, _ := IsSectionStart([]byte(l)); k == SectionHeap {
					starts++
				}
			}
			if s.Kind == SectionHeap {
				heapStarts++
				if starts != 1 {
					t.Errorf("%s: heap section %+v holds %d heap dumps", name, s, starts)
				}
			}
			last := lines[s.Last-1]
			switch s.Kind {
			case SectionSysState:
				if !s.Cut && last != sSysEnd {
					t.Errorf("%s: system state ends with %q", name, last)
				}
			case SectionProcState:
				if !s.Cut && last != sProcEnd {
					t.Errorf("%s: process state ends with %q", name, last)
				}
			case SectionPGADetail:
				if !s.Cut && (!isEqRule([]byte(last)) || lines[s.Last-2] != sPGAEnd) {
					t.Errorf("%s: PGA detail dump ends with %q, %q", name, lines[s.Last-2], last)
				}
			case SectionHang:
				if !s.Cut && (!isEqRule([]byte(last)) || lines[s.Last-2] != sHangDEnd) {
					t.Errorf("%s: hang analysis ends with %q, %q", name, lines[s.Last-2], last)
				}
			case SectionHeap:
				if !s.Cut && i+1 < len(st.Sections) && st.Sections[i+1].First != s.Last+1 && lines[s.Last-1] != sRule {
					t.Errorf("%s: heap section %+v does not end at a rule or at the next heap: %q", name, s, last)
				}
			}
		}
		total := 0
		for _, l := range lines {
			if k, _ := IsSectionStart([]byte(l)); k == SectionHeap {
				total++
			}
		}
		if name == "diag_heap_sub.trc" && heapStarts != 80 {
			t.Errorf("%s: %d heap sections", name, heapStarts)
		}
		// all of a file whose sections are all heaps: one section per HEAP DUMP line
		allHeap := len(st.Sections) > 0
		for _, s := range st.Sections {
			allHeap = allHeap && s.Kind == SectionHeap
		}
		if allHeap && heapStarts != total {
			t.Errorf("%s: %d heap sections for %d HEAP DUMP lines", name, heapStarts, total)
		}
	}
}

// Every fixture cut at many points: no panic, and sections that are consistent with the full file's.
func TestSectionPrefixes(t *testing.T) {
	for _, f := range diagFixtures(t) {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) > 2<<20 {
			continue
		}
		name := filepath.Base(f)
		full, _ := Parse(bytes.NewReader(raw), NopHandler{})
		ends := lineEnds(raw)
		cuts := map[int]bool{0: true, 1: true, len(ends): true}
		for i := 1; i <= 120; i++ {
			cuts[len(ends)*i/121] = true
		}
		for _, s := range full.Sections {
			for _, n := range []int{s.First - 2, s.First - 1, s.First, s.First + 1, s.Last - 1, s.Last, s.Last + 1, s.Last + 2} {
				if n >= 0 && n <= len(ends) {
					cuts[n] = true
				}
			}
		}
		for n := range cuts {
			end := 0
			if n > 0 {
				end = ends[n-1]
			}
			for _, data := range [][]byte{raw[:end], raw[:min(end+7, len(raw))]} { // at a line end, and in the middle of the next line
				checkSections(t, fmt.Sprintf("%s[:%d]", name, len(data)), data)
				st, _ := Parse(bytes.NewReader(data), NopHandler{})
				// a section whose successor started well before the cut is the full file's, to the line
				// (the lines after the end of a heap or a hang analysis can still be its own)
				for i, s := range full.Sections {
					if i+1 >= len(full.Sections) || full.Sections[i+1].First+2 > st.Lines {
						break
					}
					if i >= len(st.Sections) || st.Sections[i] != s {
						t.Errorf("%s cut at line %d: section %d is %v, the full file's is %+v", name, n, i, st.Sections, s)
						break
					}
				}
			}
		}
	}
}

// lineEnds are the offsets after each line of data (the last line may have no newline).
func lineEnds(b []byte) []int {
	var out []int
	for i, c := range b {
		if c == '\n' {
			out = append(out, i+1)
		}
	}
	if len(b) > 0 && b[len(b)-1] != '\n' {
		out = append(out, len(b))
	}
	return out
}

// The sniffer finds the same sections as the parser on every fixture, however the file is read in pieces.
func TestSectionSniff(t *testing.T) {
	for _, f := range diagFixtures(t) {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) > 6<<20 {
			continue
		}
		name := filepath.Base(f)
		st, _ := Parse(bytes.NewReader(raw), NopHandler{})
		for _, rd := range []io.Reader{bytes.NewReader(raw), &pieceReader{b: raw, rnd: rand.New(rand.NewSource(1))}} {
			sn, err := SniffReader(rd, SniffOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(showSections(sn.Sections), showSections(st.Sections)) || sn.Kind != st.FileKind() || sn.Lines != st.Lines {
				t.Errorf("%s: sniff %v %s, parser %v %s", name, showSections(sn.Sections), sn.Kind, showSections(st.Sections), st.FileKind())
			}
		}
	}
	// a line longer than the sniffer's buffer inside a section
	long := sSys + "\n" + strings.Repeat("y", 600<<10) + "\n" + sSysEnd + "\n" + sProc + "\nz\n"
	sn, _ := SniffReader(strings.NewReader(long), SniffOptions{})
	if got := showSections(sn.Sections); !reflect.DeepEqual(got, []string{"sysstate 1-3", "procstate 4-5 cut"}) || sn.Lines != 5 {
		t.Errorf("long line: %v %d", got, sn.Lines)
	}
	// a section start inside a cursor's text is statement text, for the parser and for the sniffer
	cursor := "PARSING IN CURSOR #1 len=13 dep=0 uid=0 oct=3 lid=0 tim=1 hv=1 ad='0' sqlid='a'\nPROCESS STATE\nEND OF STMT\nPROCESS STATE\nx\n"
	pst, _ := Parse(strings.NewReader(cursor), NopHandler{})
	sn, _ = SniffReader(strings.NewReader(cursor), SniffOptions{})
	if !reflect.DeepEqual(showSections(pst.Sections), []string{"procstate 4-5 cut"}) || !reflect.DeepEqual(showSections(sn.Sections), showSections(pst.Sections)) {
		t.Errorf("statement text: parser %v, sniffer %v", showSections(pst.Sections), showSections(sn.Sections))
	}
}

// pieceReader hands out its bytes in pieces of random sizes.
type pieceReader struct {
	b   []byte
	rnd *rand.Rand
}

func (r *pieceReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := min(1+r.rnd.Intn(5000), len(p), len(r.b))
	copy(p, r.b[:n])
	r.b = r.b[n:]
	return n, nil
}

// The numbers that matter for the primary formats: no pre-existing fixture has a section, and the
// kind counts of each are what they were before the parser knew sections (testdata/fixture_kinds_before.txt,
// made with the build before this change).
func TestFixtureKindsUnchanged(t *testing.T) {
	golden, err := os.ReadFile(filepath.Join("testdata", "fixture_kinds_before.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{}
	for _, l := range strings.Split(string(golden), "\n") {
		if l == "" || l[0] == '#' {
			continue
		}
		path, rest, _ := strings.Cut(l, " ")
		want[path] = rest
	}
	// every fixture there is, except the diagnostic dump files
	var found []string
	root := filepath.Join("..", "..", "testdata")
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		switch {
		case d.IsDir() && (rel == "diag" || rel == "big"):
			return filepath.SkipDir
		case !d.IsDir() && strings.HasSuffix(path, ".trc") && d.Name() != "diag_in_10046.trc":
			found = append(found, "testdata/"+filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != len(want) || len(want) < 100 {
		t.Errorf("%d fixtures found, %d in the table", len(found), len(want))
	}
	for _, rel := range found {
		w, ok := want[rel]
		if !ok {
			t.Errorf("%s is not in the table: add it, with the numbers of the parser before sections (git stash is not needed: build the commit before this change)", rel)
			continue
		}
		st, err := ParseFile(filepath.Join("..", "..", rel), NopHandler{})
		if err != nil {
			t.Fatal(err)
		}
		if len(st.Sections) != 0 || st.Kinds[KindDiag] != 0 {
			t.Errorf("%s: %d sections, %d diagnostic lines", rel, len(st.Sections), st.Kinds[KindDiag])
		}
		got := fmt.Sprintf("lines=%d kind=%s", st.Lines, st.FileKind())
		for k := Kind(0); k < kindCount; k++ {
			if st.Kinds[k] > 0 {
				got += fmt.Sprintf(" %s=%d", k, st.Kinds[k])
			}
		}
		if got != w {
			t.Errorf("%s:\n got %s\nwant %s", rel, got, w)
		}
		sn, err := SniffFile(filepath.Join("..", "..", rel), SniffOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if len(sn.Sections) != 0 {
			t.Errorf("%s: the sniffer found %v", rel, sn.Sections)
		}
	}
}
