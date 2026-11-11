@@_prologue.sql opt_dml
-- 10053 only. Three DML statements, three dumps, each rolled back (the tables are mtk_dml_src, mtk_dml_tgt and
-- mtk_dml_scratch, created for this scenario):
--  1. insert ... select into mtk_dml_scratch (INS$1)
--  2. update with a subquery in SET and in WHERE (UPD$1)
--  3. delete with a join predicate in a correlated EXISTS subquery (DEL$1)
@@_opt_tag.sql
alter session set events '10053 trace name context forever, level 1';
insert /* mtk_opt_&TAG dml_ins */ into mtk_dml_scratch (id, grp, val)
select s.id + 100000, s.grp, s.val from mtk_dml_src s where s.status = 'NEW';
rollback;
update /* mtk_opt_&TAG dml_upd */ mtk_dml_tgt t
   set t.val = (select max(s.val) from mtk_dml_src s where s.grp = t.grp)
 where t.id in (select s.id from mtk_dml_src s where s.status = 'DEAD');
rollback;
delete /* mtk_opt_&TAG dml_del */ from mtk_dml_tgt t
 where t.status = 'OLD'
   and exists (select 1 from mtk_dml_src s where s.id = t.id and s.status = 'DEAD');
rollback;
alter session set events '10053 trace name context off';
@@_epilogue.sql
