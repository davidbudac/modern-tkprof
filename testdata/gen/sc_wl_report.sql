@@_prologue.sql wl_report
-- Workload set, session "report": parallel queries (PX slaves write their own trace files) and a serial aggregate.
alter session enable parallel query;
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('px_totals')
select /*+ parallel(o 4) full(o) */ count(*), sum(o.amount), max(o.order_date) from mtk_orders o;
exec dbms_application_info.set_action('px_by_status')
select /*+ parallel(o 4) full(o) */ o.status, count(*), sum(o.amount) from mtk_orders o group by o.status order by 1;
exec dbms_application_info.set_action('px_join')
select /*+ parallel(o 4) full(o) full(c) */ c.name, count(*), sum(o.amount)
  from mtk_orders o join mtk_cust c on c.id = o.cust_id group by c.name order by 3 desc fetch first 10 rows only;
exec dbms_application_info.set_action('serial_top')
select /* mtk_wl_report_serial */ cust_id, count(*), sum(amount) from mtk_orders group by cust_id order by 3 desc fetch first 5 rows only;
@@_epilogue.sql
