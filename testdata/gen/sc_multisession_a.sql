@@_prologue.sql multisession_a
variable cid number
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('session_a')
exec :cid := 11
select /* mtk_ms_a */ count(*), sum(amount) from mtk_orders where cust_id = :cid;
exec dbms_session.sleep(1)
exec :cid := 12
select /* mtk_ms_a */ count(*), sum(amount) from mtk_orders where cust_id = :cid;
insert into mtk_orders (id, cust_id, order_date, amount, status) values (mtk_seq.nextval, :cid, sysdate, 1, 'MSA');
exec dbms_session.sleep(1)
rollback;
select /* mtk_ms_a_last */ count(*) from mtk_cust where id = :cid;
@@_epilogue.sql
