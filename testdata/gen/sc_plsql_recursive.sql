@@_prologue.sql plsql_recursive
set serveroutput on size unlimited
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('call_function')
-- function called from SQL: the SELECT inside mtk_f is dep=1
select /* mtk_f_from_sql */ id, mtk_f(id) as cust_amount from mtk_cust where id <= 5 order by id;
-- function called from PL/SQL: the SELECT inside mtk_f is dep=1 too (block is dep=0)
declare
  v number;
begin
  v := mtk_f(10);
  dbms_output.put_line('mtk_f(10)=' || v);
end;
/
exec dbms_application_info.set_action('insert_trigger')
-- single-row insert fires mtk_orders_bi: audit insert at dep=1, mtk_f SELECT at dep=2
insert into mtk_orders (id, cust_id, order_date, amount, status)
values (mtk_seq.nextval, 1, sysdate, 10.5, 'NEW');
-- FORALL array insert (array binds, mal>1), each row fires the trigger
declare
  type t_num is table of number index by pls_integer;
  type t_rows is table of mtk_orders%rowtype;
  v_ids  t_num;
  v_amt  t_num;
  v_cust t_num;
  v_rows t_rows;
begin
  for i in 1 .. 50 loop
    v_ids(i)  := mtk_seq.nextval;
    v_amt(i)  := i * 1.25;
    v_cust(i) := mod(i, 20) + 1;
  end loop;
  forall i in 1 .. v_ids.count
    insert into mtk_orders (id, cust_id, order_date, amount, status)
    values (v_ids(i), v_cust(i), sysdate, v_amt(i), 'BULK');
  dbms_output.put_line('forall inserted ' || sql%rowcount);
  -- bulk collect
  select * bulk collect into v_rows from mtk_orders where status = 'BULK' and rownum <= 100;
  dbms_output.put_line('bulk collected ' || v_rows.count);
  -- cursor for loop with implicit array fetch (prefetch 100)
  v_amt.delete;
  for r in (select id, amount from mtk_orders where status = 'BULK') loop
    v_amt(r.id) := r.amount;
  end loop;
  commit;   /* XCTEND rlbk=0, rd_only=0 */
end;
/
exec dbms_application_info.set_action('rollback')
insert into mtk_orders (id, cust_id, order_date, amount, status)
values (mtk_seq.nextval, 2, sysdate, 99, 'RBK');
-- XCTEND rlbk=1
rollback;
exec dbms_application_info.set_action('readonly_commit')
select count(*) from mtk_cust where id < 10;
-- XCTEND rlbk=0, rd_only=1
commit;
exec dbms_application_info.set_action('cleanup')
-- idempotency: remove the rows this scenario committed
delete from mtk_audit  where table_name = 'MTK_ORDERS' and row_id in (select id from mtk_orders where status in ('BULK', 'NEW') and id >= 1000000);
delete from mtk_orders where status in ('BULK', 'NEW') and id >= 1000000;
commit;
@@_epilogue.sql
