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

// RefScript writes a SQL*Plus script that collects the reference data the
// trace needs: names for its obj#, file# and user ids, and DBMS_XPLAN output
// for its sql_ids. The script only reads. mtkprof itself never connects to a
// database: the DBA runs the script and gives the spooled directory back with
// -ref (see internal/model/ref.go and docs/REF-BUNDLE.md).
func RefScript(m *model.Model, o RefScriptOptions) string {
	objs := map[int64]bool{}
	for i := range m.Waits {
		if id := m.Waits[i].ObjID; id > 0 {
			objs[id] = true
		}
	}
	for i := range m.PlanLines {
		if id := m.PlanLines[i].Obj; id > 0 {
			objs[id] = true
		}
	}
	files := map[int64]bool{}
	for i := range m.Waits {
		if f, ok := m.WaitFile(&m.Waits[i]); ok && f >= 0 {
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
	objList, fileList, uidList := sortedKeys(objs), sortedKeys(files), sortedKeys(uids)
	idList := make([]string, 0, len(sqlIDs))
	for id := range sqlIDs {
		idList = append(idList, id)
	}
	sort.Strings(idList)

	views := struct{ objects, users string }{"dba_objects", "dba_users"}
	if o.Lite {
		views.objects, views.users = "all_objects", "all_users"
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
	w("--   %4d obj#     -> ref/objects.csv    (owner, name, partition, type)\n", len(objList))
	if !o.Lite {
		w("--   %4d file#    -> ref/datafiles.csv  (datafile / tempfile name, tablespace)\n", len(fileList))
	}
	w("--   %4d user id  -> ref/users.csv\n", len(uidList))
	w("--   %4d sql_id   -> ref/plans/<sql_id>.txt  (DBMS_XPLAN.DISPLAY_CURSOR, ALLSTATS LAST\n", len(idList))
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

	// objects
	w("\n-- objects\n")
	if len(objList) == 0 {
		w("-- (no obj# in this trace)\n")
	} else {
		w("spool ref/objects.csv\n")
		w("select object_id, data_object_id, owner, object_name, subobject_name, object_type\n")
		w("  from %s\n where ", views.objects)
		var terms []string
		for _, col := range []string{"object_id", "data_object_id"} {
			for _, c := range chunk(objList, refInListMax) {
				terms = append(terms, col+" in ("+numList(c)+")")
			}
		}
		w("%s\n order by object_id;\n", strings.Join(terms, "\n    or "))
		w("spool off\n")
	}

	// datafiles (DBA only)
	if !o.Lite {
		w("\n-- datafiles and tempfiles; wait events report tempfiles as file# + db_files\n")
		if len(fileList) == 0 {
			w("-- (no file I/O waits with a file# in this trace)\n")
		} else {
			w("spool ref/datafiles.csv\n")
			w("select file#, name, tablespace_name, file_type, abs_file#\n  from (\n")
			w("    select d.file# as file#, d.name as name, t.name as tablespace_name, 'DATAFILE' as file_type, d.file# as abs_file#\n")
			w("      from v$datafile d join v$tablespace t on t.ts# = d.ts#\n")
			w("    union all\n")
			w("    select f.file#, f.name, t.name, 'TEMPFILE', f.file# + (select to_number(value) from v$parameter where name = 'db_files')\n")
			w("      from v$tempfile f join v$tablespace t on t.ts# = f.ts#\n")
			w("  )\n where ")
			var terms []string
			for _, c := range chunk(fileList, refInListMax) {
				terms = append(terms, "abs_file# in ("+numList(c)+")")
			}
			w("%s\n order by file_type, file#;\n", strings.Join(terms, "\n    or "))
			w("spool off\n")
		}
	}

	// users
	w("\n-- users (the uid= of the PARSING IN CURSOR lines)\n")
	if len(uidList) == 0 {
		w("-- (no parsing user ids in this trace)\n")
	} else {
		w("spool ref/users.csv\n")
		w("select user_id, username\n  from %s\n where ", views.users)
		var terms []string
		for _, c := range chunk(uidList, refInListMax) {
			terms = append(terms, "user_id in ("+numList(c)+")")
		}
		w("%s\n order by user_id;\n", strings.Join(terms, "\n    or "))
		w("spool off\n")
	}

	// plans
	w("\n-- execution plans, one file per sql_id. An aged-out cursor makes DISPLAY_CURSOR\n")
	w("-- print \"cannot be found\"; the block then tries the AWR repository. Failures are\n")
	w("-- caught per sql_id, so one missing plan does not stop the others.\n")
	if len(idList) == 0 {
		w("-- (no sql_id with text in this trace)\n")
	} else {
		w("set markup csv off\n")
		w("set serveroutput on size unlimited format wrapped\n")
		w("set linesize 1000 pagesize 0 heading off tab off\n")
		for _, id := range idList {
			w("\nspool ref/plans/%s.txt\n", id)
			w("declare\n")
			w("  l_n    pls_integer := 0;\n")
			w("  l_miss boolean := false;\n")
			w("begin\n")
			w("  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('%s', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop\n", id)
			w("    if l_n = 0 and r.p like '%%cannot be found%%' then l_miss := true; exit; end if;\n")
			w("    l_n := l_n + 1;\n")
			w("    dbms_output.put_line(r.p);\n")
			w("  end loop;\n")
			w("  if l_miss or l_n = 0 then\n")
			w("    for r in (select plan_table_output p from table(dbms_xplan.display_awr('%s', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop\n", id)
			w("      l_n := l_n + 1;\n")
			w("      dbms_output.put_line(r.p);\n")
			w("    end loop;\n")
			w("  end if;\n")
			w("  if l_n = 0 then dbms_output.put_line('-- no plan found for %s'); end if;\n", id)
			w("exception when others then\n")
			w("  dbms_output.put_line('-- no plan for %s: ' || sqlerrm);\n", id)
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
