# Oracle 19c SQL trace (10046) file format — field reference

Everything below was verified against real 19.27 traces generated in the
dbmint lab (`testdata/traces/19c/`, generator in `testdata/gen/`). Line kinds
not seen in those fixtures are marked *(unverified)*. 21c XE and 23ai Free
traces (`testdata/traces/21c/`, `23ai/`) were generated in docker; their
differences are collected in the last section.

## File prologue

```
Trace file /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_133146_mtk_basic_binds.trc
Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
Version 19.27.0.0.0
Build label:    RDBMS_19.27.0.0.0DBRU_LINUX.X64_250331
ORACLE_HOME:    /u01/app/oracle/product/19.0.0/dbhome_1
System name:	Linux
Node name:	ol9-19-dg1.localdomain
Release:	5.15.0-316.196.4.2.el9uek.x86_64
Version:	#2 SMP Thu Feb 5 11:29:51 PST 2026
Machine:	x86_64
CLID:	P
Instance name: cdb1
Instance number: 1
Database name: cdb1
Database unique name: cdb1
Database id: 1214129087
Database role: PRIMARY
Redo thread mounted by this instance: 1
Oracle process number: 68
Unix process pid: 133146, image: oracle@ol9-19-dg1.localdomain
```

Fields are separated by `:` followed by spaces or a tab. `Version` without a
colon is the database version; `Version:` is the OS kernel. `trcsess` output
has **no prologue at all**.

## Markers (`*** `)

| Line | Meaning |
|---|---|
| `*** 2026-10-22T11:35:03.510078+00:00 (PDB1(3))` | wall-clock timestamp; the `(PDB(con_id))` suffix is present when the session is in a PDB. Anchors `tim=` values. Pre-12.2 format is `*** 2016-03-01 10:20:30.123`. |
| `*** SESSION ID:(51.4357) <ts>` | sid.serial# |
| `*** CLIENT ID:(x) <ts>` | `dbms_session.set_identifier`; empty parentheses when unset |
| `*** SERVICE NAME:(pdb1) <ts>` | service (`SYS$USERS` for bequeath) |
| `*** MODULE NAME:(SQL*Plus) <ts>` / `*** ACTION NAME:(x) <ts>` | `dbms_application_info` |
| `*** CLIENT DRIVER:(SQL*PLUS) <ts>` | 12.1+; `(SERVER)` for PX slaves |
| `*** CONTAINER ID:(3) <ts>` | 12.1+ |
| `*** TRACE CONTINUED FROM FILE /path ***` / `*** TRACE CONTINUES IN FILE /path ***` | `tracefile_identifier` changed mid-session (or max size rotation) |
| `*** DUMP FILE SIZE IS LIMITED TO 307200 BYTES ***` | truncated by `max_dump_file_size`; the file may end in the middle of any block (fixtures end mid-BINDS) |
| `*** [ Unix process pid: 133531 ]` | `trcsess` output only: session/process switch. trcsess also rewrites every attribute marker into a bare timestamp line. |

A line containing a single space follows each marker block. The ACTION NAME
marker can appear between a PARSE and its EXEC.

## Cursor text

```
=====================
PARSING IN CURSOR #140124363561040 len=60 dep=0 uid=165 oct=47 lid=165 tim=10778819370 hv=1406643985 ad='61f54170' sqlid='9h8pw1x9xgbsj'
BEGIN dbms_application_info.set_action('arraysize15'); END;

END OF STMT
```

* `#n` is the cursor handle address (64-bit). Numbers are reused after CLOSE.
* `len` is the statement length in bytes. It is usually exact; for some
  statements it is one byte larger than the printed text. The parser treats a
  line `END OF STMT` as the terminator only once at least `len-4` bytes of
  text have been collected (statement text may legitimately contain such a
  line; tkprof gets this wrong).
* PL/SQL blocks from SQL*Plus end with a newline, hence the empty line.
* `dep` recursive depth, `uid` parsing schema, `lid` privilege user,
  `oct` command type (`v$sqlcommand`), `hv` hash value, `ad` library cache
  address, `sqlid` SQL ID (always present in 19c).
* 19c re-emits PARSING IN CURSOR for an already-open PL/SQL cursor on its
  first EXEC after tracing starts. Calls without a preceding PARSING IN
  CURSOR in the file only occur when a trace file is split
  (`TRACE CONTINUED FROM FILE`) or a cursor was mid-fetch when tracing began.

## Database calls

```
PARSE #140124363561040:c=455,e=455,p=0,cr=0,cu=0,mis=1,r=0,dep=0,og=1,plh=0,tim=10778819363
EXEC  #...:c=,e=,p=,cr=,cu=,mis=,r=,dep=,og=,plh=,tim=
FETCH #...:c=,e=,p=,cr=,cu=,mis=,r=,dep=,og=,plh=,tim=
CLOSE #139851226503912:c=3,e=3,dep=0,type=0,tim=10814471158
```

`c` CPU µs, `e` elapsed µs, `p` physical reads, `cr` consistent gets, `cu`
current gets, `mis` library cache misses, `r` rows, `og` optimizer goal
(1 ALL_ROWS, 2 FIRST_ROWS, 3 RULE, 4 CHOOSE), `plh` plan hash, `tim` µs at
call completion. CLOSE `type`: 0 hard close, 1 placed in session cursor
cache, 3 already in the cache. A call line is written when the call
**completes**, so the resources of recursive (dep+1) calls are included in
the parent's `c/e/p/cr/cu`. tkprof prints the parent's numbers **minus**
its children; mtkprof keeps both (inclusive and self).

A `WAIT` for cursor `#n` precedes the call line of `#n` it happened in.
`SQL*Net message from client` ends when the next call begins, so it precedes
that call's line but is time *between* calls.

## Waits

```
WAIT #140396176837672: nam='db file sequential read' ela= 89 file#=10 block#=66377 blocks=1 obj#=721 tim=10804216054
WAIT #0: nam='direct path read' ela= 12 file number=12 first dba=172318 block cnt=1 obj#=108616 tim=11043950927
WAIT #139851227700336: nam='SQL*Net message from client' ela= 129 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10814470635
WAIT #139745604251096: nam='enq: KO - fast object checkpoint' ela= 631705 name|mode=1263468550 2=65604 0=1 obj#=-1 tim=10805134758
WAIT #139954831477928: nam='PGA memory operation' ela= 115 which=5 bytes=3014656 where=4 obj#=-1 tim=11043408911
```

`ela` µs. Exactly three parameters follow, named per `v$event_name`
(names may contain spaces, `#`, `|`, `?`, `<<`), then `obj#` (−1 = none) and
`tim`. `#0` is the pseudo cursor for LOB operations, commits and PX
messages.

## Row source statistics

```
STAT #140365886646352 id=1 cnt=1 pid=0 pos=1 obj=0 op='SORT AGGREGATE (cr=7 pr=0 pw=0 str=1 time=69 us)'
STAT #... id=2 cnt=1 pid=1 pos=1 obj=73512 op='TABLE ACCESS BY INDEX ROWID BATCHED MTK_CUST (cr=51 pr=1 pw=0 str=1 time=2100 us cost=3 size=25 card=1)'
```

One block per cursor close (first execution only by default;
`plan_stat=all_executions` dumps one per execution). `cnt` rows, `str`
starts, `time` µs; `cost/size/card` are optimizer estimates. The object name
is the last token of `op` when `obj` ≠ 0.

## Binds

```
BINDS #139851226503912:

 Bind#0
  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00
  oacflg=03 fl2=1400000 frm=00 csi=00 siz=24 off=0
  kxsbbbfp=7f31a6ad56a0  bln=22  avl=02  flg=05
  value=42
```

* a blank line follows `BINDS #n:` in 19c; no `kkscoacd` line.
* `oacdty` datatype code (1 VARCHAR2, 2 NUMBER, 12 DATE, 23 RAW, 96 CHAR,
  101 BINARY_DOUBLE, 112 CLOB, 123 collection, 180 TIMESTAMP, 181 TSTZ,
  183 INTERVAL DAY TO SECOND, 208 UROWID, …), `mxl` max length (private
  length in parentheses), `mal` max array length, `scl/pre` scale/precision,
  `frm` charset form, `csi` charset id, `avl` actual value length (0 = NULL,
  then no `value=` line), `bln` buffer length.
* Character values are quoted: `value="10/22/2026 11:35:3"`. Values can
  span lines. Long values are cut: `value="Long text, ..."...`.
* TSLTZ and INTERVAL values are memory dumps (see "Bind dump formats"):
  ```
    value=Unhandled datatype (-73) found in kxsbndinf
  Dumping '' addr=0x7f713ee967a0 size=11 bytes
  Dump of memory from 0x7f713ee967a0 to 0x7f713ee967ac
  7F713EE967A0 03000080 AF424140 00402F07           [....@AB../@.]
  ```
  `Unhandled datatype (-25)` is TSLTZ (231), `(-73)` INTERVAL DAY TO SECOND (183),
  `(-74)` INTERVAL YEAR TO MONTH (182).
* Collections (dty 123): `toid ptr value=61F11290 length=16` + a hex line.
* `No oacdef for this bind.` = the bind is a repeated occurrence of an
  earlier bind name; no value is printed.
* FORALL array binds show `mal=00` and only the first row's values; the
  EXEC `r=` reveals the array size.

### Bind dump formats

Fixtures: `basic_binds.trc` (scenario block `typed_binds_plsql`) and `bind_types.trc`
(`testdata/gen/sc_bind_types.sql`: four executions with 2-digit-year, negative,
zero, 9-digit and region/offset variations of every type).

| oacdty | type | what the trace prints | verified |
|---|---|---|---|
| 12 | DATE | text, `value="12/31/1999 0:0:0"` (`M/D/YYYY H:M:S`, no padding). Some bind paths cut it at 18 characters (`"10/22/2026 11:35:3"`), the seconds may be incomplete | fixtures |
| 180 | TIMESTAMP | text in the session's NLS_TIMESTAMP_FORMAT: `29-FEB-24 01.14.15.123457 PM` (2-digit year, rounded to `scl` fraction digits) | fixtures |
| 181 | TSTZ | text: `29-FEB-24 01.14.15.123456 PM +02:00`, `... PM UTC`, or the region name `... AM AMERICA/LOS_ANGELES` | fixtures |
| 231 | TSLTZ | **dump** (`Unhandled datatype (-25)`), 7 or 11 bytes of the internal timestamp in the **database** time zone (the trace does not record it) | fixtures |
| 182 | INTERVAL YEAR TO MONTH | **dump** (`-74`), 5 bytes | fixtures |
| 183 | INTERVAL DAY TO SECOND | **dump** (`-73`), 11 bytes | fixtures |
| 23 | RAW | hex text `value=DEADBEEF...`. 19c prints **one byte fewer than `avl`** (`avl=20` shows 19 bytes, `avl=1` shows nothing) | fixtures |
| 208 / 69 | UROWID / ROWID | text `00028F76.0006.000C`: block, row, file in hex (the restricted ROWID; the data object number is not printed) | fixtures (208) |
| 1 | a ROWID bound as VARCHAR2 | quoted base-64 text `"AAAahBAAMAAAo92AAG"` | fixtures |

Memory dump layout. The hex words are printed in host byte order: on x86 the 4
bytes in memory `80 00 00 03` print as `03000080`, so reverse every 8-hex-digit word
to get the memory order (big-endian hosts print it as is; mtkprof tries both and
keeps the reading that validates). `size=N bytes` is the length of the value, the
last word is padded. The first row can be indented to the data start
(`Dump of memory from` address), blank words are not part of the data. Internal
formats (all multi-byte integers big endian):

| type | bytes | layout |
|---|---|---|
| DATE | 7 | century+100, year+100, month, day, hour+1, minute+1, second+1 |
| TIMESTAMP, TSLTZ | 7 or 11 | the DATE bytes; 11 adds nanoseconds as uint32 |
| TSTZ | 13 | the TIMESTAMP bytes in **UTC**; byte 11 = time zone hour+20, byte 12 = minute+60. If bit 7 of byte 11 is set it is a region: id = (byte11 & 0x7F) << 6 \| byte12 >> 2 (mapping the id to a name needs the time zone file) |
| INTERVAL YEAR TO MONTH | 5 | years as int32 xor 0x80000000, months+60 |
| INTERVAL DAY TO SECOND | 11 | days as int32 xor 0x80000000, hour+60, minute+60, second+60, nanoseconds as int32 xor 0x80000000 (negative intervals have negative components) |

Example (`bind_types.trc`, `interval '-12 23:59:58.000001' day to second`):
`F4FFFF7F 7F020125 0018FCFF` -> memory `7F FF FF F4 | 25 01 02 | 7F FF FC 18` -> days
-12, 25h-60 = -23, -59, -58, -1000 ns -> `-12 23:59:58.000001`.

Stored formats of TIMESTAMP / TSTZ / DATE were verified with `DUMP()` of a table
column on dbmint (`mtk_tsdump_ref`), the trace formats them as text in 19c.

## Other lines

```
XCTEND rlbk=0, rd_only=0, tim=10804247472          commit (rlbk=1 rollback; rd_only=1 nothing to commit)
ERROR #140396176538616:err=1 tim=10804229719        error raised by the call that follows/precedes
PARSE ERROR #140396176538616:len=31 dep=0 uid=165 oct=3 lid=165 tim=10804212367 err=942
select * from mtk_no_such_table                     (text follows, NO "END OF STMT")
LOBREAD: type=PERSISTENT LOB,bytes=8191,c=661,e=1153,p=4,cr=1,cu=0,tim=11043951189
LOBARRTMPFRE: type=PERSISTENT LOB,c=5,e=5,p=0,cr=0,cu=0,tim=11043987568
```

Observed LOB ops: LOBREAD, LOBARRTMPFRE (TEMPORARY LOB too). LOBGETLEN,
LOBWRITE, LOBAPPEND, LOBPGSIZE *(unverified)* share the layout. `RPC CALL:`,
`RPC BINDS:`, `RPC EXEC:` *(unverified)*.

ORA-01722 raised during the first FETCH produces **no** `ERROR #` line, only
`FETCH … r=0` and `SQL*Net break/reset to client` waits.

## 21c / 23ai differences

Verified against `testdata/traces/21c/` (21.3 XE) and `testdata/traces/23ai/`
(Oracle AI Database 26ai Free, 23.26.3, `tkprof` "Release 23.0"). All line kinds
of the 19c format are unchanged (`PARSING IN CURSOR`, `PARSE/EXEC/FETCH/CLOSE`,
`WAIT`, `STAT`, `BINDS`, `XCTEND`, `ERROR`, `LOB*`); `mtkprof lint` reports 0
unknown lines on both sets. What changed:

| Where | 19c | 21c | 23ai |
|---|---|---|---|
| Banner | `Oracle Database 19c ...` | `Oracle Database 21c Express Edition ...` | `Oracle AI Database 26ai Free Release 23.26.3.0.0 - ...` (key `Oracle Database` is kept for both spellings) |
| Pid header | `Unix process pid: 133440, image: oracle@host` | `Unix process pid: 759, NID: 4026532333, image: oracle@host` | block: `Unix process pid:       1756`, `             NID:       4026532333`, `             created:   2026-10-24T10:35:56.9600-7358+00:00` (garbage zone offset), `             image:     oracle@host`; PX detection reads the `image:` line (`(P000)`) |
| Extra header lines | `Database name/id/role`, `Oracle process number` | no `Database *` lines | one more line, `Oracle binary inode:`; otherwise as 19c |
| Markers after `*** CONTAINER ID` | – | `*** CLIENT IP:(127.0.0.1) <ts>`, `*** CONNECTION ID:(XpTCBiyDAvXgYwIAEazlbg==) <ts>` | same as 21c (kinds `CLIENT IP`, `CONNECTION ID`) |
| STAT row source stats | `(cr= pr= pw= str= time= us cost= size= card=)` | same | `(cr= pr= pw= str= time= dr=0 dw=0 us cost= size= card=)`; `dr`/`dw` (direct reads/writes) are ignored by the parser |
| Unprintable bind value | `  value=Unhandled datatype (-73) found in kxsbndinf` (2 spaces) | same | ` value=Unhandled datatype (-73) found in kxsbndinf` (**1 space**), followed by the unindented `Dumping ''` / `Dump of memory` / hex rows; the hex rows carry extra padding before the `[...]` ASCII column |
| Waits | – | `SQL*Net vector data to client` (large results) | `Allocate UGA/PGA/CGA/DGA memory from OS` (`Bytes=65536 where=1`), `Free private memory to OS`, `sequence cache replenishment` (extra `objn=` `pdbid=` fields), `SQL*Net vector data to client` |
| `trcsess` process switch | `*** [ Unix process pid: 133531 ]` | same | `*** Unix process pid:       2013` (no brackets: trcsess copies the block-form header line) |

Notes:
- `parallel` could not be generated: XE and Free run `PARALLEL` hints serially
  (`Queries Parallelized = 0`), so there is no 21c/23ai PX coordinator or slave
  trace; the PX handling is only verified against 19c.
- `tkprof` parity (`internal/golden`) holds on 21c and 23ai with one deliberate
  deviation, see the comment on `assumedNumbers` in the test.
- The 23ai Free trace of `midtrace_start` re-dumps `PARSING IN CURSOR` for the
  PL/SQL block in the continuation file (it only occurred in part 1 on 19c);
  the parser treats it like any other cursor text.
