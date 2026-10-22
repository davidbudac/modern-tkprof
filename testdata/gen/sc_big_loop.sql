define ITER=&1
@@_prologue.sql big_loop
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('big_loop')
declare
  v_amt number;
  v_id  number;
begin
  for i in 1 .. &ITER loop
    v_id := mod(i, 20000) + 1;
    select amount into v_amt from mtk_cust where id = v_id;
    insert into mtk_audit (id, table_name, row_id, cust_total) values (mtk_seq.nextval, 'BIG', i, v_amt);
    if mod(i, 1000) = 0 then
      commit;
    end if;
  end loop;
  commit;
end;
/
exec dbms_application_info.set_action('cleanup')
delete from mtk_audit where table_name = 'BIG';
commit;
@@_epilogue.sql
