-- Session 3 of the lock chain used by diag_hang and diag_sysstate. Asks for mtk_cust row 302, which session 2 holds,
-- and waits for it (enq: TX - row lock contention), at most 60 seconds. Rolls back at the end.
set echo off feedback off heading off pagesize 0 verify off termout off
whenever sqlerror continue
exec dbms_application_info.set_module('mtk_diag_chain', 's3_waits_302')
exec dbms_session.set_identifier('mtk_chain_s3')
exec dbms_session.sleep(2)
select id from mtk_cust where id = 302 for update wait 60;
rollback;
exit
