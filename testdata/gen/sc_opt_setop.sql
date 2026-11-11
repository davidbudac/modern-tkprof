@@_prologue.sql opt_setop
-- 10053 only. A UNION ALL of two joins and a WITH clause (referenced in both branches). Each branch has an OR
-- predicate on two indexed columns (cust_id, id), so OR expansion (ORE) is a candidate. One dump, by EXPLAIN PLAN FOR;
-- the dump registers a SET$1 query block and (if costed) the factored subquery.
@@_opt_tag.sql
alter session set events '10053 trace name context forever, level 1';
explain plan for
with tot as (select cust_id, sum(amount) amt from mtk_orders group by cust_id)
select /* mtk_opt_&TAG setop */ c.name, o.amount, t.amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id join tot t on t.cust_id = c.id
 where o.cust_id = 77 or o.id = 4321
union all
select c.name, o.amount, t.amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id join tot t on t.cust_id = c.id
 where c.id = 15 or o.id = 9876;
alter session set events '10053 trace name context off';
@@_epilogue.sql
