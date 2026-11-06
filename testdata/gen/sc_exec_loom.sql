@@_prologue.sql exec_loom
-- Execution Loom fixture: the same statements executed several times under different cache and read-path
-- conditions, so their executions differ in waits per object and event with the same call shape.
--   index_cold_warm   index range + table access over a random range of 2,000 ids of mtk_loom_cold, run twice:
--                     nothing else reads that table, so the first run reads its table blocks from disk
--                     (db file sequential/parallel read), the second finds them cached
--   scan_paths        one full scan fetched in arrays, three times: buffered, buffered again, direct path reads.
--                     A child cursor executed twice keeps its read path when "_serial_direct_read" changes (seen on
--                     19.27), so the direct run changes optimizer_index_cost_adj too: a new child of the same sql_id
--                     and plan, hard-parsed under "always"
--   dml_current       a no-op UPDATE of the same range, twice, rolled back: current gets
-- Session-level parameters only; the UPDATE is rolled back.
variable lo number
variable hi number
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('index_cold_warm')
exec :lo := trunc(dbms_random.value(1, 48000)); :hi := :lo + 1999
set arraysize 200
set termout off
select /*+ index(b mtk_loom_cold_pk) mtk_loom_ix */ b.id, b.grp, b.amount from mtk_loom_cold b where b.id between :lo and :hi;
select /*+ index(b mtk_loom_cold_pk) mtk_loom_ix */ b.id, b.grp, b.amount from mtk_loom_cold b where b.id between :lo and :hi;
set termout on
exec dbms_application_info.set_action('scan_paths')
set arraysize 1000
alter session set "_serial_direct_read" = never;
set termout off
select /*+ full(o) mtk_loom_scan */ o.id, o.amount from mtk_orders o where mod(o.id, 10) = 0;
select /*+ full(o) mtk_loom_scan */ o.id, o.amount from mtk_orders o where mod(o.id, 10) = 0;
set termout on
alter session set "_serial_direct_read" = always;
alter session set optimizer_index_cost_adj = 101;
set termout off
select /*+ full(o) mtk_loom_scan */ o.id, o.amount from mtk_orders o where mod(o.id, 10) = 0;
set termout on
alter session set "_serial_direct_read" = auto;
alter session set optimizer_index_cost_adj = 100;
exec dbms_application_info.set_action('dml_current')
exec :lo := trunc(:lo / 3); :hi := :lo + 199
update /*+ mtk_loom_upd */ mtk_orders set amount = amount where cust_id between :lo and :hi;
update /*+ mtk_loom_upd */ mtk_orders set amount = amount where cust_id between :lo and :hi;
rollback;
@@_epilogue.sql
