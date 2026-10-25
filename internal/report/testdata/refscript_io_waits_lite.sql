-- mtkprof reference script for io_waits.trc
--
-- LITE variant: reads only ALL_ views, so any schema can run it. Names of
-- objects the connected user cannot see are missing, and datafile names are
-- not collected (they need the DBA views). Plans work if the user can read
-- V$SQL_PLAN; otherwise the plan files only hold an error note.
-- READ-ONLY: only SELECTs and DBMS_XPLAN calls; nothing is created or changed.
--
-- It looks up what the trace refers to by number or id:
--      7 obj#     -> ref/objects.csv    (owner, name, partition, type)
--      2 user id  -> ref/users.csv
--     23 sql_id   -> ref/plans/<sql_id>.txt  (DBMS_XPLAN.DISPLAY_CURSOR, ALLSTATS LAST
--                       +PREDICATE +ALIAS; DISPLAY_AWR when the cursor has aged out)
--
-- Run it from a directory that has ref/ and ref/plans/ (SPOOL does not create
-- directories):
--   mkdir -p ref/plans        (Windows: mkdir ref ref\plans)
--   sqlplus user/password@db @ref.sql
-- then analyse with:  mtkprof report io_waits.trc -ref ref
-- Only object, file and user names and execution plans are collected; no table
-- data and no bind values leave the database. Review ref/ before sharing it.

whenever sqlerror continue
set echo off feedback off verify off heading on trimspool on
set linesize 32767 pagesize 50000 long 1000000
set markup csv on quote on

-- objects
spool ref/objects.csv
select object_id, data_object_id, owner, object_name, subobject_name, object_type
  from all_objects
 where object_id in (720, 721, 108609, 108610, 108611, 108612, 108613)
    or data_object_id in (720, 721, 108609, 108610, 108611, 108612, 108613)
 order by object_id;
spool off

-- users (the uid= of the PARSING IN CURSOR lines)
spool ref/users.csv
select user_id, username
  from all_users
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

spool ref/plans/19pctsstqdgn5.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('19pctsstqdgn5', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('19pctsstqdgn5', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 19pctsstqdgn5'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 19pctsstqdgn5: ' || sqlerrm);
end;
/
spool off

spool ref/plans/1h7h96h7gnvbj.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('1h7h96h7gnvbj', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('1h7h96h7gnvbj', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 1h7h96h7gnvbj'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 1h7h96h7gnvbj: ' || sqlerrm);
end;
/
spool off

spool ref/plans/2wmkxs5arpj0h.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('2wmkxs5arpj0h', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('2wmkxs5arpj0h', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 2wmkxs5arpj0h'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 2wmkxs5arpj0h: ' || sqlerrm);
end;
/
spool off

spool ref/plans/4r9x21mb0nhkq.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('4r9x21mb0nhkq', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('4r9x21mb0nhkq', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 4r9x21mb0nhkq'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 4r9x21mb0nhkq: ' || sqlerrm);
end;
/
spool off

spool ref/plans/4w3wvjbkvq24v.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('4w3wvjbkvq24v', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('4w3wvjbkvq24v', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 4w3wvjbkvq24v'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 4w3wvjbkvq24v: ' || sqlerrm);
end;
/
spool off

spool ref/plans/52nzchs09dgn1.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('52nzchs09dgn1', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('52nzchs09dgn1', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 52nzchs09dgn1'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 52nzchs09dgn1: ' || sqlerrm);
end;
/
spool off

spool ref/plans/64y0jakbjfvm9.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('64y0jakbjfvm9', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('64y0jakbjfvm9', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 64y0jakbjfvm9'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 64y0jakbjfvm9: ' || sqlerrm);
end;
/
spool off

spool ref/plans/7r10y07tqpg98.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('7r10y07tqpg98', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('7r10y07tqpg98', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 7r10y07tqpg98'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 7r10y07tqpg98: ' || sqlerrm);
end;
/
spool off

spool ref/plans/7t9g1m9fxtjuq.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('7t9g1m9fxtjuq', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('7t9g1m9fxtjuq', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 7t9g1m9fxtjuq'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 7t9g1m9fxtjuq: ' || sqlerrm);
end;
/
spool off

spool ref/plans/942xwb5hn658p.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('942xwb5hn658p', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('942xwb5hn658p', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 942xwb5hn658p'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 942xwb5hn658p: ' || sqlerrm);
end;
/
spool off

spool ref/plans/9wgtc7nfd142y.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('9wgtc7nfd142y', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('9wgtc7nfd142y', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for 9wgtc7nfd142y'); end if;
exception when others then
  dbms_output.put_line('-- no plan for 9wgtc7nfd142y: ' || sqlerrm);
end;
/
spool off

spool ref/plans/c7ry5gr75qv4b.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('c7ry5gr75qv4b', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('c7ry5gr75qv4b', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for c7ry5gr75qv4b'); end if;
exception when others then
  dbms_output.put_line('-- no plan for c7ry5gr75qv4b: ' || sqlerrm);
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

spool ref/plans/dcxgz5g2j9ts2.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('dcxgz5g2j9ts2', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('dcxgz5g2j9ts2', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for dcxgz5g2j9ts2'); end if;
exception when others then
  dbms_output.put_line('-- no plan for dcxgz5g2j9ts2: ' || sqlerrm);
end;
/
spool off

spool ref/plans/dk21j71dpu26c.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('dk21j71dpu26c', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('dk21j71dpu26c', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for dk21j71dpu26c'); end if;
exception when others then
  dbms_output.put_line('-- no plan for dk21j71dpu26c: ' || sqlerrm);
end;
/
spool off

spool ref/plans/dx9pb9j3623tw.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('dx9pb9j3623tw', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('dx9pb9j3623tw', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for dx9pb9j3623tw'); end if;
exception when others then
  dbms_output.put_line('-- no plan for dx9pb9j3623tw: ' || sqlerrm);
end;
/
spool off

spool ref/plans/f2xpbhw4n24pt.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('f2xpbhw4n24pt', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('f2xpbhw4n24pt', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for f2xpbhw4n24pt'); end if;
exception when others then
  dbms_output.put_line('-- no plan for f2xpbhw4n24pt: ' || sqlerrm);
end;
/
spool off

spool ref/plans/f9xbak7zf0a4a.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('f9xbak7zf0a4a', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('f9xbak7zf0a4a', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for f9xbak7zf0a4a'); end if;
exception when others then
  dbms_output.put_line('-- no plan for f9xbak7zf0a4a: ' || sqlerrm);
end;
/
spool off

spool ref/plans/fc0b4krw7fd9v.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('fc0b4krw7fd9v', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('fc0b4krw7fd9v', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for fc0b4krw7fd9v'); end if;
exception when others then
  dbms_output.put_line('-- no plan for fc0b4krw7fd9v: ' || sqlerrm);
end;
/
spool off

spool ref/plans/fvnvyaby642k8.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('fvnvyaby642k8', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('fvnvyaby642k8', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for fvnvyaby642k8'); end if;
exception when others then
  dbms_output.put_line('-- no plan for fvnvyaby642k8: ' || sqlerrm);
end;
/
spool off

spool ref/plans/gpzx10kh9gr4f.txt
declare
  l_n    pls_integer := 0;
  l_miss boolean := false;
begin
  for r in (select plan_table_output p from table(dbms_xplan.display_cursor('gpzx10kh9gr4f', null, 'ALLSTATS LAST +PREDICATE +ALIAS'))) loop
    if l_n = 0 and r.p like '%cannot be found%' then l_miss := true; exit; end if;
    l_n := l_n + 1;
    dbms_output.put_line(r.p);
  end loop;
  if l_miss or l_n = 0 then
    for r in (select plan_table_output p from table(dbms_xplan.display_awr('gpzx10kh9gr4f', null, null, 'TYPICAL +PREDICATE +ALIAS'))) loop
      l_n := l_n + 1;
      dbms_output.put_line(r.p);
    end loop;
  end if;
  if l_n = 0 then dbms_output.put_line('-- no plan found for gpzx10kh9gr4f'); end if;
exception when others then
  dbms_output.put_line('-- no plan for gpzx10kh9gr4f: ' || sqlerrm);
end;
/
spool off

exit
