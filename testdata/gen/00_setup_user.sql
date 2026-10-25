-- Run as SYSDBA (lands in CDB$ROOT). Usage: sqlplus / as sysdba @00_setup_user.sql <mtk_password> [<pdb>]
-- Idempotent: creates user MTK inside the PDB (default PDB1; FREEPDB1 / XEPDB1 in the
-- gvenzl docker images, see run_gen_docker.sh) only if missing, (re)applies grants.
set echo off feedback on verify off
whenever sqlerror continue
-- make &2 optional: when absent this defines it as empty instead of prompting
column p2 new_value 2 noprint
select '' p2 from dual where 1 = 0;
column pdbn new_value PDBNAME noprint
select nvl('&2', 'PDB1') pdbn from dual;
alter session set container = &PDBNAME;
declare
  v_cnt number;
begin
  select count(*) into v_cnt from dba_users where username = 'MTK';
  if v_cnt = 0 then
    execute immediate 'create user mtk identified by "&1" default tablespace users temporary tablespace temp quota unlimited on users';
    dbms_output.put_line('created user MTK');
  else
    -- user exists: make sure the password matches what run_gen.sh will use
    execute immediate 'alter user mtk identified by "&1"';
  end if;
exception
  when others then
    if sqlcode = -1920 then null; else raise; end if;
end;
/
grant create session, alter session, create table, create procedure, create trigger,
      create sequence, create view, create type to mtk;
grant select on sys.v_$session     to mtk;
grant select on sys.v_$diag_info   to mtk;
grant select on sys.v_$event_name  to mtk;
grant select on sys.v_$sqlcommand  to mtk;
grant select on sys.v_$mystat      to mtk;
grant select on sys.v_$statname    to mtk;
grant select on sys.v_$process     to mtk;
grant select on sys.v_$px_session  to mtk;
grant select on sys.v_$pq_sesstat  to mtk;
grant select on sys.v_$parameter   to mtk;
-- mtkprof db connection (internal/remote/db, docs/REMOTE-db.md)
grant select on sys.v_$diag_trace_file          to mtk;
grant select on sys.v_$diag_trace_file_contents to mtk;
grant select on sys.v_$instance                 to mtk;
grant execute on sys.dbms_monitor               to mtk;
select username, account_status, default_tablespace, created from dba_users where username = 'MTK';
exit
