@@_prologue.sql diag_errorstack
-- Error stack, level 3 (about 5.5 MB and 116,000 lines: it ends with a dump of the fixed PGA, SGA and UGA
-- areas), written from inside PL/SQL with two open cursors that have bind variables (see _diag_errorstack_body.sql).
-- Too big for a fixture: diag_errorstack_l2 is the same without the fixed areas.
@@_diag_errorstack_body.sql 3
@@_epilogue.sql
