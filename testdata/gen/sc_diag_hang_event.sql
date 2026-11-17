@@_prologue.sql diag_hang_event
-- The same as diag_hang, but the hang analysis is taken with the event instead of oradebug:
-- 'alter session set events ''immediate trace name hanganalyze level 3'''. Run as SYSDBA in CDB$ROOT; the chain
-- sessions are started by run_gen.sh.
exec dbms_session.sleep(6)
alter session set events 'immediate trace name hanganalyze level 3';
exec dbms_session.sleep(3)
@@_epilogue.sql
