-- Used by the diag_heap_* scenarios. Usage: @@_diag_heap_load.sql <heapdump level> [<UGA rows> [<local rows> [<cursors Y|N>]]]
-- Gives the session something to show, then dumps its heaps with that level from inside the same PL/SQL block
-- (so the call-heap memory is still allocated):
--   * a package collection of <UGA rows> x 1000 bytes (UGA; default 2000 = about 2 MB)
--   * a block-local PL/SQL collection of <local rows> x 1000 bytes (call heap / PGA; default 3000 = about 3 MB)
--   * a sort cursor (ORDER BY over mtk_orders) and a hash join cursor, each fetched once and left open, so their work
--     areas stay allocated (about 3 MB and 9 MB); not opened when the fourth argument is N
-- The package collection is released at the end, so the next call starts from the same state.
-- make &2 and &3 optional: when absent this defines them as empty instead of prompting
column p2 new_value 2 noprint
column p3 new_value 3 noprint
column p4 new_value 4 noprint
select '' p2, '' p3, '' p4 from dual where 1 = 0;
column mtk_urows new_value UROWS noprint
column mtk_lrows new_value LROWS noprint
column mtk_curs  new_value CURS  noprint
select nvl('&2', '2000') mtk_urows, nvl('&3', '3000') mtk_lrows, nvl('&4', 'Y') mtk_curs from dual;
-- the dump is preceded in the trace by an "*** ACTION NAME:(heapdump_<level>)" line, which marks where it starts
exec dbms_application_info.set_action('heapdump_&1')
declare
  type t_strs is table of varchar2(2000) index by pls_integer;
  v_local t_strs;
  c_sort  sys_refcursor;
  c_hash  sys_refcursor;
  v_id    number;
  v_amt   number;
  v_name  varchar2(100);
begin
  mtk_diag_mem.fill(&UROWS, 1000);
  for i in 1 .. &LROWS loop
    v_local(i) := rpad(to_char(i), 1000, chr(97 + mod(i, 26)));
  end loop;
  if '&CURS' = 'Y' then
    open c_sort for select /* mtk_diag_sort */ o.id, o.amount from mtk_orders o order by o.amount desc, o.id;
    fetch c_sort into v_id, v_amt;
    open c_hash for select /*+ use_hash(c) leading(o) */ /* mtk_diag_hash */ c.id, c.name from mtk_orders o join mtk_cust c on c.id = o.cust_id where o.amount > 1000;
    fetch c_hash into v_id, v_name;
  end if;
  execute immediate q'[alter session set events 'immediate trace name heapdump level &1']';
  if c_sort%isopen then close c_sort; end if;
  if c_hash%isopen then close c_hash; end if;
  mtk_diag_mem.release;
end;
/
