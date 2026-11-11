package trace

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// lines of a real 19.27 trace with event 10046 and 10053 both on
const (
	dStart   = "Registered qb: SEL$1 0xe8eab888 (PARSER)"
	dStart2  = "Registered qb: SEL$2 0xe97a3cf8 (PARSER)"
	dViewQB  = "Registered qb: SEL$58A6D7F6 0x64387718 (VIEW MERGE SEL$2; SEL$1; SEL$2)"
	dSQLID   = "----- Current SQL Statement for this session (sql_id=7jqt2tmvuc9hn) -----"
	dEnd     = "====================== END SQL Statement Dump ======================"
	dBanner  = "======================================="
	dSep     = "====================="
	dBindHdr = "----- Bind Info (kkscoacd) -----"
	dAP      = "AP: qesdpDPCSetupNextExec(enter): SQL_ID=7jqt2tmvuc9hn"
	dCost    = "kkeCostToTime: using io calibrate stats maxpmbps=200(MB/s) "
	dPIC     = "PARSING IN CURSOR #139994073020960 len=137 dep=1 uid=0 oct=3 lid=0 tim=6213148853 hv=2423459000 ad='91877170' sqlid='23s96rf87635s'"
	dText    = "select count(*) from sys.col_group_usage$  where obj# = :1 and cols = :2 and trunc(sysdate) = trunc(timestamp) and bitand(flags, :3) = :3"
	dParse   = "PARSE #139994073020960:c=372,e=372,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=4,plh=0,tim=6213148853"
	dExec    = "EXEC #139994073020960:c=1090,e=1071,p=0,cr=0,cu=0,mis=1,r=1,dep=1,og=4,plh=1347681019,tim=6213149971"
	dBinds   = "BINDS #139994073020960:"
	dMarker  = "*** 2026-11-10T20:45:33.749920+00:00 (PDB1(3))"
)

// kindsOf parses the lines and returns the kind counted for each (nil for
// none) and the statistics.
func kindsOf(t *testing.T, lines ...string) ([]Kind, Stats, *recorder) {
	t.Helper()
	rec := &recorder{}
	p := New(rec)
	kinds := make([]Kind, len(lines))
	got := make([]bool, len(lines))
	p.kindHook = func(line int, k Kind) { kinds[line-1], got[line-1] = k, true }
	st, err := p.Run(strings.NewReader(strings.Join(lines, "\n") + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	for i := range lines {
		if !got[i] {
			kinds[i] = Kind(255)
		}
	}
	return kinds, st, rec
}

func wantKinds(t *testing.T, name string, got []Kind, want ...Kind) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: kinds %v, want %v", name, got, want)
	}
}

func TestDumpStartEnd(t *testing.T) {
	k, st, rec := kindsOf(t, dStart, "---------------------", "QUERY BLOCK SIGNATURE", dSQLID, dBanner, dEnd)
	wantKinds(t, "dump", k, KindOpt, KindOpt, KindOpt, KindOpt, KindOpt, KindOpt)
	want := []Dump{{First: 1, Last: 6, SQLID: "7jqt2tmvuc9hn"}}
	if !reflect.DeepEqual(st.Dumps, want) {
		t.Errorf("dumps %+v, want %+v", st.Dumps, want)
	}
	if st.Unknown != 0 || len(rec.unknown) != 0 {
		t.Errorf("unknown lines: %d %v", st.Unknown, rec.unknown)
	}
	if st.FileKind() != FileKind10053 {
		t.Errorf("file kind %s", st.FileKind())
	}
}

func TestDumpStartOnlyFromParserLine(t *testing.T) {
	// a Registered qb line that is not a (PARSER) one does not start a dump
	k, st, _ := kindsOf(t, dMarker, dViewQB, "Registered qb: SEL$1 0xe8eab888 (COPY SEL$1)", "Registered qb: SEL$1 (PARSER)", "Registered qb: SEL$1 0x (PARSER)")
	wantKinds(t, "not a start", k, KindMarker, KindUnknown, KindUnknown, KindUnknown, KindUnknown)
	if len(st.Dumps) != 0 || st.Unknown != 4 {
		t.Errorf("dumps %v unknown %d", st.Dumps, st.Unknown)
	}
	// inside a dump it is an optimizer line and not a second dump; a second
	// (PARSER) line (one per query block) neither
	k, st, _ = kindsOf(t, dStart, dViewQB, dStart2, dEnd)
	wantKinds(t, "inside", k, KindOpt, KindOpt, KindOpt, KindOpt)
	if len(st.Dumps) != 1 || st.Dumps[0].Last != 4 {
		t.Errorf("dumps %+v", st.Dumps)
	}
	// the other statement types
	for _, qb := range []string{"INS$1", "UPD$1", "DEL$1", "MRG$1", "SET$1"} {
		if !IsDumpStart([]byte("Registered qb: " + qb + " 0xe8eab888 (PARSER)")) {
			t.Errorf("%s is not a dump start", qb)
		}
	}
}

func TestDumpBindInfoIsOptimizerLines(t *testing.T) {
	bind := []string{dBindHdr, " Bind#0", "  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00",
		"  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0", "  kxsbbbfp=7fbc63a22cf0  bln=22  avl=02  flg=05", "  value=11",
		" Bind#1", "  No oacdef for this bind.", "Dumping Hints"}
	lines := append(append([]string{dStart}, bind...), dEnd)
	k, st, rec := kindsOf(t, lines...)
	for i, kk := range k {
		if kk != KindOpt {
			t.Errorf("line %d %q: %s, want optimizer", i+1, lines[i], kk)
		}
	}
	if len(rec.binds) != 0 || st.Kinds[KindBindLine] != 0 {
		t.Errorf("bind lines of a dump were taken for a BINDS block: %d sets, %d bind lines", len(rec.binds), st.Kinds[KindBindLine])
	}
	// after a real BINDS header the same shape is a bind block
	k, st, rec = kindsOf(t, dStart, dBinds, "", " Bind#0", "  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00", "  value=11", dExec, dEnd)
	wantKinds(t, "real binds", k, KindOpt, KindBinds, Kind(255), KindBindLine, KindBindLine, KindBindLine, KindCall, KindOpt)
	if len(rec.binds) != 1 || len(rec.binds[0].Binds) != 1 || rec.binds[0].Binds[0].Value != "11" {
		t.Errorf("binds %+v", rec.binds)
	}
}

func TestDumpKeepsRecursiveRecords(t *testing.T) {
	k, st, rec := kindsOf(t, dStart, "apadrv-end", dSep, dPIC, dText, "END OF STMT", dParse, dBinds, "", " Bind#0", "  value=108611", dExec, "CBRID: O @ SEL$1BA63A14", dEnd)
	wantKinds(t, "dep=1", k, KindOpt, KindOpt, KindSeparator, KindParsingInCursor, KindSQLText, KindEndOfStmt, KindCall, KindBinds,
		Kind(255), KindBindLine, KindBindLine, KindCall, KindOpt, KindOpt)
	if len(rec.cursors) != 1 || rec.cursors[0].Dep != 1 || rec.cursors[0].SQLID != "23s96rf87635s" || rec.cursors[0].Text != dText {
		t.Errorf("cursors %+v", rec.cursors)
	}
	if len(rec.calls) != 2 || st.Unknown != 0 {
		t.Errorf("calls %d unknown %d", len(rec.calls), st.Unknown)
	}
	// a banner of the dump is not a separator, the 21-character one is
	k, st, _ = kindsOf(t, dStart, dBanner, dSep, dEnd)
	wantKinds(t, "banner", k, KindOpt, KindOpt, KindSeparator, KindOpt)
	if st.Kinds[KindSeparator] != 1 {
		t.Errorf("separators %d", st.Kinds[KindSeparator])
	}
	// a marker inside a dump is a marker
	k, _, _ = kindsOf(t, dStart, "*** 2026-11-10T20:45:33.749920+00:00 (PDB1(3))", dEnd)
	wantKinds(t, "marker", k, KindOpt, KindMarker, KindOpt)
}

func TestDumpChatterAfterEnd(t *testing.T) {
	k, st, _ := kindsOf(t, dStart, dEnd, dAP, "AP: qesdpInitExecMutable(enter): SQL_ID=7jqt2tmvuc9hn", "", "AP: qesdpSetupMutable (exit)", dBinds, " Bind#0", "  value=11", dAP, dExec, "something else")
	wantKinds(t, "chatter", k, KindOpt, KindOpt, KindOpt, KindOpt, KindBlank, KindOpt, KindBinds, KindBindLine, KindBindLine, KindOpt, KindCall, KindUnknown)
	if st.Unknown != 1 {
		t.Errorf("unknown %d, want only the line after the EXEC", st.Unknown)
	}
	// the chatter ends at a separator and at a marker: what follows is unknown again
	for _, end := range []string{dSep, "*** 2026-11-10T20:45:33.749920+00:00 (PDB1(3))"} {
		k, _, _ = kindsOf(t, dStart, dEnd, dAP, end, "something else")
		if k[4] != KindUnknown {
			t.Errorf("after %q: %s, want unknown", end, k[4])
		}
	}
	// a dump after the chatter starts a second dump
	_, st, _ = kindsOf(t, dStart, dEnd, dAP, dStart, dSQLID, dEnd)
	if len(st.Dumps) != 2 || st.Dumps[1].First != 4 || st.Dumps[1].Last != 6 || st.Dumps[1].SQLID != "7jqt2tmvuc9hn" {
		t.Errorf("dumps %+v", st.Dumps)
	}
	// before any dump the same lines are unknown (lines outside a dump are classified as before)
	k, st, _ = kindsOf(t, dMarker, dAP, dCost)
	wantKinds(t, "no dump", k, KindMarker, KindUnknown, KindUnknown)
	if st.Unknown != 2 || len(st.Dumps) != 0 {
		t.Errorf("unknown %d dumps %v", st.Unknown, st.Dumps)
	}
}

func TestDumpRuntimeLinesBetweenRecords(t *testing.T) {
	k, st, _ := kindsOf(t, dStart, dEnd, dSep, dPIC, dText, "END OF STMT", dExec,
		dAP, dCost, " block_size=8192 mb_io_count=1 mb_io_size=8192 (bytes) ", " tot_io_size=3(MB) time=15(ms)",
		"STAT #139994073028056 id=1 cnt=0 pid=0 pos=1 obj=0 op='SORT ORDER BY (cr=672 pr=654 pw=0 str=1 time=5794 us cost=385 size=81 card=1)'")
	wantKinds(t, "runtime", k, KindOpt, KindOpt, KindSeparator, KindParsingInCursor, KindSQLText, KindEndOfStmt, KindCall,
		KindOpt, KindOpt, KindOpt, KindOpt, KindStat)
	if st.Unknown != 0 {
		t.Errorf("unknown %d", st.Unknown)
	}
}

func TestDumpCut(t *testing.T) {
	_, st, _ := kindsOf(t, dStart, "---------------------", "QUERY BLOCK SIGNATURE")
	want := []Dump{{First: 1, Last: 3, Cut: true}}
	if !reflect.DeepEqual(st.Dumps, want) {
		t.Errorf("dumps %+v, want %+v", st.Dumps, want)
	}
	// "TRACE CONTINUES IN FILE" cuts the dump before the marker
	_, st, _ = kindsOf(t, dStart, dSQLID, "*** TRACE CONTINUES IN FILE /u01/trace/cdb1_ora_1_2.trc ***")
	want = []Dump{{First: 1, Last: 2, SQLID: "7jqt2tmvuc9hn", Cut: true}}
	if !reflect.DeepEqual(st.Dumps, want) {
		t.Errorf("dumps %+v, want %+v", st.Dumps, want)
	}
}

func TestDumpStatsOfAGrowingFile(t *testing.T) {
	p := New(NopHandler{})
	_, err := p.Run(strings.NewReader(dStart + "\n" + dSQLID + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	// Run ended the input; Stats on a parser in the middle of a dump counts it as cut
	p2 := New(NopHandler{})
	p2.line = 7
	p2.opt.begin(3)
	if d := p2.Stats().Dumps; len(d) != 1 || d[0].First != 3 || d[0].Last != 7 || !d[0].Cut {
		t.Errorf("snapshot dumps %+v", d)
	}
	if len(p2.stats.Dumps) != 0 {
		t.Errorf("the snapshot changed the parser's dumps")
	}
}

// TestDumpLineKinds pins the classification of whole dumps in real files: no
// unknown line, no cursor from a dump, and the dump's lines in the optimizer
// kind.
func TestDumpFixtures(t *testing.T) {
	files, _ := filepath.Glob("../../testdata/opt/*/*.trc")
	inter, _ := filepath.Glob("../../testdata/traces/*/opt_interleaved.trc")
	files = append(files, inter...)
	if len(files) == 0 {
		t.Skip("no fixtures")
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			rec := &recorder{}
			st, err := ParseFile(f, rec)
			if err != nil {
				t.Fatal(err)
			}
			if st.Unknown != 0 {
				t.Errorf("%d unknown lines, first %q", st.Unknown, rec.unknown[:min(3, len(rec.unknown))])
			}
			if len(st.Dumps) == 0 {
				t.Fatal("no dump found")
			}
			raw, _ := os.ReadFile(f)
			lines := strings.Split(string(raw), "\n")
			opt := 0
			blank := 0
			for _, d := range st.Dumps {
				if d.Cut {
					t.Errorf("dump %+v is cut", d)
				}
				if !IsDumpStart([]byte(lines[d.First-1])) || !IsDumpEnd([]byte(lines[d.Last-1])) {
					t.Errorf("dump %+v does not run from a start line to an END banner: %q ... %q", d, lines[d.First-1], lines[d.Last-1])
				}
				if id := dumpSQLIDIn(lines[d.First-1 : d.Last]); id != d.SQLID || id == "" {
					t.Errorf("dump %+v: sql_id %q in the text", d, id)
				}
				opt += d.Lines()
				for _, l := range lines[d.First-1 : d.Last] {
					if strings.TrimSpace(l) == "" {
						blank++
					}
				}
			}
			if st.Kinds[KindOpt] < opt-blank-opt/50 { // the dump's lines, less its blank lines, markers and 10046 records
				t.Errorf("%d optimizer lines for %d dump lines", st.Kinds[KindOpt], opt)
			}
			for i := 1; i < len(st.Dumps); i++ {
				if st.Dumps[i].First <= st.Dumps[i-1].Last {
					t.Errorf("dumps overlap: %+v", st.Dumps)
				}
			}
			if strings.Contains(f, "testdata/opt/") != (st.FileKind() == FileKind10053) {
				t.Errorf("file kind %s", st.FileKind())
			}
		})
	}
}

func dumpSQLIDIn(lines []string) string {
	for _, l := range lines {
		if id, ok := DumpSQLID([]byte(l)); ok {
			return id
		}
	}
	return ""
}

// TestInterleavedFixture pins what the 10046 reader sees of the interleaved
// file: the numbers of the 10046 lines are those of the parser before it knew
// about dumps (when 26,920 of 28,236 lines were unknown).
func TestInterleavedFixture(t *testing.T) {
	f := "../../testdata/traces/19c/opt_interleaved.trc"
	rec := &recorder{}
	st, err := ParseFile(f, rec)
	if err != nil {
		t.Skip(err)
	}
	if st.Unknown != 0 {
		t.Errorf("%d unknown lines", st.Unknown)
	}
	if st.FileKind() != FileKindBoth {
		t.Errorf("file kind %s", st.FileKind())
	}
	if len(st.Dumps) != 2 {
		t.Fatalf("dumps %+v", st.Dumps)
	}
	// each dump's sql_id is the sqlid of a dep=0 cursor of the file
	sqlids := map[string]bool{}
	for _, c := range rec.cursors {
		if c.Dep == 0 {
			sqlids[c.SQLID] = true
		}
	}
	for _, d := range st.Dumps {
		if !sqlids[d.SQLID] {
			t.Errorf("dump %+v: no cursor with that sql_id (%v)", d, sqlids)
		}
	}
	got := map[string]int{"cursors": len(rec.cursors), "calls": len(rec.calls), "waits": len(rec.waits), "stats": len(rec.stats), "binds": len(rec.binds)}
	want := map[string]int{"cursors": 6, "calls": 37, "waits": 40, "stats": 36, "binds": 3}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("10046 records %v, want %v", got, want)
	}
	if st.Kinds[KindOpt] < 26000 {
		t.Errorf("%d optimizer lines", st.Kinds[KindOpt])
	}
}
