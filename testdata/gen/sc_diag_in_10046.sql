@@_prologue.sql diag_in_10046
-- A 10046 trace with an error stack of level 2 inside it (event 942, ORA-00942), see _diag_in_10046_body.sql.
-- Level 2 because level 3 makes the trace 5.2 MB (diag_in_10046_l3). tkprof is run on it.
@@_diag_in_10046_body.sql 2
@@_epilogue.sql
