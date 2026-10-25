# Remote traces: SSH (and Oracle)

How mtkprof reaches traces on other machines: the desktop engine's
connections (`/engine/connections`, `api/engine.openapi.yaml`) and the CLI
commands `mtkprof fetch` and `mtkprof follow`. Plan: `docs/PLAN-DESKTOP.md`
§ 2 "Remote" and § 6. This file covers SSH (work package E7); the Oracle
part (E8: grants, `V$DIAG_*` findings) is added by that package.

## Security stance

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

## Transports

`internal/remote/sshconn` picks one per connection (`transport` field):

| transport | what | when |
|---|---|---|
| `cli` | the system `ssh`/`sftp` (`internal/remote/sshcli`) | `auto` with `ssh` on `PATH` (Windows: also `%SystemRoot%\System32\OpenSSH`) |
| `lib` | `golang.org/x/crypto/ssh` + `github.com/pkg/sftp` (`internal/remote/sshlib`) | no ssh binary, forced, or after the askpass failure below |
| `auto` (default) | cli first; the first operation runs `Test`, and if ssh ignored `SSH_ASKPASS` the connection moves to lib for good (`active` in the connection info says which) | |

Both implement `remote.SSH`: `Test` (`uname -sr`), `Ls`, `Diag`, `Fetch`
(from a byte offset), `Follow` (tail -f), `Close`.

### cli: system binaries and the askpass bridge

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

### Windows askpass failure

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

### lib: Go library

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

## Remote commands and shell portability

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

## Fetch and follow

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

## Measurements (loopback, in-process server, this laptop)

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

## CLI

```
mtkprof fetch  oracle@dbmint:2200 /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_4711.trc -o traces/
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc -o live.trc     # Ctrl-C stops; rerun resumes
mtkprof follow oracle@dbmint:2200 /u01/.../cdb1_ora_4711.trc | less           # to stdout
```

Prompts go to the terminal (`/dev/tty`, `CONIN$`); with the cli transport
the CLI starts an in-process askpass bridge on 127.0.0.1 so ssh's prompts
reach the same terminal. `-transport lib` forces the Go library.
