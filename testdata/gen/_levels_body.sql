variable cid number
exec :cid := 5
select /* mtk_levels */ count(*), sum(amount) from mtk_orders where cust_id = :cid;
exec :cid := 6
select /* mtk_levels */ count(*), sum(amount) from mtk_orders where cust_id = :cid;
insert into mtk_orders (id, cust_id, order_date, amount, status) values (mtk_seq.nextval, :cid, sysdate, 1, 'LVL');
rollback;
declare
  v number;
begin
  v := mtk_f(3);
end;
/
