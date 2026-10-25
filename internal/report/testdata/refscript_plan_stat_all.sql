-- mtkprof reference script for plan_stat_all.trc
--
-- Needs SELECT_CATALOG_ROLE (DBA views and V$ views).
-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.
--
-- It looks up what the trace refers to by number or id:
--      2 obj#     -> ref/objects.csv    (owner, name, partition, type)
--      0 file#    -> ref/datafiles.csv  (datafile / tempfile name, tablespace)
--      1 user id  -> ref/users.csv
--     15 sql_id   -> ref/plans/<sql_id>.txt  (DBMS_XPLAN.DISPLAY_CURSOR, ALLSTATS LAST
--                       +PREDICATE +ALIAS; DISPLAY_AWR when the cursor has aged out)
--
-- Run it from a directory that has ref/ and ref/plans/ (SPOOL does not create
-- directories):
--   mkdir -p ref/plans        (Windows: mkdir ref ref\plans)
--   sqlplus user/password@db @ref.sql
-- then analyse with:  mtkprof report plan_stat_all.trc -ref ref
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
 where object_id in (108611, 108613)
    or data_object_id in (108611, 108613)
 order by object_id;
spool off

-- datafiles and tempfiles; wait events report tempfiles as file# + db_files
-- (no file I/O waits with a file# in this trace)

-- users (the uid= of the PARSING IN CURSOR lines)
spool ref/users.csv
select user_id, username
  from dba_users
 where user_id in (165)
 order by user_id;
spool off

-- execution plans, one file per sql_id. An aged-out cursor makes DISPLAY_CURSOR
-- print "cannot be found"; the block then tries the AWR repository. Failures are
-- caught per sql_id, so one missing plan does not stop the others.
set markup csv off
set serveroutput on size unlimited format wrapped
set linesize 1000 pagesize 0 heading off tab off

spool ref/plans/00dz651v9yn1q.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('00dz651v9yn1q', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('00dz651v9yn1q', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 00dz651v9yn1q'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 00dz651v9yn1q: ' || sqlerrm);
end;
/
spool off

spool ref/plans/2pfbk1wk3zyq4.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('2pfbk1wk3zyq4', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('2pfbk1wk3zyq4', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 2pfbk1wk3zyq4'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 2pfbk1wk3zyq4: ' || sqlerrm);
end;
/
spool off

spool ref/plans/3uzh8049h89zn.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('3uzh8049h89zn', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('3uzh8049h89zn', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 3uzh8049h89zn'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 3uzh8049h89zn: ' || sqlerrm);
end;
/
spool off

spool ref/plans/6pm4h055mu5s4.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('6pm4h055mu5s4', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('6pm4h055mu5s4', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 6pm4h055mu5s4'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 6pm4h055mu5s4: ' || sqlerrm);
end;
/
spool off

spool ref/plans/6yn8asfckva3u.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('6yn8asfckva3u', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('6yn8asfckva3u', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 6yn8asfckva3u'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 6yn8asfckva3u: ' || sqlerrm);
end;
/
spool off

spool ref/plans/7226hs0335m60.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('7226hs0335m60', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('7226hs0335m60', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 7226hs0335m60'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 7226hs0335m60: ' || sqlerrm);
end;
/
spool off

spool ref/plans/8640t5yz70r29.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('8640t5yz70r29', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('8640t5yz70r29', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 8640t5yz70r29'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 8640t5yz70r29: ' || sqlerrm);
end;
/
spool off

spool ref/plans/8ff2wa3agwt7s.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('8ff2wa3agwt7s', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('8ff2wa3agwt7s', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 8ff2wa3agwt7s'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 8ff2wa3agwt7s: ' || sqlerrm);
end;
/
spool off

spool ref/plans/96pp7vgp4u06b.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('96pp7vgp4u06b', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('96pp7vgp4u06b', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 96pp7vgp4u06b'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 96pp7vgp4u06b: ' || sqlerrm);
end;
/
spool off

spool ref/plans/bnh0fba5bduzw.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('bnh0fba5bduzw', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('bnh0fba5bduzw', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for bnh0fba5bduzw'); end if;
exception when others then
  dbms_output.put_line('-- no plan for bnh0fba5bduzw: ' || sqlerrm);
end;
/
spool off

spool ref/plans/bz2z37aj1gkkw.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('bz2z37aj1gkkw', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('bz2z37aj1gkkw', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for bz2z37aj1gkkw'); end if;
exception when others then
  dbms_output.put_line('-- no plan for bz2z37aj1gkkw: ' || sqlerrm);
end;
/
spool off

spool ref/plans/d3fcamgmtzt4p.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('d3fcamgmtzt4p', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('d3fcamgmtzt4p', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for d3fcamgmtzt4p'); end if;
exception when others then
  dbms_output.put_line('-- no plan for d3fcamgmtzt4p: ' || sqlerrm);
end;
/
spool off

spool ref/plans/f9p8d99dh6qgh.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('f9p8d99dh6qgh', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('f9p8d99dh6qgh', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for f9p8d99dh6qgh'); end if;
exception when others then
  dbms_output.put_line('-- no plan for f9p8d99dh6qgh: ' || sqlerrm);
end;
/
spool off

spool ref/plans/fjb9hrux76jua.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('fjb9hrux76jua', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('fjb9hrux76jua', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for fjb9hrux76jua'); end if;
exception when others then
  dbms_output.put_line('-- no plan for fjb9hrux76jua: ' || sqlerrm);
end;
/
spool off

spool ref/plans/gpxch3ft9xhpm.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('gpxch3ft9xhpm', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('gpxch3ft9xhpm', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for gpxch3ft9xhpm'); end if;
exception when others then
  dbms_output.put_line('-- no plan for gpxch3ft9xhpm: ' || sqlerrm);
end;
/
spool off

exit
