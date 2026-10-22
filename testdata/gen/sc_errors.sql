@@_prologue.sql errors
set serveroutput on size unlimited
whenever sqlerror continue
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('parse_error')
select * from mtk_no_such_table;
select id, from mtk_cust;
select id from mtk_cust where name = :undefined_bind_is_client_side_only;
exec dbms_application_info.set_action('fetch_error')
select /* mtk_fetch_error */ id, to_number(name) from mtk_cust where id <= 5;
set arraysize 2
select /* mtk_fetch_error_divzero */ id, 1/(id - 3) from mtk_cust where id <= 5 order by id;
set arraysize 15
exec dbms_application_info.set_action('unique_violation')
insert into mtk_cust (id, name) values (1, 'duplicate of id 1');
exec dbms_application_info.set_action('plsql_exception')
begin
  raise_application_error(-20001, 'mtk custom error raised from PL/SQL');
end;
/
declare
  v number;
begin
  select id into v from mtk_cust where id = -1;   -- NO_DATA_FOUND
exception
  when no_data_found then
    dbms_output.put_line('no_data_found handled inside the block');
end;
/
declare
  v number;
begin
  select id into v from mtk_cust where id = -2;   -- unhandled NO_DATA_FOUND -> ORA-01403 to the client
end;
/
declare
  v number := 0;
begin
  v := 1 / v;   -- ORA-01476 raised in PL/SQL
end;
/
begin
  insert into mtk_cust (id, name) values (2, 'dup from plsql');   -- ORA-00001 at dep=1
end;
/
exec dbms_application_info.set_action('after_errors')
select count(*) as still_alive from mtk_cust;
rollback;
@@_epilogue.sql
