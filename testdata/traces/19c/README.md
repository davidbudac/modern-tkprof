# Oracle 19c SQL trace (event 10046) fixtures

Real traces captured on the "dbmint" lab: VirtualBox VM `ol9-19-dg1.localdomain`
(`ssh -p 2200 oracle@dbmint`), Oracle Database 19c EE **19.27.0.0.0**
(build `RDBMS_19.27.0.0.0DBRU_LINUX.X64_250331`), SQL*Plus 19.27, kernel
5.15.0-316 UEK, CDB `cdb1` with PDB `PDB1` (con_id 3, service `pdb1`, listener
service name `pdb1.world`). Trace directory (ADR):
`/u01/app/oracle/diag/rdbms/cdb1/cdb1/trace`. All sessions connected as schema
user `MTK` (uid 165) through the listener (`*** CLIENT DRIVER:(SQL*PLUS)`), with
`NLS_LANG=AMERICAN_AMERICA.AL32UTF8` and DB charset AL32UTF8.

Generator: `testdata/gen/run_gen.sh` (runs inside the VM; see its header).
Unless noted, every scenario uses
`alter session set tracefile_identifier='mtk_<scenario>'`,
`dbms_application_info.set_module('mtk_<scenario>','start')`,
`dbms_session.set_identifier('mtk_client_<scenario>')`, then
`alter session set events '10046 trace name context forever, level 12'`, and ends
with `alter session set events '10046 trace name context off'`.
The `.trc` files are byte-exact copies (`cp -p`). For every trace there is
`<name>.tkprof.txt` (`tkprof ... sys=yes waits=yes aggregate=yes sort=prsela,exeela,fchela`)
and `<name>.tkprof-noagg.txt` (same with `aggregate=no`).

Global observations (all files): cursor ids are 64-bit addresses
(`#140124363561040`); `WAIT #0:` lines exist (LOB reads, PX dequeues); every
`PARSING IN CURSOR` is preceded by a `=====================` line; PL/SQL blocks
sent by SQL*Plus end with a newline, so an empty line precedes `END OF STMT` for
them but not for plain SQL; marker lines (`*** ACTION NAME:` etc.) are followed
by a line containing a single space; `len=` in `PARSING IN CURSOR` is a byte
count (UTF-8 text inside); timestamps look like
`*** 2026-10-22T11:35:03.510078+00:00 (PDB1(3))`; `STAT` lines appear only at
cursor close; `CLOSE` has `type=0|1|3`; there is no `kkscoacd` line in 19c.

## basic_binds.trc (213,689 bytes, 3,059 lines)
10 executions of the same parameterized select (`/* mtk_basic_binds */`) with
SQL*Plus `variable` binds: NUMBER, VARCHAR2 short and 1500 chars, CHAR(10),
BINARY_DOUBLE (incl. `binary_double_infinity`), BINARY_FLOAT, a NULL VARCHAR2
bind referenced twice; 5 runs with `set arraysize 15` (FETCH r=15), 5 with
`arraysize 500`. Each `exec :b := ...` between runs is itself a traced PL/SQL
block with binds. A PL/SQL block then binds DATE (oacdty=12), TIMESTAMP (180),
TIMESTAMP WITH TIME ZONE (181), INTERVAL YEAR TO MONTH (182), INTERVAL DAY TO
SECOND (183), RAW (23), ROWID/UROWID (208), NVARCHAR2 (frm=02) and CHAR (96) via
`execute immediate ... using` (dep=1), plus a static SQL with DATE binds.
Oddities: the 1500-char value is truncated and the line ends with `ong "...`
(no closing quote, trailing `...`); the second and third references to the
NULL bind print `No oacdef for this bind.`; DATE prints `value="10/22/2026 11:35:3"`
(no zero padding); the INTERVAL DAY TO SECOND bind prints
`value=Unhandled datatype (-73) found in kxsbndinf` followed by **unindented**
`Dumping '' addr=0x... size=11 bytes`, `Dump of memory from 0x... to 0x...` and
a hex row `7F713EE967A0 03000080 AF424140 00402F07           [....@AB../@.]`;
TIMESTAMP/TSTZ binds use the same memory-dump form instead of `value=`.

## plsql_recursive.trc (121,044 bytes, 2,419 lines)
`mtk_f` called from SQL and from PL/SQL (its SELECT at dep=1), an insert into
`mtk_orders` firing trigger `mtk_orders_bi` (audit insert dep=1, `mtk_f` select
dep=2, 106 lines with dep=2), a FORALL insert of 50 rows, BULK COLLECT, a cursor
FOR loop, then `commit` (`XCTEND rlbk=0, rd_only=0`), insert + `rollback`
(`XCTEND rlbk=1, rd_only=0`), a read-only `commit` (`XCTEND rlbk=0, rd_only=1`),
and cleanup DELETEs. `set serveroutput on` was active, so SQL*Plus's
`BEGIN DBMS_OUTPUT.GET_LINES(:LINES, :NUMLINES); END;` appears with a PL/SQL
collection bind `oacdty=123 mxl=656(656)` followed by unindented
`toid ptr value=61F11290 length=16` and a raw hex line `86B64B66F23D012EE053F706E80A06`.
Oddity: the FORALL array binds show `mal=00` and only the first row's values; the
array nature is visible only as `EXEC ... r=50` at dep=1.

## errors.trc (54,346 bytes, 895 lines)
`PARSE ERROR #...:len=31 dep=0 uid=165 oct=3 lid=165 tim=... err=942` (and err=936)
followed by the statement text on the next line(s) with **no** `END OF STMT`, then
`WAIT ... nam='SQL*Net break/reset to client' ... break?=1`. `ERROR #cursor:err=1 tim=...`
for ORA-00001 (both dep=0 and inside PL/SQL dep=1), err=20001 for
`raise_application_error`, err=1403 for unhandled NO_DATA_FOUND, err=1476.
Oddity: the ORA-01722 raised during the first fetch of `/* mtk_fetch_error */`
produces **no** `ERROR #` line, only `FETCH ... r=0` followed by STAT lines and
the break/reset wait. One `log file sync` and `db file sequential read` on
recursive dictionary SQL (sys objects obj#=720/721) are present.

## io_waits.trc (1,591,810 bytes, 16,428 lines)
Session parameters `"_serial_direct_read"=always`, `workarea_size_policy=manual`,
`sort_area_size=65536`, `hash_area_size=131072` (all as traced ALTER SESSION
statements). Full scans give `direct path read` (`file number=12 first dba=...
block cnt=...`) preceded by `enq: KO - fast object checkpoint` (631 ms once) and
`reliable message`; the order-by and hash join spill: 1,607 `direct path write temp`
and 6,943 `direct path read temp` on `file number=203` (tempfile 3 + db_files 200).
600 random single-row lookups by PK from PL/SQL. Also `PGA memory operation`,
`asynch descriptor resize`, `Disk file operations I/O`, `SQL*Net more data to client`.
Oddity: only 3 `db file sequential read` because the small tables were already
cached (direct reads bypass the cache; cannot flush it with session-level rights).

## lobs.trc (135,180 bytes, 1,627 lines)
`set long 2000000 longchunksize 32767`, client selects of CLOB/BLOB columns
(128 KB/256 KB rows), `substr` on a clob, PL/SQL `dbms_lob.writeappend/read/write/
copy/append/createtemporary/freetemporary` (rolled back), `insert ... select` of LOB
rows, a client-side temporary CLOB bind (`variable vc clob`, `print`), and a partial
read with `set long 100`. Lines: 80 `LOBREAD: type=PERSISTENT LOB,bytes=8191,c=...,e=...,p=4,cr=1,cu=0,tim=...`,
14 `LOBREAD: type=TEMPORARY LOB,...`, `LOBARRTMPFRE: type=PERSISTENT LOB,...` and
`type=TEMPORARY LOB`. Oddities: no `LOBGETLEN`/`LOBWRITE`/`LOBAPPEND` lines at
all: SQL*Plus never calls OCILobGetLength/Write and server-side `dbms_lob` calls
are not traced as LOB* lines; LOB physical reads are `WAIT #0: nam='direct path read'`
with `obj#=108616` (the LOB segment, see reference/mtk_objects.csv).

## plan_stat_all.trc (29,266 bytes, 450 lines)
First half enabled with `alter session set events 'sql_trace wait=true, bind=true,
plan_stat=all_executions'` (ended with `'sql_trace off'`), second half with
`dbms_session.session_trace_enable(waits=>true, binds=>true, plan_stat=>'ALL_EXECUTIONS')`
(ended with `session_trace_disable`); the same `/* mtk_plan_stat_all */` query ran
5 times per half with different `:cid` values, giving 15 two-line STAT blocks for
one sqlid (30 STAT lines).

## plan_change.trc (28,589 bytes, 450 lines)
One sql_id with two plans in the same trace: `select /* mtk_plan_change */ count(*),
max(amount) from mtk_orders where cust_id = :cid` (sqlid `70qh8zxg4kk69`) ran 5 times
(`:cid` 11..15, action `plan_index`) with plan hash **254283197** (`INDEX RANGE SCAN
MTK_ORDERS_CUST_IX` + `TABLE ACCESS BY INDEX ROWID BATCHED`, cr=7), then
`alter session set optimizer_index_cost_adj = 10000` (traced) and 5 more times
(`:cid` 21..25, action `plan_full`) with plan hash **3570327658** (`TABLE ACCESS FULL
MTK_ORDERS`, cr=499, cost=137). The changed optimizer environment makes the cached
child unshareable, so the first parse after the ALTER is a hard parse (`PARSE ... mis=1`,
`EXEC ... mis=1`) of a new child under the same parent (`ad='6f54c890'` for both).
tkprof (aggregate=yes) prints two sections with the same `SQL ID` and different
`Plan Hash`, 5 executions each. Oddities: only 3 of the 5 runs per plan have a
`PARSING IN CURSOR` block and STAT lines; runs 4 and 5 are session-cursor-cache hits
(the previous CLOSE is `type=1`, then a bare `PARSE ... mis=0` on the same cursor number,
`CLOSE type=3`) and dump no STAT lines, giving 3 STAT blocks per plan (6 total, 15 lines);
for this single-row aggregate the STAT lines appear right after the first FETCH (r=1),
before the trailing `FETCH ... r=0` and the CLOSE; `PARSE` lines of the hard parses show
`plh=0`, the plan hash appears from the EXEC on.

## level_1.trc / level_4.trc / level_8.trc (7,812 / 10,207 / 10,377 bytes; 122 / 189 / 143 lines)
Same body (two selects with a bind, an insert + rollback, a PL/SQL call of `mtk_f`)
traced at `level 1` (no WAIT, no BINDS), `level 4` (8 BINDS sections, no WAIT),
`level 8` (21 WAIT lines, no BINDS). STAT lines appear at all levels.

## truncated.trc (307,257 bytes, 5,620 lines)
`alter session set max_dump_file_size='300K'` then a PL/SQL loop of 1,500 iterations
each hard-parsing a unique statement. The file stops mid-`BINDS` section (the last
lines are `BINDS #...:` and an empty line) and ends with
`*** DUMP FILE SIZE IS LIMITED TO 307200 BYTES ***` plus a trailing empty line; the
trace-off statement and everything after it are absent.

## cursor_cache.trc (55,236 bytes, 794 lines)
Two statements (`/* mtk_cc_a */`, `/* mtk_cc_b */`) alternated 20 times from
SQL*Plus with a third statement every 7th round and a bind change at round 10
(`session_cached_cursors=50`). CLOSE types: 8 x `type=0`, 3 x `type=1`,
34 x `type=3`; the same cursor address is reused for different statements.

## nasty_sql.trc (33,687 bytes, 282 lines)
Statement texts that mimic trace lines: a `/* WAIT #1: nam='fake wait' ... */`
comment, a `-- END OF STMT` line (preserved verbatim inside the text), a statement
starting with a multi-line `/* PARSING IN CURSOR #0 ... ===== */` comment, a
multi-line string literal whose lines start with `PARSING IN CURSOR #99`, `END OF STMT`,
`PARSE #99`, `BINDS #99`, ` Bind#0`, `EXEC`, `WAIT`, `FETCH`, `STAT`, `CLOSE`,
`XCTEND`, `*** 2099-...`, `*** SESSION ID:(1.1)`, `*** DUMP FILE SIZE IS LIMITED TO 1 BYTES ***`
and `=====================`; q-quoted strings, doubled quotes, tabs, UTF-8
(é ü ß 日本語 ✓ €, a `"日本"` column alias, a Japanese comment), empty lines inside
a statement (`set sqlblanklines on`), a 4,570-char single-line IN-list (dep=0) and
an 8,970-char dynamic one (dep=1), a statement with form-feed and vertical-tab
characters. Oddities: SQL*Plus strips CR from script lines, so CRLF inside a
literal survived only in the dynamically built `/* mtk_nasty_crlf */` statement
(the file contains exactly 2 CR bytes); SQL*Plus's 4,999-char line limit caps dep=0
line length; Oracle rejects doubled double quotes inside a quoted identifier
(ORA-03001), so that case was dropped.

## multisession_a.trc / multisession_b.trc / multisession.trc (16,670 / 14,807 / 29,637 bytes; 263 / 230 / 448 lines)
Two concurrent SQL*Plus sessions (modules `mtk_multisession_a` / `_b`, `dbms_session.sleep`
between statements) traced into two files, merged with
`trcsess output=multisession.trc service=pdb1 multisession_a.trc multisession_b.trc`.
Oddity (important): trcsess output has **no file header and no `*** SESSION ID`
lines**; each session switch is a `*** [ Unix process pid: 133531 ]` line (5
switches), and the original `*** SESSION ID/CLIENT ID/SERVICE NAME/MODULE NAME/ACTION NAME`
lines are reduced to bare `*** 2026-10-22T11:35:39.957522+00:00` timestamps
(text after the timestamp removed); `*** CLIENT DRIVER` and `*** CONTAINER ID` survive.

## parallel.trc / parallel_slave.trc (62,601 / 7,499 bytes; 702 / 92 lines)
Query coordinator trace of `select /*+ parallel(mtk_orders 4) */ count(*), max(amount)`
and a parallel GROUP BY: waits `PX Deq: Execute Reply`, `PX qref latch`,
`PX Deq: Slave Session Stats`, `PX Deq: Signal ACK EXT`, `PX Deq: Parse Reply`,
`PX Deq: Join ACK`, `enq: PS - contention`, `oracle thread bootstrap`. The slave
file (`cdb1_p000_8505_mtk_parallel.trc`, the identifier propagates to slaves) has
`*** CLIENT DRIVER:(SERVER)`, `*** TRACE CONTINUED FROM FILE .../cdb1_p000_8505.trc ***`
(the slave's pre-identifier file), the rewritten PX SQL at dep=1, `WAIT #0:` PX
dequeue lines, and two `*** SESSION ID` blocks (the slave served both queries).

## midtrace_start.trc / midtrace_start_part1.trc (27,619 / 9,253 bytes; 398 / 171 lines)
`mtk_p_cached` (static SQL kept open by PL/SQL) was run once untraced, then traced
(part 1, identifier `mtk_midtrace_start_part1`); a PL/SQL block then opened an
explicit cursor, fetched 5 rows, and switched `tracefile_identifier` to
`mtk_midtrace_start` from inside the fetch loop. Part 1 ends with
`*** TRACE CONTINUES IN FILE ... ***`; part 2 starts with a full file header,
`*** TRACE CONTINUED FROM FILE ... ***`, and immediately `FETCH #139660687918112`
lines (dep=1, r=1) for a cursor that has no `PARSING IN CURSOR` anywhere in that
file, plus `PARSE/BINDS/EXEC/CLOSE` for the `BEGIN mtk_p_cached(:c, :n); END;`
cursor whose text is only in part 1. Oddities: 19c re-dumps `PARSING IN CURSOR`
for an already-open PL/SQL cursor on its first EXEC after trace-on (that is why the
file switch was needed), and ALTER SESSION invalidates PL/SQL-cached cursors
(`EXEC ... mis=1` on their next run).

## ../../big/big_loop.trc (117,735,707 bytes, 2,881,438 lines; git-ignored)
Level 12 trace of a PL/SQL loop of 120,000 iterations (one PK lookup on `mtk_cust`
and one insert into `mtk_audit` each, commit every 1,000; ~990 bytes/iteration,
200k iterations would exceed the 150 MB target) followed by a cleanup DELETE.
Composition: 240,134 EXEC, 240,134 CLOSE, 240,007 BINDS, 120,002 FETCH, 602 WAIT
(`db file scattered read`, `db file parallel read`, `log buffer space`,
`log file sync`, `log file switch completion`), 122 XCTEND, 11 PARSING IN CURSOR.
Regenerate with `BIG_ITER=<n> ./run_gen.sh big`.
