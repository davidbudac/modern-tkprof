@@_prologue.sql multisession_b
variable cid number
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('session_b')
exec dbms_session.sleep(0.5)
exec :cid := 21
select /* mtk_ms_b */ max(amount) from mtk_cust where id = :cid;
exec dbms_session.sleep(1)
exec :cid := 22
select /* mtk_ms_b */ max(amount) from mtk_cust where id = :cid;
declare v number; begin v := mtk_f(:cid); end;
/
exec dbms_session.sleep(1)
select /* mtk_ms_b_last */ count(*) from mtk_orders where cust_id = :cid;
commit;
@@_epilogue.sql
