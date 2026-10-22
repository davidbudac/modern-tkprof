@@_prologue.sql plan_change
-- One sql_id, two plans in the same trace: 5 runs with the default optimizer
-- environment (index range scan on mtk_orders_cust_ix), then
-- optimizer_index_cost_adj=10000 makes the index look 100x more expensive, so the
-- next parse finds no shareable child (optimizer env mismatch), hard-parses a new
-- child cursor and picks a full scan of mtk_orders. Session-level only.
alter session set events '10046 trace name context forever, level 12';
variable cid number
exec dbms_application_info.set_action('plan_index')
set termout off
exec :cid := 11
@@_plan_change_q.sql
exec :cid := 12
@@_plan_change_q.sql
exec :cid := 13
@@_plan_change_q.sql
exec :cid := 14
@@_plan_change_q.sql
exec :cid := 15
@@_plan_change_q.sql
set termout on
alter session set optimizer_index_cost_adj = 10000;
exec dbms_application_info.set_action('plan_full')
set termout off
exec :cid := 21
@@_plan_change_q.sql
exec :cid := 22
@@_plan_change_q.sql
exec :cid := 23
@@_plan_change_q.sql
exec :cid := 24
@@_plan_change_q.sql
exec :cid := 25
@@_plan_change_q.sql
set termout on
alter session set optimizer_index_cost_adj = 100;
@@_epilogue.sql
