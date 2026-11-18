@@_prologue.sql diag_in_10046_l3
-- The same as diag_in_10046 with the error stack at level 3 (5.2 MB, 110,000 lines; too big for a fixture).
-- tkprof is run on it.
@@_diag_in_10046_body.sql 3
@@_epilogue.sql
