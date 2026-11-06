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

## exec_loom.trc (68,606 bytes, 751 lines)
Execution Loom fixture (generated 2026-11-06): the same statements run several times under different cache and read-path
conditions, so their executions have the same call shape and different waits. Actions:
`index_cold_warm` runs `/*+ index(b mtk_loom_cold_pk) mtk_loom_ix */` (`a4vuwhqavzph4`) twice over the same random
range of 2,000 ids of `MTK_LOOM_COLD` (obj# 141881; a table nothing else reads, see `01_schema.sql`): the first run
reads 118 table blocks (118 `db file sequential read` of obj#=141881, 5.82 ms), the second finds them cached
(pr=0, 648 µs). `scan_paths` runs `/*+ full(o) mtk_loom_scan */` (`fc6cz74rbm46b`) three times with arraysize
1000: buffered (`"_serial_direct_read"=never`) twice, then direct (`always`): a 239 ms `enq: KO - fast object
checkpoint` in the first FETCH (its obj#=141881 is left over from the previous wait), then 26 `direct path read`
(`file number=12`) over the fetches. `dml_current` runs a no-op UPDATE of 1,000 `mtk_orders` rows twice
(cu=1029/1028; `db file scattered read` with obj#=0 and two `db file parallel read` with obj#=-1), then rollback.
Oddity: a child cursor that has run twice keeps its read path when `"_serial_direct_read"` changes (seen on the first
run: three buffered scans), so the direct run also sets `optimizer_index_cost_adj=101`: a new child of the same sql_id
and plan hash, hard-parsed under `always` (`EXEC ... mis=1`), then reset to 100. tkprof prints `mtk_loom_scan` once
(3 executions, aggregate=yes).

## stats_basic.trc (18,506 bytes, 276 lines)
`alter session set statistics_level = basic` under 10046 level 12, then multi-line-plan queries (a nested-loop join
with group by, a hash join of 2,000 customers with `mtk_orders`, a correlated subquery) and a PL/SQL loop of 5
lookups (dep=1). Basic turns `timed_statistics` off, which in 19c means: **no STAT lines at all**, `c=0` on every
PARSE/EXEC/FETCH/CLOSE (`e=` and the calls' `tim=` still measured), and every WAIT line `ela= 0 ... tim=0` (61 of 63);
the lines after the traced `alter session set statistics_level = typical` (line 264) are timed again. tkprof shows cpu 0.00 everywhere and the same zeros for the waits.
A 19c trace never has STAT lines without row-source statistics (`op='... (cr=...)'`; the bare `op='...'` is the
pre-9.2 format). Probed on 19.27, nine ways, 2026-11-06: `statistics_level=basic` with timed_statistics off gives no
STAT under 10046 level 12, under `sql_trace ... plan_stat=all_executions`, under
`dbms_session.session_trace_enable(plan_stat=>'ALL_EXECUTIONS')` and with the cursor hard-parsed before tracing;
basic with `timed_statistics=true` (10046, `sql_trace` event or `dbms_session`) gives full `(cr=... time=...)`
lines; `"_rowsource_execution_statistics"=false` with `"_rowsource_statistics_sampfreq"=0` gives them with `time=0`.
So Row flow's "table + note" state (STAT lines with no statistics) stays unit-tested only.

## px_io.trc / px_io_slave_p000..p003.trc (65,916 / 17,588, 17,821, 35,139, 34,845 bytes; 791 / 171, 172, 310, 305 lines)
PX slaves with physical reads. `MTK_PX_BIG` (obj# 141877, 120,000 rows of about 420 bytes, about 7,000 blocks / 57 MB,
loaded direct-path; above the small-table threshold, so the slaves do not read it through the buffer cache) scanned by
`/*+ parallel(b 4) full(b) mtk_px_scan */ count(*), sum(amount), max(length(pad))` (action `px_scan`, `cznmg6kxgvkpu`)
and `/*+ parallel(b 2) full(b) mtk_px_group */ grp, count(*), sum(amount) ... group by grp order by grp`
(`px_group_by`, two slave sets). Coordinator: `PX Deq: Execute Reply` (110), `PX qref latch` (101),
`resmgr:cpu quantum` (14), `PX Deq: Join ACK` / `Parse Reply` / `Signal ACK EXT` / `Slave Session Stats`,
`enq: PS - contention`, no physical reads of the table. One file per slave process (`run_gen.sh` case `px_io` copies
every `cdb1_p0*_mtk_px_io.trc` of the run), each with `*** TRACE CONTINUED FROM FILE .../cdb1_p00N_<pid>.trc ***`, two
`*** SESSION ID` blocks and the rewritten PX SQL at dep=1: 547 `direct path read` in all (`file number=12 first dba=...
block cnt=` 2 to 32, obj#=141877): p000 74 and p001 75 (px_scan only; they were the consumer set in px_group_by),
p002 58 + 144 and p003 84 + 112 (both queries). No `enq: KO` (the direct-path load left no dirty blocks).
tkprof of a slave file shows the coordinator's statement texts (cznmg6kxgvkpu: 1,484 disk in p002).

## pinx_worker.trc (1,376,259 bytes, 22,865 lines)
Not from `run_gen.sh`: captured **live** from the PINX lab workload (schema
`PINX`, jobs `PINX_W001..24` running `pinx_hot_loop(worker, 20, 1)` against `T`).
Tracing was enabled on an already-running session from `CDB$ROOT` with
`alter session set container=PDB1` plus
`dbms_monitor.session_trace_enable(session_id=>40, serial_num=>63025, waits=>true,
binds=>true)`, ran ~25 s (tkprof: 24 elapsed seconds), then `_disable`d. The target
is a DBMS_SCHEDULER job slave (process `J00A`, ospid 5386): header has
`*** CLIENT DRIVER:(SERVER)`, `*** MODULE NAME:(PINX_WORKER)`, service `SYS$USERS`
- the first fixture not connected as `MTK` through the listener, and with no
`tracefile_identifier` (ADR name `cdb1_j00a_5386.trc`).
Composition (~1,176 loop iterations, each: hot query, 1 insert, commit, 20 ms
`dbms_session.sleep`): hot 4-way self-join on `T` (`5wrhf4jjs6mhs`, 1,176
EXEC+FETCH, 84,672 consistent gets), `INSERT INTO T (T_SEQ.NEXTVAL...)`
(`c1a8kv5yb4741`, 1,176), `COMMIT` traced as its own cursor `oct=44` with `ad='0'`
(`8ggw94h7mvxd7`, 1,188 EXEC + 24 PARSE), `SELECT PINX_CTL` (`14nmm1y6sp13p`,
1,176, the per-iteration control check - with think_ms>0 `l_batch` is 1) and
heartbeat `UPDATE PINX_POOL` (`1dkfaz4f4sk0f`, 12 EXEC, `:B1..:B4`).
Oddities: **every traced line is `dep=2`** - the dep=0 job wrapper and the
procedure body were already executing when tracing started, so no dep=0/dep=1
cursor is ever dumped and tkprof labels all 5 statements `(recursive depth: 2)`
with all-zero OVERALL TOTALS under NON-RECURSIVE; **no `STAT` lines at all** (no
statement plan in 19c without STAT dump: tkprof prints Plan Hash from the EXEC
`plh=` only, COMMIT shows `Plan Hash: 0`); all 4,728 `CLOSE` are `type=3`; only
5 `PARSING IN CURSOR` blocks and 24 `PARSE` lines (all 24 from the COMMIT cursor,
all soft: `mis=0` in every PARSE/EXEC/FETCH line); 1,188 `WAIT` = 1,176
`PL/SQL lock timer` (the 20 ms sleeps, 23.72 s total) + 7 `db file scattered
read` + 4 `buffer busy waits` + 1 `PGA memory operation`; 1,188 `XCTEND rlbk=0,
rd_only=0`. Regenerate by tracing any live PINX worker the same way.

## pinx_worker_w01/_w06/_w11/_w16/_w21.trc (5 more live captures, 2026-11-06)
Second PINX batch: workload restarted with `pinx.pinx_lab.start_workers(24, 20,
2000, 60, 1)`, then five workers traced **concurrently** - one PDB1 block doing
five `dbms_monitor.session_trace_enable`, `dbms_session.sleep(25)`, five
`_disable` (tkprof: 24 elapsed seconds in each file). All are job slaves with
`*** CLIENT DRIVER:(SERVER)`, `*** MODULE NAME:(PINX_WORKER)`, no
`tracefile_identifier`. Sizes/lines: w01 1,412,941/23,302, w06 1,403,313/23,097,
w11 1,399,960/23,042, w16 1,401,681/23,058, w21 1,401,890/23,076. Sessions:
w01=SID 48/43923 (`J003`, ospid 37070, ADR `cdb1_j003_37070.trc`), w06=56/45765
(`J007`, 37078), w11=310/18210 (`J005`, 37074), w16=71/49311 (`J00N`, 37110),
w21=259/39858 (`J00B`, 37086).
w06/w11/w16/w21 are composition clones of `pinx_worker.trc`: same 5 cursors, ~18
more iterations (1,183-1,186 `PL/SQL lock timer` waits, 1,196-1,199 `XCTEND`,
4,758-4,770 `CLOSE` `type=3`), **all lines `dep=2`**, no `STAT` lines, all parses
soft (`mis=0`), e.g. w06 hot cursor 1,186 EXEC+FETCH, 85,392 consistent gets.
w01 is the interesting one: it hard-parsed inside the window - 11 cursors
instead of 5 and 10 `mis=1` lines - pulling in 6 recursive cursors the siblings
never show: sequence cache-miss `UPDATE seq$` (`4m7m0t6fjcs5x`, `dep=3`) and
five dictionary lookups at `dep=4` (`gx4mv66pvj3xz` `con$`/`cond$`,
`cw1mnps0mfazc` `/*+ rule */ con$`, `a4n4ayr88dbhy` + `6h3cwmunz5z8q` `col$`
privilege checks, `53saa2zkr6wc3` `icol$`). So dep is not flat there: 11,903
`dep=2` + 6 `dep=3` + 63 `dep=4`, and the tkprof output is ~2x the siblings'.

## ../../big/big_loop.trc (117,735,707 bytes, 2,881,438 lines; git-ignored)
Level 12 trace of a PL/SQL loop of 120,000 iterations (one PK lookup on `mtk_cust`
and one insert into `mtk_audit` each, commit every 1,000; ~990 bytes/iteration,
200k iterations would exceed the 150 MB target) followed by a cleanup DELETE.
Composition: 240,134 EXEC, 240,134 CLOSE, 240,007 BINDS, 120,002 FETCH, 602 WAIT
(`db file scattered read`, `db file parallel read`, `log buffer space`,
`log file sync`, `log file switch completion`), 122 XCTEND, 11 PARSING IN CURSOR.
Regenerate with `BIG_ITER=<n> ./run_gen.sh big`.
