@@_prologue.sql diag_heap_large_pdb
-- Heap dump of the large pool as MTK in PDB1: 'heapdump level 32'. It works for a non-SYSDBA session, but prints
-- "(only chunks clearly belonging to pdb id 3 will be dumped)" and no chunks.
exec dbms_application_info.set_action('heapdump_32')
alter session set events 'immediate trace name heapdump level 32';
@@_epilogue.sql
