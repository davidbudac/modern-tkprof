-- mtkprof reference script for multisession_a.trc
--
-- Needs SELECT_CATALOG_ROLE (DBA views and V$ views).
-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.
--
-- It looks up what the trace refers to by number or id:
--      7 obj#     -> ref/objects.csv    (owner, name, partition, type)
--      0 file#    -> ref/datafiles.csv  (datafile / tempfile name, tablespace)
--      2 user id  -> ref/users.csv
--     12 sql_id   -> ref/plans/<sql_id>.txt  (DBMS_XPLAN.DISPLAY_CURSOR, ALLSTATS LAST
--                       +PREDICATE +ALIAS; DISPLAY_AWR when the cursor has aged out)
--
-- Run it from a directory that has ref/ and ref/plans/ (SPOOL does not create
-- directories):
--   mkdir -p ref/plans        (Windows: mkdir ref ref\plans)
--   sqlplus user/password@db @ref.sql
-- then analyse with:  mtkprof report multisession_a.trc -ref ref
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
 where object_id in (127, 108609, 108610, 108611, 108613, 108614, 108621)
    or data_object_id in (127, 108609, 108610, 108611, 108613, 108614, 108621)
 order by object_id;
spool off

-- datafiles and tempfiles; wait events report tempfiles as file# + db_files
-- (no file I/O waits with a file# in this trace)

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

spool ref/plans/18grqd4nfgv98.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('18grqd4nfgv98', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('18grqd4nfgv98', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 18grqd4nfgv98'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 18grqd4nfgv98: ' || sqlerrm);
end;
/
spool off

spool ref/plans/26guyq9914k0n.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('26guyq9914k0n', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('26guyq9914k0n', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 26guyq9914k0n'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 26guyq9914k0n: ' || sqlerrm);
end;
/
spool off

spool ref/plans/4nfvy63y9varm.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('4nfvy63y9varm', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('4nfvy63y9varm', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 4nfvy63y9varm'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 4nfvy63y9varm: ' || sqlerrm);
end;
/
spool off

spool ref/plans/4s274qfnswc5z.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('4s274qfnswc5z', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('4s274qfnswc5z', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 4s274qfnswc5z'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 4s274qfnswc5z: ' || sqlerrm);
end;
/
spool off

spool ref/plans/4zm9rnpjhr8xm.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('4zm9rnpjhr8xm', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('4zm9rnpjhr8xm', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 4zm9rnpjhr8xm'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 4zm9rnpjhr8xm: ' || sqlerrm);
end;
/
spool off

spool ref/plans/5zdrtngrc21tb.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('5zdrtngrc21tb', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('5zdrtngrc21tb', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 5zdrtngrc21tb'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 5zdrtngrc21tb: ' || sqlerrm);
end;
/
spool off

spool ref/plans/7jf4xk7vfxp28.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('7jf4xk7vfxp28', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('7jf4xk7vfxp28', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 7jf4xk7vfxp28'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 7jf4xk7vfxp28: ' || sqlerrm);
end;
/
spool off

spool ref/plans/9p6bq1v54k13j.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('9p6bq1v54k13j', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('9p6bq1v54k13j', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 9p6bq1v54k13j'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 9p6bq1v54k13j: ' || sqlerrm);
end;
/
spool off

spool ref/plans/a147h8u01uav2.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('a147h8u01uav2', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('a147h8u01uav2', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for a147h8u01uav2'); end if;
exception when others then
  dbms_output.put_line('-- no plan for a147h8u01uav2: ' || sqlerrm);
end;
/
spool off

spool ref/plans/fq7fgtdq2jdh6.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('fq7fgtdq2jdh6', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('fq7fgtdq2jdh6', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for fq7fgtdq2jdh6'); end if;
exception when others then
  dbms_output.put_line('-- no plan for fq7fgtdq2jdh6: ' || sqlerrm);
end;
/
spool off

spool ref/plans/gayh31j2d5htk.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('gayh31j2d5htk', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('gayh31j2d5htk', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for gayh31j2d5htk'); end if;
exception when others then
  dbms_output.put_line('-- no plan for gayh31j2d5htk: ' || sqlerrm);
end;
/
spool off

exit
