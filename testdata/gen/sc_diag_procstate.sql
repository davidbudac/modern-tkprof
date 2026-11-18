@@_prologue.sql diag_procstate
-- Process state, level 10: the session first takes row locks (select ... for update on three mtk_cust rows,
-- rolled back at the end), then opens two cursors with bind variables inside mtk_diag_outer / mtk_diag_inner and runs
-- 'immediate trace name processstate level 10' with execute immediate. No other session is involved.
variable ev varchar2(200)
variable cid number
exec :ev := q'[alter session set events 'immediate trace name processstate level 10']'
exec :cid := 11
select /* mtk_diag_lock */ id, name from mtk_cust where id between 101 and 103 for update;
exec dbms_application_info.set_action('processstate_10')
begin mtk_diag_outer(:ev, :cid); end;
/
rollback;
@@_epilogue.sql
