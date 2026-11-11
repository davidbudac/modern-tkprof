@@_prologue.sql opt_unified
-- 10053 only, by unified tracing (events 'trace[rdbms.SQL_Optimizer.*]') instead of the classic 10053 event.
-- The hinted statement of opt_two (bad index name, three row sources, an aggregate inline view).
@@_opt_tag.sql
alter session set events 'trace[rdbms.SQL_Optimizer.*]';
select /*+ index(o no_such_index) use_hash(c) */ /* mtk_opt_&TAG unified */ c.name, o.status, t.tot
  from mtk_cust c
  join mtk_orders o on o.cust_id = c.id
  join (select cust_id, sum(amount) tot from mtk_orders group by cust_id) t on t.cust_id = c.id
 where c.id < 200 and o.status = 'PAID';
alter session set events 'trace[rdbms.SQL_Optimizer.*] off';
@@_epilogue.sql
