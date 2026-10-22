@@_prologue.sql truncated
alter session set max_dump_file_size = '300K';
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('fill_trace')
declare
  v number;
begin
  for i in 1 .. 1500 loop
    select count(*) into v from mtk_orders where cust_id = mod(i, 20000) + 1;
    -- unique statement text each time: hard parse + PARSING IN CURSOR + STAT lines
    execute immediate 'select /* mtk_truncated ' || i || ' */ count(*) from mtk_cust where id = :1' into v using i;
  end loop;
end;
/
select count(*) from mtk_cust;
@@_epilogue.sql
