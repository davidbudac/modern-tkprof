@@_prologue.sql opt_interleaved
-- 10046 (level 12) and 10053 (level 1) on together, so one trace file holds both: the opt_subq_binds statement with
-- its bind, executed and fetched, then the hinted statement of opt_two (bad index name), executed and fetched.
-- (The first statement returns no rows on this database: no order with an mtk_audit row has a status in the IN list.)
-- The first statement has binds (PARSING IN CURSOR, then the dump, then EXEC); the second has none (the dump comes
-- first, then PARSING IN CURSOR). Goes through the normal path of run_gen.sh, with tkprof.
@@_opt_tag.sql
variable cid number
exec :cid := 11
alter session set events '10046 trace name context forever, level 12';
alter session set events '10053 trace name context forever, level 1';
select /* mtk_opt_&TAG inter_a */ c.name, o.status, sum(o.amount) amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id between :cid and :cid + 50
   and o.status in (select status from mtk_orders where amount > 100)
   and exists (select 1 from mtk_audit a where a.row_id = o.id)
 group by c.name, o.status order by 3 desc;
select /*+ index(o no_such_index) use_hash(c) */ /* mtk_opt_&TAG inter_b */ c.name, o.status, t.tot
  from mtk_cust c
  join mtk_orders o on o.cust_id = c.id
  join (select cust_id, sum(amount) tot from mtk_orders group by cust_id) t on t.cust_id = c.id
 where c.id < 200 and o.status = 'PAID';
alter session set events '10053 trace name context off';
@@_epilogue.sql
