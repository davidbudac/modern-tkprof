# Oracle 19c optimizer trace (event 10053) — format reference

Verified on 2026-11-10 against real 19.27 traces generated in the dbmint lab (schema `MTK`, session-level
events, read-only queries; the commands are in the last section). They are not fixtures yet: `docs/PLAN-10053.md`
step 1 adds the scenarios to `testdata/gen`. Anything not seen in those traces is marked *(unverified)* with its
source. 21c and 23ai were not generated.

mtkprof does not read this format today: `mtkprof lint` on a file holding both events parses the 10046 part
correctly and counts the rest as unknown lines (26,757 of 28,194).

## What the trace is

The optimizer's log of **one hard parse**: one dump per optimized statement, written while the statement is
compiled. It has no `tim=` values and no per-line timestamps; it is a record of decisions, not of time. A
statement that finds a shareable cursor writes nothing.

## How it is produced

| Command | Notes |
|---|---|
| `alter session set events '10053 trace name context forever, level 1'` / `... context off` | the classic event. Level 1 and level 2 gave the same output on 19.27 apart from ids (older sources say level 2 leaves the statistics out). |
| `alter session set events 'trace[rdbms.SQL_Optimizer.*]'` / `... off` | unified tracing, 11g+; same format on 19.27. `[sql:<sql_id>]` limits it to one statement *(unverified here; oracle-base.com)*; also `alter system` *(unverified; Jonathan Lewis, Oracle-L 2022)*. |
| `dbms_sqldiag.dump_trace(p_sql_id, p_child_number, p_component => 'Optimizer' \| 'Compiler', p_file_id)` | re-optimizes an existing cursor without running it; the environment comes from `V$SQL_OPTIMIZER_ENV`, so the result may differ from the original parse *(unverified here: the probe failed on a missing grant; Oracle Optimizer blog, Jonathan Lewis 2014)*. |
| `V$DIAG_OPT_TRACE_RECORDS`, `V$DIAG_TRACE_FILE_CONTENTS` (12.2+) | the same records as rows, with `SECTION_NAME`, `COMPONENT_NAME`, `RECORD_LEVEL` *(unverified; Oracle reference)*. |

`explain plan for …` is a hard parse and writes a dump.

## Where a dump starts and ends

- Start: the first `Registered qb: SEL$1 0x… (PARSER)` line (`INS$1`, `UPD$1`, `DEL$1`, `MRG$1`, `SET$1` for
  other statement types *(unverified)*). Nothing before it names the statement; the `sql_id` comes about 50
  lines later in `----- Current SQL Statement for this session (sql_id=8sjn0t7rms5s7) -----`.
- End: `====================== END SQL Statement Dump ======================`. A few `AP: qesdp…` lines of the
  adaptive plan follow it at the first execution.
- The file prologue and the `*** ` markers are those of a 10046 trace (`docs/trace-format-19c.md`).

### With event 10046 in the same file

Both events write to the process's trace file, so a session with both on gives one interleaved file.

- **A statement with binds**: `PARSING IN CURSOR`, its text, `END OF STMT` and `PARSE #…mis=1` come first, then
  the dump, then `EXEC #…mis=1` (the optimization is deferred to the first execution, for bind peeking).
- **A statement without binds**: the dump comes first, then `PARSING IN CURSOR` and `PARSE #…mis=1` (the PARSE
  line is written when the call ends).
- **Recursive SQL inside the dump**: the optimizer's dictionary lookups appear as complete `dep=1` 10046 records
  between optimizer lines (two cursors, 4 EXEC, 4 FETCH, 5 STAT, 4 BINDS in one dump of the probe). They are
  rule-based SYS statements and have no dump of their own.
- **Join keys**: the dump's `sql_id` is the cursor's `sqlid`; `plan_hash` in the dump's `Content of other_xml
  column` is the `plh` of the EXEC line (checked on two statements: 2477488908, 498381677). The
  `plan_hash_value=-1817478388(93ab7b0c)` of the `Starting SQL statement dump` line is another hash.

## Sections, in file order

A banner is a line of `*`, `-` or `=` above and below a title; their lengths vary.

### 1. Parser query blocks

```
Registered qb: SEL$1 0x63baa6c8 (PARSER)
---------------------
QUERY BLOCK SIGNATURE
---------------------
  signature (): qb_name=SEL$1 nbfros=2 flg=0
    fro(0): flg=4 objn=108609 hint_alias="C"@"SEL$1"
    fro(1): flg=4 objn=108611 hint_alias="O"@"SEL$1"
```

`objn` is the object number (0 for an inline view or subquery). The same line shape registers every block a
transformation creates later, with the derivation in the parentheses:

```
Registered qb: SEL$58A6D7F6 0x64387718 (VIEW MERGE SEL$2; SEL$1; SEL$2)
Registered qb: SEL$1BA63A14 0x63bdfbb0 (SUBQUERY UNNEST SEL$58A6D7F6; SEL$4 SEL$3)
Registered qb: SEL$FDFFF663 0x639bb8e0 (PLACE GROUP BY SEL$1BA63A14; SEL$1BA63A14; LIST 1)
Registered qb: SEL$1BA63A14 0x63b77ed8 (COPY SEL$1BA63A14)
```

Seen: `PARSER`, `COPY`, `VIEW MERGE`, `SUBQUERY UNNEST`, `PLACE GROUP BY`, `QUERY BLOCK TABLES CHANGED`,
`SPLIT/MERGE QUERY BLOCKS`, `ELIMINATION OF GROUP BY`.

### 2. Preamble lines

`SPM: statement not found in SMB`, `SPM: capture of plan baseline is OFF`, `kkoctx(): choosing CBO since
optimizer mode set to all/first_rows`, the `Automatic degree of parallelism (AUTODOP)` banner with its reason
(`… is disabled: Parameter.`), a first `PM:` (predicate move-around) pass.

### 3. `OPTIMIZER INFORMATION`

- `----- Current SQL Statement for this session (sql_id=…) -----`, the statement text as typed, `----- Parser
  State -----` (four lines).
- `Legend`: the trace's own abbreviation list. Transformations: CBQT, JPPD, OJPPD, FPD, PM, CVM, SPJ, SJC, SU,
  OBYE, OST, ST, CNT, JE, JF, CBY, SLP, DP, VT, AAT, ORE, LORE. Terms: qb, LB, DK, LB/K, DB/K, CLUF, NDV, Resp,
  Card, Resc, NL, SM, HA, CPUSPEED, IOTFRSPEED, IOSEEKTIM, SREADTIM, MREADTIM, MBRC, MAXTHR, SLAVETHR, dmeth (with
  its ten codes), sel, ptn, AP. Prefixes used but not in the legend: TE (table expansion), BJ (bushy join), PJE,
  OJE, CSE (common subexpression elimination, by its banner), GBP (group-by placement), SPD (SQL plan
  directives), CBRID, and UPT (`Checking validity of unpivot transformation`), SQE (`Trying SQ elimination`),
  SQT (`Considering Statistic-based Query Transformation`), DCL (`Checking validity of group-by elimination`).
- `PARAMETERS USED BY THE OPTIMIZER`:
  - `PARAMETERS WITH ALTERED VALUES`, then `Compilation Environment Dump` (`name = value` lines, empty when
    nothing is altered) and `Bug Fix Control Environment` (altered fix controls).
  - `PARAMETERS WITH DEFAULT VALUES`, then `Compilation Environment Dump` (about 610 lines such as
    `optimizer_features_enable           = 19.1.0`, hidden parameters included). The fix controls are not
    listed here: the full list is in the `Optimizer state dump` (section 9).
  - `PARAMETERS IN OPT_PARAM HINT` (empty without such a hint).
- `Column Usage Monitoring is ON: tracking level = 53`.

### 4. Query transformations

```
Considering Query Transformations on query block SEL$2 (#0)
**************************
Query transformations (QT)
**************************
JF: Bypassed: not a UNION or UNION-ALL query block.
ST: not valid since star transformation parameter is FALSE
TE: Bypassed: No partitioned table in query block.
ORE: bypassed - No valid predicate for OR expansion.
VT: Bypassed: inmemory is disabled.
JE:[V2]: Cannot eliminate C by ref. join elim - predicate column refs.
SU:   Checking validity of unnesting subquery SEL$3 (#3)
SU:   Passed validity checks, no costing.
```

One line per step: a prefix (the transformation), a colon, free text. The wording of a refusal is not uniform
(`Bypassed:`, `bypassed -`, `not valid since`, `Cannot …`, `invalid because …`). After a transformation the
statement is printed again as one line (up to 1,111 characters in the probe):

```
******* UNPARSED QUERY IS *******
SELECT "C"."NAME" "NAME","O"."STATUS" "STATUS",SUM("O"."AMOUNT") "AMT" FROM "MTK"."MTK_CUST" "C", …
```

Other headers of this phase: `Stmt: ******* UNPARSED QUERY IS *******`, `BEFORE REDUCTION` / `AFTER
REDUCTION`, `Final query after transformations:******* UNPARSED QUERY IS *******`.

### 5. Binds and directives

```
----- Bind Info (kkscoacd) -----
 Bind#0
  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0
  kxsbbbfp=7fbc63a22cf0  bln=22  avl=02  flg=05
  value=11
 Bind#1
  No oacdef for this bind.
```

The bind block has the shape of a 10046 `BINDS` block (the 10046 classifier already takes these lines for bind
lines). `SPD: BEGIN context at statement level` … `SPD: END context at statement level` lists the objects and
their SQL plan directives (`dirid = …, state = 1, flags = 1, loc = 1, forDS = NO, forCG = YES {E(108611)[1]}`).

### 6. Cost-based transformations

A state-space search: each iteration costs one variant of the statement and ends in a verdict.

```
GBP: Starting iteration 1, state space = (1,2,3,4) : (0,0,0,0)
GBP: Costing transformed query.
…one or more costing runs (section 7)…
GBP: Updated best state, Cost = 384.608830
GBP: Starting iteration 2, state space = (1,2,3,4) : (C,0,C,C)
…
GBP: Not update best state, Cost = 385.608830
```

Seen with the prefixes `GBP`, `CVM`, `JPPD` (`JPPD: Will not use JPPD from query block SEL$1 (#1)`, `CVM: Will
not merge view SEL$2 (#2)`). Between iterations: `CBQT: Looking for cost annotations for query block …, key =
…`, `CBQT: Saved costed qb# 2 (…)`. **Searches nest**: in the hinted probe statement the JPPD iterations 1 and
2 run inside CVM iteration 2, and a second JPPD search follows the CVM verdict. A run can be ten lines long
when its cost is reused (`CBQT: Replaced cost annotations`).
A parse-time line per step, `TIMER: SU: iteration (#1) SEL$… cpu: 105.656 sec elapsed: 110.375 sec`, exists
from 12.1.0.2 under fix control 16923858 *(unverified; Franck Pachot, dbi-services)*.

### 7. A costing run (`kkoqbc`)

From `kkoqbc: optimizing query block SEL$1BA63A14 (#1)` to `kkoqbc: finish optimizing query block …`. The same
query block is costed once per iteration that contains it (nine runs in the probe trace).

**Header**: `QUERY BLOCK TEXT` (the original statement again, or `Not available.`), `QUERY BLOCK SIGNATURE`
(`signature (optimizer): …`), `SYSTEM STATISTICS INFORMATION`:

```
Using dictionary system stats.
  Using NOWORKLOAD Stats
  CPUSPEEDNW: 2467 millions instructions/sec (default is 100)
  IOTFRSPEED: 4096 bytes per millisecond (default is 4096)
  IOSEEKTIM:  10 milliseconds (default is 10)
  MBRC:       NO VALUE blocks (default is 8)
```

**`BASE STATISTICAL INFORMATION`**, per table:

```
Table Stats::
  Table: MTK_ORDERS  Alias:  O
  #Rows: 100001  SSZ: 0  LGR: 0  #Blks:  496  AvgRowLen:  28.00  NEB: 0  ChainCnt:  0.00  ScanRate:  0.00  …
  Column (#5): STATUS(VARCHAR2)
    AvgLen: 7 NDV: 6 Nulls: 0 Density: 0.000005
    Histogram: Freq  #Bkts: 6  UncompBkts: 100001  EndPtVals: 6  ActualVal: yes
  Column (#2): CUST_ID(NUMBER)
    AvgLen: 5 NDV: 20128 Nulls: 0 Density: 0.000050 Min: 1.000000 Max: 20000.000000
Index Stats::
  Index: MTK_ORDERS_CUST_IX  Col#: 2
  LVLS: 1  #LB: 256  #DK: 20128  LB/K: 1.00  DB/K: 4.00  CLUF: 100001.00  NRW: 100001.00 …
```

A table without statistics prints `(NOT ANALYZED)` *(unverified; modb.pro 19.3 sample)*.

**`SINGLE TABLE ACCESS PATH`**, per table:

```
Access path analysis for MTK_ORDERS
***************************************
SINGLE TABLE ACCESS PATH
  Single Table Cardinality Estimation for MTK_ORDERS[MTK_ORDERS]
 kkecdn: Single Table Predicate:"MTK_ORDERS"."AMOUNT">100
  Column (#4): AMOUNT(NUMBER)
    AvgLen: 5 NDV: 91832 Nulls: 0 Density: 0.000011 Min: 1.000000 Max: 4999.940000
  Estimated selectivity: 0.980196 , col: #4
  Table: MTK_ORDERS  Alias: MTK_ORDERS
    Card: Original: 100001.000000rsel = 0.980196   Rounded: 98021  Computed: 98020.560347  Non Adjusted: 98020.560347
  Cost of predicates:
    io = NOCOST, cpu = 50.000000, sel = 0.980196 flag = 2048  ("MTK_ORDERS"."AMOUNT">100)
  Access Path: TableScan
    Cost:  137.063704  Resp: 137.063704  Degree: 0
      Cost_io: 136.000000  Cost_cpu: 31492914
      Resp_io: 136.000000  Resp_cpu: 31492914
  Best:: AccessPath: TableScan
         Cost: 137.063704  Degree: 1  Resp: 137.063704  Card: 98020.560347  Bytes: 0.000000
```

`Original:` and `rsel` run together without a space. An index path:

```
 ****** Costing Index MTK_ORDERS_CUST_IX
  Access Path: index (AllEqJoinGuess)
    Index: MTK_ORDERS_CUST_IX
    resc_io: 2.000000  resc_cpu: 16323
    ix_sel: 4.9682e-05  ix_sel_with_filters: 1.5145e-07
```

Selectivities switch to exponent notation when small. Dynamic sampling blocks (`** Performing dynamic sampling
initial checks. **`, `** Generated dynamic sampling query:`, `** Using dynamic sampling card. : 78835`) sit
inside this section *(unverified; modb.pro 19.3 sample)*.

**`OPTIMIZER STATISTICS AND COMPUTATIONS`** (a bare line, no banner) / **`GENERAL PLANS`** (a banner): the
join order search.

```
Considering cardinality-based initial join order.
Permutations for Starting Table :0
Join order[1]:  MTK_CUST[C]#0  MTK_ORDERS[O]#1  MTK_AUDIT[A]#2  MTK_ORDERS[MTK_ORDERS]#3

***************
Now joining: MTK_ORDERS[O]#1
***************
NL Join
  Outer table: Card: 52.002500  Cost: 6.002106  Resp: 6.002106  Degree: 1  Bytes:
  …access paths of the inner table, as above, each with "NL Join:  Cost: …"…
  Best NL cost: 110.031654
Join Card:  52.193545 = outer (52.002500) * inner (259.951507) * sel (0.003861)
Join Card - Rounded: 52 Computed: 52.193545
SM Join
  SM cost: 144.037587
HA Join
  HA cost: 143.055820
Best:: JoinMethod: NestedLoop
       Cost: 110.031654  Degree: 1  Resp: 110.031654  Card: 52.193545 Bytes:
```

- `TABLE[ALIAS]#n`: `n` is the table's position in the query block's signature.
- A join order shares its prefix with the previous one, so its block starts at the first table that differs.
- A permutation ends in `Best so far:  Table#: 0  cost: 6.002106  card: 52.002500  bytes: 2132.000000` lines
  (one per table) when it completes, or in `Join order aborted: cost > best plan cost`.
- The search ends with `(newjo-stop-1) k:0, spcnt:0, perm:18, maxperm:2000` and `Number of join permutations
  tried: 18`; `(newjo-save)    [3 0 1 2 ]` is the kept order as table numbers.
- Variants seen: `SM Join (with index on outer)`, `Best:: JoinMethod: HashSemi`, `SORT ressource` blocks (sic),
  `Grouping column cardinality [ NAME] 52`, `Enumerating distribution method (advanced)`.

**End of the run**:

```
Final cost for query block SEL$1BA63A14 (#1) - All Rows Plan:
  Best join order: 13
  Cost: 384.608830  Degree: 1  Card: 1.000000  Bytes: 81.000000
  Resc: 384.608830  Resc_io: 380.000000  Resc_cpu: 136452901
  Resp: 384.608830  Resp_io: 380.000000  Resc_cpu: 136452901
```

### 8. Adaptive plan

Inside the final costing run, between its join order search and its `Final cost`: `AP: Costing Nested Loops
Join for inflection point at card 77.00` / `AP: Costing Hash Join for inflection point at card 77.00`, repeated
while the search narrows (about 22 pairs and 2,000 lines in the probe), each with a full costing of the join.

### 9. `Starting SQL statement dump`

```
user_id=165 user_name=MTK module=SQL*Plus action=
sql_id=8sjn0t7rms5s7 plan_hash_value=-1817478388(93ab7b0c) problem_type=3 command_type=3
```

then the statement text twice more (`----- Current SQL Statement …`, `sql_text_length=334`, `sql=…`) and:

- `----- Explain Plan Dump -----`, `Plan Table`: columns `Id | Operation | Name | Rows | Bytes | Cost | Time`
  (`96K`, `1149K` abbreviations; inactive adaptive rows and `STATISTICS COLLECTOR` included), then `Query Block
  Name / Object Alias (identified by operation id):` and `Predicate Information:` in DBMS_XPLAN's wording
  (`4 - access("O"."STATUS"="STATUS")`, with the original bind names).
- `Content of other_xml column`: `db_version`, `parse_schema`, `plan_hash_full`, `plan_hash`, `plan_hash_2`,
  `Peeked Binds` (`position=1`, `datatype(string)=NUMBER`, `value=11`), `adaptive_plan  : yes`, `Optimizer
  Metrics`, `QUERY BLOCK REGISTRY` (one line of XML), `Outline Data:` (the hint block `/*+ BEGIN_OUTLINE_DATA …
  END_OUTLINE_DATA */`), and for a hinted statement a `Hint Report` (per query block and table: `Unused:
  use_hash(c)`, `Syntax Error: …`, with the reason) ending in `End Hint Report`.
- `Optimizer state dump:`: every parameter once more and the fix controls (1,735 lines `    fix 37589069 =
  enabled`; about 2,350 lines together), then `Query Block
  Registry:` as an indented tree, the final block marked:

  ```
  SEL$2 0x64387718 (PARSER)
    SEL$58A6D7F6 0x64387718 (VIEW MERGE SEL$2; SEL$1; SEL$2)
      SEL$1BA63A14 0x64387718 (SUBQUERY UNNEST SEL$58A6D7F6; SEL$4 SEL$3) [FINAL]
  ```

  Blocks of rejected variants are in the tree with address `0x0`; `...` stands for a subtree already printed.
- `Dumping Hints`:

  ```
    atom_hint=(@=0x7efe27c54128 err=0 resol=1 used=1 token=922 org=1 lvl=3 txt=USE_HASH ("C") )
    atom_hint=(@=0x7efe2742bdd0 err=9 resol=1 used=1 token=83 org=1 lvl=3 txt=INDEX ("O" "NO_SUCH_INDEX") )
  ********** WARNING: SOME HINTS HAVE ERRORS *********
  ```

  The section is empty for a statement without hints.

## Sizes

| Statement (19.27) | Lines | Bytes | Join orders | Costing runs |
|---|---|---|---|---|
| 2 tables, an `IN` and an `EXISTS` subquery, `GROUP BY` | 18,523 | 882 KB | 18 per run | 9 |
| 3 tables, one an aggregate view, two hints | 9,288 | 414 KB | | |
| 4 tables, plain joins | 5,576 | 235 KB | 6 | 1 |
| 6 tables | 7,497 | 339 KB | 15 | 1 |
| 8 tables | 13,486 | 651 KB | 48 | 1 |
| 10 tables | 93,620 | 4.7 MB | 498 | 1 |

In the first trace 86 % of the bytes are sections 4 to 8; the parameters (printed twice) and the fix controls
(once) are 112 KB whatever the statement. A trace of about 2 million lines is reported for a statement with a 120 s parse
*(Franck Pachot, dbi-services)*.

## Not verified

- 21c and 23ai. A 23.6 excerpt shows the 19c bind section unchanged (Jonathan Lewis, 2025).
- Partitioned tables, parallel plans, dynamic sampling, star transformation, OR expansion that applies, SQL
  plan baselines in use, DML statements, set operations: none was in the probe statements.
- `DBMS_SQLDIAG.DUMP_TRACE` output and `[sql:<sql_id>]` filtering.
- A dump cut by `max_dump_file_size`, and a session whose trace continues in another file.

## The probe

Run as `MTK` in `PDB1`, each statement made unique by a comment so it is hard parsed:

```sql
alter session set tracefile_identifier = 'mtk_p53_a';
variable cid number
exec :cid := 11
alter session set events '10053 trace name context forever, level 1';
select /* p53 a */ c.name, o.status, sum(o.amount) amt
  from mtk_cust c join mtk_orders o on o.cust_id = c.id
 where c.id between :cid and :cid + 50
   and o.status in (select status from mtk_orders where amount > 100)
   and exists (select 1 from mtk_audit a where a.row_id = o.id)
 group by c.name, o.status order by 3 desc;
alter session set events '10053 trace name context off';
```

Variants: `b` the same with `10046 … level 12` on as well, followed by a second statement with a bad index
hint (`/*+ index(o no_such_index) use_hash(c) */`, three tables and an aggregate inline view); `c` the hinted
statement under `trace[rdbms.SQL_Optimizer.*]`; `d` level 2; the size table's joins by `explain plan`.

## Sources

- Wolfgang Breitling, "A Look under the Hood of CBO: the 10053 Event" (8.1.7).
- Oracle Optimizer blog (Maria Colgan): capturing 10053 traces, `DBMS_SQLDIAG.DUMP_TRACE`.
- Jonathan Lewis, jonathanlewis.wordpress.com: "10053 viewer" (2010), "10053" (2013), "10053 trace" (2014),
  "Bind Peeking 2" (2025).
- Mauro Pagano, mauro-pagano.com: bushy joins (2017), SQL Diag Repository (2017).
- Franck Pachot, dbi-services.com: "CBO parse time: match time with transformation".
- A full 19.3 trace: modb.pro/db/22835.
- Oracle Database Reference: `V$DIAG_OPT_TRACE_RECORDS`.
