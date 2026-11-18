-- Session B of diag_deadlock. Waits half a second (session A locks row 201 first), locks mtk_cust row 202, waits
-- 2 seconds, then asks for row 201. See _diag_deadlock_a.sql. Rolls back at the end; no data is changed.
@@_prologue.sql diag_deadlock_b
set echo on
exec dbms_session.sleep(0.5)
exec dbms_application_info.set_action('b_locks_202')
select id from mtk_cust where id = 202 for update;
exec dbms_session.sleep(2)
exec dbms_application_info.set_action('b_asks_201')
select id from mtk_cust where id = 201 for update wait 30;
exec dbms_application_info.set_action('b_done')
rollback;
@@_epilogue.sql
