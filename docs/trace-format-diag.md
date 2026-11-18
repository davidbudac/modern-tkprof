# Diagnostic dumps in trace files: format reference (19.27 lab)

Written 2026-11-17 from traces generated on the dbmint lab (Oracle 19.27, CDB `cdb1`, PDB `PDB1`) by
`testdata/gen/sc_diag_*.sql`. Everything below was read off those files; a line reference is
`fixture:line`. Fixtures are in `testdata/diag/19c/`; the ones marked *(big)* are over the size limit and are
in `testdata/big/diag/` (not in git, regenerated with `run_gen.sh diag`).

Plan: `docs/PLAN-DIAG.md`. What is not verified is listed at the end.

## How the dumps were produced

| Dump | Command | Needs |
|---|---|---|
| heap dump | `alter session set events 'immediate trace name heapdump level N'` | ALTER SESSION |
| error stack | `… 'immediate trace name errorstack level N'` (1, 2, 3), or on an error: `events '942 trace name errorstack level 2'` | ALTER SESSION |
| process state | `… 'immediate trace name processstate level 10'` | ALTER SESSION |
| PGA summary | `… 'immediate trace name pga_summary level 1'` | ALTER SESSION |
| PGA detail | `oradebug dump pga_detail_get <orapid>`, wait, `oradebug dump pga_detail_dump <orapid>`, `pga_detail_cancel` | SYSDBA |
| hang analysis | `oradebug hanganalyze 3`, or the event `immediate trace name hanganalyze level 3` | SYSDBA for oradebug |
| system state | `oradebug dump systemstate N` (1, 2, 258, 266) | SYSDBA |
| deadlock | written by Oracle on ORA-00060 | |
| incident | written by Oracle on an internal error (here ORA-06544) | |

All of them go to the trace file of the session that asked (a hang analysis too, not to a DIA0 file). The
deadlock trace is written only by the session that received ORA-00060; the other session writes nothing.

### Heap dump levels

| Level | Heaps dumped |
|---|---|
| 1 | `pga heap`, `top call heap`, `top uga heap` |
| 4 | `session heap` (the UGA) |
| 5 | `session heap`, then the three of level 1 |
| 2 | the shared pool: `sga heap`, `sga heap(1,0)`, `sga heap(1,3)`, `IMCA_RO`, `IMCA_RW` *(big: 32.7 MB, 502,806 lines)* |
| 32 | `large pool` |
| + 0x10000000 (268435457) | after each top heap, its five largest sub-heaps, one level |
| + 0x20000000 (536870913, 536870917) | the same, recursively (80 heaps in `diag_heap_sub`) |
| + 1024 (1025) | chunk contents; only PGA chunks print any (1028, 1032, 1056, 1058 print none) |

## Common frame

- **File header**: as a 10046 trace (`Trace file …`, version lines, `Unix process pid:`), then the `*** ` marker
  group (`SESSION ID`, `CLIENT ID`, `SERVICE NAME`, `MODULE NAME`, `ACTION NAME`, `CLIENT DRIVER`,
  `CONTAINER ID`). An incident file starts with `Dump file …` instead of `Trace file …`.
- **`*** ` timestamp lines occur inside dumps** (a new one whenever time has passed, with the container:
  `*** 2026-11-17T21:34:26.400889+00:00 ((1))`, `diag_errorstack_l2:5063`). A marker does not end a section.
- **Oradebug wraps its output**: `Processing Oradebug command 'hanganalyze 3'` before, `Oradebug command '…'
  console output: …` after (`diag_hang:38`, `:278`). The event form has neither.
- **`*** TRACE CONTINUES IN FILE` / `CONTINUED FROM FILE`** appear when `tracefile_identifier` changes mid-session.
- **No line inside any dump has the form of a 10046 record** (checked on every fixture: `PARSE #`, `EXEC #`,
  `WAIT #`, `PARSING IN CURSOR #`, …). In `diag_in_10046` the 98 such lines are all real records outside the dump.

## Heap dump

```
******************************************************
HEAP DUMP heap name="pga heap"  desc=0x7f952ce9a220
 extent sz=0x20c0 alt=272 het=32767 rec=0 flg=0x2 opc=0
 parent=(nil) owner=(nil) nex=(nil) xsz=0xfff0 heap=(nil) lru=(nil)
 fl2=0x60, fl3=0x0, nex=(nil), idx=0, dur=-1, dsxvers=1, dsxflg=0x0
 dsx first ext=0x7f952cd79b60
 dsx empty ext bytes=0  subheap rc link=0x7f952cd79c98,0x7f952b3b9288
 dsx heap size=4707160, dsx heap depth=0
 pdb id=0, src pdb id=0
EXTENT 0 addr=0x7f952ae99010
  Chunk     7f952ae99020 sz=     4328    free      "               "
  Chunk     7f952ae9a108 sz=     6128    freeable  "diag pga       "  ds=0x7f952ce557c8
  Chunk     7f952b3b9278 sz=     1240    recreate  "koh-kghu call  "
     ds     7f952bcd11e8 sz=  3552984 ct=      158
            7f952aad9020 sz=    65504
  Chunk     7f952ce58778 sz=     1512    perm      "perm           "  alo=1512
Total heap size    =  4707160
FREE LISTS:
 Bucket 0 size=56
  Chunk     7f952cdb6950 sz=       64    free      "               "
  Chunk     7f952cd79ba0 sz=        0   kghdsx
Total free space   =    49560
UNPINNED RECREATABLE CHUNKS (lru first):
PERMANENT CHUNKS:
  Chunk     7f952b4cc020 sz=   118624    perm      "perm           "  alo=115224
            7f952b4cc040 sz=    85776    cprm      "row cache      "
Permanent space    =   392464
No stack allocations
******************************************************
```

- **Start**: `HEAP DUMP heap name="<name>"  desc=0x<hex>`, after a line of 54 `*`. The name is padded or cut to
  about 15 characters and can end with a blank (`"koh-kghu call "`).
- **Header**: lines that begin with one blank. `parent=` is the descriptor of the parent heap ((nil) for a top
  heap); `dsx heap size=` is the total again; `dsx heap depth=` is the nesting depth; `pdb id=`.
- **Chunk line**: `  Chunk <hex addr> sz=<bytes> <type> "<comment>"` then optionally `ds=0x<hex>` (the
  sub-heap this chunk belongs to as an extent), `alo=<bytes>` (perm chunks), or in the shared pool a creation
  time `C21:34:59` followed by a `hits=` line. The address column is wider for SGA addresses (`0a3000068`).
- **Chunk types seen**: `free`, `freeable`, `recreate`, `perm`, `lastchk` (large pool), and in the shared pool
  `R-free`, `R-freeable`, `freeableU` and `recr` with a suffix (`recrPT001`, `recrUR001`, `recrPC001`, …).
- **A `ds` line follows the `recreate` chunk that holds a sub-heap's descriptor**: `ds <addr> sz=<bytes of
  the sub-heap> ct=<its extents>`, then up to ten of its extents as bare `<addr> sz=<bytes>` lines. The address
  is the `ds=0x…` of the parent's chunks and the `desc=` of the sub-heap's own dump.
- **Sections after the extents**, in this order: `Total heap size`, `FREE LISTS:` (`Bucket N size=<bytes>`
  lines, each with its chunks; a `kghdsx` chunk of size 0 is a list head), `Total free space`, `UNPINNED
  RECREATABLE CHUNKS (lru first):` (SGA heaps add a `SEPARATOR` line and `Unpinned space = N rcr=N trn=N`),
  `PERMANENT CHUNKS:` (each perm chunk again, with its parts as `cprm` lines), `Permanent space`.
- **End**: the first line of 54 `*` after the start. After `Permanent space` the rule does not always follow
  at once: `No stack allocations` can stand between, and a heap with sub-heaps lists them (`N LARGEST SUB HEAPS`,
  `SUBHEAP n: desc=`) and dumps each before its own end rule, so the first rule after a parent's start is the
  start rule of its first sub-heap (`diag_heap_sub:934`). Rules are shared: one rule can end a heap and lead the
  next (the large pool headers, `diag_heap_large:40`), or two stand in a row. A heap header
  with no extents (the `sga heap` latch directory at *(big)* `:198`, `IMCA_RO`, `IMCA_RW`, the first `large pool`
  header) ends at the next line of `*` and prints no totals.
- **Sub-heaps** (levels with the high bits): after a heap's `Permanent space`,

  ```
  5 LARGEST SUB HEAPS for heap name="pga heap"   desc=0x7fde9a405220
    Subheap ds=0x7fde992411e8  heap name=  koh-kghu call   size=         3552984
     owner=(nil)  latch=(nil)
  SUBHEAP 1: desc=0x7fde992411e8
  ```

  then the sub-heap's own `HEAP DUMP`, whose `parent=` is the parent's `desc` and whose `dsx heap depth` is one
  more (`diag_heap_sub:922-942`). The `size=` on the `Subheap` line is a little larger than the sub-heap's
  `Total heap size` (3,552,984 against 3,546,640).
- **Contents** (level 1025): after a chunk line, `Dump of memory from 0x… to 0x…`, rows of four 32-bit words
  with an ASCII column in brackets, and `Repeat N times` lines (`diag_heap_contents:43-50`).
- **A dump taken inside a PDB** omits other containers' chunks: `(only chunks clearly belonging to pdb id 3
  will be dumped)`, then the extent lines without chunks and the unchanged totals (`diag_heap_large_pdb`).
- **A sampled heap**: `Heap has significant amount of free memory (76 percent)` / `Dumping sample extents to
  show fragmentation pattern:` prints some extents only and no totals (`diag_pga_summary:90-99`).

**Totals, verified.** On all 87 heaps that print totals (the PGA, UGA, sub-heap, contents, large pool and
shared pool fixtures and the two heaps inside `diag_in_10046`):

- the sum of `sz=` over the chunk lines of the extents equals `Total heap size`;
- the sum over the chunk lines under `FREE LISTS:` equals `Total free space`, and equals the sum of the
  extents' `free` chunks in the PGA and UGA heaps;
- the sum over the `perm` chunk lines under `PERMANENT CHUNKS:` equals `Permanent space`.

The check cannot be made for a PDB-filtered dump, a sampled heap or a header without extents.

Read again for the reader (stage 3), on the 100 heaps of the committed fixtures and the five of the shared pool
dump (the totals test, `internal/diag`):

- the same holds for every heap: 288 of the 300 checks of the committed fixtures match, the other 12 are heaps
  that cannot be checked (6 headers without extents, 3 of a PDB-filtered dump, 3 of the sampled heap) and no
  check differs;
- an SGA heap prints **reserved free lists** after `Total free space`: `RESERVED FREE LISTS:` (and `... FOR SIZES
  64KB to 256KB:`, `... OVER 256KB:`) with ` Reserved bucket N size=` lines, each block closed by `Total of this
  reserved free space` and the whole by `Total of all reserved free space` (a heap with one block prints only the
  first). The `R-free` chunks under them sum to that total (shared pool: 24,345,192 for `sga heap(1,0)`); the
  reader makes it a fourth check;
- the chunk types of the shared pool also include `R-stopper` (`reserved stoppe`) and `mfreeable` (with
  `prv=`/`nxt=`), and the `recr` family has the shape `recr<P|U><C|T|R><nnn>`; `recreate` is not in it;
- a ` ds <addr> sz= ct=` line (the address without `0x` and, in the SGA, zero-padded) follows any chunk that
  holds a sub-heap descriptor, not only `recreate` ones (`recrPC001` in the shared pool); the `ds=0x..` of a
  chunk has no leading zeros;
- a **sampled heap** of a `pga_summary` stands inside the part `PRIVATE MEMORY SUMMARY FOR THIS PROCESS` (the
  outline gives it a node under that part); it prints chunk lines of the sampled extents and no totals, no free
  lists;
- a heap dump cut by the end of the file may stop in the middle of a line: a total printed on the last line is
  not taken.

## PGA memory dumps

**`pga_summary`** (`diag_pga_summary`) is the memory part an out-of-memory trace prints. Blocks in order:

```
=======================================
TOP 10 MEMORY USES FOR THIS PROCESS
---------------------------------------
32% 3429 KB, 217 chunks: "pl/sql vc2                "  PL/SQL
         koh-kghu call   ds=0x7f72d80b11e8  dsprt=0x7f72d9282220
```

- `TOP 10 MEMORY USES FOR THIS PROCESS`: pairs of lines; share, KB, chunks, comment, an optional category
  (`PL/SQL`, `SQL`); then the heap name, its descriptor and its parent's.
- `PRIVATE MEMORY SUMMARY FOR THIS PROCESS` / `PRIVATE HEAP SUMMARY DUMP`: totals (`10 MB total:`, commented,
  permanent, free), then `Summary of subheaps at depth N` blocks with `KB, N chunks:` or `KB, N heaps:` lines.
- heap dumps of heaps with much free memory (sampled, see above), `KGH STACK DUMP`.
- `Private memory usage per Oracle process`: `Top 10 processes:` (`17% ospid 2361 (MMON): 14 MB used, 108 MB
  alloc[, N KB freeable]`), then `All processes:`, with a `Begin session detail for pid N` … `End session
  detail` block (sid, serial, user, pdb, `current SQL:`) for a process over 32 MB.
- `ESTIMATED MEMORY USES FOR ALL PROCESSES`: `(from 10 snapshots out of 74 processes)`, then pairs of lines:
  share, size, processes, comment; heap name and chunks.
- `SWAP INFORMATION`: three lines.

Sizes are rounded (KB or MB as printed), so this dump has no exact total to check.

**`pga_detail_dump`** (`diag_pga_detail:45-1001`): between `Begin PGA memory detail dump` and `End PGA memory
detail dump`, under `PGA memory detail for pid N, OS pid N`, pairs of lines with exact bytes:

```
  3512312 bytes, 217 chunks: "pl/sql vc2                "  PL/SQL
          koh-kghu call   ds=0x7f584c9111e8  dsprt=0x7f584dae2220
```

## A diagnostic dump: error stack, call stack, process state

`errorstack`, a deadlock and an incident all write the same unit:

```
dbkedDefDump(): Starting a non-incident diagnostic dump (flags=0x0, level=1, mask=0x0)
----- Error Stack Dump -----
<error barrier> at 0x7ffc95d31c50 placed dbkda.c@298
----- Current SQL Statement for this session (sql_id=8fdx3ffur0ddr) -----
alter session set events 'immediate trace name errorstack level 1'
----- Parser State -----
----- PL/SQL Stack -----
----- PL/SQL Call Stack -----
  object      line  object
  handle    number  name
0x7b3c9620        11  procedure MTK.MTK_DIAG_INNER
----- Call Stack Trace -----
calling              call     entry                argument values in hex
location             type     point                (? means dubious value)
-------------------- -------- -------------------- ----------------------------
ksedst1()+95         call     kgdsdst()            7FFC95D310A0 000000002
                                                   7FFC95D2B2F0 ? 7FFC95D2B408 ?
```

- **Start**: `dbkedDefDump(): Starting a non-incident diagnostic dump (flags=…, level=N, mask=…)`; in an
  incident file `dbkedDefDump(): Starting incident default dumps (flags=0x2, level=3, mask=0x0)`.
- **Sections are `----- Title -----` lines.** In order at level 1 (`diag_errorstack_l1`): `Error Stack Dump`
  33, `Current SQL Statement for this session (sql_id=…)` 35 with the statement text, `Parser State` 37,
  `PL/SQL Stack` 42, `PL/SQL Call Stack` 43, `Call Stack Trace` 50, `Binary Stack Dump` 188 (a `========== FRAME
  [n] (caller()+off -> callee()) ==========` block per frame with registers and memory), `Argument/Register
  Address Dump` 2700, `End of Call Stack Trace` 4839, `Process Map Dump`, `Process Resource Limits`, `Java
  Stack`, `KSWRDUMP START` / `END`, `KSMEM_DUMP START` / `END`, `KSM MGA PRIVATE DUMP START` / `END`, `VKTM Time
  Drifts Circular Buffer`.
- **Call stack table**: three header lines, then per frame `caller()+offset`, `call`, `callee()`, argument
  values; continuation lines hold more arguments. A long caller name wraps: `dbkedDefDump()+2434` on one line
  and `7` at the start of the next (`:60-61`). The frame headers of the binary dump give the whole name
  (`dbkedDefDump()+24347 -> ksedst()`), so those are the reliable source of the frame list.
- **The PL/SQL call stack** is a table of handle, line number and object name, ended by a blank line.
- **Level 2 adds** (`diag_errorstack_l2`): `----- Process State Dump (2)-----` 5045 (the process state, below),
  `Session Cursor Dump` 7597, `Session Open Cursors` 7604, a `Dump Cursor sql_id=…` block per cursor with
  `Bind Byte Code (IN)` and `Bind Info (kkscoacd)`, `Session Cached Cursor Dump` 7955.
- **Level 3 adds** *(big `diag_errorstack`, 5.5 MB)*: `Fixed Areas Dump (level=327)` with the `Dump of the Fixed
  PGA`, `… SGA`, `… UGA` blocks, almost all `Dump of memory` rows.
- **Bind values** are printed in the cursor dumps, in the form of a 10046 `BINDS` body: ` Bind#0`, `oacdty=…`,
  `value=…` under `----- Bind Info (kkscoacd) -----`. These are what redaction has to act on.
- **End**: there is no end line. In a trace of its own the dump runs to the end of the file. Inside a 10046
  trace it runs to the next 10046 record: in `diag_in_10046` the dump is lines 114-29753 and the trace goes on
  with the separator and `PARSE ERROR #…: … err=942` at 29754-29755. The last lines of a dump vary (`about to
  signal 942`, `Name: MTK_NO_SUCH_TABLE`).
- **Other content inside**: block dumps (`tab 0, row 0`, `col 0: …`), heap dumps (two in `diag_in_10046`, with
  totals), an explain plan (`Explain Plan Dump`, `Plan Table`, `diag_deadlock:6140`).

## Process state

```
===================================================
PROCESS STATE
-------------
Process global information:
     process: 0xa255f4d8, call: 0x91171cf0, xact: (nil), curses: 0xa2759640, usrses: 0xa2759640
     in_exception_handler: no
  ----------------------------------------
  SO: 0xa2eec2a0, type: process (2), map: 0xa255f4d8
      state: LIVE (0x4532), flags: 0x1
      owner: (nil), proc: 0xa2eec2a0
      child list count: 6, link: 0xa2eec310[0xa2ef64c0, 0xa2fe96e0]
  SOC: 0xa255f4d8, type: process (2), map: 0xa2eec2a0
  (process) Oracle pid:6, ser:33, calls cur/top: 0x91171cf0/0x98ca4400
```

- **Start**: `PROCESS STATE` with a 13-dash underline, after a rule of `=`. As a dump of its own
  (`diag_procstate:33`) or as the section `Process State Dump (2)` of a diagnostic dump.
- **State object**: `SO: 0x<addr>, type: <name> (<number>), map: 0x<addr>`, indented two blanks per level of
  the tree; the next lines give `state:`, `owner: 0x<parent>, proc: 0x<process>` and `child list count:`. A
  `SOC:` line and the object's own text follow, which begins with the kind in parentheses: `(process)`,
  `(session)`, `(call)`, `(enqueue)`, …
- **Types seen in a user process**: process (2), session (4), call (3), enqueue (11), transaction (85), DML
  lock (83), LIBRARY OBJECT LOCK (118), LIBRARY OBJECT PIN (119), channel handle (19), Block List (84), and a
  few others. A level-266 system state shows 30 types *(big)*.
- **Session** (`diag_errorstack_l2:5121`): `(session) sid: 22 ser: 14058 trans: …`, `user#/name: 165/MTK`,
  `oct: 47, prv: 0, sql: 0x…, psql: 0x…`, `service name:`, `client details:` (machine, program, `application
  name:`, `action name:`), then

  ```
      Current Wait Stack:
       0: waiting for 'enq: TX - row lock contention'
          name|mode=0x54580006, usn<<16 | slot=0x80005, sequence=0x5817
          wait times: snap=7.175594 sec, exc=7.175594 sec, total=7.175594 sec
      There is at least one session blocking this session.
        Dumping 1 direct blocker(s):
          inst: 1, sid: 52, ser: 41898
        Dumping final blocker:
          inst: 1, sid: 52, ser: 41898
      There are 1 sessions blocked by this session.
      Wait State:
      Session Wait History:
       0: waited for 'SQL*Net message from client'
  ```

  or `Not in wait; last wait ended 0.058207 sec ago`. **The dump names the blockers itself.**
- **End**: `END OF PROCESS STATE` on a line of its own, the last line of a process state dump of its own
  (`diag_procstate:10394`) and of the one inside an errorstack (`diag_errorstack_l2:8732`). *(Corrected in
  stage 2: this reference first said 19.27 writes no such line.)* The dump before it ends with a `Fixed
  Areas Dump (level=65)` and `KSM MGA PRIVATE DUMP END` (`diag_procstate:10393`). The line is nested in an
  outer dump (errorstack, deadlock) as a line like any other: the outer one has no end line.

### Verified in stage 4 (`internal/diag/procstate.go`, `stack.go`)

- **`sql:` and `psql:` of a session** are addresses of library handles: the current top-level statement and the
  previous one (`big/diag_sysstate_l266`: sid 45, action `s2_holds_302_waits_301`, `sql:` is the `id = 301 ... wait 60`
  statement, `psql:` the `id = 302 for update` one). The session holds a `LIBRARY OBJECT LOCK` on each handle it
  used, whose text has `LibraryObjectLock:  Address= Handle=0x79a02048 Mode=N` and, under the `LibraryHandle:` line,
  `ObjectName:  Name=<statement>` and `FullHashValue=... Namespace=SQL AREA(00) SqlId=f3j90cdzgg7d2 Type=CURSOR(00)`
  (`diag_procstate:667-682`). A system state of level 1 prints no child state objects, so only the address is known.
- **Enqueues** are `ksqdmc(): Enqueue Dump (enqueue) TX-00050016-00005A54-ED94F66A-00000000` lines inside the text of
  several objects (the transaction, the DML lock, an `enqueue` object), each followed by `mode: X, lock_flag: 0x20` for a
  held lock or `req: X, lock_flag: 0x30` for a requested one (`big/diag_sysstate_l266:51935`: the TX that sid 45 requests
  carries the slot and sequence of its wait parameters and is the one the holder's transaction holds). `released
  enqueue or enqueue in flux` and `<no resource>` name none.
- **A transaction** prints `env [...]: (scn: ... xid: 0x0005.016.00005a54 ...)`, `Undo blks: 1 recs: 3` and `Begin scn:
  ... ts:...[11/17/2026 21:34:26]`; its child `Block List` has `index itli rdba sql_id obj# savepoint` rows (the sql_id of
  the statement that changed the block); a `DML lock` prints `DML LOCK: tab=108609 flg=11` and `his[0]: mod=3` (the
  table's TM enqueue `TM-0001A841` is the same object in hex and has mode SX).
- **Blockers**: `There is at least one session blocking this session.`, `Dumping 1 direct blocker(s):` and `Dumping final
  blocker:` each with `inst: 1, sid: 52, ser: 41898`; `There are 2 sessions blocked by this session.` with `Dumping one
  waiter:` (one is dumped however many there are), its `wait event:`, `p1:`...`p3:` lines, `row_wait_obj#: 108609,
  block#: 169252, row#: 6, file# 12` and `min_blocked_time:`. A session blocked by another has the blocker in the Process
  Summary as `Blocked by` and `Final Blocker` lines.
- **The command**: the Process Summary's `Cmd:` line next to the session's `oct:` gives 3 `SELECT` and 47 `PL/SQL
  EXECUTE` on the lab (levels 1, 2, 258, 266); 0 has no `Cmd:`. Other numbers are not named.
- **A process in a system state may print no session object** (`big/diag_sysstate_l266:33578`, a job process that the
  summary lists with a session).
- **The tree of state objects ends** at the first line of `=` or titled `----- X -----` after it
  (`diag_errorstack_l2:7338`, the instantiation state banner).
- **The call stack table** can hold a `*** 2026-11-17T21:34:27.435785+00:00 (PDB1(3))` timestamp marker and a blank
  line in its middle (`diag_in_10046:188`); its wrapped names are cut at the 20 characters of the first and third
  column and continue on the next line in the same column. `CALL TYPE: call   ERROR SIGNALED: yes   COMPONENT: KSM`
  under a frame header says the frame signalled the error (`big/diag_oom_incident`: frames 9 and 12).
- **An event-written dump** (`diag_in_10046`) has no ORA- line: its error is `about to signal 942` and `Name:
  MTK_NO_SUCH_TABLE` at its end (`:29752`). An incident file prints its ORA- lines before the dump (`[TOC00001]`,
  `big/diag_oom_incident:36`) and in an `error stack dump with barriers` block (`:114740`).

## System state

```
===================================================
SYSTEM STATE (level=10, with short stacks)
------------
Dumping the Process Summary
       2: PMON ospid 2188 sid 1 ser 13443, waiting for 'pmon timer'
       6: USER ospid 13945 sid 52 ser 41898, waiting for 'PL/SQL lock timer'
          Cmd: PL/SQL EXECUTE
      61: USER ospid 13947 sid 255 ser 62769, waiting for 'enq: TX - row lock contention'
…
PROCESS 2: PMON
…
END OF SYSTEM STATE
```

- **Start**: `SYSTEM STATE (level=N[, with short stacks])` with a dash underline; before it the caller's short
  stack. **End**: `END OF SYSTEM STATE`.
- **`Dumping the Process Summary`**: one line per process: Oracle pid, name (`USER` for a foreground), `ospid`,
  `sid`, `ser`, and `waiting for '<event>'` or nothing; an optional `Cmd:` line. This is the summary
  `ass109.awk` was written to produce.
- **`PROCESS <n>: <name>`** starts each process; under it the process's state object tree as in a process state,
  with a `Short stack dump:` (functions joined by `<-`) at levels with short stacks.
- **Levels on the lab** (about 80 processes): 1 = processes and sessions only (1.1 MB, 26,094 lines); 2 = all
  state objects (4.3 MB); 258 = 2 with short stacks; 266 = 10 with short stacks (4.9 MB, 83,386 lines) *(big)*.
- After the last process: Data Guard broker state and `KSM MGA SYSTEM DUMP`.
- **What each level prints about blockers** (checked in stage 6 on the four fixtures; the three sessions of the chain are
  sid 255 blocked by 45, blocked by 52, which sleeps): the same at levels 1, 2, 258 and 266.
  1. The process summary marks the blocked sessions: under the line of a session that waits for a lock, `Blocked by inst:
     1, sid: 45, ser: 12004` (the direct blocker) and `Final Blocker inst: 1, sid: 52, ser: 41898` (`diag_sysstate_l1:104-107`,
     `:114-117`; the same lines at `:106-109` and `:116-119` in level 266). A session that blocks and is not blocked, and
     every other session, has no mark. The summary has no "blocks N" line.
  2. The body of each blocked session prints `There is at least one session blocking this session.`, `Dumping 1 direct
     blocker(s):` and `Dumping final blocker:` each with `inst: 1, sid:, ser:` (level 1: `:18586-18588`, `:21582-21585`;
     level 2: `:42312`, `:49312`; level 258: `:41718`, `:48732`; level 266: `:42451`, `:50387`).
  3. The body of a session that blocks others prints `There are N sessions blocked by this session.` and `Dumping one
     waiter:` with that waiter's `inst: 1, sid:, ser:`, `wait event:`, `p1:`..`p3:`, `row_wait_obj#:` and
     `min_blocked_time:`: one waiter whatever N is (the holder, which blocks two, dumps only its direct waiter: level 1
     `:3416-3417`, `:21586-21587`). N counts the sessions below it in the chain, direct or not.
  What differs between the levels is what surrounds this: level 1 prints no child state objects, so a session's
  statement is only the address of its library handle (`sql: 0x797b5b90`); levels 2, 258 and 266 print the library
  object locks, so the statement and its sql_id are known (`LibraryHandle:` with `ObjectName:  Name=` and
  `FullHashValue=... SqlId=...`); 258 and 266 add a `Short stack dump:` per process. The summary and the bodies are
  written at different moments: on a live instance a process can move on between them (level 266, process 60, `CJQ0`:
  the summary says `waiting for 'enq: JG - queue lock'`, its body is in `rdbms ipc message`).
- **Summary lines**: `1: PSEUDO process` (no ospid, no sid); `35: D000 ospid 2365 sid 0 ser 0, ` (a process with no session
  and no wait: dispatchers, parallel slaves `P000`); `10: GEN1 ospid 2299_2300 sid 5 ser 2712,` (a thread of a
  multithreaded process: `ospid <pid>_<tid>`); the process that takes the dump has a session and no wait
  (`74: USER ospid 13944 sid 61 ser 58038, `, the session of the `*** SESSION ID:(61.58038)` marker). Entries are in
  Oracle process number order with gaps (no 41, 75-77, 82-104); a `PROCESS n:` body exists for each entry.
- **Before the section** (outside it, as the parser leaves them): `Processing Oradebug command 'dump systemstate 266'`, then
  `System state caller's stack:`, `Short stack dump: ` and the caller's stack on one line, `ksedsts()+426<-ksdxfstk()+63<-...`
  (`diag_sysstate_l1:35-38`): the first two functions are the signal handler's, the rest is where the caller stood.

## Hang analysis

- **Start**: a rule of 79 `=`, `HANG ANALYSIS:` and its header lines. **End**: `END OF HANG ANALYSIS` between
  rules (`diag_hang:254`), followed by a `HANG ANALYSIS DUMPS:` … `HANG ANALYSIS DUMPS: END` block.
- `Chains most likely to have caused the hang:` lists ` [a] Chain 1 Signature: 'X'<='Y'<='Z'` and its hash.
- Each `Chain N:` is a list of sessions, the first waiting, each next one after `and is blocked by` / ` =>`:

  ```
      Oracle session identified by:
      {
                  instance: 1 (cdb1.cdb1)
                     os id: 13912
                process id: 61, oracle@ol9-19-dg1.localdomain
                session id: 255
          session serial #: 22508
               module name: 3 (mtk_diag_chain-dg1.localdomain (TNS V1-V3))
                    pdb id: 3 (PDB1)
      }
      is waiting for 'enq: TX - row lock contention' with wait info:
      {
                        p1: 'name|mode'=0x54580006
              time in wait: 4.029036 sec
                  blocking: 0 sessions
            current sql_id: 3373088609
               current sql: select id from mtk_cust where id = 302 for update wait 60
               short stack: ksedsts<-ksdxfstk<-…
              wait history:
      }
  ```

- **`current sql_id` is a number, and it is the high half of the sql_id, not the hash value** (checked in stage 5).
  A sql_id is the last 8 bytes of the statement's MD5 spelled in base 32 (alphabet `0123456789abcdfghjkmnpqrstuvwxyz`,
  13 characters). The library handle of the statement prints the whole MD5 as `FullHashValue=`, and its last 4 bytes
  as the hash value (`Hash=` on the `LibraryHandle:` line, `Identifier=` on the `FullHashValue` line, `hv=` of a 10046
  trace). The number a hang analysis prints is the 4 bytes before those: bytes 9 to 12 of the `FullHashValue`. The
  statements of `sc_diag_chain` appear in both kinds of dump:

  | statement | sql_id | `FullHashValue` | hash value (`Hash=`) | `current sql_id` in `diag_hang` (`:86`, `:125`, `:214`) |
  |---|---|---|---|---|
  | `select id from mtk_cust where id = 302 for update wait 60` | `ck39zc6g6ufn3` | `ee9e4662e14b3f2e`**`c90d3f61`**`9e6d3a83` (`big/diag_sysstate_l266:42802`) | 2657958531 = 0x9e6d3a83 | 3373088609 = 0xc90d3f61 |
  | `select id from mtk_cust where id = 301 for update wait 60` | `f7y3fp7r3u84f` | `397184b5a5b27134`**`e3f86ea9`**`ee3d208e` (`:50680`) | 3996983438 = 0xee3d208e | 3824709289 = 0xe3f86ea9 |
  | `DECLARE job BINARY_INTEGER := :job; ...` (the scheduler job) | `8gqhcqqam4cth` | `ee4c5ff77583903b`**`87da0cb5`**`95323330` (`:32332`) | 2503095088 = 0x95323330 | 2279214261 = 0x87da0cb5 |

  On all 386 statement handles of `big/diag_sysstate_l266` the sql_id spells the last 8 bytes of the `FullHashValue`,
  and `Identifier=` and `Hash=` are its last 4 (`TestHangSqlIDHigh`). So the number is the **high 32 bits of the sql_id's
  number** (the reader names it `sqlIdHigh`), it cannot be matched to a `hv=` of a 10046 trace, and it can be matched to
  a `sqlid=` by decoding the sql_id (`diag.SQLIDParts`). `0` is no statement (`diag_hang_event` chain 3, a Data Guard
  process). The first reading of this reference, which listed it as probably the 10046 `hv=`, was wrong.
- **Other lines the reader reads** (stage 5): `process id: 40, oracle@ol9-19-dg1.localdomain (J001)` names the
  background process in parentheses; `module name: 3 (mtk_diag_chain-dg1.localdomain (TNS V1-V3))` has the container id
  before the parenthesis, and its text is the module joined with what follows it in the dump's buffer (the scheduler
  job's reads `DBMS_SCHEDULERstack_l1aldomain (TNS V1-V3)` in `diag_hang` and `DBMS_SCHEDULER-dg1.localdomain (TNS
  V1-V3)` in `diag_hang_event`: the tail of the previous string shows through), so the reader keeps it as printed;
  `heur. time in wait:` (`diag_hang_event:196`) and `timeout after: never` (`:241`); a session that waits for nothing
  that has a name prints no parameter lines (`Redo Transport Attach`); `current sql:` is on one line (cut in the
  fixture lines shown above) and is absent from the event form (`diag_hang_event`), which also prints no `short stack:`
  and no `analysis initiated by oradebug` line (the oradebug form prints it, `diag_hang:44`).
- **Groups of chains**: `Non-intersecting chains:` (chains whose head waits for something), then `Sessions in an
  involuntary wait or not in a wait:` for chains whose head waits for an event the dump does not count as a
  blocking wait (here `Streams AQ`, `Redo Transport Attach`: `diag_hang:189`, `diag_hang_event:175`).
- **The chain's order**: a chain's first session waits, each next one is the one `and is blocked by` / ` =>` names, the
  last one is the head. The signature lists the events from the head: `'PL/SQL lock timer'<='enq: TX - row lock
  contention'<='enq: TX - row lock contention'` for a chain whose sessions wait, in order, for the TX lock, the TX lock and
  the timer. `blocking: N sessions` counts the sessions below it in the chain (0, 1, 2).
- `State of ALL nodes` lists `[nodenum]/cnode/sid/sess_srno/session/ospid/state/[adjlist]`: one row per node of a chain (`[254]/1/255/22508/0xa299efe8/13912/NLEAF/[51]`); the adjacency is the node the session is blocked by (`[254]` is session 255, `[51]` session 52, which is the next in the chain).

## Deadlock graph

```
DEADLOCK DETECTED ( ORA-00060 )
…
Deadlock graph:
                                          ------------Blocker(s)-----------  ------------Waiter(s)------------
Resource Name                             process session holds waits serial  process session holds waits serial
TX-000A0009-00004D46-ED94F66A-00000000         61     255     X        52110       6      61           X  27430
 
----- Information for waiting sessions -----
Session 255:
Holds resource TX-000A0009-00004D46-ED94F66A-00000000 acquired 5 seconds ago.
  sid: 255 ser: 52110 audsid: 4273372 user: 165/MTK
  current SQL:
  select id from mtk_cust where id = 202 for update wait 30
----- End of information for waiting sessions -----
```

- **Start**: `DEADLOCK DETECTED ( ORA-00060 )` (`diag_deadlock:33`), one line after a `ksqdld_hdr_dump()` line.
- The graph is a fixed-column table, one row per resource. The sessions' blocks follow, each with its
  `current SQL:`.
- **The graph's columns**: the header words give the right edge of each cell; the numbers and modes are right-aligned, an empty cell
  is blank (a blocker that does not wait, a waiter that holds nothing: `diag_deadlock:46-47`), and the waiter's group sits
  one character to the left of its header words. Both rows of the fixture: the blocker holds `X`, the waiter waits for `X`; the row
  is `resource, blocker process/session/holds/waits/serial, waiter process/session/holds/waits/serial`.
- **The trace is the victim's**: the process that received ORA-00060 writes it, so the `*** SESSION ID:(255.52110)` marker before
  the graph (`diag_deadlock:24`) is the victim, session 255, whose statement is the `Current SQL Statement` of the dump that
  follows. `Rows waited on:` (`diag_deadlock:4124`) is in the dump that follows the graph, after the heaps and areas, one
  `Session N: obj - rowid = 0001A841 - AAAahBAAMAAApUZAAD` and one `(dictionary objn - 108609, file - 12, block - 169241, slot - 3)`
  line per session.
- **After `End of information for waiting sessions` a whole diagnostic dump follows** (level 1 with a process
  state and cursor dumps, 10,478 lines in all), so the graph is 50 lines of a 636 KB file.

## Incident file

*(big `diag_oom_incident`, 5.4 MB, an ORA-06544 incident.)*

- The session's trace gets two lines: a timestamp and `Incident 199651 created, dump file: …/incdir_199651/
  cdb1_ora_11593_i199651.trc`.
- The incident file has its own header and marker group, then:

  ```
  [TOC00000]
  Jump to table of contents
  Dump continued from file: /u01/…/trace/cdb1_ora_11593_mtk_diag_exp10.trc
  [TOC00001]
  ORA-6544 [pevm_peruws_callback-1] [27102] [] [] [] [] [] [] [] [] [] []
  [TOC00001-END]
  [TOC00002]
  ========= Dump for incident 199651 (ORA 6544 [pevm_peruws_callback-1]) ========
  dbkedDefDump(): Starting incident default dumps (flags=0x2, level=3, mask=0x0)
  [TOC00003]
  ----- Current SQL Statement for this session (sql_id=gcdr7qpu1ctg0) -----
  ```

- **`[TOCnnnnn]` and `[TOCnnnnn-END]` markers bracket the sections and nest**: 209 opening markers (`TOC00000`
  to `TOC00208`) and 208 closing ones (`TOC00000` has none). 117 of the opening markers are a line of their
  own; the other 92 stand at the end of a line (`        NamespaceDump:  [TOC00026]`, `:79806`). A closing
  marker is a line of its own and can be indented.
- **The file ends with the table of contents itself** (`:114950`): `TOC00000 - Table of contents`, then one line
  per marker, `| ` per nesting level and `TOCnnnnn - <title>`, closed by `End of TOC`. This is a ready outline
  of the file.

## What mtkprof makes of these files today

`mtkprof lint` (before any change): every line of a dump is `unknown` (1,455 of 1,486 in `diag_heap_pga`,
79,864 in the level-266 system state); the file kind is `none`. `diag_in_10046` is a 10046 trace with 29,371
unknown lines. Put in `testdata/traces/19c/` it breaks `TestClassifyMatchesParser` (`internal/trace`): 211 lines
of the dump (`Dump of memory …`, ` Bind#0`, `oacdty=…`) are `bind-line` to `trace.Classify` and unknown to the
parser, because a real `BINDS` block precedes the dump. The fixture therefore waits in `testdata/diag/19c/`
until the parser tracks sections (stage 2), and `go test ./internal/golden` passes with it in either place.

## What the parser does with them (stage 2)

`internal/trace/section.go` (header comment) has the rules; one section per `HEAP DUMP`, runs of heaps
adjacent, the other kinds as above. Lines no section takes: the `Processing Oradebug command ...` and
`Oradebug command ... console output` wrapper lines, the caller's short stack before a system state, the
`ksqdld_hdr_dump()` line before a deadlock graph, the latch directory before the first shared pool heap.

## Not verified

- **A real ORA-04030 or ORA-04036 trace.** Under a memory limit (`ulimit -d` or `-v`) this host fails the
  allocation with ORA-27102, which PL/SQL raises as an ORA-06544 incident; event 10261 gives ORA-10260. The
  memory blocks are those of `pga_summary` by their titles; that an ORA-04030 trace prints the same blocks is
  not shown by a fixture.
- **Other versions.** No committable public sample was found. Local only, no licence: four 10.2 XE deadlock
  traces (heap dump, process state, deadlock graph; a different state object syntax) and one 11.2.0.2 RAC `lmd0`
  trace. Nothing from 12.x, 18c, 21c or 23ai.
- **RAC and shared server**; a system state of a busy instance (the lab has about 80 processes, three in a
  chain).
- **The end of a diagnostic dump inside a 10046 trace** is seen once (`diag_in_10046`).
- **A session in a hang analysis chain that is not in a wait**, and a chain over two instances: the reader reads a line that does not say `waiting for '...'` as the state and keeps its text; no fixture shows one.
- **ORA-04031** (shared pool) traces; latch and mutex waits in a system state; library object lock waits.
- **A dump cut by `max_dump_file_size`.**
