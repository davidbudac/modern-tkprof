-- Session 1 of the lock chain used by diag_hang and diag_sysstate. Usage: @@_diag_chain_1.sql <seconds to hold the lock>
-- Locks mtk_cust row 301 and holds it, doing nothing, then rolls back (no data is changed). Session 2 waits for it.
set echo off feedback off heading off pagesize 0 verify off termout off
whenever sqlerror continue
exec dbms_application_info.set_module('mtk_diag_chain', 's1_holds_301')
exec dbms_session.set_identifier('mtk_chain_s1')
select id from mtk_cust where id = 301 for update;
exec dbms_session.sleep(&1)
rollback;
exit
