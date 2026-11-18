@@_prologue.sql diag_hang
-- Run as SYSDBA in CDB$ROOT, the fourth session of diag_hang: three MTK sessions wait in a chain on row locks
-- (S2 waits for S1 on mtk_cust row 301, S3 waits for S2 on row 302; _diag_chain_1/2/3.sql, started by run_gen.sh).
-- After 6 seconds, when all three are waiting, this session takes a hang analysis, level 3:
-- 'oradebug setmypid' and 'oradebug hanganalyze 3'. The "HANG ANALYSIS" is written to this session's own trace file
-- (not to a DIA0 trace), which run_gen.sh collects as out/diag_hang.trc.
exec dbms_session.sleep(6)
oradebug setmypid
oradebug hanganalyze 3
exec dbms_session.sleep(3)
@@_epilogue.sql
