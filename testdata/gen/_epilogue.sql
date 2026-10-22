-- Common epilogue: trace off, reset module, record the trace file name.
alter session set events '10046 trace name context off';
exec dbms_application_info.set_module(null, null)
set heading off feedback off pagesize 0 termout off trimspool on linesize 1000
spool out/&SCN..tracefile
select value from v$diag_info where name = 'Default Trace File';
spool off
set termout on
exit
