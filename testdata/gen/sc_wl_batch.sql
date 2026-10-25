@@_prologue.sql wl_batch
-- Workload set, session "batch": PL/SQL with recursive SQL, in-call sleeps (idle waits inside a call) and a
-- tracefile_identifier switch half way, so the trace continues in a second file (TRACE CONTINUES IN FILE).
variable n number
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('batch_pass_1')
declare
  v_cnt number;
  v_sum number := 0;
begin
  for i in 1 .. 30 loop
    mtk_p_cached(mod(i, 40) + 1, v_cnt);
    v_sum := v_sum + mtk_f(i);
    if mod(i, 10) = 0 then
      dbms_session.sleep(0.4);
    end if;
    if i = 15 then
      execute immediate 'alter session set tracefile_identifier = ''mtk_wl_batch_2''';
      dbms_application_info.set_action('batch_pass_2');
    end if;
  end loop;
  :n := v_sum;
end;
/
print n
exec dbms_application_info.set_action('batch_audit')
insert into mtk_audit (id, note, created) select mtk_seq.nextval, 'wl batch ' || id, sysdate from mtk_cust where id <= 20;
rollback;
@@_epilogue.sql
