# Remote traces: SSH and Oracle

How mtkprof reaches traces on other machines: the desktop engine's
connections (`/engine/connections`, `api/engine.openapi.yaml`) and the CLI
commands `fetch`, `follow`, `trace` and `ref -db`. Plan: `docs/PLAN-DESKTOP.md`
§ 2 "Remote" and § 6. Two kinds of connection:

- **ssh** (work package E7): the trace files on the database host, by `ssh`
  or an SSH library. Part 1 below.
- **db** (E8): an Oracle login, no OS access needed: the trace files through
  the ADR views, the sessions to trace, trace on/off, and the reference
  bundle. Part 2 (from "Oracle connections").

The verification checklist for dbmint (both) is the last section.

## Part 1: SSH

### Security stance

- **No secrets at rest.** Connection definitions carry no password field
  (`POST /engine/connections` rejects unknown fields). Every credential,
  one-time code and host-key confirmation goes through one `Prompter`
  (`internal/remote/prompt.go`): the engine's (`prompt` SSE event, answered
  with `POST /engine/prompts/{id}`), the terminal's (`TerminalPrompter`,
  no echo for secrets) or a test fake.
- Passwords and key passphrases are kept **in engine memory** per
  connection so one session of work prompts once; `DELETE
  /engine/connections/{id}` or engine exit drops them. One-time codes and
  host-key answers are never cached. Nothing from a prompt is logged.
- Host keys: unknown keys are a `hostkey` prompt with the SHA256
  fingerprint; `~/.ssh/known_hosts` is appended only on "yes". A key that
  differs from the known one is refused (lib) or handled by ssh's own
  `StrictHostKeyChecking=ask` (cli: it refuses too).
- The only files written are the fetched traces under
  `<cache>/remote/<connection>/<basename>` (0600, directory 0700) and, on
  "yes", the known_hosts line.

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
ssh that behaves that way; **the real Windows 11 behaviour is unverified:
to verify in S6** and record here.

#### lib: Go library

Authentication order: the agent (`SSH_AUTH_SOCK`; Windows: the OpenSSH
agent pipe `\\.\pipe\openssh-ssh-agent` opened with `os.OpenFile`, **to
verify on Windows in S6**), identity files (`IdentityFile` from
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

Checked here: GNU coreutils/dash (tests run the scripts with the local
`sh`, `sh -n` parses `DiagScript`). AIX and Solaris syntax: read from the
man pages, not run. Large files (> 2 GB) through AIX `tail -c`: unverified.
A Windows OpenSSH server is not supported by the cli scripts (lib's
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
  keeps the plain mirror.

### Measurements (loopback, in-process server, this laptop)

| path | 64 MB trace-like file |
|---|---|
| cli: OpenSSH 9.6 `tail \| gzip -1` | ~320 MB/s |
| cli: OpenSSH 9.6 `tail` | ~330 MB/s |
| lib: x/crypto + pkg/sftp | ~600 MB/s |

Loopback hides the network; on a LAN or VPN, `gzip -1` cuts trace bytes
~5–10× and the network is the limit. Follow latency: cli ≈ the host's
`tail -f` (inotify on Linux: immediate); lib ≤ the 500 ms poll. Pending
on dbmint: `MTKPROF_SSH_TEST=oracle@dbmint:2200 go test ./internal/remote/sshconn -run Dbmint -v`
(fetch sha256 over cli+gzip, cli, lib and scp, resume, diag, follow
latency with the 2 s budget).

### CLI

```
mtkprof fetch  oracle@dbmint:2200 /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_4711.trc -o traces/
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc -o live.trc     # Ctrl-C stops; rerun resumes
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc | less           # to stdout
```

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

#### PDB vs CDB (to verify on dbmint)

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

### Fetch through `V$DIAG_TRACE_FILE_CONTENTS`

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
(the engine job sets its `message` past that size; `db.BigFetch`).

### TCPS

`-tcps` sets go-ora `SSL=true`. The server certificate is verified against
the system roots and must match the host name in the spec; a self-signed or
internal-CA listener needs `-tls-skip-verify` (`Spec.TLSSkipVerify`, go-ora
`SSL VERIFY=false`), which encrypts but does not authenticate the server.
No client certificates (they need a wallet, out of scope for v1). The usual
TCPS port is 2484. Not tested: dbmint has no TCPS listener.

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
  leaves it out (every db command then fails with a clear error), e.g. for
  builds copied onto database hosts.
- Native network encryption (`SQLNET.ENCRYPTION_SERVER = required`) and
  old password verifiers: go-ora implements Oracle's advanced negotiation;
  not tested here.

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

## Verification checklist for dbmint

Nothing here has run yet (the dev machine has no access to the lab). The
automated tests use fakes; this list is what remains. `dbmint` is the lab VM
(`ssh -p 2200 oracle@dbmint`; sandboxed shells need
`dangerouslyDisableSandbox: true` for it). Record results in this file
(replace "to verify" with what was seen).

### SSH (E7): verified on dbmint 2026-10-25

Results (`ssh -p 2200 oracle@dbmint`, key authentication, OpenSSH 8.7 on
the host, 9.6 locally):

- `TestDbmint`: cli, cli+gzip, lib and scp give the same sha256 of
  `cdb1_ora_133146_mtk_basic_binds.trc` (213 689 bytes); resume from a
  truncated copy works; `Diag` finds `/u01/app/oracle/diag/rdbms/cdb1/cdb1/trace`;
  follow latency 149 ms (cli, inotify `tail -f`) and 501 ms (lib, 500 ms poll).
- `mtkprof fetch oracle@dbmint:2200 .../cdb1_ora_134678_mtk_big_loop.trc`:
  117.7 MB in 0.97 s (gzip over the VM loopback), sha256 equal to
  `testdata/big/big_loop.trc`; the second run is a 0.4 s no-op.
- Engine: `POST /engine/connections` (ssh, transport auto → cli), `test`,
  `diag`, `fetch` (job done, 171 216 bytes under `<cache>/remote/lab/`),
  `follow` → a live session (`live`, rev 2, 3 059 lines after 4 s); no prompt
  events (key auth); `DELETE` of the session left no `tail` on the host
  (`pgrep -a tail` empty).
- Not yet verified: Windows 11 askpass and the agent pipe (S6).

The original checklist, kept for the next lab:

1. Gated transport tests (fetch sha256 over cli+gzip, cli, lib and scp,
   resume, diag, follow latency within 2 s):
   `MTKPROF_SSH_TEST=oracle@dbmint:2200 go test ./internal/remote/sshconn -run Dbmint -v`
2. CLI: `mtkprof fetch oracle@dbmint:2200 <Diag Trace>/<file>.trc -o /tmp/f/`
   (password or key; run it twice: the second is a no-op), `cmp` with
   `ssh -p 2200 oracle@dbmint cat <file>`.
3. `mtkprof follow oracle@dbmint:2200 <file> | head`, generate trace
   (`testdata/gen/run_gen.sh`), lines appear; Ctrl-C leaves no `tail` on the
   host (`ssh -p 2200 oracle@dbmint pgrep -a tail`).
4. Engine (loopback, token in the environment):
   ```
   export MTKPROF_TOKEN=dev-token; H="Authorization: Bearer $MTKPROF_TOKEN"
   bin/mtkprof engine -listen 127.0.0.1:8047 &        # find it later with: ss -ltnp | grep :8047
   curl -N -H "$H" localhost:8047/engine/events &     # prompt events appear here
   curl -H "$H" -XPOST localhost:8047/engine/connections -d '{"id":"lab","kind":"ssh","host":"dbmint","port":2200,"user":"oracle"}'
   curl -H "$H" -XPOST localhost:8047/engine/connections/lab/test        # answer the prompt: curl -H "$H" -XPOST localhost:8047/engine/prompts/<id> -d '{"answer":"..."}'
   curl -H "$H" localhost:8047/engine/connections/lab/diag
   curl -H "$H" -XPOST localhost:8047/engine/connections/lab/fetch -d '{"paths":["<Diag Trace>/<file>.trc"]}'
   ```
   The password prompt appears once for test + diag + fetch (cli:
   multiplexed; lib: cached).
5. Windows 11 (S6): the askpass failure and the OpenSSH agent pipe, see the
   notes in Part 1.

### Oracle (E8)

Tunnel from the laptop, then the gated test (the password is in the
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
and `FetchRef` (full and lite) on `io_waits.trc` applied with `ApplyRef`; it
logs fetch throughput.

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
10. **Engine** (same engine as in the SSH list, tunnel up; `MTKPROF_TOKEN`,
    `H` as above; answer prompts with `POST /engine/prompts/<id>`):
    ```
    curl -H "$H" -XPOST localhost:8047/engine/connections -d '{"id":"ora","kind":"db","host":"localhost","port":15210,"user":"mtk","service":"pdb1.world"}'
    curl -H "$H" -XPOST localhost:8047/engine/connections/ora/test       # one password prompt; server 19.x, diag
    curl -H "$H" localhost:8047/engine/connections/ora/sessions
    curl -H "$H" "localhost:8047/engine/connections/ora/tracefiles?since=1d"
    curl -H "$H" -XPOST localhost:8047/engine/connections/ora/trace -d '{"sid":S,"serial":N,"enable":true}'
    curl -H "$H" -XPOST localhost:8047/engine/connections/ora/fetch -d '{"adrHome":"<ADR Home>","name":"<file>"}'
    # open the fetched file (localPaths in the answer), then:
    curl -H "$H" -XPOST localhost:8047/engine/sessions -d '{"paths":["<localPath>"]}'
    curl -H "$H" -XPOST localhost:8047/s/<session>/api/ref -d '{"connection":"ora","lite":true}'
    curl -H "$H" localhost:8047/s/<session>/api/doc | head -c 300      # names filled in; rev 2 in the session
    ```
    Expected: a single password prompt for the whole run (fetch and ref use
    sessions of their own with the cached password); killing the tunnel in
    the middle of a fetch fails the job, and the same `fetch` call resumes
    it; `DELETE /engine/connections/ora` closes the sessions
    (`select count(*) from v$session where username='MTK'` drops).
