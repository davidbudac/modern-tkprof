@@_prologue.sql opt_parallel
-- 10053 only. A parallel plan: mtk_px_big (the 60 MB table, 120,000 rows) joined to mtk_cust with parallel(b 4)
-- and parallel query enabled, executed (so the query coordinator also runs it). No GROUP BY: with one the
-- group-by placement search multiplies the costing runs and the trace grows to 12 MB. The coordinator's trace is
-- the fixture; run_gen.sh logs PX slave trace files of the run and copies them to out/ without keeping them.
alter session enable parallel query;
@@_opt_tag.sql
alter session set events '10053 trace name context forever, level 1';
select /*+ parallel(b 4) full(b) */ /* mtk_opt_&TAG parallel */ count(*), sum(b.amount)
  from mtk_px_big b join mtk_cust c on c.id = b.grp + 1
 where b.amount > 100;
alter session set events '10053 trace name context off';
@@_epilogue.sql
