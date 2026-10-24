@@_prologue.sql bind_types
-- Bind memory dumps of the types SQL*Plus VARIABLE cannot declare, with the
-- values chosen to exercise every branch of the decoders (docs/trace-format-19c.md,
-- "Bind dump formats"). Each statement is run with two value sets.
alter session set time_zone = '+01:00';
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('bind_types')
declare
  v_cnt number;
  procedure run(
    p_ts    timestamp,
    p_tstz  timestamp with time zone,
    p_tsltz timestamp with local time zone,
    p_ds    varchar2,
    p_ym    varchar2,
    p_raw   raw,
    p_date  date) is
    v_ds interval day(9) to second(9) := to_dsinterval(p_ds);
    v_ym interval year(9) to month    := to_yminterval(p_ym);
  begin
    execute immediate
      'select /* mtk_bind_types */ count(*) from dual where :ts is not null and :tstz is not null ' ||
      ' and :tsltz is not null and :ds is not null and :ym is not null and :r is not null and :d is not null'
      into v_cnt using p_ts, p_tstz, p_tsltz, v_ds, v_ym, p_raw, p_date;
  end;
begin
  -- set 1: fractional seconds, positive offsets, positive intervals
  run(timestamp '2024-02-29 13:14:15.123456789',
      timestamp '2024-02-29 13:14:15.123456 +02:00',
      timestamp '2024-07-01 23:59:59.5',
      '3 04:05:06.789',
      '1-6',
      hextoraw('DEADBEEF00112233445566778899AABBCCDDEEFF'),
      date '1999-12-31');
  -- set 2: no fraction, negative offset with minutes, region id, negative and large intervals
  run(timestamp '1970-01-01 00:00:00',
      timestamp '2031-11-05 08:30:00 America/Los_Angeles',
      timestamp '2000-01-01 00:00:00',
      '-12 23:59:58.000001',
      '-123-11',
      hextoraw('00'),
      date '2024-10-22' + 12/24 + 35/1440 + 31/86400);
  -- set 3: tz offset with minutes, zero and 9-digit day interval
  run(timestamp '2024-12-31 23:59:59.999999999',
      timestamp '2024-12-31 23:59:59.999999 -03:30',
      timestamp '2024-12-31 23:59:59.999999',
      '0 00:00:00',
      '0-0',
      hextoraw('FF'),
      date '0001-01-01');
  -- set 4: numeric extremes of the interval types
  run(timestamp '2024-02-29 12:00:00',
      timestamp '2024-02-29 12:00:00 UTC',
      timestamp '2024-02-29 12:00:00',
      '999999999 23:59:59.999999999',
      '999999999-11',
      hextoraw('0102030405060708090A0B0C0D0E0F10'),
      date '2024-02-29');
end;
/
@@_epilogue.sql
