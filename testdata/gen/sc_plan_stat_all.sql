@@_prologue.sql plan_stat_all
variable cid number
alter session set events 'sql_trace wait=true, bind=true, plan_stat=all_executions';
exec dbms_application_info.set_action('event_syntax')
set termout off
exec :cid := 1
@@_plan_stat_q.sql
exec :cid := 2
@@_plan_stat_q.sql
exec :cid := 3
@@_plan_stat_q.sql
exec :cid := 4
@@_plan_stat_q.sql
exec :cid := 5
@@_plan_stat_q.sql
set termout on
alter session set events 'sql_trace off';
exec dbms_application_info.set_action('dbms_session')
exec dbms_session.session_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS')
set termout off
exec :cid := 101
@@_plan_stat_q.sql
exec :cid := 102
@@_plan_stat_q.sql
exec :cid := 103
@@_plan_stat_q.sql
exec :cid := 104
@@_plan_stat_q.sql
exec :cid := 105
@@_plan_stat_q.sql
set termout on
exec dbms_session.session_trace_disable
@@_epilogue.sql
