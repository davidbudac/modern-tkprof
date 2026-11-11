@@_prologue.sql opt_part
-- 10053 only. A range-partitioned table (mtk_part, four yearly partitions, local index on cust_id) joined to
-- mtk_cust. The sale_date predicate selects the 2023 partition only, so the optimizer prunes (partition
-- statistics, "Partition Iterator" / "PARTITION RANGE SINGLE" in the plan), by EXPLAIN PLAN FOR.
@@_opt_tag.sql
alter session set events '10053 trace name context forever, level 1';
explain plan for
select /* mtk_opt_&TAG part */ c.name, p.region, sum(p.amount)
  from mtk_part p join mtk_cust c on c.id = p.cust_id
 where p.sale_date >= date '2023-01-01' and p.sale_date < date '2024-01-01'
   and c.id < 500
 group by c.name, p.region;
alter session set events '10053 trace name context off';
@@_epilogue.sql
