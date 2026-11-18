@@_prologue.sql diag_heap_sub
-- Heap dumps with sub-heaps, three in one trace file, with the same load as diag_heap_pga (see _diag_heap_load.sql):
-- 'heapdump level 268435457' (0x10000001), then 536870913 (0x20000001), then 536870917 (0x20000005).
-- An "*** ACTION NAME:(heapdump_<level>)" line marks the start of each.
@@_diag_heap_load.sql 268435457
@@_diag_heap_load.sql 536870913
@@_diag_heap_load.sql 536870917
@@_epilogue.sql
