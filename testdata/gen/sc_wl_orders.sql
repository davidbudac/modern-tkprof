@@_prologue.sql wl_orders
-- Workload set, session "orders": OLTP loop with binds, small fetches, commits and think time.
variable cid number
variable oid number
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('lookup')
begin
  for i in 1 .. 25 loop
    :cid := mod(i, 40) + 1;
    for r in (select /* mtk_wl_orders_lookup */ id, amount, status from mtk_orders where cust_id = :cid order by id) loop
      null;
    end loop;
    insert into mtk_orders (id, cust_id, order_date, amount, status)
      values (mtk_seq.nextval, :cid, sysdate, i * 10, 'WL') returning id into :oid;
    update mtk_orders set status = 'WLX' where id = :oid;
    commit;
    dbms_session.sleep(0.15);
  end loop;
end;
/
exec dbms_application_info.set_action('customer')
set arraysize 3
select /* mtk_wl_orders_cust */ c.id, c.name, count(o.id) orders, sum(o.amount) amount
  from mtk_cust c left join mtk_orders o on o.cust_id = c.id
 where c.id between 1 and 40 group by c.id, c.name order by c.id;
set arraysize 15
exec dbms_application_info.set_action('cleanup')
delete from mtk_orders where status in ('WL', 'WLX');
commit;
@@_epilogue.sql
