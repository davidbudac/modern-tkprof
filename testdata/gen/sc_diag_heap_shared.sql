@@_prologue.sql diag_heap_shared
-- NOT A FIXTURE (about 31 MB). Run as SYSDBA in CDB$ROOT (run_gen.sh does this; the result goes to out/big/).
-- Heap dump of the shared pool: 'heapdump level 2'.
exec dbms_application_info.set_action('heapdump_2')
alter session set events 'immediate trace name heapdump level 2';
@@_epilogue.sql
