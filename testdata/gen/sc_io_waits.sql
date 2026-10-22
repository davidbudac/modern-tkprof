@@_prologue.sql io_waits
variable cid number
alter session set events '10046 trace name context forever, level 12';
alter session set "_serial_direct_read" = always;
alter session set workarea_size_policy = manual;
alter session set sort_area_size = 65536;
alter session set hash_area_size = 131072;
exec dbms_application_info.set_action('full_scan')
set termout off
select /*+ full(o) mtk_full_scan_orders */ count(*), sum(amount), max(order_date) from mtk_orders o;
select /*+ full(c) mtk_full_scan_cust */ count(*), sum(length(notes)) from mtk_cust c;
select /*+ full(o) mtk_full_scan_orders2 */ count(*) from mtk_orders o where status = 'PAID';
set termout on
exec dbms_application_info.set_action('index_range')
exec :cid := 17
set termout off
select /*+ index(o mtk_orders_cust_ix) mtk_index_range */ o.id, o.amount from mtk_orders o where o.cust_id = :cid;
exec :cid := 4242
select /*+ index(o mtk_orders_cust_ix) mtk_index_range */ o.id, o.amount from mtk_orders o where o.cust_id = :cid;
select /*+ index(o mtk_orders_cust_ix) mtk_index_range_wide */ o.id, o.amount from mtk_orders o where o.cust_id between 100 and 400;
set termout on
exec dbms_application_info.set_action('single_row')
declare
  v_amt number;
  v_id  number;
begin
  for i in 1 .. 300 loop
    v_id := trunc(dbms_random.value(1, 20000));
    select amount into v_amt from mtk_cust where id = v_id;
  end loop;
  for i in 1 .. 300 loop
    v_id := trunc(dbms_random.value(1, 100000));
    select amount into v_amt from mtk_orders where id = v_id;
  end loop;
end;
/
exec dbms_application_info.set_action('sort_spill')
set arraysize 500
set termout off
select /*+ mtk_sort_spill */ o.id, o.cust_id, o.amount, o.order_date, o.status
  from mtk_orders o order by o.amount desc, o.order_date, o.id;
select /*+ use_hash(c o) mtk_hash_spill */ count(*), sum(o.amount * c.amount)
  from mtk_cust c join mtk_orders o on o.cust_id = c.id;
set termout on
@@_epilogue.sql
