-- Used by sc_diag_in_10046*.sql. Usage: @@_diag_in_10046_body.sql <errorstack level of event 942>
-- A 10046 trace (level 12) with an error stack inside it: event 942 is set to write an errorstack, then a statement
-- with a bind variable, a select from a table that does not exist (ORA-00942, which writes the stack in the middle of
-- the 10046 records), and three more statements, two of them with a bind.
variable cid number
alter session set events '10046 trace name context forever, level 12';
alter session set events '942 trace name errorstack level &1';
exec dbms_application_info.set_action('before_error')
exec :cid := 11
select /* mtk_diag_before */ count(*), sum(amount) from mtk_orders where cust_id = :cid;
exec dbms_application_info.set_action('error')
select /* mtk_diag_missing */ count(*) from mtk_no_such_table where id = :cid;
exec dbms_application_info.set_action('after_error')
exec :cid := 12
select /* mtk_diag_after */ count(*), sum(amount) from mtk_orders where cust_id = :cid;
select /* mtk_diag_after_last */ count(*) from mtk_cust where id = :cid;
alter session set events '942 trace name errorstack off';
