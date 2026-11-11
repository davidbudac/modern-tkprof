@@_prologue.sql opt_two
-- 10053 only. Two statements, two dumps, in one file:
--  1. the opt_subq_binds statement (two tables, IN and EXISTS subqueries, binds, GROUP BY, ORDER BY);
--  2. a hinted statement with three row sources, one an aggregate inline view, and a bad index name:
--     index(o no_such_index) is a hint error (err= in "Dumping Hints", "Hint Report" entry), use_hash(c) is fine.
--     The unique tag is in a plain second comment, not in the hint comment, so the only hint problem is the index name.
@@_opt_tag.sql
variable cid number
exec :cid := 11
alter session set events '10053 trace name context forever, level 1';
select /* mtk_opt_&TAG two_a */ c.name, o.status, sum(o.amount) amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id between :cid and :cid + 50
   and o.status in (select status from mtk_orders where amount > 100)
   and exists (select 1 from mtk_audit a where a.row_id = o.id)
 group by c.name, o.status order by 3 desc;
select /*+ index(o no_such_index) use_hash(c) */ /* mtk_opt_&TAG two_b */ c.name, o.status, t.tot
  from mtk_cust c
  join mtk_orders o on o.cust_id = c.id
  join (select cust_id, sum(amount) tot from mtk_orders group by cust_id) t on t.cust_id = c.id
 where c.id < 200 and o.status = 'PAID';
alter session set events '10053 trace name context off';
@@_epilogue.sql
