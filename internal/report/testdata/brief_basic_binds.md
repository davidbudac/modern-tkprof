# Trace brief

An Oracle SQL trace (event 10046) as read by mtkprof. The sections below are facts read from the trace; the notes and the case description are the DBA's own words.

## Trace

- **Database:** Oracle 19.27.0.0.0, instance cdb1
- **Files:** `basic_binds.trc` (0.2 MB, 3,059 lines)
- **Sessions:** 1 with time in scope
  - context 0: session 51.4357, service pdb1, module mtk_basic_binds, action start
  - context 1: session 51.4357, service pdb1, module mtk_basic_binds, action arraysize15
  - context 2: session 51.4357, service pdb1, module mtk_basic_binds, action arraysize500
  - context 3: session 51.4357, service pdb1, module mtk_basic_binds, action typed_binds_plsql
- **Window:** the whole trace (2026-10-22 11:35:03.510 +00:00 to 2026-10-22 11:35:03.700 +00:00, tim 10778817834 to 10779007897; 190.1 ms)
- **Response time:** 190.1 ms
- **Bind values:** masked: each value is shown as its type, length and a hash that is the same for equal values inside this brief only
- **SQL text:** as traced; literals in it are not masked

## Resource profile

The response time of the scope split into CPU of the top-level calls and every wait. Idle waits are time between calls, mostly the client or the network.

| Component | Seconds | % | Count | Avg ms | Max ms | Class |
|---|---:|---:|---:|---:|---:|---|
| SQL*Net message from client (idle) | 0.127 | 66.6% | 370 | 0.342 | 4.960 | Idle |
| CPU | 0.035 | 18.3% |  |  |  |  |
| log file sync | 0.003 | 1.8% | 1 | 3.423 | 3.423 | Commit |
| SQL*Net more data to client | 0.001 | 0.4% | 30 | 0.028 | 0.052 | Network |
| SQL*Net message to client | 0.000 | 0.1% | 370 | 0.000 | 0.007 | Network |
| db file sequential read | 0.000 | 0.1% | 1 | 0.100 | 0.100 | User I/O |
| Disk file operations I/O | 0.000 | 0.0% | 1 | 0.078 | 0.078 | User I/O |
| asynch descriptor resize | 0.000 | 0.0% | 1 | 0.006 | 0.006 | Other |
| unaccounted-for | 0.024 | 12.7% |  |  |  |  |
| **Total response time** | 0.190 | 100.0% | | | | |

## Top statements

Ranked by own time: elapsed time without recursive children, plus idle time between the statement's calls. Listed until they cover 80% of the response time, at most 10. 3 of 22 statements with time in scope are listed; the other 19 add up to 22.9 ms (12.1% of the response time).

### 1. `f6jyzt7462kx2` SELECT, 75.7% of the response time

- **Time:** own 143.8 ms; elapsed 19.0 ms including recursive children; cpu 11.7 ms; waits inside calls 940 µs; idle between calls 127.2 ms
- **Work:** executions 10, rows 10,000, disk reads 0, query gets 1,305, current gets 7, cursors 3, hard parses 1
- **Where:** 11:35:03.512 to 11:35:03.680; first trace line 75; module mtk_basic_binds, action arraysize15, session 51.4357
- **Recursive statements it runs:** `10gywwmwk6xfy` (1.5 ms, 4 calls), `dbvj6jc977hqh` (854 µs, 3 calls)

```sql
select /* mtk_basic_binds */ c.id, c.name, c.amount, c.created,
       :b_num as n, :b_vc2 as v, :b_chr as ch, :b_dbl as d, :b_flt as f,
       :b_null as nul, length(:b_long) as lng
  from mtk_cust c
 where c.id between :b_lo and :b_hi
   and (:b_null is null or c.name = :b_null)
 order by c.id
```

| Call | Count | Misses | CPU s | Elapsed s | Disk | Query | Current | Rows |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Parse | 10 | 1 | 0.000 | 0.000 | 0 | 0 | 0 | 0 |
| Execute | 10 | 1 | 0.004 | 0.006 | 0 | 3 | 7 | 0 |
| Fetch | 355 | 0 | 0.007 | 0.012 | 0 | 1,302 | 0 | 10,000 |
| Close | 10 | 0 | 0.000 | 0.000 | 0 | 0 | 0 | 0 |
| **Total** | 375 | 2 | 0.012 | 0.019 | 0 | 1,305 | 7 | 10,000 |

Top waits of this statement:

- SQL*Net message from client (idle): 123.7 ms in 355 waits, longest 5.0 ms
- log file sync: 3.4 ms in 1 waits, longest 3.4 ms
- SQL*Net more data to client: 828 µs in 30 waits, longest 52 µs
- SQL*Net message to client: 116 µs in 355 waits, longest 7 µs

Executions: 10; elapsed min 1.1 ms, avg 1.9 ms, max 6.4 ms. The slowest:

- exec 1 of the cursor at line 75, 11:35:03.513: elapsed 6.4 ms, cpu 4.2 ms, 1,000 rows, 0 disk, 194 query, 68 fetches
  binds: `:0 <NUMBER len=2 h=3c73edb5> :1 <VARCHAR2 len=11 h=8f765cc4> :2 <CHAR len=10 h=dd05d513> :3 <BINARY_DOUBLE len=8 h=a712fd58> :4 <BINARY_FLOAT len=4 h=1fbbbe00> :5 VARCHAR2=NULL :6 <VARCHAR2 len=1500 h=13825c5a> :7 <NUMBER len=2 h=3c73edb5> :8 <NUMBER len=2 h=d54326ad> :9 (same as an earlier bind) :10 (same as an earlier bind)`
- exec 1 of the cursor at line 445, 11:35:03.541: elapsed 1.7 ms, cpu 619 µs, 1,000 rows, 0 disk, 194 query, 68 fetches
  binds: `:0 <NUMBER len=2 h=b837fc98> :1 <VARCHAR2 len=10 h=446251b9> :2 <CHAR len=10 h=dd05d513> :3 <BINARY_DOUBLE len=8 h=a712fd58> :4 <BINARY_FLOAT len=4 h=1fbbbe00> :5 VARCHAR2=NULL :6 <VARCHAR2 len=1500 h=13825c5a> :7 <NUMBER len=3 h=f898db09> :8 <NUMBER len=2 h=30d07bd1> :9 (same as an earlier bind) :10 (same as an earlier bind)`
- exec 2 of the cursor at line 747, 11:35:03.579: elapsed 1.7 ms, cpu 702 µs, 1,000 rows, 0 disk, 193 query, 68 fetches
  binds: `:0 <NUMBER len=2 h=5ca851e7> :1 <VARCHAR2 len=10 h=446251b9> :2 <CHAR len=10 h=b9fbaf88> :3 <BINARY_DOUBLE len=8 h=8f36de72> :4 <BINARY_FLOAT len=4 h=1fbbbe00> :5 VARCHAR2=NULL :6 <VARCHAR2 len=1500 h=13825c5a> :7 <NUMBER len=3 h=246efd26> :8 <NUMBER len=2 h=387c8d47> :9 (same as an earlier bind) :10 (same as an earlier bind)`

Execution plan, plan hash 2403330195 (row source statistics from the STAT lines at trace line 1011; 3 dumps of this plan):

```text
  Id        Rows   Starts         CR        PR        PW     Time ms  Operation
   1       1,000        1        194         0         0       1.719  FILTER
   2       1,000        1        194         0         0       1.718   TABLE ACCESS BY INDEX ROWID MTK_CUST  [cost 62 card 50]
   3       1,000        1         71         0         0       0.628    INDEX RANGE SCAN MTK_CUST_PK  [cost 3 card 1000]
```

### 2. `a6txjhtbq9x8p` SELECT, 3.4% of the response time

- **Time:** own 6.4 ms; elapsed 7.0 ms including recursive children; cpu 4.4 ms; waits inside calls 0 µs; idle between calls 0 µs
- **Work:** executions 10, rows 10, disk reads 1, query gets 12, current gets 5, cursors 1, hard parses 1
- **Where:** 11:35:03.686 to 11:35:03.693; first trace line 2158; module mtk_basic_binds, action typed_binds_plsql, session 51.4357
- **Recursive statements it runs:** `10gywwmwk6xfy` (341 µs, 3 calls), `dbvj6jc977hqh` (235 µs, 2 calls)
- **Called recursively from:** `atbp0549pnzjg` (7.0 ms, 31 calls)

```sql
select /* mtk_typed_binds */ count(*) from mtk_cust c  where c.rowid = :rid and c.created < :d and :ts > :tstz - :iv and :ivym is not null   and :r is not null and c.id = :n and :nc is not null and :bf < :bd and :ch is not null   and :nul is null and c.rowid = :urid
```

| Call | Count | Misses | CPU s | Elapsed s | Disk | Query | Current | Rows |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Parse | 1 | 1 | 0.000 | 0.000 | 0 | 0 | 0 | 0 |
| Execute | 10 | 1 | 0.004 | 0.007 | 1 | 2 | 5 | 0 |
| Fetch | 10 | 0 | 0.000 | 0.000 | 0 | 10 | 0 | 10 |
| Close | 10 | 0 | 0.000 | 0.000 | 0 | 0 | 0 | 0 |
| **Total** | 21 | 2 | 0.004 | 0.007 | 1 | 12 | 5 | 10 |

Executions: 10; elapsed min 287 µs, avg 683 µs, max 4.1 ms. The slowest:

- exec 1 of the cursor at line 2158, 11:35:03.686: elapsed 4.1 ms, cpu 1.6 ms, 1 rows, 1 disk, 3 query, 1 fetches
  binds: `:0 <VARCHAR2 len=18 h=b80b2275> :1 <DATE len=7 h=c22821dd> :2 <TIMESTAMP len=11 h=ddbe5b34> :3 <TIMESTAMP WITH TIME ZONE len=13 h=c15bbe98> :4 <INTERVAL DAY TO SECOND len=11 h=55528f05> :5 <INTERVAL YEAR TO MONTH len=5 h=bcca3aa0> :6 <RAW len=8 h=04500087> :7 <NUMBER len=2 h=b06735d6> :8 <VARCHAR2 len=14 h=8804580d> :9 <BINARY_FLOAT len=4 h=e8eaea6a> :10 <BINARY_DOUBLE len=8 h=83e9a111> :11 <CHAR len=5 h=b94f70a4> :12 VARCHAR2=NULL :13 <UROWID len=13 h=d428690f>`
- exec 6 of the cursor at line 2158, 11:35:03.692: elapsed 329 µs, cpu 329 µs, 1 rows, 0 disk, 1 query, 1 fetches
  binds: `:0 <VARCHAR2 len=18 h=b80b2275> :1 <DATE len=7 h=c22821dd> :2 <TIMESTAMP len=11 h=ddbe5b34> :3 <TIMESTAMP WITH TIME ZONE len=13 h=c15bbe98> :4 <INTERVAL DAY TO SECOND len=11 h=55528f05> :5 <INTERVAL YEAR TO MONTH len=5 h=bcca3aa0> :6 <RAW len=8 h=04500087> :7 <NUMBER len=2 h=ab120514> :8 <VARCHAR2 len=14 h=8804580d> :9 <BINARY_FLOAT len=4 h=e8eaea6a> :10 <BINARY_DOUBLE len=8 h=83e9a111> :11 <CHAR len=5 h=b94f70a4> :12 VARCHAR2=NULL :13 <UROWID len=13 h=d428690f>`
- exec 8 of the cursor at line 2158, 11:35:03.693: elapsed 325 µs, cpu 407 µs, 1 rows, 0 disk, 1 query, 1 fetches
  binds: `:0 <VARCHAR2 len=18 h=b80b2275> :1 <DATE len=7 h=c22821dd> :2 <TIMESTAMP len=11 h=ddbe5b34> :3 <TIMESTAMP WITH TIME ZONE len=13 h=c15bbe98> :4 <INTERVAL DAY TO SECOND len=11 h=55528f05> :5 <INTERVAL YEAR TO MONTH len=5 h=bcca3aa0> :6 <RAW len=8 h=04500087> :7 <NUMBER len=2 h=3327c495> :8 <VARCHAR2 len=14 h=8804580d> :9 <BINARY_FLOAT len=4 h=e8eaea6a> :10 <BINARY_DOUBLE len=8 h=83e9a111> :11 <CHAR len=5 h=b94f70a4> :12 VARCHAR2=NULL :13 <UROWID len=13 h=d428690f>`

Execution plan, plan hash 1478684411 (row source statistics from the STAT lines at trace line 2298; 1 dumps of this plan):

```text
  Id        Rows   Starts         CR        PR        PW     Time ms  Operation
   1           1        1          1         0         0       2.343  SORT AGGREGATE
   2           0        1          1         0         0       2.339   FILTER
   3           0        1          1         0         0       0.004    TABLE ACCESS BY USER ROWID MTK_CUST  [cost 1 card 1]
```

### 3. `atbp0549pnzjg` PL/SQL EXECUTE, 3.0% of the response time

- **Time:** own 5.7 ms; elapsed 18.3 ms including recursive children; cpu 13.4 ms; waits inside calls 0 µs; idle between calls 232 µs
- **Work:** executions 1, rows 1, disk reads 1, query gets 1,213, current gets 5, cursors 1, hard parses 1
- **Where:** 11:35:03.681 to 11:35:03.699; first trace line 2113; module mtk_basic_binds, action typed_binds_plsql, session 51.4357
- **Recursive statements it runs:** `a6txjhtbq9x8p` (7.0 ms, 31 calls), `b82pqjfm8rnb1` (5.2 ms, 4 calls), `2vuucsj8rdyqn` (583 µs, 4 calls)

```sql
declare
  v_date  date                     := date '2024-02-29';
  v_ts    timestamp                := timestamp '2024-02-29 13:14:15.123456';
  v_tstz  timestamp with time zone := timestamp '2024-02-29 13:14:15.123456 +02:00';
  v_iv    interval day to second   := interval '3 04:05:06.789' day to second;
  v_ivym  interval year to month   := interval '1-6' year to month;
  v_raw   raw(16)                  := hextoraw('DEADBEEF00112233');
  v_rid   rowid;
  v_urid  urowid;
  v_nc    nvarchar2(20)            := n'日本語 ÄÖÜ';
  v_ch    char(5)                  := 'ab';
  v_bf    binary_float             := 1.5;
  v_bd    binary_double            := 2.25;
  v_num   number                   := 7;
  v_cnt   number;
  v_null  varchar2(10)             := null;
begin
  select rowid into v_rid from mtk_cust where id = 7;
  v_urid := v_rid;
  for i in 1 .. 10 loop
    execute immediate
      'select /* mtk_typed_binds */ count(*) from mtk_cust c ' ||
      ' where c.rowid = :rid and c.created < :d and :ts > :tstz - :iv and :ivym is not null' ||
      '   and :r is not null and c.id = :n and :nc is not null and :bf < :bd and :ch is not null' ||
      '   and :nul is null and c.rowid = :urid'
      into v_cnt
      using v_rid, v_date, v_ts, v_tstz, v_iv, v_ivym, v_raw, v_num + i, v_nc, v_bf, v_bd, v_ch, v_null, v_urid;
  end loop;
  -- static SQL with DATE / ROWID binds
  select count(*) into v_cnt from mtk_cust
   where created between v_date - 3650 and v_date and rowid <> v_rid;
end;
```

| Call | Count | Misses | CPU s | Elapsed s | Disk | Query | Current | Rows |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Parse | 1 | 1 | 0.002 | 0.003 | 0 | 0 | 0 | 0 |
| Execute | 1 | 0 | 0.011 | 0.016 | 1 | 1,213 | 5 | 1 |
| Close | 1 | 0 | 0.000 | 0.000 | 0 | 0 | 0 | 0 |
| **Total** | 2 | 1 | 0.013 | 0.018 | 1 | 1,213 | 5 | 1 |

Top waits of this statement:

- SQL*Net message from client (idle): 232 µs in 1 waits, longest 232 µs
- SQL*Net message to client: 0 µs in 1 waits, longest 0 µs

One execution:

- exec 1 of the cursor at line 2113, 11:35:03.684: elapsed 15.6 ms, cpu 11.4 ms, 1 rows, 1 disk, 1,213 query, 0 fetches

## Findings

Rule hits computed by mtkprof over the same scope, most serious first. A finding is a fact about the trace, not a diagnosis.

### 1. Think time (notable)

130.0 ms of 190.1 ms response time (68%) idle between calls

- Impact: 130.0 ms
- SQL*Net message from client: 126.6 ms in 370 waits (67%)
- f6jyzt7462kx2: 127.2 ms idle (67% of response time); 19.0 ms elapsed in calls
- 5skrvwtc8qmrc: 265 us idle (0% of response time); 609 us elapsed in calls
- 1b1sdgct70uyr: 235 us idle (0% of response time); 439 us elapsed in calls
- atbp0549pnzjg: 232 us idle (0% of response time); 18.3 ms elapsed in calls
- 0qf2w6jy1fpmg: 199 us idle (0% of response time); 615 us elapsed in calls

### 2. Small fetches (info)

f6jyzt7462kx2: 14.7 rows per fetch; 340 fetches, 5000 rows in 5 of 10 executions; 83.8 ms in these fetches and preceding round trips

- Statement: `f6jyzt7462kx2` `select /* mtk_basic_binds */ c.id, c.name, c.amount, c.cr...` (statement 1 above); impact 83.8 ms
- small-fetch executions: 5 of 10 (at least 3 fetches, under 20 rows per fetch)
- fetches / rows: 340 / 5000 (14.7 rows per fetch)
- whole statement: 355 fetches / 10000 rows (28.2 rows per fetch)
- exec 1: first: 68 fetches, 1000 rows, 6.4 ms (trace line 202)

## For the agent

You are helping a DBA understand this Oracle SQL trace. Everything above is read from the trace; interpreting it is your part.

- Keep what the trace shows apart from what you infer. Mark an inference as one and say what would confirm it.
- Cite what you rely on: a sql_id, a trace line number, a finding, a wait event, or a figure from the tables above. Do not quote a number that is not in this brief.
- This is a summary. Only the largest statements are listed, SQL and plans are cut where marked, and each statement shows its slowest executions only. If you need something that is not here, say what you need instead of guessing.
- A statement's elapsed time includes its recursive children; own time does not. Idle time is time between calls, usually spent in the client or on the network, not in the database.
- Bind values are masked as `<TYPE len=N h=XXXXXXXX>`: equal tokens are equal values, and the value itself is not known. Bind positions count from 0 as in the trace.
- Answer with the likely causes in order, the evidence for each, and the next thing to check or change. Keep it short.
