@@_prologue.sql opt_nostats_ds
-- 10053 only. A join of mtk_nostats (no statistics ever gathered, locked) with mtk_cust, by EXPLAIN PLAN FOR:
-- the base statistics show (NOT ANALYZED) for mtk_nostats and the optimizer samples it dynamically.
-- The default optimizer_dynamic_sampling (2) samples a table without statistics; the level is set to 4 here
-- anyway so the scenario does not depend on the database default.
@@_opt_tag.sql
alter session set optimizer_dynamic_sampling = 4;
alter session set events '10053 trace name context forever, level 1';
explain plan for
select /* mtk_opt_&TAG nostats_ds */ c.name, n.grp, sum(n.amount)
  from mtk_nostats n join mtk_cust c on c.id = n.cust_id
 where n.grp = 'G3' and c.id < 5000
 group by c.name, n.grp;
alter session set events '10053 trace name context off';
@@_epilogue.sql
