@@_prologue.sql diag_heap_contents
-- Heap dump of the PGA with contents: 'immediate trace name heapdump level 1025' (1 = PGA, 1024 = memory contents),
-- issued as a plain statement in an otherwise idle session (no PL/SQL block, no open cursors, nothing allocated),
-- because the same level from inside a PL/SQL block with 3 MB of data is 36 MB and an empty one already 5 MB.
exec dbms_application_info.set_action('heapdump_1025')
alter session set events 'immediate trace name heapdump level 1025';
@@_epilogue.sql
