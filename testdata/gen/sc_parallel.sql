@@_prologue.sql parallel
alter session enable parallel query;
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('px_count')
select /*+ parallel(mtk_orders 4) */ count(*), max(amount) from mtk_orders;
exec dbms_application_info.set_action('px_group_by')
select /*+ parallel(o 4) full(o) */ o.status, count(*), sum(o.amount) from mtk_orders o group by o.status order by 1;
select statistic, last_query from v$pq_sesstat where statistic in ('Queries Parallelized', 'Allocation Height', 'Server Threads');
@@_epilogue.sql
