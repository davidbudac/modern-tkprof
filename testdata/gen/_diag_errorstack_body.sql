-- Used by sc_diag_errorstack*.sql. Usage: @@_diag_errorstack_body.sql <errorstack level>
-- Error stack written from inside PL/SQL: SQL*Plus calls mtk_diag_outer -> mtk_diag_inner (so there is a PL/SQL call
-- stack of two procedures and an anonymous block), which opens two cursors that have bind variables, fetches one row
-- from each and runs 'alter session set events ''immediate trace name errorstack level <n>''' with execute immediate.
-- The call uses SQL*Plus bind variables.
variable ev varchar2(200)
variable cid number
exec :ev := q'[alter session set events 'immediate trace name errorstack level &1']'
exec :cid := 11
exec dbms_application_info.set_action('errorstack_&1')
begin mtk_diag_outer(:ev, :cid); end;
/
