@@_prologue.sql diag_pga_detail
-- Run as SYSDBA in CDB$ROOT. The PGA memory detail of another process: _diag_pgadetail_s1.sql (started by run_gen.sh)
-- holds about 7 MB of PGA and UGA. After 6 seconds this session finds that process (v$session.client_identifier =
-- 'mtk_pgadetail') and runs 'oradebug dump pga_detail_get <pid>', waits 5 seconds, runs 'oradebug dump
-- pga_detail_dump <pid>' (this writes "Begin PGA memory detail dump" to this session's trace) and
-- 'oradebug dump pga_detail_cancel <pid>'. The rows v$process_memory_detail holds are written to out/log/diag_pga_detail.log.
exec dbms_session.sleep(6)
column tpid new_value TPID noprint
select p.pid tpid from v$process p join v$session s on s.paddr = p.addr where s.client_identifier = 'mtk_pgadetail';
oradebug setmypid
oradebug dump pga_detail_get &TPID
exec dbms_session.sleep(5)
set pagesize 60 linesize 200 heading on
column category format a14
column name format a28
select * from (select pid, category, name, heap_name, bytes, allocation_count from v$process_memory_detail where pid = &TPID order by bytes desc) where rownum <= 15;
oradebug dump pga_detail_dump &TPID
oradebug dump pga_detail_cancel &TPID
@@_epilogue.sql
