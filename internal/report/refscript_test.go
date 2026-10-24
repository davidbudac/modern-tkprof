package report

import (
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

func TestRefScriptCoversTrace(t *testing.T) {
	m, err := model.Build("../../testdata/traces/19c/io_waits.trc", model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	sc := RefScript(m, RefScriptOptions{})

	objs := map[int64]bool{}
	for _, w := range m.Waits {
		if w.ObjID > 0 {
			objs[w.ObjID] = true
		}
	}
	for _, l := range m.PlanLines {
		if l.Obj > 0 {
			objs[l.Obj] = true
		}
	}
	if len(objs) == 0 {
		t.Fatal("fixture has no obj#")
	}
	// every obj# is in the objects query (once per column)
	for id := range objs {
		re := regexp.MustCompile(`(?s)object_id in \([^)]*\b` + itoa(id) + `\b`)
		if !re.MatchString(sc) {
			t.Errorf("obj# %d missing from the script", id)
		}
	}
	nIDs := 0
	for _, st := range m.Statements {
		if st.Kind == model.StmtSQL && st.SQLID != "" && st.Text != "" {
			nIDs++
			if !strings.Contains(sc, "spool ref/plans/"+st.SQLID+".txt") || !strings.Contains(sc, "display_cursor('"+st.SQLID+"'") {
				t.Errorf("sql_id %s has no plan block", st.SQLID)
			}
		}
	}
	if got := strings.Count(sc, "spool ref/plans/"); got != nIDs {
		t.Errorf("%d plan spools for %d sql_ids", got, nIDs)
	}
	for _, want := range []string{"spool ref/objects.csv", "spool ref/datafiles.csv", "spool ref/users.csv", "dba_objects", "dba_users", "v$tempfile", "set markup csv on quote on", "whenever sqlerror continue", "display_awr", "ALLSTATS LAST +PREDICATE +ALIAS", "READ-ONLY", "user_id in (0, 165)"} {
		if !strings.Contains(sc, want) {
			t.Errorf("script lacks %q", want)
		}
	}
	// file# 12 (users01) is only an example of a db file read; the in-list holds the trace's p1 values
	if !regexp.MustCompile(`abs_file# in \(\d+`).MatchString(sc) {
		t.Error("datafile query lacks its file# list")
	}
}

func TestRefScriptLiteHasNoDBAViews(t *testing.T) {
	m, err := model.Build("../../testdata/traces/19c/io_waits.trc", model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	sc := RefScript(m, RefScriptOptions{Lite: true})
	if strings.Contains(strings.ToUpper(sc), "DBA_") {
		t.Errorf("-lite script mentions a DBA_ view:\n%s", sc)
	}
	for _, want := range []string{"all_objects", "all_users", "spool ref/objects.csv", "spool ref/users.csv"} {
		if !strings.Contains(sc, want) {
			t.Errorf("lite script lacks %q", want)
		}
	}
	if strings.Contains(sc, "datafiles.csv") && strings.Contains(sc, "spool ref/datafiles.csv") {
		t.Error("lite script must not collect datafiles")
	}
}

// Oracle rejects expression lists above 1000 items (ORA-01795); sql_ids from a
// hostile trace must not reach the SQL or the file names.
func TestRefScriptChunksAndSanitises(t *testing.T) {
	m := &model.Model{File: model.FileInfo{Path: "/tmp/x\ny.trc"}}
	for i := 1; i <= 2500; i++ {
		m.Waits = append(m.Waits, model.Wait{ObjID: int64(100000 + i), Event: model.None})
	}
	m.Statements = []model.Statement{
		{Kind: model.StmtSQL, SQLID: "abcdefghijklm", Text: "select 1", UID: 5},
		{Kind: model.StmtSQL, SQLID: "x'; drop table t; --", Text: "select 2"},
		{Kind: model.StmtSQL, SQLID: "../../etc/passwd", Text: "select 3"},
		{Kind: model.StmtSQL, SQLID: "nodetext000000"[:13], Text: ""},
	}
	sc := RefScript(m, RefScriptOptions{})
	// 2500 ids -> 3 chunks per column
	if n := strings.Count(sc, "object_id in ("); n != 6 { // 3 for object_id, 3 for data_object_id
		t.Errorf("object_id in-lists = %d, want 6", n)
	}
	for _, list := range regexp.MustCompile(`(?s)\bin \(([^)]*)\)`).FindAllStringSubmatch(sc, -1) {
		if n := strings.Count(list[1], ",") + 1; n > 1000 {
			t.Errorf("in-list of %d items", n)
		}
	}
	if strings.Contains(sc, "drop table") || strings.Contains(sc, "passwd") {
		t.Error("untrusted sql_id leaked into the script")
	}
	if strings.Count(sc, "spool ref/plans/") != 1 || !strings.Contains(sc, "abcdefghijklm") {
		t.Errorf("want exactly the one valid sql_id with text:\n%s", sc)
	}
	if !strings.HasPrefix(sc, "-- mtkprof reference script for x?y.trc\n") {
		t.Errorf("trace name not sanitised: %q", strings.SplitN(sc, "\n", 2)[0])
	}
	if !strings.Contains(sc, "-- (no file I/O waits") {
		t.Error("expected the no-file# note")
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
