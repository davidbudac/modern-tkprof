select /* mtk_cc_a */ count(*) from mtk_orders where cust_id = :cid;
select /* mtk_cc_b */ max(amount) from mtk_cust where id = :cid;
