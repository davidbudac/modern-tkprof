# Oracle 19c SQL trace (10046) file format — field reference

Everything below was verified against real 19.27 traces generated in the
dbmint lab (`testdata/traces/19c/`, generator in `testdata/gen/`). Line kinds
not seen in those fixtures are marked *(unverified)*.

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
* TIMESTAMP / TSTZ / INTERVAL values are memory dumps:
  ```
    value=
  Dumping '' addr=0x7f713ee967a0 size=11 bytes
  Dump of memory from 0x7f713ee967a0 to 0x7f713ee967ac
  7F713EE967A0 03000080 AF424140 00402F07           [....@AB../@.]
  ```
* INTERVAL DAY TO SECOND may print `value=Unhandled datatype (-73) found in kxsbndinf`.
* Collections (dty 123): `toid ptr value=61F11290 length=16` + a hex line.
* `No oacdef for this bind.` = the bind is a repeated occurrence of an
  earlier bind name; no value is printed.
* FORALL array binds show `mal=00` and only the first row's values; the
  EXEC `r=` reveals the array size.

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
