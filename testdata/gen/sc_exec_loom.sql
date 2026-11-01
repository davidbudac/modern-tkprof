@@_prologue.sql exec_loom
-- Execution Loom fixture: the same statements executed several times under different cache and read-path
-- conditions, so their executions differ in waits per object and event with the same call shape.
--   index_cold_warm   index range + table access over a random (likely uncached) customer range, run twice:
--                     the first reads index and table blocks (db file sequential read), the second finds them cached
--   scan_paths        one full scan fetched in arrays, three times: buffered, buffered again, direct path reads
--   dml_current       a no-op UPDATE of the same range, twice, rolled back: current gets
-- Session-level parameters only; the UPDATE is rolled back.
variable lo number
variable hi number
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('index_cold_warm')
exec :lo := trunc(dbms_random.value(1, 19800)); :hi := :lo + 199
set arraysize 200
set termout off
select /*+ index(o mtk_orders_cust_ix) mtk_loom_ix */ o.id, o.amount, o.order_date from mtk_orders o where o.cust_id between :lo and :hi;
select /*+ index(o mtk_orders_cust_ix) mtk_loom_ix */ o.id, o.amount, o.order_date from mtk_orders o where o.cust_id between :lo and :hi;
set termout on
exec dbms_application_info.set_action('scan_paths')
set arraysize 1000
alter session set "_serial_direct_read" = never;
set termout off
select /*+ full(o) mtk_loom_scan */ o.id, o.amount from mtk_orders o where mod(o.id, 10) = 0;
select /*+ full(o) mtk_loom_scan */ o.id, o.amount from mtk_orders o where mod(o.id, 10) = 0;
set termout on
alter session set "_serial_direct_read" = always;
set termout off
select /*+ full(o) mtk_loom_scan */ o.id, o.amount from mtk_orders o where mod(o.id, 10) = 0;
set termout on
alter session set "_serial_direct_read" = auto;
exec dbms_application_info.set_action('dml_current')
update /*+ mtk_loom_upd */ mtk_orders set amount = amount where cust_id between :lo and :hi;
update /*+ mtk_loom_upd */ mtk_orders set amount = amount where cust_id between :lo and :hi;
rollback;
@@_epilogue.sql
