@@_prologue.sql basic_binds
variable b_num  number
variable b_vc2  varchar2(50)
variable b_long varchar2(2000)
variable b_chr  char(10)
variable b_dbl  binary_double
variable b_flt  binary_float
variable b_null varchar2(20)
variable b_lo   number
variable b_hi   number
begin
  :b_num  := 42;
  :b_vc2  := 'Customer 42';
  :b_long := rpad('L', 1500, 'ong text, ');
  :b_chr  := 'PAID';
  :b_dbl  := 3.141592653589793;
  :b_flt  := 2.5;
  :b_null := null;
  :b_lo   := 1;
  :b_hi   := 1000;
end;
/
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('arraysize15')
set arraysize 15
set termout off
exec :b_num := 1;  :b_lo := 1;    :b_hi := 1000
@@_basic_binds_q.sql
exec :b_num := 2;  :b_lo := 1001; :b_hi := 2000; :b_vc2 := 'second run'
@@_basic_binds_q.sql
exec :b_num := 3;  :b_lo := 2001; :b_hi := 3000; :b_chr := 'X'
@@_basic_binds_q.sql
exec :b_num := 4;  :b_lo := 3001; :b_hi := 4000; :b_dbl := -1.5e-300
@@_basic_binds_q.sql
exec :b_num := 5;  :b_lo := 4001; :b_hi := 5000; :b_vc2 := 'it''s "quoted"'
@@_basic_binds_q.sql
set termout on
exec dbms_application_info.set_action('arraysize500')
set arraysize 500
set termout off
exec :b_num := 6;  :b_lo := 5001; :b_hi := 6000
@@_basic_binds_q.sql
exec :b_num := 7;  :b_lo := 6001; :b_hi := 7000; :b_long := rpad('M', 1500, 'ore long text, ')
@@_basic_binds_q.sql
exec :b_num := 8;  :b_lo := 7001; :b_hi := 8000; :b_vc2 := 'unicode é 日本'
@@_basic_binds_q.sql
exec :b_num := 9;  :b_lo := 8001; :b_hi := 9000; :b_dbl := binary_double_infinity
@@_basic_binds_q.sql
exec :b_num := 10; :b_lo := 9001; :b_hi := 10000; :b_null := null
@@_basic_binds_q.sql
set termout on
exec dbms_application_info.set_action('typed_binds_plsql')
-- Types SQL*Plus VARIABLE cannot declare (DATE, TIMESTAMP, TSTZ, INTERVAL, RAW, ROWID, NVARCHAR2)
-- are bound from PL/SQL via native dynamic SQL (dep=1 BINDS section).
declare
  v_date  date                     := date '2024-02-29';
  v_ts    timestamp                := timestamp '2024-02-29 13:14:15.123456';
  v_tstz  timestamp with time zone := timestamp '2024-02-29 13:14:15.123456 +02:00';
  v_iv    interval day to second   := interval '3 04:05:06.789' day to second;
  v_ivym  interval year to month   := interval '1-6' year to month;
  v_raw   raw(16)                  := hextoraw('DEADBEEF00112233');
  v_rid   rowid;
  v_urid  urowid;
  v_nc    nvarchar2(20)            := n'日本語 ÄÖÜ';
  v_ch    char(5)                  := 'ab';
  v_bf    binary_float             := 1.5;
  v_bd    binary_double            := 2.25;
  v_num   number                   := 7;
  v_cnt   number;
  v_null  varchar2(10)             := null;
begin
  select rowid into v_rid from mtk_cust where id = 7;
  v_urid := v_rid;
  for i in 1 .. 10 loop
    execute immediate
      'select /* mtk_typed_binds */ count(*) from mtk_cust c ' ||
      ' where c.rowid = :rid and c.created < :d and :ts > :tstz - :iv and :ivym is not null' ||
      '   and :r is not null and c.id = :n and :nc is not null and :bf < :bd and :ch is not null' ||
      '   and :nul is null and c.rowid = :urid'
      into v_cnt
      using v_rid, v_date, v_ts, v_tstz, v_iv, v_ivym, v_raw, v_num + i, v_nc, v_bf, v_bd, v_ch, v_null, v_urid;
  end loop;
  -- static SQL with DATE / ROWID binds
  select count(*) into v_cnt from mtk_cust
   where created between v_date - 3650 and v_date and rowid <> v_rid;
end;
/
@@_epilogue.sql
