@@_prologue.sql opt_join8
-- 10053 only. An eight-table join (mtk_cust and mtk_orders alternating, a chain of join predicates, no
-- transitive closure) by EXPLAIN PLAN FOR (a hard parse, so a dump, without running the statement):
-- one costing run with many join orders ("Join order[n]", "Number of join permutations tried"). Every table's
-- name or amount is selected, so join elimination cannot remove the customer tables (it did with a shorter select list).
@@_opt_tag.sql
alter session set events '10053 trace name context forever, level 1';
explain plan for
select /* mtk_opt_&TAG join8 */ c1.name, c2.name, c3.name, c4.name, o1.amount, o2.amount, o3.amount, o4.amount
  from mtk_cust c1, mtk_orders o1, mtk_cust c2, mtk_orders o2, mtk_cust c3, mtk_orders o3, mtk_cust c4, mtk_orders o4
 where o1.cust_id = c1.id
   and c2.id = o1.id
   and o2.cust_id = c2.id
   and c3.id = o2.id
   and o3.cust_id = c3.id
   and c4.id = o3.id
   and o4.cust_id = c4.id
   and c1.id between 1 and 10;
alter session set events '10053 trace name context off';
@@_epilogue.sql
