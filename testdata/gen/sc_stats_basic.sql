@@_prologue.sql stats_basic
-- statistics_level=basic (session) under 10046 level 12. Basic also turns timed_statistics off, and with
-- timed_statistics=false 19c dumps no STAT lines at all (10046 level 12, sql_trace plan_stat=all_executions and
-- dbms_session plan_stat=>'ALL_EXECUTIONS' alike) and reports c=0 on every call; e= is still measured.
-- With timed_statistics=true the STAT lines come back with full row-source statistics, so a 19c trace never
-- has STAT lines without "(cr=...)" (that form is the pre-9.2 trace format).
variable lo number
alter session set statistics_level = basic;
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('basic_joins')
exec :lo := 100
set termout off
select /*+ mtk_basic_nl */ c.id, c.name, count(*), sum(o.amount)
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id between :lo and :lo + 40
 group by c.id, c.name order by 1;
select /*+ mtk_basic_hash */ o.status, count(*), sum(c.amount)
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id < 2000
 group by o.status order by 2;
select /*+ mtk_basic_subq */ c.id, c.amount
  from mtk_cust c
 where c.amount > (select avg(o.amount) * 20 from mtk_orders o where o.cust_id = c.id)
   and c.id < 500
 order by c.amount desc;
set termout on
exec dbms_application_info.set_action('basic_plsql')
declare
  v_n number;
begin
  for i in 1 .. 5 loop
    select /* mtk_basic_loop */ count(*) into v_n
      from mtk_orders o join mtk_cust c on c.id = o.cust_id
     where o.cust_id = i * 7 and c.amount >= 0;
  end loop;
end;
/
alter session set statistics_level = typical;
@@_epilogue.sql
