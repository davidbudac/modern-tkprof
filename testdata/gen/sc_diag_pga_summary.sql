@@_prologue.sql diag_pga_summary
-- PGA summary: 'immediate trace name pga_summary level 1' (the dump the ORA-04030 trace begins with: "TOP 10 MEMORY
-- USES FOR THIS PROCESS", the work area table, per-process private memory), run as MTK from inside a PL/SQL block that
-- holds a 2 MB package collection, a 3 MB local collection and an open sort cursor (as diag_heap_pga).
exec dbms_application_info.set_action('pga_summary_1')
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
  execute immediate q'[alter session set events 'immediate trace name pga_summary level 1']';
  close c_sort;
  mtk_diag_mem.release;
end;
/
@@_epilogue.sql
