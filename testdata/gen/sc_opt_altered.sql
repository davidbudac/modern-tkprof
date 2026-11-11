@@_prologue.sql opt_altered
-- 10053 only. The opt_subq_binds statement in a session with altered optimizer parameters, so
-- "PARAMETERS WITH ALTERED VALUES" is not empty: optimizer_index_cost_adj = 50, optimizer_mode = first_rows_10,
-- and a hidden parameter (_optimizer_cost_based_transformation = off) set at session level; plus an opt_param hint,
-- so "PARAMETERS IN OPT_PARAM HINT" lists a parameter too.
@@_opt_tag.sql
alter session set optimizer_index_cost_adj = 50;
alter session set optimizer_mode = first_rows_10;
alter session set "_optimizer_cost_based_transformation" = off;
variable cid number
exec :cid := 11
alter session set events '10053 trace name context forever, level 1';
select /*+ opt_param('optimizer_index_caching' 40) */ /* mtk_opt_&TAG altered */ c.name, o.status, sum(o.amount) amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id between :cid and :cid + 50
   and o.status in (select status from mtk_orders where amount > 100)
   and exists (select 1 from mtk_audit a where a.row_id = o.id)
 group by c.name, o.status order by 3 desc;
alter session set events '10053 trace name context off';
@@_epilogue.sql
