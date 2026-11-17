@@_prologue.sql diag_heap_uga
-- Heap dumps of the session's UGA, two in one trace file, with the same load as diag_heap_pga (see _diag_heap_load.sql):
-- 'heapdump level 4' (UGA only) and then 'heapdump level 5' (PGA and UGA). An "*** ACTION NAME:(heapdump_<level>)"
-- line marks the start of each.
@@_diag_heap_load.sql 4
@@_diag_heap_load.sql 5
@@_epilogue.sql
