-- Run as MTK inside PDB1. Idempotent: objects created only if missing, data loaded only if empty.
set echo off feedback on serveroutput on size unlimited verify off
whenever sqlerror continue
declare
  procedure ddl(p_sql varchar2) is
  begin
    execute immediate p_sql;
    dbms_output.put_line('created: ' || substr(p_sql, 1, 60));
  exception
    when others then
      -- ORA-00955 name in use, ORA-01408 column list already indexed,
      -- ORA-02260/02264/02275 constraint already exists
      if sqlcode in (-955, -1408, -2260, -2264, -2275) then
        dbms_output.put_line('exists:  ' || substr(p_sql, 1, 60));
      else
        raise;
      end if;
  end;
begin
  ddl('create table mtk_cust (
         id      number        constraint mtk_cust_pk primary key,
         name    varchar2(100),
         created date,
         amount  number(12,2),
         notes   varchar2(2000))');
  ddl('create table mtk_orders (
         id         number       constraint mtk_orders_pk primary key,
         cust_id    number       not null constraint mtk_orders_cust_fk references mtk_cust(id),
         order_date date,
         amount     number(12,2),
         status     varchar2(10))');
  ddl('create index mtk_orders_cust_ix on mtk_orders(cust_id)');
  ddl('create table mtk_audit (
         id         number,
         table_name varchar2(30),
         row_id     number,
         cust_total number,
         created    timestamp default systimestamp,
         username   varchar2(128))');
  ddl('create table mtk_lob (
         id number constraint mtk_lob_pk primary key,
         c  clob,
         b  blob)
       lob(c) store as securefile mtk_lob_c (nocache)
       lob(b) store as securefile mtk_lob_b (nocache)');
  ddl('create sequence mtk_seq start with 1000000 increment by 1 cache 100');
end;
/

-- Function with a SELECT inside (dep=1 when called from SQL, dep=2 when called from the trigger)
create or replace function mtk_f(n in number) return number is
  v_amount number;
begin
  select nvl(max(amount), 0) into v_amount from mtk_cust where id = n;
  return v_amount;
end mtk_f;
/

-- Procedure with a static cursor; PL/SQL keeps it open between calls (used by midtrace_start)
create or replace procedure mtk_p_cached(p_cust in number, p_cnt out number) is
begin
  select /* mtk_p_cached static cursor */ count(*) into p_cnt
    from mtk_orders where cust_id = p_cust;
end mtk_p_cached;
/

-- Data: ~20k customers, ~100k orders (loaded BEFORE the trigger exists on first run)
declare
  v_n number;
begin
  select count(*) into v_n from mtk_cust;
  if v_n = 0 then
    insert into mtk_cust (id, name, created, amount, notes)
    select level,
           'Customer ' || level || ' ' || dbms_random.string('a', 20),
           date '2020-01-01' + mod(level, 2000),
           round(dbms_random.value(0, 100000), 2),
           rpad(dbms_random.string('x', 40), 200 + mod(level, 300), 'x')
      from dual connect by level <= 20000;
    dbms_output.put_line('mtk_cust loaded: ' || sql%rowcount);
    commit;
  end if;
  select count(*) into v_n from mtk_orders;
  if v_n = 0 then
    insert into mtk_orders (id, cust_id, order_date, amount, status)
    select level,
           mod(level * 7919, 20000) + 1,
           date '2021-01-01' + mod(level, 1500),
           round(dbms_random.value(1, 5000), 2),
           case mod(level, 5) when 0 then 'NEW' when 1 then 'PAID' when 2 then 'SHIPPED'
                              when 3 then 'CLOSED' else 'CANCEL' end
      from dual connect by level <= 100000;
    dbms_output.put_line('mtk_orders loaded: ' || sql%rowcount);
    commit;
  end if;
end;
/

-- LOB rows: 32 KB, 128 KB, 256 KB, 512 KB, 1 MB (clob and blob of the same size)
declare
  v_n     number;
  v_c     clob;
  v_b     blob;
  v_chunk varchar2(32767);
  v_raw   raw(32767);
  v_reps  number;
begin
  select count(*) into v_n from mtk_lob;
  if v_n = 0 then
    for i in 1 .. 5 loop
      insert into mtk_lob (id, c, b) values (i, empty_clob(), empty_blob())
        returning c, b into v_c, v_b;
      v_chunk := rpad('clob row ' || i || ' ', 32000, 'abcdefghij ');
      v_raw   := utl_raw.cast_to_raw(v_chunk);
      v_reps  := power(2, i - 1) * 1;           -- 1,2,4,8,16 chunks of 32 KB
      if i = 1 then v_reps := 1; elsif i = 2 then v_reps := 4; elsif i = 3 then v_reps := 8;
      elsif i = 4 then v_reps := 16; else v_reps := 32; end if;
      for k in 1 .. v_reps loop
        dbms_lob.writeappend(v_c, length(v_chunk), v_chunk);
        dbms_lob.writeappend(v_b, utl_raw.length(v_raw), v_raw);
      end loop;
    end loop;
    commit;
    dbms_output.put_line('mtk_lob loaded');
  end if;
end;
/

-- Trigger (created after the initial load so the load does not fire it)
create or replace trigger mtk_orders_bi
before insert on mtk_orders
for each row
begin
  insert into mtk_audit (id, table_name, row_id, cust_total, username)
  values (mtk_seq.nextval, 'MTK_ORDERS', :new.id, mtk_f(:new.cust_id), user);
end;
/

begin
  dbms_stats.gather_table_stats(user, 'MTK_CUST',   cascade => true);
  dbms_stats.gather_table_stats(user, 'MTK_ORDERS', cascade => true);
  dbms_stats.gather_table_stats(user, 'MTK_LOB',    cascade => true);
  dbms_stats.gather_table_stats(user, 'MTK_AUDIT',  cascade => true);
end;
/
select object_type, object_name, status from user_objects order by 1, 2;
select 'mtk_cust' t, count(*) from mtk_cust union all select 'mtk_orders', count(*) from mtk_orders
union all select 'mtk_lob', count(*) from mtk_lob union all select 'mtk_audit', count(*) from mtk_audit;
exit
