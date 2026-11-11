-- Defines &TAG, unique per run (month-day, time to the millisecond). Put it in a comment of every statement a
-- 10053 scenario traces, so the statement is hard parsed (a new sql_id) on every run and always writes a dump.
-- Run it BEFORE the event is turned on.
column mtk_tag new_value TAG noprint
select to_char(systimestamp, 'MMDD"t"HH24MISSFF3') mtk_tag from dual;
