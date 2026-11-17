@@_prologue.sql diag_oom
-- Run as SYSDBA in CDB$ROOT, as a local bequeath session started by run_gen.sh from a shell with 'ulimit -d 300000'
-- (300 MB of private data memory; override with OOM_LIMIT_KB). The session grows a PL/SQL collection (32 KB strings)
-- until the process cannot get memory, after about 230 MB of PGA.
-- THIS DID NOT PRODUCE AN ORA-04030 ON THE LAB (19.27, Linux, RLIMIT_DATA or RLIMIT_AS alike): the failed mmap of a
-- 16 MB heap region is reported as ORA-27102 "out of memory" (Linux-x86_64 Error: 12), which PL/SQL turns into an
-- incident for ORA-06544 [pevm_peruws_callback-1] [27102]. A few other allocators (bulk collect, package collection,
-- recursion, sort and hash join with manual work areas) gave the same ORA-27102 or no failure at all.
-- run_gen.sh copies the incident trace file this run writes to out/diag_oom_incident.trc (5.4 MB: too big for a fixture).
-- Only the first run in a while writes one: after that DDE flood control says "Problem Key 'ORA 6544 [pevm_peruws_callback-1]'
-- was flood controlled" in the session trace and writes no incident (the script then logs a WARN).
set serveroutput on size unlimited
exec dbms_application_info.set_action('grow')
declare
  type t_strs is table of varchar2(32767) index by pls_integer;
  v t_strs;
begin
  for i in 1 .. 1000000 loop
    v(i) := rpad('x', 32767, 'y');
    if mod(i, 100) = 0 then dbms_application_info.set_client_info('elements: ' || i); end if;
  end loop;
end;
/
select 'reached ' || client_info info from v$session where sid = sys_context('userenv', 'sid');
@@_epilogue.sql
