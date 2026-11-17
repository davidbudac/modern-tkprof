-- Session 2 of the lock chain used by diag_hang and diag_sysstate. Locks mtk_cust row 302, then asks for row 301,
-- which session 1 holds, and waits for it (enq: TX - row lock contention), at most 60 seconds. Rolls back at the end.
set echo off feedback off heading off pagesize 0 verify off termout off
whenever sqlerror continue
exec dbms_application_info.set_module('mtk_diag_chain', 's2_holds_302_waits_301')
exec dbms_session.set_identifier('mtk_chain_s2')
exec dbms_session.sleep(1)
select id from mtk_cust where id = 302 for update;
select id from mtk_cust where id = 301 for update wait 60;
rollback;
exit
