-- mtkprof reference script for basic_binds.trc
--
-- Needs SELECT_CATALOG_ROLE (DBA views and V$ views).
-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.
--
-- It looks up what the trace refers to by number or id:
--      4 obj#     -> ref/objects.csv    (owner, name, partition, type)
--      1 file#    -> ref/datafiles.csv  (datafile / tempfile name, tablespace)
--      2 user id  -> ref/users.csv
--     21 sql_id   -> ref/plans/<sql_id>.txt  (DBMS_XPLAN.DISPLAY_CURSOR, ALLSTATS LAST
--                       +PREDICATE +ALIAS; DISPLAY_AWR when the cursor has aged out)
--
-- Run it from a directory that has ref/ and ref/plans/ (SPOOL does not create
-- directories):
--   mkdir -p ref/plans        (Windows: mkdir ref ref\plans)
--   sqlplus user/password@db @ref.sql
-- then analyse with:  mtkprof report basic_binds.trc -ref ref
-- Only object, file and user names and execution plans are collected; no table
-- data and no bind values leave the database. Review ref/ before sharing it.

whenever sqlerror continue
set echo off feedback off verify off heading on trimspool on
set linesize 32767 pagesize 50000 long 1000000
set markup csv on quote on

-- objects
spool ref/objects.csv
select object_id, data_object_id, owner, object_name, subobject_name, object_type
  from dba_objects
 where object_id in (720, 721, 108609, 108610)
    or data_object_id in (720, 721, 108609, 108610)
 order by object_id;
spool off

-- datafiles and tempfiles; wait events report tempfiles as file# + db_files
spool ref/datafiles.csv
select file#, name, tablespace_name, file_type, abs_file#
  from (
    select d.file# as file#, d.name as name, t.name as tablespace_name, 'DATAFILE' as file_type, d.file# as abs_file#
      from v$datafile d join v$tablespace t on t.ts# = d.ts#
    union all
    select f.file#, f.name, t.name, 'TEMPFILE', f.file# + (select to_number(value) from v$parameter where name = 'db_files')
      from v$tempfile f join v$tablespace t on t.ts# = f.ts#
  )
 where abs_file# in (10)
 order by file_type, file#;
spool off

-- users (the uid= of the PARSING IN CURSOR lines)
spool ref/users.csv
select user_id, username
  from dba_users
 where user_id in (0, 165)
 order by user_id;
spool off

-- execution plans, one file per sql_id. An aged-out cursor makes DISPLAY_CURSOR
-- print "cannot be found"; the block then tries the AWR repository. Failures are
-- caught per sql_id, so one missing plan does not stop the others.
set markup csv off
set serveroutput on size unlimited format wrapped
set linesize 1000 pagesize 0 heading off tab off

spool ref/plans/06nvwn223659v.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('06nvwn223659v', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('06nvwn223659v', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 06nvwn223659v'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 06nvwn223659v: ' || sqlerrm);
end;
/
spool off

spool ref/plans/0qf2w6jy1fpmg.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('0qf2w6jy1fpmg', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('0qf2w6jy1fpmg', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 0qf2w6jy1fpmg'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 0qf2w6jy1fpmg: ' || sqlerrm);
end;
/
spool off

spool ref/plans/10gywwmwk6xfy.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('10gywwmwk6xfy', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('10gywwmwk6xfy', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 10gywwmwk6xfy'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 10gywwmwk6xfy: ' || sqlerrm);
end;
/
spool off

spool ref/plans/1b1sdgct70uyr.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('1b1sdgct70uyr', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('1b1sdgct70uyr', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 1b1sdgct70uyr'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 1b1sdgct70uyr: ' || sqlerrm);
end;
/
spool off

spool ref/plans/1xbtgu3frcgwx.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('1xbtgu3frcgwx', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('1xbtgu3frcgwx', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 1xbtgu3frcgwx'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 1xbtgu3frcgwx: ' || sqlerrm);
end;
/
spool off

spool ref/plans/2a5gr8t4zcw1r.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('2a5gr8t4zcw1r', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('2a5gr8t4zcw1r', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 2a5gr8t4zcw1r'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 2a5gr8t4zcw1r: ' || sqlerrm);
end;
/
spool off

spool ref/plans/2vuucsj8rdyqn.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('2vuucsj8rdyqn', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('2vuucsj8rdyqn', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 2vuucsj8rdyqn'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 2vuucsj8rdyqn: ' || sqlerrm);
end;
/
spool off

spool ref/plans/34sd41a62205a.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('34sd41a62205a', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('34sd41a62205a', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 34sd41a62205a'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 34sd41a62205a: ' || sqlerrm);
end;
/
spool off

spool ref/plans/555wazjt00pfr.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('555wazjt00pfr', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('555wazjt00pfr', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 555wazjt00pfr'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 555wazjt00pfr: ' || sqlerrm);
end;
/
spool off

spool ref/plans/5skrvwtc8qmrc.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('5skrvwtc8qmrc', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('5skrvwtc8qmrc', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 5skrvwtc8qmrc'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 5skrvwtc8qmrc: ' || sqlerrm);
end;
/
spool off

spool ref/plans/603bhnksn9zks.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('603bhnksn9zks', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('603bhnksn9zks', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 603bhnksn9zks'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 603bhnksn9zks: ' || sqlerrm);
end;
/
spool off

spool ref/plans/7hf8u22rgqn7f.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('7hf8u22rgqn7f', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('7hf8u22rgqn7f', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 7hf8u22rgqn7f'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 7hf8u22rgqn7f: ' || sqlerrm);
end;
/
spool off

spool ref/plans/8h4hft44jngx3.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('8h4hft44jngx3', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('8h4hft44jngx3', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 8h4hft44jngx3'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 8h4hft44jngx3: ' || sqlerrm);
end;
/
spool off

spool ref/plans/8t067txm216hb.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('8t067txm216hb', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('8t067txm216hb', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 8t067txm216hb'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 8t067txm216hb: ' || sqlerrm);
end;
/
spool off

spool ref/plans/9h8pw1x9xgbsj.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('9h8pw1x9xgbsj', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('9h8pw1x9xgbsj', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 9h8pw1x9xgbsj'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 9h8pw1x9xgbsj: ' || sqlerrm);
end;
/
spool off

spool ref/plans/a6txjhtbq9x8p.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('a6txjhtbq9x8p', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('a6txjhtbq9x8p', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for a6txjhtbq9x8p'); end if;
exception when others then
  dbms_output.put_line('-- no plan for a6txjhtbq9x8p: ' || sqlerrm);
end;
/
spool off

spool ref/plans/atbp0549pnzjg.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('atbp0549pnzjg', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('atbp0549pnzjg', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for atbp0549pnzjg'); end if;
exception when others then
  dbms_output.put_line('-- no plan for atbp0549pnzjg: ' || sqlerrm);
end;
/
spool off

spool ref/plans/b82pqjfm8rnb1.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('b82pqjfm8rnb1', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('b82pqjfm8rnb1', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for b82pqjfm8rnb1'); end if;
exception when others then
  dbms_output.put_line('-- no plan for b82pqjfm8rnb1: ' || sqlerrm);
end;
/
spool off

spool ref/plans/cnxqg71x9438y.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('cnxqg71x9438y', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('cnxqg71x9438y', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for cnxqg71x9438y'); end if;
exception when others then
  dbms_output.put_line('-- no plan for cnxqg71x9438y: ' || sqlerrm);
end;
/
spool off

spool ref/plans/dbvj6jc977hqh.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('dbvj6jc977hqh', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('dbvj6jc977hqh', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for dbvj6jc977hqh'); end if;
exception when others then
  dbms_output.put_line('-- no plan for dbvj6jc977hqh: ' || sqlerrm);
end;
/
spool off

spool ref/plans/f6jyzt7462kx2.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('f6jyzt7462kx2', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('f6jyzt7462kx2', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for f6jyzt7462kx2'); end if;
exception when others then
  dbms_output.put_line('-- no plan for f6jyzt7462kx2: ' || sqlerrm);
end;
/
spool off

exit
