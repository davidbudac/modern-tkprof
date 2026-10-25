@@_prologue.sql wl_admin
-- Workload set, session "admin": errors, a burst of literal SQL (hard parses) and a plan change through a session parameter.
set serveroutput on size unlimited
whenever sqlerror continue
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('errors')
select * from mtk_no_such_table;
select /* mtk_wl_admin_divzero */ id, 1/(id - 3) from mtk_cust where id <= 5 order by id;
exec dbms_application_info.set_action('literals')
begin
  for i in 1 .. 20 loop
    execute immediate 'select /* mtk_wl_admin_literal */ count(*) from mtk_orders where cust_id = ' || i || ' and amount > ' || (i * 3);
  end loop;
end;
/
exec dbms_application_info.set_action('plan_change')
select /* mtk_wl_admin_plan */ count(*), sum(amount) from mtk_orders where cust_id between 1 and 5;
alter session set optimizer_index_cost_adj = 10000;
select /* mtk_wl_admin_plan */ count(*), sum(amount) from mtk_orders where cust_id between 1 and 5;
alter session set optimizer_index_cost_adj = 100;
@@_epilogue.sql
