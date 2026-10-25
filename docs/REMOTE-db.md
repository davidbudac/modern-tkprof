# Remote: Oracle connections (`internal/remote/db`)

The db half of `docs/REMOTE.md` (to be folded in there; written separately so
it does not collide with the SSH part). Plan: `docs/PLAN-DESKTOP.md` § 6.

A db connection reaches what SSH cannot when there is no OS login on the
database host: the trace files through the ADR views, the sessions to trace,
trace on/off, and the reference bundle (`docs/REF-BUNDLE.md`) without
SQL*Plus. Driver: pure-Go `github.com/sijms/go-ora/v2` (v2.9.0) over
`database/sql`, behind `db.Driver` / `db.Conn` so it can be swapped.
Username/password over TCP or TCPS only: no sysdba, wallet, Kerberos or OS
authentication in v1.

## 1. Commands

`<db-spec>` is `user@host[:port]/service` (Easy Connect; port 1521 when
omitted; IPv6 as `[::1]:1521`). A password in the spec (`user/pw@…`,
`user:pw@…`) is refused. The password is prompted on the terminal (or read as
one line of stdin when stdin is not a terminal), never a flag or an
environment variable, and lives only in the open connection.

```
mtkprof trace <db-spec> -diag                         version, ADR home, trace dir, own trace file
mtkprof trace <db-spec> -sessions [-json]             V$SESSION (type USER); "(this)" marks mtkprof's own
mtkprof trace <db-spec> -files [-sid S -serial N] [-since 2h] [-json]
mtkprof trace <db-spec> -sid S -serial N -on [-waits=true] [-binds=true] [-plan-stat all_executions]
mtkprof trace <db-spec> -sid S -serial N -off
mtkprof fetch -db <db-spec> -name cdb1_ora_4242.trc [-adr-home H] [-o file] [-resume]
mtkprof ref   -db <db-spec> <trace...> [-o dir] [-lite]
```

All take `-tcps` and `-tls-skip-verify`. `trace -on` prints the session's
trace file and the `fetch` / `-off` command lines to use next. `ref -db`
builds the model, runs the queries `refscript` would print, writes the bundle
to `<trace>.ref/` (or `-o`), applies it and prints the `report -ref` line.
`fetch -db` is reached from `mtkprof fetch` when `-db` is present
(`fetchDBArgs` → `cmdFetchDB`).

## 2. Privileges

| What | Needs |
|---|---|
| connect | `CREATE SESSION` |
| `-diag` | `SELECT` on `V$DIAG_INFO`; version: `V$INSTANCE` (else the public `V$VERSION` banner) |
| `-sessions` | `SELECT` on `V$SESSION`, `V$PROCESS` |
| `-files`, `fetch -db` | `SELECT` on `V$DIAG_TRACE_FILE`, `V$DIAG_TRACE_FILE_CONTENTS` (12.2+), `V$PROCESS`, `V$SESSION`. Without `V$DIAG_TRACE_FILE` (ORA-00942) `-files` lists `V$PROCESS.TRACEFILE` of live sessions instead (marked `fromProcess`; usable for an SSH fetch) |
| `trace -on/-off` | `EXECUTE` on `DBMS_MONITOR` |
| own-session trace (`MyTrace`, tests) | `DBMS_SESSION` (granted to PUBLIC) and `ALTER SESSION` (to verify) |
| `ref -db` | as the refscript: `SELECT_CATALOG_ROLE` (`DBA_OBJECTS`, `DBA_USERS`, `V$DATAFILE`, `V$TEMPFILE`, `V$TABLESPACE`, `V$PARAMETER`) and `V$SQL_PLAN` for DBMS_XPLAN; `-lite`: `ALL_` views only, no datafiles |

`SELECT_CATALOG_ROLE` covers every view above. Grant script, run as a DBA in
the container the user connects to (for a PDB user: `alter session set
container = PDB1;` first):

```sql
-- either the role
grant select_catalog_role to app_reader;
-- or exactly what mtkprof reads (V$ views are granted through their V_$ objects)
grant create session to app_reader;
grant select on sys.v_$diag_info               to app_reader;
grant select on sys.v_$diag_trace_file         to app_reader;
grant select on sys.v_$diag_trace_file_contents to app_reader;
grant select on sys.v_$session                 to app_reader;
grant select on sys.v_$process                 to app_reader;
grant select on sys.v_$instance                to app_reader;
-- trace on/off for other sessions
grant execute on sys.dbms_monitor              to app_reader;
-- ref -db without the role: DBA_ views (or use -lite), datafiles, plans
grant select on sys.dba_objects   to app_reader;
grant select on sys.dba_users     to app_reader;
grant select on sys.v_$datafile   to app_reader;
grant select on sys.v_$tempfile   to app_reader;
grant select on sys.v_$tablespace to app_reader;
grant select on sys.v_$parameter  to app_reader;
grant select on sys.v_$sql_plan   to app_reader;
grant select on sys.v_$sql_plan_statistics_all to app_reader;
grant select on sys.v_$sql        to app_reader;
```

The lab user `mtk` gets the trace/diag/monitor grants from
`testdata/gen/00_setup_user.sql`.

### PDB vs CDB (to verify on dbmint)

Expected, not yet observed:

- A PDB-local user sees `V$SESSION` rows of its own PDB only; `V$PROCESS`
  may show all processes.
- `V$DIAG_TRACE_FILE` has `CON_ID`; a PDB user probably sees the files whose
  `CON_ID` is the PDB's (foreground sessions of that PDB), not background or
  CDB$ROOT traces. `V$DIAG_TRACE_FILE_CONTENTS` likewise.
- Tracing a session of another PDB from a PDB is not possible; from
  CDB$ROOT with a common user it is.

If a file is listed but `fetch -db` returns no lines, the file belongs to a
container the user cannot see; use SSH.

## 3. Fetch

`SELECT line_number, payload FROM v$diag_trace_file_contents WHERE adr_home =
:h AND trace_filename = :f AND line_number BETWEEN :a AND :b ORDER BY
line_number`, 50 000 lines per query, one payload per output line (a newline
is added unless the payload has one). A chunk with fewer rows than asked ends
the file. Each chunk is buffered and written whole, so after a dropped
connection the output holds complete chunks and `fromLine + lines` (CLI:
`-resume`, which also cuts a partial last line) continues it. Rows are
fetched 1000 per round trip (go-ora `PREFETCH_ROWS`, `Spec.PrefetchRows`).

The view is slow (it parses the file on the server per query). Above
**200 MB** the CLI prints a note and the UI must warn and offer SSH instead
(the engine route should carry the same threshold; `bigFetch` in
`cmd/mtkprof/refdb.go`).

## 4. TCPS

`-tcps` sets go-ora `SSL=true`. The server certificate is verified against
the system roots and must match the host name in the spec; a self-signed or
internal-CA listener needs `-tls-skip-verify` (`Spec.TLSSkipVerify`, go-ora
`SSL VERIFY=false`), which encrypts but does not authenticate the server.
No client certificates (they need a wallet, out of scope for v1). The usual
TCPS port is 2484. Not tested: dbmint has no TCPS listener.

## 5. go-ora notes

- One session per client: the pool is capped at one connection and pinned
  (`sql.Conn`), because `DBMS_SESSION` tracing and `sys_context('USERENV',
  'SID')` are per session.
- 19c cannot bind PL/SQL `BOOLEAN`: `waits` / `binds` go as 1/0 and are
  compared in the block (`waits => :w = 1`). `plan_stat` is bound
  upper-case; empty = NULL = the server default (first execution).
- Binds are positional (`:h, :f, :a, :b` in order).
- `MODIFY_TIME` filters use epoch seconds (`timestamp '1970-01-01 00:00:00
  +00:00' + numtodsinterval(:since, 'SECOND')`) so no driver time-zone
  conversion of a bound time is involved.
- ORA-01017 re-prompts the password up to three times.
- Binary size: go-ora carries ~12 MB of character-set tables; the binary
  grows from 10.8 to 25 MB (`-ldflags "-s -w"`). `go build -tags nooracle`
  leaves it out (every db command then fails with a clear error), e.g. for
  builds copied onto database hosts.
- Native network encryption (`SQLNET.ENCRYPTION_SERVER = required`) and
  old password verifiers: go-ora implements Oracle's advanced negotiation;
  not tested here.

## 6. To verify on dbmint

Tunnel from the laptop, then run the gated test (the password is in the
variable for the test only):

```
ssh -p 2200 -N -L 15210:localhost:1521 oracle@dbmint &
# once, as SYSDBA in the VM, to apply the grants: testdata/gen/00_setup_user.sql (run_gen.sh does it)
MTKPROF_DB_TEST=mtk/mtk@localhost:15210/pdb1.world go test ./internal/remote/db -run DBMint -v
MTKPROF_DB_TEST=mtk/mtk@localhost:15210/pdb1.world MTKPROF_DB_TEST_BIG=<big trace_filename> \
  go test ./internal/remote/db -run DBMint -v -timeout 30m
```

`TestDBMint` checks version, `V$DIAG_INFO`, its own session in `Sessions`,
`MyTrace` on → marked statement → off, its file in `TraceFiles`, line-number
semantics, `Fetch` (and resume from line 2) parsed with `model.BuildFiles`
containing the statement, `DBMS_MONITOR` on/off with `V$SESSION.SQL_TRACE`,
and `FetchRef` (full and lite) on `io_waits.trc` applied with `ApplyRef`;
it logs fetch throughput.

Questions, with the SQL to answer them (as `mtk` in PDB1 unless noted):

1. **Grants**: do the views answer?
   `select count(*) from v$diag_trace_file;`
   `select count(*) from v$diag_trace_file_contents where rownum <= 1;`
   `select version_full from v$instance;`
2. **What a PDB user sees** (compare with SYSDBA in CDB$ROOT):
   `select con_id, count(*) from v$diag_trace_file group by con_id;`
   `select con_id, count(*) from v$process group by con_id;`
   `select con_id, count(*) from v$session group by con_id;`
   and whether a background trace (`cdb1_mmon_*.trc`) is fetchable:
   `select count(*) from v$diag_trace_file_contents where trace_filename like 'cdb1\_mmon\_%' escape '\';`
3. **`line_number` is 1..count with no gaps** (resume depends on it):
   `select min(line_number), max(line_number), count(*) from v$diag_trace_file_contents where trace_filename = '<file>';`
4. **Payload = one line**: embedded newlines and long lines.
   `select count(*), max(length(payload)), sum(case when instr(payload, chr(10)) > 0 then 1 else 0 end) from v$diag_trace_file_contents where trace_filename = '<file>';`
   then byte-compare a db fetch with the SSH copy:
   `mtkprof fetch -db mtk@localhost:15210/pdb1.world -name <file> -o /tmp/db.trc` and
   `ssh -p 2200 oracle@dbmint cat <Diag Trace>/<file> | cmp - /tmp/db.trc`.
   (Lines over 4000 bytes, e.g. long SQL text or bind values, are the risk.)
5. **Throughput** on a ~100 MB trace (`run_gen.sh big`), lines/s and MB/s;
   and whether a chunk's time grows with its offset (the `BETWEEN` not
   pushed into the file read, i.e. quadratic): the per-chunk progress log of
   `MTKPROF_DB_TEST_BIG`. If it is quadratic, switch to one unbounded
   `order by line_number` query streamed with resume by line.
6. **Trace on/off**: `mtkprof trace mtk@localhost:15210/pdb1.world -sessions`,
   then `-sid S -serial N -on` on another mtk session and
   `select sql_trace, sql_trace_waits, sql_trace_binds, sql_trace_plan_stats from v$session where sid = S;`
   (also confirms the `waits => :w = 1` binding through go-ora).
7. **`DBMS_SESSION.SESSION_TRACE_ENABLE`** without `ALTER SESSION`: revoke
   it from a scratch user and call
   `begin dbms_session.session_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS'); end;`.
8. **Ref bundle equals the refscript's** (the E8 "done when"):
   ```
   mtkprof refscript testdata/traces/19c/io_waits.trc -o /tmp/ref.sql   # run with sqlplus in the VM, copy ref/ back
   mtkprof ref -db mtk@localhost:15210/pdb1.world testdata/traces/19c/io_waits.trc -o /tmp/refdb
   diff <(mtkprof report testdata/traces/19c/io_waits.trc -ref ref) <(mtkprof report testdata/traces/19c/io_waits.trc -ref /tmp/refdb)
   ```
   `mtk` lacks `SELECT_CATALOG_ROLE`: run it once with `-lite` and once with
   the role granted.
9. **Time zones**: `select modify_time from v$diag_trace_file where trace_filename = '<file>';`
   against `TraceFile.Modified` in `-files -json`, and `-since 10m` lists the
   file just written.
