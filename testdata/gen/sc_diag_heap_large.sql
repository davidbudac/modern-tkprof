@@_prologue.sql diag_heap_large
-- Run as SYSDBA in CDB$ROOT (run_gen.sh does this). Heap dump of the large pool: 'heapdump level 32'.
-- As SYSDBA in the root the dump lists the chunks (the PX message pool buffers); as MTK in PDB1 it does not
-- (diag_heap_large_pdb).
exec dbms_application_info.set_action('heapdump_32')
alter session set events 'immediate trace name heapdump level 32';
@@_epilogue.sql
