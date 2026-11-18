@@_prologue.sql diag_sysstate
-- Run as SYSDBA in CDB$ROOT, the fourth session of diag_sysstate: the same lock chain as diag_hang (S2 waits for S1,
-- S3 waits for S2; started by run_gen.sh). After 6 seconds this session takes four system state dumps with oradebug
-- ('oradebug dump systemstate <level>'), levels 1, 2, 258 and 266, each into its own trace file
-- (tracefile_identifier mtk_diag_sysstate_l<level>); run_gen.sh copies them to out/diag_sysstate_l<level>.trc.
-- Levels 2, 258 and 266 are 4.5 to 5.2 MB each (about 70 processes): too big for a fixture. Level 1 (1.1 MB) is the fixture.
exec dbms_session.sleep(6)
oradebug setmypid
set heading off feedback off pagesize 0 termout off trimspool on linesize 1000
alter session set tracefile_identifier = 'mtk_diag_sysstate_l1';
oradebug dump systemstate 1
spool out/diag_sysstate_l1.tracefile
select value from v$diag_info where name = 'Default Trace File';
spool off
alter session set tracefile_identifier = 'mtk_diag_sysstate_l2';
oradebug dump systemstate 2
spool out/diag_sysstate_l2.tracefile
select value from v$diag_info where name = 'Default Trace File';
spool off
alter session set tracefile_identifier = 'mtk_diag_sysstate_l258';
oradebug dump systemstate 258
spool out/diag_sysstate_l258.tracefile
select value from v$diag_info where name = 'Default Trace File';
spool off
alter session set tracefile_identifier = 'mtk_diag_sysstate_l266';
oradebug dump systemstate 266
spool out/diag_sysstate_l266.tracefile
select value from v$diag_info where name = 'Default Trace File';
spool off
set termout on
alter session set tracefile_identifier = 'mtk_diag_sysstate';
@@_epilogue.sql
