-- The target session of diag_pga_detail. Holds a 2 MB package collection (UGA), a 3 MB local collection and an open sort
-- cursor for about 16 seconds, in a loop of one-second sleeps (so the process is back in the server often enough to
-- answer a dump request from another session), then ends. Its client identifier is mtk_pgadetail.
set echo off feedback off heading off pagesize 0 verify off termout off
whenever sqlerror continue
exec dbms_application_info.set_module('mtk_diag_pga_detail', 'target')
exec dbms_session.set_identifier('mtk_pgadetail')
declare
  type t_strs is table of varchar2(2000) index by pls_integer;
  v_local t_strs;
  c_sort  sys_refcursor;
  v_id    number;
  v_amt   number;
begin
  mtk_diag_mem.fill(2000, 1000);
  for i in 1 .. 3000 loop
    v_local(i) := rpad(to_char(i), 1000, chr(97 + mod(i, 26)));
  end loop;
  open c_sort for select /* mtk_diag_sort */ o.id, o.amount from mtk_orders o order by o.amount desc, o.id;
  fetch c_sort into v_id, v_amt;
  for i in 1 .. 16 loop
    dbms_session.sleep(1);
    select count(*) into v_id from dual;
  end loop;
  close c_sort;
  mtk_diag_mem.release;
end;
/
exit
