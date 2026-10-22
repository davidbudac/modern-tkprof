select /* mtk_plan_change */ count(*), max(amount) from mtk_orders where cust_id = :cid;
