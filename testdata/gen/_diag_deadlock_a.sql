-- Session A of diag_deadlock. Locks mtk_cust row 201, waits 2 seconds (session B locks row 202 meanwhile), then asks
-- for row 202. Session B asks for row 201 at about the same time: a deadlock; ORA-00060 goes to the one that detects it
-- (within about 3 seconds). Rolls back at the end; no data is changed.
@@_prologue.sql diag_deadlock_a
set echo on
exec dbms_application_info.set_action('a_locks_201')
select id from mtk_cust where id = 201 for update;
exec dbms_session.sleep(2)
exec dbms_application_info.set_action('a_asks_202')
select id from mtk_cust where id = 202 for update wait 30;
exec dbms_application_info.set_action('a_done')
rollback;
@@_epilogue.sql
