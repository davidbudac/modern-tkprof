@@_prologue.sql opt_subq_binds
-- 10053 only (no 10046; run_gen.sh does not run tkprof on it).
-- One statement with two tables, an IN and an EXISTS subquery (unnested), a bind pair, GROUP BY and ORDER BY:
-- the dump shows PARSER / VIEW MERGE / SUBQUERY UNNEST / PLACE GROUP BY query blocks, nine costing runs
-- (cost-based transformation iterations), the adaptive plan, peeked binds and the explain plan dump.
-- The binds are set and the unique tag defined before the event is turned on, so the file holds one dump.
@@_opt_tag.sql
variable cid number
exec :cid := 11
alter session set events '10053 trace name context forever, level 1';
select /* mtk_opt_&TAG subq_binds */ c.name, o.status, sum(o.amount) amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id between :cid and :cid + 50
   and o.status in (select status from mtk_orders where amount > 100)
   and exists (select 1 from mtk_audit a where a.row_id = o.id)
 group by c.name, o.status order by 3 desc;
alter session set events '10053 trace name context off';
@@_epilogue.sql
