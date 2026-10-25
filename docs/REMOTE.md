# Remote traces: SSH and Oracle

How mtkprof reaches traces on other machines: the desktop engine's
connections (`/engine/connections`, `api/engine.openapi.yaml`) and the CLI
commands `fetch`, `follow`, `trace` and `ref -db`. User view of the same:
`docs/DESKTOP.md` § Connections. Plan: `docs/PLAN-DESKTOP.md` § 2 "Remote"
and § 6. Two kinds of connection:

- **ssh** (E7): the trace files on the database host, by `ssh` or an SSH
  library. Part 1.
- **db** (E8): an Oracle login, no OS access needed: the trace files through
  the ADR views, the sessions to trace, trace on/off, and the reference
  bundle. Part 2.

Contents: security stance, Part 1 (SSH), Part 2 (Oracle, with the grants),
"Verified on dbmint" (what ran, with numbers), "Open" (what did not), and
"Re-running the lab checks".

## Security stance

Both kinds of connection:

- **No secrets at rest.** Connection definitions carry no password field
  (`POST /engine/connections` rejects unknown fields). Every credential,
  one-time code and host-key confirmation goes through one `Prompter`
  (`internal/remote/prompt.go`): the engine's (`prompt` SSE event, answered
  with `POST /engine/prompts/{id}`), the terminal's (`TerminalPrompter`,
  no echo for secrets) or a test fake.
- Passwords and key passphrases are kept **in engine memory** per
  connection so one run of the app prompts once; `DELETE
  /engine/connections/{id}` or engine exit drops them. One-time codes and
  host-key answers are never cached. Nothing from a prompt is logged.
- A password is never a flag or an environment variable of the CLI; a
  password in a db spec is refused.

ssh:

- Host keys: unknown keys are a `hostkey` prompt with the SHA256
  fingerprint; `~/.ssh/known_hosts` is appended only on "yes". A key that
  differs from the known one is refused (lib) or handled by ssh's own
  `StrictHostKeyChecking=ask` (cli: it refuses too).
- The only files written are the fetched traces under
  `<cache>/remote/<connection>/<basename>` (0600, directory 0700) and, on
  "yes", the known_hosts line.

db:

- Username/password only, over TCP or TCPS. TCPS verifies the server
  certificate unless `tlsSkipVerify` is set, which encrypts but does not
  authenticate (see "TCPS").
- Read-mostly: the only writes are `DBMS_MONITOR` trace on/off, on the
  session the user names.

## Part 1: SSH

### Transports

`internal/remote/sshconn` picks one per connection (`transport` field):

| transport | what | when |
|---|---|---|
| `cli` | the system `ssh`/`sftp` (`internal/remote/sshcli`) | `auto` with `ssh` on `PATH` (Windows: also `%SystemRoot%\System32\OpenSSH`) |
| `lib` | `golang.org/x/crypto/ssh` + `github.com/pkg/sftp` (`internal/remote/sshlib`) | no ssh binary, forced, or after the askpass failure below |
| `auto` (default) | cli first; the first operation runs `Test`, and if ssh ignored `SSH_ASKPASS` the connection moves to lib for good (`active` in the connection info says which) | |

Both implement `remote.SSH`: `Test` (`uname -sr`), `Ls`, `Diag`, `Fetch`
(from a byte offset), `Follow` (tail -f), `Close`.

#### cli: system binaries and the askpass bridge

The engine spawns ssh with:

```
SSH_ASKPASS=<this mtkprof binary>  SSH_ASKPASS_REQUIRE=force  MTKPROF_ASKPASS=1
MTKPROF_ENGINE=127.0.0.1:<port>  MTKPROF_TOKEN=<engine token>  MTKPROF_PROMPT_CONN=<connection id>
MTKPROF_PROMPT_SPAWN=<id of this ssh run>  MTKPROF_ASKPASS_MARK=<temp file>
DISPLAY=mtkprof:0 (only when unset; OpenSSH < 8.4 needs it to use askpass; -x keeps X11 off)
ssh -o BatchMode=no -o StrictHostKeyChecking=ask [-o User= -o Port=] -o ControlMaster=auto
    -o ControlPath=/tmp/mtkprof-ssh-<uid>/%C -o ControlPersist=60 -x -T -- host "sh -c '...'"
```

in a new session without a controlling terminal (`setsid`; Windows:
`CREATE_NO_WINDOW`), so ssh cannot read the tty and runs the askpass
helper for every question. ssh runs `mtkprof "<prompt text>"`;
`MTKPROF_ASKPASS=1` makes the binary act as the helper whatever its
arguments (`mtkprof askpass "<text>"` is the explicit form). The helper
classifies the text (`remote.ClassifyPrompt`: password, passphrase for
"Enter passphrase for key", otp for "Verification code"/"One-time
password", hostkey for "Are you sure you want to continue connecting" with
the fingerprint, confirm otherwise), posts `{connection, kind, text,
fingerprint, spawn}` to `POST /engine/askpass`, which raises the `prompt`
event and holds the request until the user answers, and prints the answer
(hostkey: `yes`/`no`). Without `MTKPROF_ENGINE` it asks the terminal.

- **Cache per connection, once per run**: a cached password is offered
  once per ssh run (`spawn`); if ssh asks again in the same run the answer
  was wrong, so the user is asked and the cache replaced.
- **Connection sharing** (not on Windows): `ControlMaster=auto` with
  `ControlPersist=60` makes every later ssh/sftp of the connection reuse
  the first authentication: one password or OTP prompt per connection, and
  no handshake per listing. `Close` (connection delete, engine exit) runs
  `ssh -O exit`. The socket directory must be 0700 and short (a Unix socket
  path is at most 104 bytes on macOS); otherwise sharing is off.
- **sftp batch mode**: `sftp -b` adds `-oBatchMode=yes`, which disables
  password prompts; our `-o BatchMode=no` comes first on the command line
  and wins (the first value of an option is used). Verified with OpenSSH 9.6.
- **Cancel** kills ssh's process group (ProxyCommand included; a
  ControlPersist master has its own session and stays for its 60 s).

Tested locally with OpenSSH 9.6 against the in-process test server
(`internal/remote/sshtest`): host-key prompt through the bridge, ssh
writes known_hosts after "yes", password through the bridge, one login for
test + ls + two fetches (multiplexed), wrong password asked
`NumberOfPasswordPrompts` times, follow and fetch.

#### Windows askpass failure

Windows 11's bundled `ssh.exe` is reported to ignore `SSH_ASKPASS`
(Win32-OpenSSH issue #2115). Detection (`sshcli.ErrAskpassIgnored`): ssh
exits non-zero, the askpass helper was never run (it appends to the
`MTKPROF_ASKPASS_MARK` file), and stderr shows that ssh wanted a
credential (`password:`, `passphrase for`, `verification code`, or
`Permission denied (...password...)` / `(...keyboard-interactive...)`).
A plain `Permission denied (publickey)` does not count: no prompt would
have helped. `auto` connections then switch to lib for the rest of the
engine's run (log event "ssh did not use SSH_ASKPASS"). Tested with a fake
ssh that behaves that way; **the real Windows 11 behaviour is unverified**
(see "Open").

#### lib: Go library

Authentication order: the agent (`SSH_AUTH_SOCK`; Windows: the OpenSSH
agent pipe `\\.\pipe\openssh-ssh-agent` opened with `os.OpenFile`, **unverified
on Windows**, see "Open"), identity files (`IdentityFile` from
`~/.ssh/config`, else `id_ed25519`, `id_ecdsa`, `id_rsa`; an encrypted key
is offered by its public half and the passphrase asked only when the
server accepts it, 3 tries), password (3 tries), keyboard-interactive
(password questions share the password cache; other questions are otp
prompts with the server's echo flag). `~/.ssh/config` is read minimally:
`Host` patterns (`*`, `?`, `!`), `HostName` (`%h`), `User`, `Port`,
`IdentityFile` (`~`, `%d %u %h %r %p`); `Match`, `Include`, `ProxyJump`
and the rest are ignored: use the cli transport for those. known_hosts:
`~/.ssh/known_hosts` (hashed entries are read; new entries are written in
plain form); the server is asked for the key types known for the host so a
known host does not trip over another algorithm. Listing is SFTP
`ReadDir` (dotfiles hidden as in sftp's `ls`), fetch an SFTP read from the
offset (concurrent reads), follow a `Stat` poll every 500 ms.

### Remote commands and shell portability

Every remote command is POSIX sh run as `sh -c '<script>'` (the login
shell may be csh or ksh; scripts are one line because csh rejects a newline
inside quotes), paths single-quoted with the `'\''` escape
(`remote.ShQuote`). Only what AIX, Solaris and Linux all have:

| command | used for | notes |
|---|---|---|
| `tail -c +N -- FILE` | fetch from byte N-1 | POSIX `-c` with `+N`; no size suffixes, no GNU `--bytes` |
| `tail -c +N -f -- FILE & t=$!; cat >/dev/null; kill $t` | follow | POSIX `-f`, never `--follow`/`-F`. sshd only closes its pipes when the client goes, so an idle `tail -f` would stay on the DB host until the file grows; `cat` waits for ssh's stdin to close (we close it to stop, or the connection drops) and kills tail. The test server reports any process that outlives its channel |
| `gzip -1 -c` | compressed fetch | probed once per connection with `command -v gzip >/dev/null 2>&1`; Solaris 10's Bourne `/bin/sh` has no `command`, so the probe fails and the fetch is plain |
| `[ -r F ]`, `[ -d D ]`, `for/do/done`, backquotes | checks, diag | no `$(...)`, no `local`, no arrays (Bourne shell) |
| `uname -sr` | test | |

`Diag` (`remote.DiagScript`): `$ORACLE_BASE/diag/rdbms/*/*/trace` (rarely
set in a non-interactive ssh session), then for every home in
`/etc/oratab` or `/var/opt/oracle/oratab` (Solaris) the trace directories
under its ORACLE_BASE (`$ORACLE_HOME/bin/orabase`, else the home cut at
`/product/`), then `/u01/app/oracle/diag/rdbms/*/*/trace`; existing
directories only, duplicates removed. Listing uses sftp's client-side
`ls -ln` format (`sshcli.ParseLs`), the same whatever the server's OS.

Checked: GNU coreutils/dash locally (tests run the scripts with the local
`sh`, `sh -n` parses `DiagScript`) and the lab's Linux host. AIX and Solaris
syntax: read from the man pages, not run ("Open"). A Windows OpenSSH server is not supported by the cli scripts (lib's
SFTP listing and fetch would work; diag and follow would not).

### Fetch and follow

- Fetch writes `<cache>/remote/<connection>/<basename>` (engine) or
  `-o dir` (CLI). Resume: a local file shorter than the remote one is
  continued at its size (`tail -c +<size+1>`, or an SFTP read from that
  offset); a longer one means the remote file was replaced or rotated and
  is fetched again from 0. Resume does not compare content: a remote file
  replaced by a longer different one would be appended to wrongly (rare
  for traces, which only grow).
- Follow: the engine job appends to the same local file, reopening the
  stream at the local size after a drop (1 s, 2 s, …; 5 failures in a row
  end the job), and a live session parses the mirror as it grows
  (`docs/ARCHITECTURE.md` § Engine mode, "Live sessions"); `mirrorOnly`
  keeps the plain mirror. When the trace continues in another file (`***
  TRACE CONTINUES IN FILE x ***`, a changed `tracefile_identifier`), the
  session starts a follow job for the file of that name in the same remote
  directory (waiting until the host has it), stops the first job (its
  `tail` ends with the stream) and parses on into the second mirror.

### Measurements (loopback, in-process server, this laptop)

| path | 64 MB trace-like file |
|---|---|
| cli: OpenSSH 9.6 `tail \| gzip -1` | ~320 MB/s |
| cli: OpenSSH 9.6 `tail` | ~330 MB/s |
| lib: x/crypto + pkg/sftp | ~600 MB/s |

Loopback hides the network; on a LAN or VPN, `gzip -1` cuts trace bytes
~5–10× and the network is the limit. Follow latency: cli ≈ the host's
`tail -f` (inotify on Linux: immediate); lib ≤ the 500 ms poll. Numbers
from the real lab VM: "Verified on dbmint".

### CLI

```
mtkprof fetch  oracle@dbmint:2200 /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_4711.trc -o traces/
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc -o live.trc     # Ctrl-C stops; rerun resumes
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc | less           # to stdout
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc -serve            # live report at http://127.0.0.1:8046/
```

`follow -serve[=ADDR]` (default `127.0.0.1:8046`) runs the engine's live
session in-process (`engine.FollowRemote`, `SessionHandler`): the follow job
mirrors the file (`-o file`, else a temporary directory removed at exit),
the session parses the mirror and serves its snapshots at `/api/*`, the
same routes and answers as `/s/{id}/` of the engine (GET and HEAD only, so
no reference bundle upload; CORS open for reads like `serve`'s
`/api/doc`), the UI at `/`. `X-Rev` and `api/doc?rev=` as in the engine.
`-batch-ms` sets the batch, `-bind-values`/`-redact-salt` as for `serve`.
A chain (`TRACE CONTINUES IN FILE x`) is mirrored next to the first file
under the remote names and followed. Ctrl-C closes the listener, cancels
the follow (the remote `tail` ends with the stream) and removes the spill.

Prompts go to the terminal (`/dev/tty`, `CONIN$`); with the cli transport
the CLI starts an in-process askpass bridge on 127.0.0.1 so ssh's prompts
reach the same terminal. `-transport lib` forces the Go library.

## Part 2: Oracle connections (`internal/remote/db`)

A db connection reaches what SSH cannot when there is no OS login on the
database host. Driver: pure-Go `github.com/sijms/go-ora/v2` (v2.9.0) over
`database/sql`, behind `db.Driver` / `db.Conn` so it can be swapped.
Username/password over TCP or TCPS only: no sysdba, wallet, Kerberos or OS
authentication in v1.

### Commands

`<db-spec>` is `user@host[:port]/service` (Easy Connect; port 1521 when
omitted; IPv6 as `[::1]:1521`). A password in the spec (`user/pw@…`,
`user:pw@…`) is refused. The password is prompted on the terminal (`remote.TerminalPrompter`; one
line of stdin when stdin is a pipe), never a flag or an environment
variable, and lives only in the open connection.

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
`mtkprof fetch` with `-db` anywhere on the line is `fetch -db`.

### Privileges

| What | Needs |
|---|---|
| connect | `CREATE SESSION` |
| `-diag` | `SELECT` on `V$DIAG_INFO`; version: `V$INSTANCE` (else the public `V$VERSION` banner) |
| `-sessions` | `SELECT` on `V$SESSION`, `V$PROCESS` |
| `-files`, `fetch -db` | `SELECT` on `V$DIAG_TRACE_FILE`, `V$DIAG_TRACE_FILE_CONTENTS` (12.2+), `V$PROCESS`, `V$SESSION`. Without `V$DIAG_TRACE_FILE` (ORA-00942) `-files` lists `V$PROCESS.TRACEFILE` of live sessions instead (marked `fromProcess`; usable for an SSH fetch) |
| `trace -on/-off` | `EXECUTE` on `DBMS_MONITOR` |
| own-session trace (`MyTrace`, tests) | `DBMS_SESSION` (granted to PUBLIC) **and** `ALTER SESSION`: without it `SESSION_TRACE_ENABLE` fails with ORA-01031 (verified on 19.27 with a `CREATE SESSION`-only user) |
| from `CDB$ROOT` on a PDB session | a common user (`C##…`) with the grants above `CONTAINER=ALL` **and** `ALTER USER c##u SET CONTAINER_DATA=ALL CONTAINER=CURRENT`; without `CONTAINER_DATA` `V$SESSION` in the root shows only root sessions (verified: `trace -sessions/-on/-off` on a PDB1 session through `cdb1.world`) |
| `ref -db` (full) | as the refscript: `SELECT_CATALOG_ROLE` or `SELECT ANY DICTIONARY` for `DBA_OBJECTS`, `DBA_USERS`; `V$DATAFILE`, `V$TEMPFILE`, `V$TABLESPACE`, `V$PARAMETER` for the datafiles; `V$SQL`, `V$SQL_PLAN`... for DBMS_XPLAN (`DISPLAY_CURSOR`, `DISPLAY_AWR`) |
| `ref -db -lite` | nothing beyond `CREATE SESSION`: `ALL_OBJECTS`, `ALL_USERS` (only what the user may see), no datafiles; plans as far as DBMS_XPLAN is allowed |

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

The lab user `mtk` (PDB1) is not a DBA. From `testdata/gen/00_setup_user.sql`
it has `CREATE SESSION`, `ALTER SESSION` and the schema-creation privileges,
`EXECUTE` on `DBMS_MONITOR`, and `SELECT` on `V_$DIAG_INFO`,
`V_$DIAG_TRACE_FILE`, `V_$DIAG_TRACE_FILE_CONTENTS`, `V_$INSTANCE`,
`V_$SESSION`, `V_$PROCESS`, `V_$PARAMETER` (and the `V_$` objects of the
generators: `EVENT_NAME`, `MYSTAT`, `STATNAME`, `SQLCOMMAND`, `PX_SESSION`,
`PQ_SESSTAT`). No role (`SESSION_ROLES` is empty), no `DBA_` views and no
`V_$DATAFILE`, `V_$TEMPFILE`, `V_$TABLESPACE`, `V_$SQL`, `V_$SQL_PLAN`.
Consequences, seen on dbmint:

- `ref -db` (full) gets ORA-00942 for `objects.csv` and `users.csv`
  (`DBA_OBJECTS`, `DBA_USERS`) and for `datafiles.csv` (`V$DATAFILE`). The two
  with an `ALL_` counterpart are **answered by the lite query** (`FetchRef`
  returns a `*db.PartialError` whose `Fallback` lists them, with the refusal;
  the CLI prints a `note:` per file, the engine job puts it in `message`);
  `datafiles.csv` has no lite form, so it stays missing (`Failed`). The same
  fallback happens on ORA-01031. Lite mode itself is clean: the bundle has the
  objects and users `mtk` may see (5 objects, 2 users for `io_waits.trc`: the
  lab database differs from the fixture bundle's, which is fine).
- The full mode needs, besides `SELECT_CATALOG_ROLE` (or `SELECT ANY
  DICTIONARY`, which covers `DBA_` and `V$` alike), nothing else: the role has
  every `V$` view of the table above. Without the role, the explicit grants
  of the script above (`dba_objects`, `dba_users`, `v_$datafile`,
  `v_$tempfile`, `v_$tablespace`, `v_$sql*`) are what each file needs.
- No plans: `DISPLAY_CURSOR` found no cursor of the fixture's sql_ids and
  `mtk` cannot read `V$SQL_PLAN`; the plan files say "no plan found".

#### PDB vs CDB (observed on dbmint, Oracle 19.27, `mtk` in PDB1)

- `V$DIAG_TRACE_FILE`: one container only, `CON_ID` 3 (5313 files); the
  files of CDB$ROOT are not listed. `V$SESSION`: the user's own session plus
  the `CON_ID` 0 background sessions (`Sessions` lists type USER only).
- Background traces such as `cdb1_mmon_*.trc` are listed and **readable**
  through `V$DIAG_TRACE_FILE_CONTENTS`.
- `V$DIAG_INFO` works; `V$INSTANCE.version_full` is `19.27.0.0.0`;
  `DBMS_MONITOR.SESSION_TRACE_ENABLE/DISABLE` on the user's own session works
  (`V$SESSION.SQL_TRACE` follows).
- Not tried: tracing another PDB's session (not possible from a PDB; from
  CDB$ROOT with a common user it is).

If a file is listed but `fetch -db` returns no lines, the file belongs to a
container the user cannot see; use SSH.

### Fetch through `V$DIAG_TRACE_FILE_CONTENTS`

**A row is a record, not a line.** Its `payload` holds one or more lines, and
`line_number` is the file's line count at the *end* of the record (a handful
of single-line STAT records have their FETCH's number, one less than their
own line; several records can share a number). Measured on
`cdb1_ora_133146_mtk_basic_binds.trc` (= `testdata/traces/19c/basic_binds.trc`,
3059 lines, 213 689 bytes): 2707 rows, `line_number` 1..3059 with 363 gaps,
314 rows with inner newlines, max payload 1498 bytes, 20 rows with a NULL
payload (they follow the "Dump of memory" blocks; they add nothing and repeat
the previous row's number). The payloads, **concatenated as they are**, in row
order, are the file byte for byte (sha256 `adfd68fb...`). `db.Fetch` therefore
never adds a newline; NULL is nothing. The view's rows are kept as a fixture
(`testdata/db/basic_binds.view`) for the fake-driver tests.

```sql
select line_number, payload from (
  select line_number, payload, rownum rn from v$diag_trace_file_contents
   where adr_home = :h and trace_filename = :f and line_number between :a and :b)
 order by line_number, rn
```

(`rn` keeps the rows of one number in the order the view returned them.)

Fetch reads `max(line_number)` first, then asks for ranges of line numbers
from 1 up to that maximum. A range starts at 50 000 numbers (`FetchChunk`;
about 43 700 rows on a real trace) and adapts: it doubles after a query that
took under 1 s (`FetchFast`) up to 400 000 (`FetchChunkMax`), and halves after
one over 4 s (`FetchSlow`) down to 50 000 (`chunkSizer`, `fetch.go`). A resume
starts with the 50 000 range as before; the prefix match is independent of the
range sizes. a chunk returns fewer rows than line numbers, so "fewer rows than
asked" cannot end the file, and a file that is an exact multiple needs no
empty query. Each chunk is buffered and written whole, so after a dropped
connection the output holds complete chunks. Rows are fetched 1000 per round
trip (go-ora `PREFETCH_ROWS`, `Spec.PrefetchRows`).

**Resume** (`-resume`, the engine's repeated `fetch` call): `db.OpenResume`
cuts a partial last line and returns `Resume{Lines: '\n' count L, Tail: last
256 KB}`. Counting alone is not a key: `line_number > L` would lose a STAT
line numbered like the FETCH before it, `>= L` repeats the FETCH, and a copy
cut inside a multi-line record has half a row. So Fetch starts at line number
`L - 64` (`ResumeBack`), takes the rows from there, and finds in them the
longest whole-line prefix that is a suffix of the local tail *and* ends in a
row numbered `L-1`..`L+k` (the number check keeps a repetitive trace from
matching too far); only the bytes after it are appended. If no prefix matches
the copy is not this trace and the resume fails
("does not match the database's trace"). Tested at every line end and inside
lines of the fixture, with a truncated file on dbmint, and (unit test) on a
trace made of 40 identical copies.

**Speed.** On dbmint through the SSH tunnel: 1.8 s (quiet lab) to 5 s per
chunk of 50 000 line numbers (about 0.4-1 MB/s), independent of the offset
(not quadratic: first and last chunk take the same); a query costs 2.5-3 s
even for a few rows, so the server, not the network, is the limit. A
117 MB / 2.88 M-line trace takes 2-5 minutes (measured 301 s); SSH is faster
for anything big. Above **200 MB** the CLI prints a note and the UI
must warn and offer SSH instead (the engine job sets its `message` past that
size; `db.BigFetch`).

### TCPS

`-tcps` sets go-ora `SSL=true`. The server certificate is verified against
the system roots and must match the host name in the spec; a self-signed or
internal-CA listener needs `-tls-skip-verify` (`Spec.TLSSkipVerify`, go-ora
`SSL VERIFY=false`), which encrypts but does not authenticate the server.
No client certificates (they need a wallet, out of scope for v1). The usual
TCPS port is 2484. Not tested ("Open"): dbmint has no TCPS listener.

### go-ora notes

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
  leaves it out (every db command then fails with a clear error); `make
  release` ships those as `mtkprof-lite-<os>-<arch>` for linux, aix and
  solaris, the builds copied onto database hosts.
- Native network encryption (`SQLNET.ENCRYPTION_SERVER = required`) and
  old password verifiers: go-ora implements Oracle's advanced negotiation;
  not tested ("Open").

### In the engine

A connection `{"id", "kind":"db", "host", "port", "user", "service",
"adrHome"?, "tcps"?, "tlsSkipVerify"?}` (no password field, as for ssh).
Routes (`api/engine.openapi.yaml`):

| route | what |
|---|---|
| `POST /engine/connections/{id}/test` | connects, asks the password through a `prompt` event if it is not cached; `{server, transport: tcp\|tcps, diag: {adrHome, traceDir}}` |
| `GET .../diag` | `{dirs: [Diag Trace], adrHome}` (V$DIAG_INFO) |
| `GET .../tracefiles?sid&serial&since` | `{files: [...]}`; `since` is `2h`, `30m`, `1d` or RFC 3339 |
| `GET .../sessions` | `{sessions: [...]}` (V$SESSION, `self` marks the connection's own) |
| `POST .../trace {sid, serial, enable, waits, binds, planStat}` or `{self: true, enable}` | DBMS_MONITOR / DBMS_SESSION; `{enabled, traceFile?}` |
| `POST .../fetch {adrHome?, name}` | 202 `{job, localPaths}`; job kind `fetch`, unit `lines` |
| `POST /s/{id}/api/ref {dir}` or `{connection, lite?}` | job kind `ref`; see below |

`ls` and `follow` are ssh-only (400 on a db connection).

- **One password prompt per connection.** The password is kept in engine
  memory like the SSH credentials (offered once per open: a rejected one is
  dropped and asked again, up to three times, then `remote` 502 with
  ORA-01017); `DELETE /engine/connections/{id}` or engine exit forgets it.
  A cancelled prompt is `cancelled` (409). Driver errors are `remote` (502).
- **Sessions.** The connection's quick calls share one pinned database
  session (opened on first use, one statement at a time, reopened with the
  cached password after a dropped network). Long jobs (fetch, ref) open a
  session of their own so they do not block `sessions` or `trace -off`; the
  database sees up to 1 + running jobs sessions of the user.
- **Fetch job.** Writes `<cache>/remote/<connection>/<name>` (0600), 50 000
  lines per query. A partial local file is continued: complete lines are
  counted (a cut last line is dropped) and the next query starts after them,
  so cancelling, a dropped connection or a crash resume where they stopped.
  `done` is the number of lines (`total` unknown); finishing with zero lines is
  an error (wrong `adrHome` or name, or a container the user cannot see).
  Past 200 MB the job's `message` says SSH is faster. `adrHome` defaults to
  the connection's, else V$DIAG_INFO's.
- **Ref job.** `POST /s/{id}/api/ref` obtains a reference bundle
  (`docs/REF-BUNDLE.md`) from `{dir}` (a bundle directory on the engine's
  machine) or `{connection}` (runs `report.RefQueries` of the session's
  trace on the connection, `lite` = ALL_ views only), keeps it, applies it to
  the open session (`model.ApplyRef`, which replaces an earlier bundle),
  rebuilds the document and bumps the session's `rev` (`session` event);
  `GET /s/{id}/api/doc` then returns the new document (`?rev=` is still
  ignored). Queries that fail are skipped like the refscript's `whenever
  sqlerror continue`; the job is `done` and its `message` lists them
  (`queries skipped: users.csv: ORA-00942 ...`). A bundle with no usable file
  fails the job and changes nothing.
- **Where the bundle is kept.** `<cache>/ref/<trace identity>/` (the
  session's `identity`, the content identity of the trace files without
  build options, so every session and every bind mode of the same trace
  share it), in the bundle layout of `internal/ref` (`objects.csv`,
  `datafiles.csv`, `users.csv`, `plans/<sql_id>.txt`). It lives outside the
  index-cache entry (`<cache>/index/<id>/`) on purpose: the entry's manifest
  lists every file and is validated strictly. Opening the same trace again,
  a cache hit or a fresh parse, applies the kept bundle before the first
  document is built (`rev` 1, bundle in). `DELETE /engine/cache` also
  removes the bundles of traces no session has open; evicting an entry does
  not (they are a few KB).
- **TLS.** `tcps` and `tlsSkipVerify` on the definition, as `-tcps` and
  `-tls-skip-verify`.

## Verified on dbmint

Lab: the VM `dbmint` (`ssh -p 2200 oracle@dbmint`; sandboxed agent shells
need `dangerouslyDisableSandbox: true`), Oracle 19.27, user `mtk` in PDB1, OpenSSH
8.7 on the host, 9.6 locally. All on 2026-10-25. The unit and integration
tests elsewhere use fakes and in-process servers; these are the runs against
the real database host.

### ssh (E7)

Key authentication; transport `auto` chose cli.

| Check | Result |
|---|---|
| `TestDbmint`: fetch of `cdb1_ora_133146_mtk_basic_binds.trc` over cli+gzip, cli, lib and scp | same sha256 (213 689 bytes) |
| Resume from a truncated copy | correct |
| `Diag` | finds `/u01/app/oracle/diag/rdbms/cdb1/cdb1/trace` |
| Follow latency | 149 ms (cli, inotify `tail -f`), 501 ms (lib, 500 ms poll); budget 2 s |
| `mtkprof fetch ... cdb1_ora_134678_mtk_big_loop.trc` | 117.7 MB in 0.97 s (gzip, VM loopback); sha256 equal to `testdata/big/big_loop.trc`; second run a 0.4 s no-op |
| Engine: connection (`auto` → cli), `test`, `diag`, `fetch` | job done, 171 216 bytes under `<cache>/remote/lab/` |
| Engine: `follow` | live session (`live`, rev 2, 3 059 lines after 4 s) |
| Prompts | none (key auth); the password round trip is covered by the in-process server (Part 1) |
| Cleanup | deleting the session left no `tail` on the host (`pgrep -a tail` empty) |

### Oracle (E8)

Through an ssh tunnel (`-L 15210`). Gated test `TestDBMint` plus CLI runs.

| Question | Result |
|---|---|
| Do the views answer for `mtk`? | Yes: `v$diag_trace_file`, `v$diag_trace_file_contents`, `v$instance` (`version_full` 19.27.0.0.0), `v$diag_info`. `DBA_` views and `V$DATAFILE` do not (no role). |
| What a PDB user sees | `v$diag_trace_file`: `con_id` 3 only (5313 files); `v$session`: own session plus `con_id` 0 background sessions; background traces (`cdb1_mmon_*`) readable |
| Is `line_number` 1..count? | No. A row is a record of one or more lines; `line_number` is its last line, with gaps and repeats: 2707 rows for the 3059 lines of `basic_binds.trc` |
| Payload | verbatim concatenation is the file: 314 of 2707 rows have inner newlines, 20 have a NULL payload, max 1498 bytes; sha256 equal to the fixture. `fetch -db -resume` of a truncated copy is byte-equal |
| Throughput, 117 MB / 2 881 438 lines | 301 s = 0.39 MB/s = 9 570 lines/s; 58 chunks of 4.4–5.5 s; sha256 equal. A quiet lab measured 1.8 s per chunk (about 1 MB/s, 2 min). Time per chunk is flat in the offset. Ranges of 200 000 numbers are ~1.6× faster per line (hence the adaptive range; its dbmint run is not measured yet) |
| Resume on the big file | cut after 2 875, 1 066 738 and 2 680 613 lines: the first range returned exactly the bytes that follow the local copy |
| Trace on/off | `DBMS_MONITOR` on/off through the test; `V$SESSION.SQL_TRACE` follows; `trace -sessions` lists `mtk` sessions with "(this)" |
| `ref -db -lite` on `io_waits.trc` | clean: 5 objects, 2 users; applied, `report -ref` shows the names |
| `ref -db` (full) as `mtk` | ORA-00942 for `DBA_OBJECTS`, `DBA_USERS` (answered by the lite query, notes printed) and `V$DATAFILE` (`datafiles.csv` missing, no lite form). No plans: `mtk` cannot read `V$SQL_PLAN` |

Second round (2026-10-25, users `mtkcat` = `mtk` + `SELECT_CATALOG_ROLE`,
`mtknoalt` = `CREATE SESSION` + the V$ views, `c##mtkroot` common; all
created by hand as SYSDBA, not by `00_setup_user.sql`):

| Question | Result |
|---|---|
| Full `ref -db` as `mtkcat` vs the `refscript` bundle run with sqlplus | same file set (`objects.csv`, `users.csv`, `datafiles.csv`, 23 `plans/*.txt`); CSVs identical but for the spool's leading blank line; every plan text identical; `report -ref` output identical. 7 objects, 3 datafiles, 2 users, 6 plans found for `io_waits.trc` |
| `TestDBMint` as `mtkcat` | passes (7 s, `basic_binds.trc` fixture byte-equal) |
| `DBMS_SESSION.SESSION_TRACE_ENABLE` without `ALTER SESSION` | ORA-01031 at `SYS.DBMS_SESSION` line 343: `ALTER SESSION` is required (table above) |
| `modify_time` vs `-since` | `V$DIAG_TRACE_FILE.MODIFY_TIME` is `TIMESTAMP(3) WITH TIME ZONE`; the CLI prints it as UTC (`2026-10-22T11:40:12Z`) equal to the file's mtime on the host; `-since 72h`/`96h` exclude/include a 74 h old file correctly from a CET client against a UTC server. `trace -since` now accepts `Nd` like the engine |
| Tracing a PDB session from `CDB$ROOT` | works as `c##mtkroot` through the root service once `CONTAINER_DATA=ALL` is set: the PDB1 session is listed, `trace -on` / `-off` by sid/serial succeed (`DBMS_MONITOR` from the root) |
| 2 GB trace through the engine (the 117 MB lab trace concatenated 17×, 49 M lines, on this laptop) | open 13 s (cache build included), peak RSS 146 MB, cache entry 1.9 GB; reopen from the cache 0.25 s (`hit: true`), RSS 98 MB; `api/doc` 0.7 ms (469 KB), `lines` 0.3 ms, `at` 0.4 ms, `search` 4 ms, `pivot` 0.9 ms, text report 79 ms |

## Open

Not verified yet:

- **Windows 11**: whether `ssh.exe` ignores `SSH_ASKPASS` (the detection
  and the switch to lib are tested with a fake ssh), and the OpenSSH agent
  pipe for the lib transport. Needs a real machine; record the result here.
- **TCPS**: dbmint has no TCPS listener; the certificate and
  `-tls-skip-verify` paths are untested, as are native network encryption and
  old password verifiers.
- The engine's db routes end to end with curl (one password prompt for
  test + sessions + fetch + ref; killing the tunnel mid-fetch and resuming).
- AIX and Solaris remote scripts (read from the man pages, not run); a
  > 2 GB file through AIX `tail -c`.

Deferred by design: adaptive fetch ranges; wallet, sysdba and Kerberos
authentication; `ProxyJump`/`Include`/`Match` in the lib transport (use cli).

## Re-running the lab checks

SSH, gated tests and CLI:

```
MTKPROF_SSH_TEST=oracle@dbmint:2200 go test ./internal/remote/sshconn -run Dbmint -v
mtkprof fetch  oracle@dbmint:2200 <Diag Trace>/<file>.trc -o /tmp/f/     # twice: the second is a no-op
mtkprof follow oracle@dbmint:2200 <file> | head                          # then testdata/gen/run_gen.sh; Ctrl-C
ssh -p 2200 oracle@dbmint pgrep -a tail                                  # must print nothing
```

Oracle (the password is in the variable for the test only; the grants come
from `testdata/gen/00_setup_user.sql`, which `run_gen.sh` runs as SYSDBA):

```
ssh -p 2200 -N -L 15210:localhost:1521 oracle@dbmint &
MTKPROF_DB_TEST=mtk/mtk@localhost:15210/pdb1.world go test ./internal/remote/db -run DBMint -v
MTKPROF_DB_TEST=... MTKPROF_DB_TEST_BIG=<big trace_filename> MTKPROF_DB_TEST_BIG_SHA256=<hash> \
  go test ./internal/remote/db -run DBMint -v -timeout 30m
```

`TestDBMint` checks version, `V$DIAG_INFO`, its own session in `Sessions`,
`MyTrace` on → marked statement → off, its file in `TraceFiles`, the record
semantics of the view, `Fetch` parsed with `model.BuildFiles` containing the
statement, resume of a truncated copy (cut at 0, 1/4, 1/2 and inside the last
quarter, plus a partial line) equal to a fresh fetch, `DBMS_MONITOR` on/off
with `V$SESSION.SQL_TRACE`, and `FetchRef` (full and lite) on `io_waits.trc`
applied with `ApplyRef`. It logs fetch throughput.
`MTKPROF_DB_TEST_FIXTURE=cdb1_ora_133146_mtk_basic_binds.trc` also compares
the lab's copy with `testdata/traces/19c/basic_binds.trc`. Compare any other
fetch with the SSH copy: `ssh -p 2200 oracle@dbmint cat <Diag Trace>/<file> | cmp - /tmp/db.trc`.

Reference bundle against the refscript's (after granting the role):

```
mtkprof refscript testdata/traces/19c/io_waits.trc -o /tmp/ref.sql   # run with sqlplus in the VM, copy ref/ back
mtkprof ref -db mtk@localhost:15210/pdb1.world testdata/traces/19c/io_waits.trc -o /tmp/refdb
diff <(mtkprof report testdata/traces/19c/io_waits.trc -ref ref) <(mtkprof report testdata/traces/19c/io_waits.trc -ref /tmp/refdb)
```

Engine (loopback; the token is in the environment, prompts are answered with
`POST /engine/prompts/<id>`):

```
export MTKPROF_TOKEN=dev-token; H="Authorization: Bearer $MTKPROF_TOKEN"
bin/mtkprof engine -listen 127.0.0.1:8047 &        # find it later with: ss -ltnp | grep :8047
curl -N -H "$H" localhost:8047/engine/events &     # prompt events appear here
# ssh
curl -H "$H" -XPOST localhost:8047/engine/connections -d '{"id":"lab","kind":"ssh","host":"dbmint","port":2200,"user":"oracle"}'
curl -H "$H" -XPOST localhost:8047/engine/connections/lab/test
curl -H "$H" localhost:8047/engine/connections/lab/diag
curl -H "$H" -XPOST localhost:8047/engine/connections/lab/fetch -d '{"paths":["<Diag Trace>/<file>.trc"]}'
# db (tunnel up)
curl -H "$H" -XPOST localhost:8047/engine/connections -d '{"id":"ora","kind":"db","host":"localhost","port":15210,"user":"mtk","service":"pdb1.world"}'
curl -H "$H" -XPOST localhost:8047/engine/connections/ora/test       # one password prompt
curl -H "$H" localhost:8047/engine/connections/ora/sessions
curl -H "$H" "localhost:8047/engine/connections/ora/tracefiles?since=1d"
curl -H "$H" -XPOST localhost:8047/engine/connections/ora/trace -d '{"sid":S,"serial":N,"enable":true}'
curl -H "$H" -XPOST localhost:8047/engine/connections/ora/fetch -d '{"adrHome":"<ADR Home>","name":"<file>"}'
curl -H "$H" -XPOST localhost:8047/engine/sessions -d '{"paths":["<localPath>"]}'
curl -H "$H" -XPOST localhost:8047/s/<session>/api/ref -d '{"connection":"ora","lite":true}'
curl -H "$H" localhost:8047/s/<session>/api/doc | head -c 300      # names filled in; rev 2
```

Expected: one password prompt per connection for the whole run (cli:
multiplexed; lib and db: cached); killing the tunnel in the middle of a
fetch fails the job and the same `fetch` call resumes it; `DELETE
/engine/connections/ora` closes the sessions (`select count(*) from v$session
where username='MTK'` drops).
