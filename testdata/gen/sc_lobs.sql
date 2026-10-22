@@_prologue.sql lobs
set serveroutput on size unlimited
set long 2000000 longchunksize 32767 linesize 32767 arraysize 10
alter session set events '10046 trace name context forever, level 12';
exec dbms_application_info.set_action('client_select_lob')
set termout off
select id, dbms_lob.getlength(c) as clen, dbms_lob.getlength(b) as blen from mtk_lob order by id;
select /* mtk_lob_clob_client */ id, c from mtk_lob where id in (2, 3) order by id;
select /* mtk_lob_blob_client */ id, b from mtk_lob where id = 2;
select /* mtk_lob_substr */ id, substr(c, 1, 100) as head from mtk_lob order by id;
set termout on
exec dbms_application_info.set_action('plsql_lob_write')
declare
  v_c    clob;
  v_b    blob;
  v_tmp  clob;
  v_buf  varchar2(4000);
  v_raw  raw(4000);
  v_amt  number;
  v_len  number;
begin
  select c, b into v_c, v_b from mtk_lob where id = 1 for update;
  v_buf := rpad('appended by mtk_lobs scenario ', 4000, 'z');
  v_raw := utl_raw.cast_to_raw(v_buf);
  for i in 1 .. 5 loop
    dbms_lob.writeappend(v_c, length(v_buf), v_buf);
    dbms_lob.writeappend(v_b, utl_raw.length(v_raw), v_raw);
  end loop;
  v_len := dbms_lob.getlength(v_c);
  dbms_output.put_line('clob length after append = ' || v_len);
  v_amt := 4000;
  dbms_lob.read(v_c, v_amt, 1, v_buf);
  dbms_lob.write(v_c, 10, 1, 'OVERWRITE!');
  dbms_lob.createtemporary(v_tmp, true);
  dbms_lob.copy(v_tmp, v_c, 20000);
  dbms_lob.append(v_tmp, v_c);
  dbms_output.put_line('temp lob length = ' || dbms_lob.getlength(v_tmp));
  dbms_lob.freetemporary(v_tmp);
  rollback;   -- keep the fixture data unchanged
end;
/
exec dbms_application_info.set_action('insert_select_lob')
insert into mtk_lob (id, c, b) select id + 100, c, b from mtk_lob where id in (1, 2);
select id, dbms_lob.getlength(c) as clen from mtk_lob where id > 100;
update mtk_lob set c = c || ' (updated)' where id = 101;
rollback;
exec dbms_application_info.set_action('client_temp_lob')
variable vc clob
begin
  dbms_lob.createtemporary(:vc, true);
  dbms_lob.writeappend(:vc, 30, 'client side temp lob content..');
end;
/
select length(:vc) as tmp_len from dual;
print vc
select :vc as tmp_clob from dual;
insert into mtk_lob (id, c) values (200, :vc);
rollback;
exec dbms_lob.freetemporary(:vc)
exec dbms_application_info.set_action('client_partial_read')
set long 100 longchunksize 100
select /* mtk_lob_partial_read */ id, c from mtk_lob where id in (4, 5) order by id;
set long 2000000 longchunksize 32767
variable vc2 clob
begin select c into :vc2 from mtk_lob where id = 2; end;
/
print vc2
@@_epilogue.sql
