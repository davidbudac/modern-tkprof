@@_prologue.sql cursor_cache
alter session set events '10046 trace name context forever, level 12';
variable cid number
exec :cid := 3
set termout off
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
select /* mtk_cc_c */ sysdate, :cid from dual;
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
exec :cid := 4
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
select /* mtk_cc_c */ sysdate, :cid from dual;
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
@@_cursor_cache_pair.sql
set termout on
@@_epilogue.sql
