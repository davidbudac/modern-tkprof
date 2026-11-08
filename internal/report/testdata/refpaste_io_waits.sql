-- mtkprof names script for io_waits.trc
--
-- Prints the names of what the trace refers to by number. Copy its whole
-- output (from "mtkprof-ref 1" to "mtkprof-ref end") and paste it into mtkprof:
-- Import names (the I/O map's Objects tab, or Connections > Reference data).
-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.
--
--      7 obj#     owner, name, partition, type  (DBA_OBJECTS, else ALL_OBJECTS)
--      3 file#    datafile / tempfile, tablespace  (V$DATAFILE, V$TEMPFILE)
--      2 user id  (DBA_USERS, else ALL_USERS)
--
-- Run it as a user with SELECT_CATALOG_ROLE for every name; any other user
-- gets the objects it can see and no file names. For a PDB trace connect to
-- the PDB.
--   SQL*Plus, SQLcl:  sqlplus user/password@db @names.sql   (or paste it at SQL>)
--   SQL Developer:    Run Script (F5), then copy the Script Output
-- Saved to a file (sqlplus -s ... @names.sql > names.txt), the output also
-- works as  mtkprof report io_waits.trc -ref names.txt
-- Only object, file and user names are printed; no table data, no binds.

set serveroutput on size unlimited format wrapped
set echo off feedback off verify off define off heading off
set linesize 32767 pagesize 0 trimout on trimspool on tab off
declare
  type t_cur is ref cursor;
  objs  sys.odcinumberlist := sys.odcinumberlist();
  files sys.odcinumberlist := sys.odcinumberlist();
  uids  sys.odcinumberlist := sys.odcinumberlist();
  procedure put(s varchar2) is begin dbms_output.put_line(s); end;
  function qt(s varchar2) return varchar2 is
  begin
    return '"' || replace(translate(s, chr(10) || chr(13), '  '), '"', '""') || '"';
  end;
  procedure push(l in out nocopy sys.odcinumberlist, v sys.odcinumberlist) is
  begin
    for i in 1 .. v.count loop l.extend; l(l.count) := v(i); end loop;
  end;
  -- prints the rows of stmt (one text column), the ids bound as :ids
  procedure emit(stmt varchar2, ids sys.odcinumberlist) is
    c t_cur;
    l varchar2(32767);
  begin
    open c for stmt using ids;
    loop
      fetch c into l;
      exit when c%notfound;
      put(l);
    end loop;
    close c;
  exception when others then
    if c%isopen then close c; end if;
    raise;
  end;
  -- the rows of stmt, else (a view this user may not read) of alt; what failed is a note
  procedure section(what varchar2, ids sys.odcinumberlist, stmt varchar2, alt varchar2, altnote varchar2) is
    e varchar2(4000);
  begin
    if ids.count = 0 then return; end if;
    emit(stmt, ids);
  exception when others then
    e := sqlerrm;
    if alt is null then put('note,' || qt(what || ': ' || e)); return; end if;
    begin
      emit(alt, ids);
      put('note,' || qt(what || ': ' || e || '; ' || altnote));
    exception when others then
      put('note,' || qt(what || ': ' || sqlerrm));
    end;
  end;
begin
  dbms_output.enable(null);
  push(objs, sys.odcinumberlist(720, 721, 108609, 108610, 108611, 108612, 108613));
  push(files, sys.odcinumberlist(10, 12, 203));
  push(uids, sys.odcinumberlist(0, 165));
  put('mtkprof-ref 1');
  -- objects (waits report object_id or data_object_id)
  section('objects', objs,
    q'[with t as (select column_value id from table(:ids))
    select 'obj,' || object_id || ',' || data_object_id || ',' || '"' || replace(owner, '"', '""') || '"' || ',' || '"' || replace(object_name, '"', '""') || '"' || ',' || '"' || replace(subobject_name, '"', '""') || '"' || ',' || '"' || replace(object_type, '"', '""') || '"'
      from dba_objects
     where object_id in (select id from t) or data_object_id in (select id from t)
     order by object_id]',
    q'[with t as (select column_value id from table(:ids))
    select 'obj,' || object_id || ',' || data_object_id || ',' || '"' || replace(owner, '"', '""') || '"' || ',' || '"' || replace(object_name, '"', '""') || '"' || ',' || '"' || replace(subobject_name, '"', '""') || '"' || ',' || '"' || replace(object_type, '"', '""') || '"'
      from all_objects
     where object_id in (select id from t) or data_object_id in (select id from t)
     order by object_id]',
    'read ALL_OBJECTS: only the objects this user can see');
  -- datafiles and tempfiles (waits report tempfiles as file# + db_files)
  section('datafiles', files,
    q'[with t as (select column_value id from table(:ids))
    select 'file,' || file# || ',' || '"' || replace(name, '"', '""') || '"' || ',' || '"' || replace(tablespace_name, '"', '""') || '"' || ',' || '"' || replace(file_type, '"', '""') || '"' || ',' || abs_file#
      from (
        select d.file# as file#, d.name as name, ts.name as tablespace_name, 'DATAFILE' as file_type, d.file# as abs_file#
          from v$datafile d join v$tablespace ts on ts.ts# = d.ts#
        union all
        select f.file#, f.name, ts.name, 'TEMPFILE', f.file# + (select to_number(value) from v$parameter where name = 'db_files')
          from v$tempfile f join v$tablespace ts on ts.ts# = f.ts#
      )
     where abs_file# in (select id from t)
     order by file_type, file#]',
    null, null);
  -- users (the uid= of the PARSING IN CURSOR lines)
  section('users', uids,
    q'[with t as (select column_value id from table(:ids))
    select 'user,' || user_id || ',' || '"' || replace(username, '"', '""') || '"'
      from dba_users
     where user_id in (select id from t)
     order by user_id]',
    q'[with t as (select column_value id from table(:ids))
    select 'user,' || user_id || ',' || '"' || replace(username, '"', '""') || '"'
      from all_users
     where user_id in (select id from t)
     order by user_id]',
    'read ALL_USERS');
  put('mtkprof-ref end');
end;
/
