package report

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// RefPasteOptions control RefPasteScript.
type RefPasteOptions struct {
	Plans bool // DBMS_XPLAN output for the trace's sql_ids too (a much longer output)
}

// RefCounts are how many ids of each kind the reference data looks up.
type RefCounts struct {
	Objects int `json:"objects"`
	Files   int `json:"files"`
	Users   int `json:"users"`
	Plans   int `json:"plans"`
}

// RefCountsOf counts the ids of m the reference scripts look up.
func RefCountsOf(m *model.Model) RefCounts {
	r := collectRefIDs(m)
	return RefCounts{Objects: len(r.objs), Files: len(r.files), Users: len(r.uids), Plans: len(r.sqlIDs)}
}

// refPasteListMax: the ids go into the block as sys.odcinumberlist literals
// of at most this many (a constructor is a function call).
const refPasteListMax = 1000

// refPasteIDsMax is the capacity of sys.odcinumberlist (a varray).
const refPasteIDsMax = 32767

// sqlText is the SQL expression that writes column col as a quoted CSV
// field: " doubled, NULL as "".
func sqlText(col string) string {
	return `'"' || replace(` + col + `, '"', '""') || '"'`
}

// RefPasteScript writes the names script: one read-only PL/SQL block that
// prints the reference data of the trace (ref.PasteHeader explains the lines)
// to be copied from the client's output and pasted into mtkprof, instead of
// spooling a bundle directory (RefScript). It needs no directories and runs in
// SQL*Plus, SQLcl and SQL Developer (Run Script). A part the user may not
// read in the DBA_ views is read from the ALL_ views, and a note line says
// so; a part that fails altogether becomes a note line, the rest still runs.
func RefPasteScript(m *model.Model, o RefPasteOptions) string {
	ids := collectRefIDs(m)
	capped := func(v []int64) []int64 {
		if len(v) > refPasteIDsMax {
			return v[:refPasteIDsMax]
		}
		return v
	}
	ids.objs, ids.files, ids.uids = capped(ids.objs), capped(ids.files), capped(ids.uids)
	if !o.Plans {
		ids.sqlIDs = nil
	} else if len(ids.sqlIDs) > refPasteIDsMax {
		ids.sqlIDs = ids.sqlIDs[:refPasteIDsMax]
	}

	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	trace := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return '?'
		}
		return r
	}, filepath.Base(m.File.Path))

	w("-- mtkprof names script for %s\n", trace)
	w("--\n")
	w("-- Prints the names of what the trace refers to by number. Copy its whole\n")
	w("-- output (from %q to %q) and paste it into mtkprof:\n", ref.PasteHeader, ref.PasteEnd)
	w("-- Import names (the I/O map's Objects tab, or Connections > Reference data).\n")
	w("-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.\n")
	w("--\n")
	w("--   %4d obj#     owner, name, partition, type  (DBA_OBJECTS, else ALL_OBJECTS)\n", len(ids.objs))
	w("--   %4d file#    datafile / tempfile, tablespace  (V$DATAFILE, V$TEMPFILE)\n", len(ids.files))
	w("--   %4d user id  (DBA_USERS, else ALL_USERS)\n", len(ids.uids))
	if o.Plans {
		w("--   %4d sql_id   DBMS_XPLAN.DISPLAY_CURSOR, else DISPLAY_AWR\n", len(ids.sqlIDs))
	}
	w("--\n")
	w("-- Run it as a user with SELECT_CATALOG_ROLE for every name; any other user\n")
	w("-- gets the objects it can see and no file names. For a PDB trace connect to\n")
	w("-- the PDB.\n")
	w("--   SQL*Plus, SQLcl:  sqlplus user/password@db @names.sql   (or paste it at SQL>)\n")
	w("--   SQL Developer:    Run Script (F5), then copy the Script Output\n")
	w("-- Saved to a file (sqlplus -s ... @names.sql > names.txt), the output also\n")
	w("-- works as  mtkprof report %s -ref names.txt\n", trace)
	w("-- Only object, file and user names%s are printed; no table data, no binds.\n", map[bool]string{true: " and execution plans"}[o.Plans])
	w("\n")
	w("set serveroutput on size unlimited format wrapped\n")
	w("set echo off feedback off verify off define off heading off\n")
	w("set linesize 32767 pagesize 0 trimout on trimspool on tab off\n")
	w("declare\n")
	w("  type t_cur is ref cursor;\n")
	w("  objs  sys.odcinumberlist := sys.odcinumberlist();\n")
	w("  files sys.odcinumberlist := sys.odcinumberlist();\n")
	w("  uids  sys.odcinumberlist := sys.odcinumberlist();\n")
	if o.Plans {
		w("  sqlids sys.odcivarchar2list := sys.odcivarchar2list();\n")
	}
	w("  procedure put(s varchar2) is begin dbms_output.put_line(s); end;\n")
	w("  function qt(s varchar2) return varchar2 is\n")
	w("  begin\n")
	w("    return '\"' || replace(translate(s, chr(10) || chr(13), '  '), '\"', '\"\"') || '\"';\n")
	w("  end;\n")
	w("  procedure push(l in out nocopy sys.odcinumberlist, v sys.odcinumberlist) is\n")
	w("  begin\n")
	w("    for i in 1 .. v.count loop l.extend; l(l.count) := v(i); end loop;\n")
	w("  end;\n")
	if o.Plans {
		w("  procedure push(l in out nocopy sys.odcivarchar2list, v sys.odcivarchar2list) is\n")
		w("  begin\n")
		w("    for i in 1 .. v.count loop l.extend; l(l.count) := v(i); end loop;\n")
		w("  end;\n")
	}
	w("  -- prints the rows of stmt (one text column), the ids bound as :ids\n")
	w("  procedure emit(stmt varchar2, ids sys.odcinumberlist) is\n")
	w("    c t_cur;\n")
	w("    l varchar2(32767);\n")
	w("  begin\n")
	w("    open c for stmt using ids;\n")
	w("    loop\n")
	w("      fetch c into l;\n")
	w("      exit when c%%notfound;\n")
	w("      put(l);\n")
	w("    end loop;\n")
	w("    close c;\n")
	w("  exception when others then\n")
	w("    if c%%isopen then close c; end if;\n")
	w("    raise;\n")
	w("  end;\n")
	w("  -- the rows of stmt, else (a view this user may not read) of alt; what failed is a note\n")
	w("  procedure section(what varchar2, ids sys.odcinumberlist, stmt varchar2, alt varchar2, altnote varchar2) is\n")
	w("    e varchar2(4000);\n")
	w("  begin\n")
	w("    if ids.count = 0 then return; end if;\n")
	w("    emit(stmt, ids);\n")
	w("  exception when others then\n")
	w("    e := sqlerrm;\n")
	w("    if alt is null then put('note,' || qt(what || ': ' || e)); return; end if;\n")
	w("    begin\n")
	w("      emit(alt, ids);\n")
	w("      put('note,' || qt(what || ': ' || e || '; ' || altnote));\n")
	w("    exception when others then\n")
	w("      put('note,' || qt(what || ': ' || sqlerrm));\n")
	w("    end;\n")
	w("  end;\n")
	w("begin\n")
	w("  dbms_output.enable(null);\n")
	pushNums := func(list string, v []int64) {
		for _, c := range chunk(v, refPasteListMax) {
			w("  push(%s, sys.odcinumberlist(%s));\n", list, pasteNumList(c))
		}
	}
	pushNums("objs", ids.objs)
	pushNums("files", ids.files)
	pushNums("uids", ids.uids)
	for i := 0; i < len(ids.sqlIDs); i += refPasteListMax {
		c := ids.sqlIDs[i:min(i+refPasteListMax, len(ids.sqlIDs))]
		q := make([]string, len(c))
		for k, id := range c {
			q[k] = "'" + id + "'" // validSQLID: base-32 digits only
		}
		w("  push(sqlids, sys.odcivarchar2list(%s));\n", strings.Join(q, ", "))
	}
	w("  put('%s');\n", ref.PasteHeader)

	objects := func(view string) string {
		return "with t as (select column_value id from table(:ids))\n" +
			"select 'obj,' || object_id || ',' || data_object_id || ',' || " + sqlText("owner") + " || ',' || " + sqlText("object_name") +
			" || ',' || " + sqlText("subobject_name") + " || ',' || " + sqlText("object_type") + "\n" +
			"  from " + view + "\n" +
			" where object_id in (select id from t) or data_object_id in (select id from t)\n" +
			" order by object_id"
	}
	files := "with t as (select column_value id from table(:ids))\n" +
		"select 'file,' || file# || ',' || " + sqlText("name") + " || ',' || " + sqlText("tablespace_name") + " || ',' || " + sqlText("file_type") + " || ',' || abs_file#\n" +
		"  from (\n" +
		"    select d.file# as file#, d.name as name, ts.name as tablespace_name, 'DATAFILE' as file_type, d.file# as abs_file#\n" +
		"      from v$datafile d join v$tablespace ts on ts.ts# = d.ts#\n" +
		"    union all\n" +
		"    select f.file#, f.name, ts.name, 'TEMPFILE', f.file# + (select to_number(value) from v$parameter where name = 'db_files')\n" +
		"      from v$tempfile f join v$tablespace ts on ts.ts# = f.ts#\n" +
		"  )\n" +
		" where abs_file# in (select id from t)\n" +
		" order by file_type, file#"
	users := func(view string) string {
		return "with t as (select column_value id from table(:ids))\n" +
			"select 'user,' || user_id || ',' || " + sqlText("username") + "\n" +
			"  from " + view + "\n" +
			" where user_id in (select id from t)\n" +
			" order by user_id"
	}
	lit := func(s string) string { return "q'[" + strings.ReplaceAll(s, "\n", "\n    ") + "]'" } // the SQL holds no "]'"
	section := func(what, list, stmt, alt, altnote string) {
		w("  section('%s', %s,\n    %s,\n", what, list, lit(stmt))
		if alt == "" {
			w("    null, null);\n")
		} else {
			w("    %s,\n    '%s');\n", lit(alt), altnote)
		}
	}
	w("  -- objects (waits report object_id or data_object_id)\n")
	section("objects", "objs", objects("dba_objects"), objects("all_objects"), "read ALL_OBJECTS: only the objects this user can see")
	w("  -- datafiles and tempfiles (waits report tempfiles as file# + db_files)\n")
	section("datafiles", "files", files, "", "")
	w("  -- users (the uid= of the PARSING IN CURSOR lines)\n")
	section("users", "uids", users("dba_users"), users("all_users"), "read ALL_USERS")
	if o.Plans {
		w("  -- execution plans: DISPLAY_CURSOR, else (the cursor aged out) DISPLAY_AWR\n")
		w("  for i in 1 .. sqlids.count loop\n")
		w("    declare\n")
		w("      sqlid varchar2(13) := sqlids(i);\n")
		w("      n     pls_integer := 0;\n")
		w("      miss  boolean := false;\n")
		w("    begin\n")
		w("      for r in (select plan_table_output p from table(dbms_xplan.display_cursor(sqlid, null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop\n")
		w("        if n = 0 and r.p like '%%%s%%' then miss := true; exit; end if;\n", RefPlanMissing)
		w("        n := n + 1;\n")
		w("        put('plan,' || qt(sqlid) || ',' || qt(r.p));\n")
		w("      end loop;\n")
		w("      if miss or n = 0 then\n")
		w("        for r in (select plan_table_output p from table(dbms_xplan.display_awr(sqlid, null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop\n")
		w("          n := n + 1;\n")
		w("          put('plan,' || qt(sqlid) || ',' || qt(r.p));\n")
		w("        end loop;\n")
		w("      end if;\n")
		w("      if n = 0 then put('note,' || qt('plan ' || sqlid || ': no plan found')); end if;\n")
		w("    exception when others then\n")
		w("      put('note,' || qt('plan ' || sqlid || ': ' || sqlerrm));\n")
		w("    end;\n")
		w("  end loop;\n")
	}
	w("  put('%s');\n", ref.PasteEnd)
	w("end;\n")
	w("/\n")
	return b.String()
}

// pasteNumList formats ids ten to a line, indented under the push call.
func pasteNumList(v []int64) string {
	var b strings.Builder
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
			if i%10 == 0 {
				b.WriteString("\n    ")
			} else {
				b.WriteByte(' ')
			}
		}
		b.WriteString(strconv.FormatInt(x, 10))
	}
	return b.String()
}

// RefNamed counts, of the ids RefCountsOf counts, those the model's applied
// bundle names (model.ApplyRef): objects, datafiles, users, and sql_ids with
// a DBMS_XPLAN plan.
func RefNamed(m *model.Model) RefCounts {
	r := collectRefIDs(m)
	var c RefCounts
	for _, id := range r.objs {
		if m.ObjectName(id) != "" {
			c.Objects++
		}
	}
	for _, f := range r.files {
		if m.FileName(f) != "" {
			c.Files++
		}
	}
	for _, u := range r.uids {
		if m.UserName(u) != "" {
			c.Users++
		}
	}
	planned := map[string]bool{}
	for i := range m.Statements {
		if st := &m.Statements[i]; st.RefPlan != "" {
			planned[st.SQLID] = true
		}
	}
	for _, id := range r.sqlIDs {
		if planned[id] {
			c.Plans++
		}
	}
	return c
}

// RefCountsOfBundle counts a bundle's entries.
func RefCountsOfBundle(b *ref.Bundle) RefCounts {
	return RefCounts{Objects: len(b.Objects), Files: len(b.Files), Users: len(b.Users), Plans: len(b.Plans)}
}

// RefPasteScriptName is a file name for the names script of m: names-<trace>.sql.
func RefPasteScriptName(m *model.Model) string {
	base := strings.TrimSuffix(filepath.Base(m.File.Path), filepath.Ext(m.File.Path))
	base = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '_'
	}, base)
	if base == "" || base == "." {
		base = "trace"
	}
	return "names-" + base + ".sql"
}
