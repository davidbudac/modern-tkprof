@@_prologue.sql px_io
-- PX slaves with physical reads: mtk_px_big (about 60 MB, loaded direct-path, above the small-table threshold)
-- scanned in parallel, so each slave reads its granules with direct path read (file#, first dba, block cnt).
-- The slave traces are collected by run_gen.sh (case px_io). Session-level parameters only.
alter session enable parallel query;
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('px_scan')
select /*+ parallel(b 4) full(b) mtk_px_scan */ count(*), sum(amount), max(length(pad)) from mtk_px_big b;
exec dbms_application_info.set_action('px_group_by')
select /*+ parallel(b 2) full(b) mtk_px_group */ grp, count(*), sum(amount) from mtk_px_big b group by grp order by grp;
select statistic, last_query from v$pq_sesstat where statistic in ('Queries Parallelized', 'Allocation Height', 'Server Threads');
@@_epilogue.sql
