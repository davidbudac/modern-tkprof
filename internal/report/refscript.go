package report

import (
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// RefScriptOptions control RefScript.
type RefScriptOptions struct {
	Lite bool // ALL_ views only: no datafile section, nothing that needs DBA_ views
}

// refInListMax is Oracle's limit for an expression list (ORA-01795).
const refInListMax = 1000

// RefColumn is one column of a CSV a RefQuery fills, named as SQL*Plus
// prints it in the header. Number columns are written unquoted, the others
// quoted (set markup csv on quote on).
type RefColumn struct {
	Name   string
	Number bool
}

// RefQuery is one query of the reference bundle. RefScript prints it inside
// a SPOOL; internal/remote/db runs it directly and writes the same file.
type RefQuery struct {
	Name    string      // objects, datafiles, users or plan
	SQL     string      // one statement without the terminating semicolon
	Columns []RefColumn // CSV header; nil for plans
	Target  string      // file in the bundle: objects.csv, datafiles.csv, users.csv, plans/<sql_id>.txt

	// plans only: SQL is the DBMS_XPLAN.DISPLAY_CURSOR query; when its first
	// row says the cursor "cannot be found" (RefPlanMissing) or it returns no
	// rows, Fallback (DISPLAY_AWR) is run instead.
	SQLID    string
	Fallback string
}

// Texts of the plan step, shared by the script and the direct fetch.
const (
	// RefPlanMissing is what DISPLAY_CURSOR prints for an aged-out cursor.
	RefPlanMissing = "cannot be found"
)

// RefPlanNone is the plan file's line when neither query found a plan.
func RefPlanNone(sqlID string) string { return "-- no plan found for " + sqlID }

// RefPlanError is the plan file's line when the plan queries failed.
func RefPlanError(sqlID, err string) string { return "-- no plan for " + sqlID + ": " + err }

var (
	refObjectColumns = []RefColumn{{"OBJECT_ID", true}, {"DATA_OBJECT_ID", true}, {"OWNER", false}, {"OBJECT_NAME", false}, {"SUBOBJECT_NAME", false}, {"OBJECT_TYPE", false}}
	refFileColumns   = []RefColumn{{"FILE#", true}, {"NAME", false}, {"TABLESPACE_NAME", false}, {"FILE_TYPE", false}, {"ABS_FILE#", true}}
	refUserColumns   = []RefColumn{{"USER_ID", true}, {"USERNAME", false}}
)

// refIDs are the numbers and ids of a trace the bundle resolves.
type refIDs struct {
	objs, files, uids []int64
	sqlIDs            []string
}

func collectRefIDs(m *model.Model) refIDs {
	objs := map[int64]bool{}
	waitObjs, waitFiles := m.WaitRefIDs() // an aggregation-only model (the engine's) has no waits: its sink kept their ids
	for _, id := range waitObjs {
		objs[id] = true
	}
	for i := range m.PlanLines {
		if id := m.PlanLines[i].Obj; id > 0 {
			objs[id] = true
		}
	}
	files := map[int64]bool{}
	for _, f := range waitFiles {
		if f >= 0 {
			files[f] = true
		}
	}
	uids := map[int64]bool{}
	sqlIDs := map[string]bool{}
	for i := range m.Statements {
		st := &m.Statements[i]
		if st.Kind != model.StmtSQL {
			continue
		}
		uids[int64(st.UID)] = true
		if st.LID > 0 {
			uids[int64(st.LID)] = true
		}
		if st.SQLID != "" && st.Text != "" && validSQLID(st.SQLID) {
			sqlIDs[st.SQLID] = true
		}
	}
	r := refIDs{objs: sortedKeys(objs), files: sortedKeys(files), uids: sortedKeys(uids)}
	r.sqlIDs = make([]string, 0, len(sqlIDs))
	for id := range sqlIDs {
		r.sqlIDs = append(r.sqlIDs, id)
	}
	sort.Strings(r.sqlIDs)
	return r
}

// RefQueries are the queries that collect the reference data the trace
// needs: names for its obj#, file# and user ids, and DBMS_XPLAN output for
// its sql_ids. Only SELECTs; ids are literals (numbers, and sql_ids checked
// by validSQLID). A part with nothing to look up has no query. lite: ALL_
// views, no datafiles.
func RefQueries(m *model.Model, lite bool) []RefQuery {
	return collectRefIDs(m).queries(lite)
}

func (r refIDs) queries(lite bool) []RefQuery {
	views := struct{ objects, users string }{"dba_objects", "dba_users"}
	if lite {
		views.objects, views.users = "all_objects", "all_users"
	}
	var qs []RefQuery
	if len(r.objs) > 0 {
		var terms []string
		for _, col := range []string{"object_id", "data_object_id"} {
			for _, c := range chunk(r.objs, refInListMax) {
				terms = append(terms, col+" in ("+numList(c)+")")
			}
		}
		qs = append(qs, RefQuery{Name: "objects", Target: "objects.csv", Columns: refObjectColumns,
			SQL: "select object_id, data_object_id, owner, object_name, subobject_name, object_type\n" +
				"  from " + views.objects + "\n where " + strings.Join(terms, "\n    or ") + "\n order by object_id"})
	}
	if !lite && len(r.files) > 0 {
		var terms []string
		for _, c := range chunk(r.files, refInListMax) {
			terms = append(terms, "abs_file# in ("+numList(c)+")")
		}
		qs = append(qs, RefQuery{Name: "datafiles", Target: "datafiles.csv", Columns: refFileColumns,
			SQL: "select file#, name, tablespace_name, file_type, abs_file#\n  from (\n" +
				"    select d.file# as file#, d.name as name, t.name as tablespace_name, 'DATAFILE' as file_type, d.file# as abs_file#\n" +
				"      from v$datafile d join v$tablespace t on t.ts# = d.ts#\n" +
				"    union all\n" +
				"    select f.file#, f.name, t.name, 'TEMPFILE', f.file# + (select to_number(value) from v$parameter where name = 'db_files')\n" +
				"      from v$tempfile f join v$tablespace t on t.ts# = f.ts#\n" +
				"  )\n where " + strings.Join(terms, "\n    or ") + "\n order by file_type, file#"})
	}
	if len(r.uids) > 0 {
		var terms []string
		for _, c := range chunk(r.uids, refInListMax) {
			terms = append(terms, "user_id in ("+numList(c)+")")
		}
		qs = append(qs, RefQuery{Name: "users", Target: "users.csv", Columns: refUserColumns,
			SQL: "select user_id, username\n  from " + views.users + "\n where " + strings.Join(terms, "\n    or ") + "\n order by user_id"})
	}
	for _, id := range r.sqlIDs {
		qs = append(qs, RefQuery{Name: "plan", Target: "plans/" + id + ".txt", SQLID: id,
			SQL:      "select plan_table_output p from table(dbms_xplan.display_cursor('" + id + "', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))",
			Fallback: "select plan_table_output p from table(dbms_xplan.display_awr('" + id + "', null, null, 'TYPICAL +PREDICATE +ALIAS'))"})
	}
	return qs
}

// RefScript writes a SQL*Plus script that runs RefQueries and spools their
// output into ref/. The script only reads. The DBA runs it and gives the
// spooled directory back with -ref (see internal/model/ref.go and
// docs/REF-BUNDLE.md); internal/remote/db runs the same queries directly.
func RefScript(m *model.Model, o RefScriptOptions) string {
	ids := collectRefIDs(m)
	byName := map[string]RefQuery{}
	var plans []RefQuery
	for _, q := range ids.queries(o.Lite) {
		if q.Name == "plan" {
			plans = append(plans, q)
		} else {
			byName[q.Name] = q
		}
	}

	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	trace := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return '?'
		}
		return r
	}, filepath.Base(m.File.Path))

	w("-- mtkprof reference script for %s\n", trace)
	w("--\n")
	if o.Lite {
		w("-- LITE variant: reads only ALL_ views, so any schema can run it. Names of\n")
		w("-- objects the connected user cannot see are missing, and datafile names are\n")
		w("-- not collected (they need the DBA views). Plans work if the user can read\n")
		w("-- V$SQL_PLAN; otherwise the plan files only hold an error note.\n")
	} else {
		w("-- Needs SELECT_CATALOG_ROLE (DBA views and V$ views).\n")
	}
	w("-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.\n")
	w("--\n")
	w("-- It looks up what the trace refers to by number or id:\n")
	w("--   %4d obj#     -> ref/objects.csv    (owner, name, partition, type)\n", len(ids.objs))
	if !o.Lite {
		w("--   %4d file#    -> ref/datafiles.csv  (datafile / tempfile name, tablespace)\n", len(ids.files))
	}
	w("--   %4d user id  -> ref/users.csv\n", len(ids.uids))
	w("--   %4d sql_id   -> ref/plans/<sql_id>.txt  (DBMS_XPLAN.DISPLAY_CURSOR, ALLSTATS LAST\n", len(ids.sqlIDs))
	w("--                       +PREDICATE +ALIAS; DISPLAY_AWR when the cursor has aged out)\n")
	w("--\n")
	w("-- Run it from a directory that has ref/ and ref/plans/ (SPOOL does not create\n")
	w("-- directories):\n")
	w("--   mkdir -p ref/plans        (Windows: mkdir ref ref\\plans)\n")
	w("--   sqlplus user/password@db @ref.sql\n")
	w("-- then analyse with:  mtkprof report %s -ref ref\n", trace)
	w("-- Only object, file and user names and execution plans are collected; no table\n")
	w("-- data and no bind values leave the database. Review ref/ before sharing it.\n")
	w("\n")
	w("whenever sqlerror continue\n")
	w("set echo off feedback off verify off heading on trimspool on\n")
	w("set linesize 32767 pagesize 50000 long 1000000\n")
	w("set markup csv on quote on\n")
	spool := func(q RefQuery) {
		w("spool ref/%s\n%s;\nspool off\n", q.Target, q.SQL)
	}

	w("\n-- objects\n")
	if q, ok := byName["objects"]; ok {
		spool(q)
	} else {
		w("-- (no obj# in this trace)\n")
	}

	// datafiles (DBA only)
	if !o.Lite {
		w("\n-- datafiles and tempfiles; wait events report tempfiles as file# + db_files\n")
		if q, ok := byName["datafiles"]; ok {
			spool(q)
		} else {
			w("-- (no file I/O waits with a file# in this trace)\n")
		}
	}

	w("\n-- users (the uid= of the PARSING IN CURSOR lines)\n")
	if q, ok := byName["users"]; ok {
		spool(q)
	} else {
		w("-- (no parsing user ids in this trace)\n")
	}

	w("\n-- execution plans, one file per sql_id. An aged-out cursor makes DISPLAY_CURSOR\n")
	w("-- print \"%s\"; the block then tries the AWR repository. Failures are\n", RefPlanMissing)
	w("-- caught per sql_id, so one missing plan does not stop the others.\n")
	if len(plans) == 0 {
		w("-- (no sql_id with text in this trace)\n")
	} else {
		w("set markup csv off\n")
		w("set serveroutput on size unlimited format wrapped\n")
		w("set linesize 1000 pagesize 0 heading off tab off\n")
		for _, q := range plans {
			w("\nspool ref/%s\n", q.Target)
			w("declare\n")
			w("  l_n    pls_integer := 0;\n")
			w("  l_miss boolean := false;\n")
			w("begin\n")
			w("  for r in (%s) loop\n", q.SQL)
			w("    if l_n = 0 and r.p like '%%%s%%' then l_miss := true; exit; end if;\n", RefPlanMissing)
			w("    l_n := l_n + 1;\n")
			w("    dbms_output.put_line(r.p);\n")
			w("  end loop;\n")
			w("  if l_miss or l_n = 0 then\n")
			w("    for r in (%s) loop\n", q.Fallback)
			w("      l_n := l_n + 1;\n")
			w("      dbms_output.put_line(r.p);\n")
			w("    end loop;\n")
			w("  end if;\n")
			w("  if l_n = 0 then dbms_output.put_line('%s'); end if;\n", RefPlanNone(q.SQLID))
			w("exception when others then\n")
			w("  dbms_output.put_line('%s' || sqlerrm);\n", RefPlanError(q.SQLID, ""))
			w("end;\n/\n")
			w("spool off\n")
		}
	}
	w("\nexit\n")
	return b.String()
}

// validSQLID: sql_ids come from an untrusted trace and end up in SQL and
// file names, so only accept the characters Oracle uses (base-32 digits).
func validSQLID(s string) bool {
	if len(s) == 0 || len(s) > 13 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

func sortedKeys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func chunk(v []int64, n int) [][]int64 {
	var out [][]int64
	for len(v) > n {
		out = append(out, v[:n])
		v = v[n:]
	}
	if len(v) > 0 {
		out = append(out, v)
	}
	return out
}

// numList formats ids ten to a line, wrapped to align under the opening bracket.
func numList(v []int64) string {
	var b strings.Builder
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
			if i%10 == 0 {
				b.WriteString("\n        ")
			} else {
				b.WriteByte(' ')
			}
		}
		b.WriteString(strconv.FormatInt(x, 10))
	}
	return b.String()
}
