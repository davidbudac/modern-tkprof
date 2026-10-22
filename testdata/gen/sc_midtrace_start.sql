@@_prologue.sql midtrace_start
-- Part 1 goes to a separate file (identifier mtk_midtrace_start_part1).
alter session set tracefile_identifier = 'mtk_midtrace_start_part1';
variable n number
variable c number
exec :c := 1
-- first call is NOT traced: PL/SQL parses and caches the static cursor inside mtk_p_cached
exec mtk_p_cached(:c, :n)
print n
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('part1_traced')
exec :c := 2
-- 19c dumps the cached cursor's PARSING IN CURSOR on its first EXEC after trace-on (lands in part 1)
exec mtk_p_cached(:c, :n)
set heading off feedback off pagesize 0 termout off
spool out/midtrace_start_part1.tracefile
select value from v$diag_info where name = 'Default Trace File';
spool off
set termout on heading on feedback on pagesize 50
exec dbms_application_info.set_action('switch_file_mid_fetch')
-- Open a cursor, fetch a few rows, then switch tracefile_identifier while the cursor is still open.
-- Oracle starts a NEW file (part 2 = midtrace_start.trc); the remaining FETCH lines and the
-- SQL*Plus-level EXECs of the already-parsed "BEGIN mtk_p_cached" block land there with no
-- PARSING IN CURSOR. (Note: ALTER SESSION bumps the session environment, so PL/SQL-cached cursors
-- re-parse with mis=1 on their next execution.)
declare
  cursor c_orders is
    select /* mtk_midtrace_open_cursor */ o.id, o.amount from mtk_orders o
     where o.cust_id between 1 and 30 order by o.id;
  v_id  number;
  v_amt number;
  v_n   pls_integer := 0;
  v_cnt number;
begin
  open c_orders;
  loop
    fetch c_orders into v_id, v_amt;
    exit when c_orders%notfound;
    v_n := v_n + 1;
    if v_n = 5 then
      execute immediate 'alter session set tracefile_identifier = ''mtk_midtrace_start''';
    end if;
    if mod(v_n, 50) = 0 then
      mtk_p_cached(v_id, v_cnt);
    end if;
  end loop;
  close c_orders;
end;
/
exec dbms_application_info.set_action('part2_cached_cursor_calls')
exec :c := 3
exec mtk_p_cached(:c, :n)
exec :c := 4
exec mtk_p_cached(:c, :n)
exec :c := 5
exec mtk_p_cached(:c, :n)
print n
@@_epilogue.sql
