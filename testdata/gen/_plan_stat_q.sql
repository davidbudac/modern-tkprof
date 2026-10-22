select /* mtk_plan_stat_all */ o.id, o.amount, o.status
  from mtk_orders o
 where o.cust_id = :cid
 order by o.id;
