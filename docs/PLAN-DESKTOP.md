# Desktop app: implementation plan

## Status and how to continue (2026-10-25, end of day)

**Done.** Phases 1–5 are implemented and merged in both repos, tagged
`v0.3.0` on both (`modern-tkprof` `53042d0`, `mtkprof-desktop` `834d7e4`,
submodule pinned to `53042d0`). Every package of § 8 (E1–E10, I1–I3, E7b,
U1, S1–S9, D1) has landed; status table, measured budgets, dbmint
verification and the open list live in `docs/HANDOFF.md` § "Desktop app v1";
user guide in `docs/DESKTOP.md`; remote details in `docs/REMOTE.md`.

**Verified.** Engine: `make test` green (Go + 92 web tests), cross-builds
(windows, aix, solaris, darwin, `CGO_ENABLED=0`); SSH and Oracle paths
against dbmint. Desktop: CI was green on all four legs through the S6 merge
(`6d23ea4`); the last three desktop commits (S7–S9 `904f0bf`, pins
`63564b5`, `834d7e4`) were refused by GitHub Actions ("recent account
payments have failed or your spending limit needs to be increased"). For
those, the CI steps were run locally instead: typecheck, 35 unit tests,
bundle, `check:deps`, `gen:api`, `cargo fmt --check`, engine build, and the
Linux Tauri build + `.deb` bundle inside Docker (image `mtk-ci:linux`, see
below) and the CI smoke test under Xvfb in the same container for `834d7e4`:
the app opened `io_waits.trc`, the simulated engine crash was followed by a
restart within 1 s and the trace re-opened from the cache (6 ms); the
screenshots matched the CI legs' earlier ones. Not run locally: the Windows
and macOS legs (impossible here) and the AppImage: linuxdeploy's static-pie AppImage runtime does not execute
at all inside Docker on this host (`cannot execute: required file not
found`, even with `/dev/fuse` and `APPIMAGE_EXTRACT_AND_RUN=1`); the
AppImage is produced only by the GitHub runner. macOS legs: built and
smoke-tested by hand on the MacBook on 2026-10-25 (both DMGs, arm64 smoke
passed; HANDOFF "Open"), recipe `docs/HANDOFF-macos-build.md` in the desktop
repo.

**Blocked on the user.**

1. ~~GitHub Actions billing~~ Decided: no GitHub Actions (cost). CI and
   releases run locally: `scripts/ci-local.sh` / `scripts/release-local.sh
   <tag>` in `modern-tkprof` and in `mtkprof-desktop`. Phase 6 = run those
   for `v0.3.0` (the desktop one uploads the installers as a prerelease).
2. `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev libgtk-3-dev patchelf`
   if `pnpm tauri dev` is wanted on this Linux box without Docker.
3. A Windows 11 machine for the `SSH_ASKPASS` / agent-pipe check
   (`docs/REMOTE.md` § Open).

**Local CI without GitHub (Linux leg).** Dockerfile at `/tmp/mtk-ci/`
(recreate: `FROM rust:1-bookworm`, apt `libwebkit2gtk-4.1-dev libgtk-3-dev
librsvg2-dev libayatana-appindicator3-dev patchelf file xvfb dbus-x11
x11-apps imagemagick xauth x11-xserver-utils`, nodesource node 22 +
`corepack prepare pnpm@10`). Run from the desktop clone:

```
docker run --rm -v $PWD:/src -v mtk-cargo-target:/cargo-target \
  -v mtk-cargo-registry:/usr/local/cargo/registry -e CI=true \
  -e CARGO_TARGET_DIR=/cargo-target \
  -e PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin -w /src mtk-ci:linux \
  bash -c 'pnpm install --frozen-lockfile && pnpm tauri build --target x86_64-unknown-linux-gnu --bundles deb --ci'
```

(`bash -lc` drops cargo from PATH in that image; pass PATH explicitly.) The
smoke step runs as `xvfb-run -a dbus-run-session -- bash scripts/smoke.sh
x86_64-unknown-linux-gnu <name>` with `src-tauri/target/<triple>` symlinked
to `/cargo-target/<triple>`.

**Next work, in order.** (a) Phase 6 once billing is restored. (b) The
deferred items in HANDOFF "Open" (none blocks v1). (c) Post-v1 backlog (§
"Post-v1 backlog" below). The orchestration pattern that worked: one
package per worktree branch, Opus 5.5 for E1/E2/E7/E8/S-shell packages,
Sonnet 5.5 for the rest, the integrator merges to `main`, `make test` green
before every merge (see `docs/PLAN-M1.md` rules).

Written 2026-10-25 after the architecture review; revised the same day after a
design interview (33 decisions, § 11). This is the handoff for implementation.
Read `docs/HANDOFF.md`, `docs/DESIGN.md` and `docs/ARCHITECTURE.md` first;
this file assumes them.

Two repositories:

- **`modern-tkprof`** (this repo): gains an engine mode (`mtkprof engine`), a
  persistent index cache, line drill-down, the remote fetchers and CLI
  subcommands for them. The CLI's existing commands stay as they are; every
  engine answer must equal the CLI's.
- **`mtkprof-desktop`** (new, private): the Tauri 2 shell, the desktop UI
  (today's `web/` views plus desktop-only views) and packaging. Pins this repo
  as a git submodule.

## 0. Decisions

| Decision | Choice | Why |
|---|---|---|
| Audience | internal team tool; private, unsigned GitHub releases; no updater (About shows the version and a link to the releases page) | a few colleagues; signing and update plumbing are not worth it yet |
| Platforms | Windows, macOS and Linux all first-class; Windows (WebView2) is tested first | the team's machines |
| Core | the existing Go packages, run as a sidecar process `mtkprof engine` | 19k golden-tested lines, ~340 MB/s parse, spill mode holds a 1 GB trace in 66 MB RSS with ~300 ms pivots. A Rust core would re-implement all of it for speed the GUI does not get from the parser. |
| Shell | Tauri 2 (Rust) around the React/TS UI, talking to the engine over loopback HTTP. Committed; no GPUI revisit. | days to a working app with every current view; heavy charts are canvas |
| Engine location | local only; no remote-engine-on-the-server mode | decided against; traces are fetched to the laptop |
| Size ceiling | 1–2 GB traces first-class | the team's traces; budgets in § 9 |
| Process model | one engine per app instance, N open traces ("sessions"), crash-isolated from the GUI | a bad parse must not take the window down |
| Storage | the engine always builds in aggregate + spill mode; the spill directory is a persistent index cache keyed by trace **content identity**, in the user cache dir, 20 GB LRU; bind values persisted (per-open redaction, wipe button) | one code path, size-independent RSS, instant reopen; moved or re-fetched files hit the cache |
| Timeline | no LOD tile pyramid; `/api/timeline` from the spill plus a 1024-bucket minimap in the document | at 2 GB the scan is sub-second; tiles were sized for 10 GB |
| Progress | counters (bytes, lines, statements) during parse; partial documents deferred | |
| Transport | HTTP/1.1 on `127.0.0.1:<ephemeral>`, bearer token from the environment, SSE for events | works everywhere without special cases; the web UI already speaks it |
| SSH | the system `ssh` / `sftp` binaries as subprocesses with an askpass bridge; `x/crypto/ssh` + `pkg/sftp` as the fallback (and for Windows prompts, § 6) | `~/.ssh/config`, bastions, agents and MFA for free |
| Oracle | pure-Go thin driver `sijms/go-ora/v2` behind an interface; username/password over TCP and TCPS only (no sysdba, wallet, Kerberos in v1) | no Instant Client to ship |
| Fetch paths | SSH and ADR views equal priority for fetch; live follow over SSH only; trace on/off via `DBMS_MONITOR` | |
| Secrets | never stored; prompted on use through one prompt mechanism (engine `prompt` events); connection definitions without secrets are an import/export JSON file, plus a watched team file | team sharing without a secret store |
| Window model | one window, session tabs; workspace restored on start | |
| Visual language | unchanged (IBM Plex, neutral chrome, hue for wait classes, facts only) | |
| UI source of truth | `web/` in this repo becomes a library (`web/src/lib`) used by the standalone shell (`web/src/app`) and the desktop repo; engine-dependent views are desktop-only | one copy of every shared view; `mtkprof html/serve` keep working |
| Protocol contract | OpenAPI 3.1 file `api/engine.openapi.yaml`, protocol version integer, TS client generated from it | a mismatch is detected at startup |
| Repos | separate desktop repo, submodule pin; desktop CI clones this private repo with a read-only deploy key held as a CI secret | one commit covers engine, protocol and shared UI |
| v1 cut | phases 1–5; phase 5 = report download, annotations and saved pivots, CLI fetch subcommands. Cross-trace compare is post-v1. | |
| Names | repo `mtkprof-desktop`, app id `com.davidbudac.mtkprof`, app name "mtkprof", Apache-2.0 | |

## 1. Target architecture

```
mtkprof-desktop (new repo)
  src-tauri/            Rust: spawn engine (externalBin), token, dialogs (file, prompts), recent, menus, single instance
  src/                  TS/React: workspace (session tabs), Lines, Connections, Prompts, Annotations, Settings, About
  engine/               git submodule -> modern-tkprof @ tag; builds the sidecar, imports web/src/lib
          |  http://127.0.0.1:<port>   Authorization: Bearer <token>   SSE /engine/events (job, session, prompt)
modern-tkprof
  cmd/mtkprof engine    control plane: sessions, jobs, cache, connections, prompts
  cmd/mtkprof askpass   SSH_ASKPASS helper: forwards ssh's prompt to the engine, prints the answer
  cmd/mtkprof fetch|follow|trace|ref -db   CLI subcommands over internal/remote (prompts on the terminal)
  internal/engine       server, session, job, cache, events, prompts
  internal/slice        /api/* (as today) + lines annot, lines/at, at, search
  internal/remote       sshcli (subprocess), sshlib (x/crypto fallback), db (go-ora), prompt interface
  internal/trace, model, analyze, report, ref   unchanged except the hooks listed below
```

Data flow for one trace: `POST /engine/sessions {paths}` → job `open`: cache
hit? load dimension tables + reopen spill files : parse (aggregate build with
`Spill` tee and progress hook) → write manifest → session `ready` → UI fetches
`/s/{id}/api/doc` (format 3, `slice: true`) and attaches a `RemoteSource` at
`/s/{id}/api/`. Everything the views ask goes to the same handlers
`serve -spill` uses today.

## 2. Engine protocol v1

Process:

```
mtkprof engine [-listen 127.0.0.1:0] [-cache DIR] [-allow-origin O,...] [-idle-exit DURATION]
  token: env MTKPROF_TOKEN (required; 32+ bytes); stdout, once ready, one line:
  {"ready":true,"addr":"127.0.0.1:41233","version":"v0.3.0","protocol":1}
  exits when stdin closes (parent gone) unless -detach
```

Every request except `GET /engine/health` needs `Authorization: Bearer
<token>`. CORS: only the origins in `-allow-origin` (the shell passes
`tauri://localhost`, `http://tauri.localhost`; dev adds `http://localhost:5173`).
Errors: `{"error": {"code": "bad_request|not_found|conflict|cancelled|needs_prompt|internal", "message": "..."}}`
with the matching HTTP status. Every list is bounded; limits are the ones in
`internal/slice`.

### Control plane

| method, path | body / params | answer |
|---|---|---|
| `GET /engine/health` | | `{version, protocol, uptime, sessions, cache:{bytes, entries, cap}}` |
| `GET /engine/events` | SSE | `job` (`{id, kind, state, phase, done, total, unit, message}`), `session` (`{id, state, rev}`), `prompt` (`{id, connection, kind:"password\|passphrase\|otp\|hostkey\|confirm", text, echo}`), `log` |
| `POST /engine/prompts/{id}` | `{answer}` or `{cancel:true}` | answers a prompt raised by ssh, the Go SSH fallback, or a DB connect |
| `POST /engine/sessions` | `{paths:[], options:{follow:true, binds:"keep\|redact\|none", salt, thresholds}}` | `{session, job}`; states `opening → ready \| failed`, `live` while following |
| `GET /engine/sessions`, `GET /engine/sessions/{id}` | | `{id, paths, state, rev, identity, files:[...], opened, bytes, lines}` |
| `DELETE /engine/sessions/{id}` | | closes, keeps the cache |
| `GET /engine/jobs`, `DELETE /engine/jobs/{id}` | | list / cancel (`context.Context` per job) |
| `GET /engine/cache`, `DELETE /engine/cache/{identity}`, `DELETE /engine/cache` | | entries with size, last use, source paths; wipe one or all |

### Per session, mounted at `/s/{id}/`

Existing (unchanged handlers): `api/doc`, the 13 endpoints of
`internal/slice` (`pivot timeline calls executions executions/detail waits
waits/hist waits/scatter waits/by profile stmt/roles stmt/waits stmt/spans`),
`api/lines?file&from&n`.

New:

| path | answer |
|---|---|
| `api/doc?rev=` | the document; `rev` increments when ref data is applied or a live session advances; `stats.minimap` carries 1024 buckets of CPU and wait time per class over the whole span (from the accumulator's timeline) |
| `api/lines?...&annot=1` | JSON `{from, total, lines:[{t, k}]}`; `k` is the parser's line kind (`trace.Kind`) |
| `api/lines/at?file&tim=` | first line whose record has `tim >= tim` (binary search over the call rows of that file, then over waits) |
| `api/at?file&line=` | the model objects at or before that line: `{call, stmt, cursor, execNo, wait, bindSet, ctx, planLine}`; `None` where absent |
| `api/search?file&q&regex=0\|1&case=0\|1&from&limit` | NDJSON stream of `{line, col, text}` then `{done:true, scanned, truncated}`; literal search via `bytes.Index` chunked scan, regex via `regexp` on line boundaries; cancelable |
| `api/plan?stmt\|sql_id&plh&exec` | `report.PlanRows` for one STAT dump (what `mtkprof plan` prints) |
| `POST api/ref` | `{dir}` or `{connection}`; job; on success `model.ApplyRef`, `rev++` |
| `api/report?format=text\|json\|csv\|html&execs=&...` | the CLI's outputs for this session (download); `html` is the standalone report |

### Remote

Connections carry no secrets at rest. The shell keeps the definitions (`id,
name, kind, host, port, user, service, adrHome, notes`) in its store and in the
import/export file; the engine receives a definition with
`POST /engine/connections`, and whenever a credential is needed it raises a
`prompt` event that the shell answers. Credentials live in engine memory for
the connection's lifetime (until `DELETE` or exit) so one session of work
prompts once per connection.

| path | body / answer |
|---|---|
| `POST /engine/connections` | `{id, kind:"ssh"\|"db", host, port, user, service?, adrHome?, transport:"auto\|cli\|lib"}` |
| `DELETE /engine/connections/{id}`, `POST .../test` | `test` connects (prompting as needed) and reports server version |
| `GET /engine/connections/{id}/ls?path` | directory listing (ssh: `sftp -b` batch `ls -l`, parsed from OpenSSH's own client format) |
| `GET /engine/connections/{id}/diag` | candidate trace directories: `$ORACLE_BASE/diag/rdbms/*/*/trace` via `ls`, or `V$DIAG_INFO` for a db connection |
| `POST /engine/connections/{id}/fetch` | ssh `{paths:[], gzip:true}` → job → `{localPaths}` under `<cache>/remote/<conn>/`; streamed with `ssh host 'tail -c +N -- path'` (piped through `gzip -c` when the host has it), resumable at byte N; db `{adrHome, name}` → job reading `V$DIAG_TRACE_FILE_CONTENTS` by `LINE_NUMBER` in 50 000-row chunks, resumable by line |
| `POST /engine/connections/{id}/follow` | ssh only: `{path}` → a `live` session fed by `ssh host 'tail -c +N -f -- path'` into the streaming parser; `rev++` per settled batch; `DELETE` the session stops it |
| `GET /engine/connections/{id}/tracefiles?sid&serial&since` | `V$DIAG_TRACE_FILE` joined with `V$PROCESS.TRACEFILE` / `V$SESSION` |
| `GET /engine/connections/{id}/sessions` | `V$SESSION` rows for picking what to trace |
| `POST /engine/connections/{id}/trace` | `{sid, serial, enable, waits:true, binds:true, planStat:"all_executions"}` → `DBMS_MONITOR.SESSION_TRACE_ENABLE/DISABLE` |

Unknown SSH host keys surface as a `hostkey` prompt with the fingerprint; the
answer is written to the user's `known_hosts` only when they confirm. Nothing
from a prompt answer is written to disk or logs.

### Contract

`api/engine.openapi.yaml` describes every endpoint above and the existing
slice endpoints. `internal/engine/contract_test.go` walks the mux and fails
when a route is missing from the schema or vice versa. The desktop repo
generates its client with `openapi-typescript` from the submodule's file.
`protocol` increments on any breaking change; the shell refuses to start an
engine whose `protocol` it does not know.

As built (phase 1, protocol 1; the YAML is authoritative):

- Lists are wrapped: `{sessions:[…]}`, `{jobs:[…]}`; `GET /engine/cache` is
  `{bytes, entries, cap, items:[{identity, bytes, created, lastUsed, paths, open}]}`;
  `DELETE /engine/cache` answers `{removed, skipped, bytes}` (open entries
  are skipped); `DELETE /engine/cache/{identity}` is 204, 404, or 409 while
  a session has it open.
- `POST /engine/sessions` is 202 `{session, job}`; `DELETE /engine/jobs/{id}`
  202 `{job}` (409 when finished); `DELETE /engine/sessions/{id}` and
  `POST /engine/prompts/{id}` 204.
- Session: `identity` is the content identity without options (annotations);
  `cacheIdentity` is the cache entry (the `{identity}` of `/engine/cache`);
  `hit`; `job` (the open job) and `error` when failed. Job: `session`,
  `lines`, `statements`; phases `open` → (`parse` bytes → `index`, miss only)
  → `ready`. Prompt events carry `state: open|closed`.
- Error codes add `unauthorized` (401); `needs_prompt` is 428, `cancelled`
  409. The slice endpoints keep their plain-text 400s.
- The event stream needs the bearer token: read it with `fetch`, not
  `EventSource`.
- Lines API (E6): `api/lines`, `lines/at`, `at`, `search` are the handlers of
  `slice.Server.WithLines`, unchanged (plain-text 400/404, NDJSON `search`
  with its final `{done, scanned, truncated}`); `mtkprof serve` serves them
  in its slicing modes too.
- `api/plan?stmt=<id>|sql_id=<sql_id>[&plh=<hash>][&exec=<n>]` (in
  `internal/slice`, so `serve` has it): `mtkprof plan` as compact JSON
  (`report.SelectPlans`, `PlansJSON`). With `plh` the row array of one dump,
  `exec` the 1-based dump of that hash (default the latest); without `plh`
  the array for a statement with one plan hash, else `{"<hash>": rows}`. 400:
  no/both of `stmt`/`sql_id`, bad id, `plh` or `exec`; 404: unknown `sql_id`,
  no STAT plan, unknown hash or dump.
- `api/report?format=text|json|csv|html` (E10, `internal/engine/report.go`):
  attachment named after the first input. `text` is `report.Text`
  (`sort top execs binds sys width`, the CLI's defaults) of the session's
  aggregate model, i.e. `mtkprof report -aggregate`: no executions tables,
  and the Volume line counts 0 bind sets (they are in the spill). `json` is
  `report.JSON` with `Facts:false, Packed:false` and the engine's plan viz URL
  (`engine -plan-viz-url`, default the CLI's). `csv` is a zip of the files
  of `mtkprof export` (`report.ExportCSVZip`; calls, waits, binds read from
  the spill, byte-equal to the CLI's). `html` is `ui.WriteStandalone` over the
  packed document without facts (`Slice:false`). Parameter errors are 400
  envelopes. Tests compare bytes with the CLI paths on `basic_binds` and
  `io_waits`.
- `mtkprof engine -cache-cap 20G`; `mtkprof engine cache ls|rm|wipe`.
- Live sessions: `options.follow` (one local file) and
  `POST /engine/connections/{id}/follow {path, options, mirrorOnly}` →
  202 `{session, job, localPath}` (the job is E7's mirror; `mirrorOnly`
  answers without a session). Options `batchMs` (default 1000) and
  `batchMB`; state `live`; job kind `live`; `api/doc` sends `X-Rev` and
  long-polls on `?rev=` (25 s). Snapshot = deep copy of builder +
  accumulator finished at a line boundary, spilled to `<cache>/live/`
  (ARCHITECTURE § Engine mode, "Live sessions").

## 3. Persistent index cache

Directory `<cache>/mtkprof/index/<identity>/` where `<cache>` is
`os.UserCacheDir()` (override `-cache`, setting in the app) and

```
identity(file) = sha256(size ‖ first 1 MiB)          per input file
identity(set)  = sha256(sorted file identities ‖ index format ‖ bind mode ‖ salt hash)
```

so a trace that was moved, renamed or fetched again hits the cache, and
annotations (§ 7) use the same `identity(file)`/`identity(set)` without the
options. `slice.SpillKey` (path, size, mtime) is replaced by this.

Contents:

```
manifest.json        engine version, index format, protocol, inputs (named file identities), source files (abs path, size, mtime, identity), options, created, lastUsed, bytes, file sizes
dims.bin             model.Model without the fact tables and Agg (statements, cursors, contexts, events, plans, transactions, errors, File, Diag)
agg.bin              the analyze.Accumulator (Model.Agg) the document and text report are computed from
calls.bin waits.bin bindsets.bin binds.bin bindvals.bin calls.stmt waits.stmt   today's spill files, unchanged layout
spill.idx            what the spill kept in memory: row counts, statement index layout, context row ranges
lines-<i>.idx        trace.LineIndex checkpoints per input file (today rebuilt on every serve)
```

As built (E2): the options in the identity are bind mode, salt hash, the
finding thresholds (they shape the aggregates) and NoFollow; the model is
stored before `ApplyRef` (applied after every load); API in the
`internal/engine` package comment.

Work:

- `internal/model/persist.go`: `Encode(w, m)` / `Decode(r)` of the dimension
  tables. Versioned, explicit binary (not gob: unexported fields in
  `FileEntry`, and gob's type descriptors make the format fragile). Round-trip
  test over every fixture: the document bytes of the decoded model equal the
  original's.
- `trace.LineIndex`: `Save(w)` / `Load(path, r)`; keep the stride constant in
  the file header.
- `slice.Spill`: `SpillOptions.Persist bool` and a fixed `Dir`; `Close` keeps
  the files when persisted; `OpenSpill(dir, m)` returns the `FactSource`
  without writing. `RemoveStale` stays for the temp case (`serve -spill`).
- `internal/engine/cache.go`: lookup by identity, manifest validation (format
  and options must match, else rebuild), LRU eviction by bytes (default cap
  20 GB), wipe, `mtkprof engine cache ls|rm|wipe` CLI for support.
- Bind values: persisted as parsed; `options.binds=redact|none` at open
  redacts or drops them in the spill and in the document (today's
  `-bind-values` / `-binds none` post-pass applies before spilling via the
  `BindSink`, as `serve -spill` does). Directory mode 0700.
- Live (`follow`) sessions are not cached: a growing file has no stable
  identity. When the follow stops the session may be re-opened normally.
- Parity test `TestCacheRoundTrip` (extends `TestSpillAllFixtures`): for every
  fixture, build → persist → reopen → every slice endpoint answers
  byte-identically to the in-memory source.
- The engine never uses `MemSource`: one path. If disk pivots on small traces
  ever feel slow, add a `memSource` loaded *from* the spill files, not a
  second build path.

## 4. Minimap

The accumulator already keeps a timeline (`analyze.Accumulator.tl`). At
`Finish` it is reduced to 1024 buckets of CPU µs and wait µs per wait class
and written into the document as `stats.minimap` (`{bucketUs, cpu:[],
waits:{<class>:[]}}`). The UI draws it as the overview strip and as the
zoom-out context of the Timeline view; any zoomed range still asks
`/api/timeline` (sub-second at 2 GB from the spill). No tile pyramid.

## 5. Line drill-down

Engine side is § 2 (`lines annot`, `lines/at`, `at`, `search`). Notes:

- `at` works per file: calls of one file are contiguous rows in `calls.bin`
  and in line order (`Call.Line`), so a binary search over the file's row
  range finds the enclosing call; waits likewise; cursors from
  `Statement`/`Cursor.Line`; bind sets from `BindSet.Line`.
- `lines/at?tim` uses the same rows the other way (`Call.Tim`, `Wait.Tim`).
- `lines?annot=1` runs `trace.Classify(line) Kind` per returned line (factor
  the kind detection out of `Parser.processLine` into a pure function; the
  only state is "inside SQL text", which the annotation may get wrong for
  text lines and marks as `KindText`).
- `search` scans the file in 4 MB chunks with overlap for line boundaries;
  literal mode uses `bytes.Index`, regex mode `regexp` applied per line;
  streams hits as they are found; honours the request context.

UI (desktop repo, reusing `web/src/lib`): a **Lines** view (full tab, in
addition to today's drawer): virtualized viewer with page cache and prefetch,
kind colouring, gutter marks for the selected statement's calls and waits,
click a line → `at` → highlight the statement/execution in the sidebar; every
table row keeps its "show in trace" link (`line` + `ctx` → file); search box
with literal/regex toggle and a hit list; bookmarks (an annotation kind, § 7);
jump to time (`lines/at`).

## 6. Remote fetch

### Prompts

`internal/remote.Prompter` is one interface (`Ask(ctx, Prompt) (string,
error)`) with three implementations: the engine's (raises a `prompt` SSE
event, blocks until `POST /engine/prompts/{id}` or cancel), the CLI's
(terminal, `golang.org/x/term`), and a test fake. Every credential, OTP,
host-key confirmation and DB password goes through it. No implementation
stores anything.

### SSH, system binaries (`internal/remote/sshcli`)

- Locate `ssh` and `sftp` on `PATH` (Windows: `%SystemRoot%\System32\OpenSSH`
  too). Spawn with `SSH_ASKPASS=<path of this mtkprof binary>`,
  `SSH_ASKPASS_REQUIRE=force`, `MTKPROF_ENGINE=<addr>`,
  `MTKPROF_TOKEN`, `MTKPROF_PROMPT_CONN=<id>`, `-o BatchMode=no`, no tty.
- `mtkprof askpass "<prompt text>"` posts the prompt to the engine
  (`POST /engine/askpass` → `prompt` event → waits for the answer), prints it
  on stdout. ssh asks for passwords, passphrases, OTPs and host-key
  confirmation through the same path.
- Listing: `sftp -b -` with `ls -l path`; parsed from OpenSSH's client-side
  format (stable across the remote OS, unlike remote `ls`). Reads: `ssh host
  'tail -c +N -- path'` for fetch and `tail -c +N -f -- path` for follow;
  `gzip -c` in the pipe when `command -v gzip` succeeds on the host. All
  remote commands are POSIX `sh`, tested against AIX and Solaris syntax.
- Known limitation: Windows 11's bundled `ssh.exe` is reported to ignore
  `SSH_ASKPASS` (Win32-OpenSSH issue #2115). The engine detects "ssh exited
  asking for a password without calling askpass" and retries that connection
  with the library transport below; the connection remembers
  `transport=lib` for the rest of the run. Verify on a Windows 11 machine in
  phase 4 and record the result in `docs/REMOTE.md`.

### SSH, library fallback (`internal/remote/sshlib`)

`golang.org/x/crypto/ssh` + `github.com/pkg/sftp`: agent (`SSH_AUTH_SOCK`;
Windows OpenSSH agent named pipe), key files (passphrase via `Prompter`),
password and keyboard-interactive (via `Prompter`), `known_hosts` with the
`hostkey` prompt. Used when no `ssh` binary exists, when `transport=lib` is
forced, or after the Windows askpass failure above. Same fetch/follow
semantics (`Seek` + read loop over SFTP).

### Oracle (`internal/remote/db`)

`database/sql` with `sijms/go-ora/v2` behind an interface so
`oracle/go-oracledb` can replace it when out of beta. Username/password over
TCP or TCPS (Easy Connect `host:port/service`), password via `Prompter`.

- list: `V$DIAG_TRACE_FILE` (12.2+), `V$PROCESS.TRACEFILE` joined to
  `V$SESSION`, `V$DIAG_INFO` for the ADR home.
- fetch: `SELECT payload FROM v$diag_trace_file_contents WHERE adr_home=:h AND
  trace_filename=:f AND line_number BETWEEN :a AND :b ORDER BY line_number`,
  chunks of 50 000 rows, progress per chunk, resumable by line; the UI warns
  above ~200 MB and suggests SSH.
- trace control: `DBMS_MONITOR.SESSION_TRACE_ENABLE(sid, serial, waits=>true,
  binds=>true, plan_stat=>'ALL_EXECUTIONS')` / `SESSION_TRACE_DISABLE`.
- ref bundle: the queries `report.RefScript` prints, executed directly and
  written into the session's cache dir in the layout `internal/ref/bundle.go`
  reads; then `model.ApplyRef`. Refactor `internal/report/refscript.go` so the
  SQL text per query is a Go value both the script writer and the fetcher use.
- Privileges: the connecting user needs `SELECT` on the `V$DIAG_*` views and
  `V$SESSION`/`V$PROCESS` (`SELECT_CATALOG_ROLE` covers them) and `EXECUTE ON
  DBMS_MONITOR`. No sysdba in v1; document a grant script in `docs/REMOTE.md`.

Verify on dbmint first (`dbmint-oracle-test` skill): which `V$DIAG_*` a
PDB-local user sees, the grants above, and throughput of
`V$DIAG_TRACE_FILE_CONTENTS` on a 100 MB trace. Record in `docs/REMOTE.md`.

As built (E7, E8, E9; `docs/REMOTE.md` is authoritative):

- ssh connections (E7): `Prompter` (engine, terminal, fake), askpass bridge,
  `sshcli`, `sshlib`, `sshconn` (auto/cli/lib), jobs `fetch` (bytes) and
  `follow` (a file mirror; the live session is E7b, in progress).
- db connections (E8 in the engine, `internal/engine/connections_db.go`):
  `test`, `diag`, `tracefiles`, `sessions`, `trace` and the `fetch` job
  (unit lines, resumed by counting the complete lines of the partial local
  file) next to the ssh routes of the same names; `tcps` / `tlsSkipVerify`
  on the definition. The password is asked once per connection through the
  engine prompts and kept in memory; long jobs use database sessions of their
  own. The SSH-only routes (`ls`, `follow`) answer 400 for a db connection.
- Reference data: `POST /s/{id}/api/ref {dir}` or `{connection, lite}` (job
  kind `ref`) keeps the bundle at `<cache>/ref/<trace identity>/`, applies it
  to the session's model (`ApplyRef` now replaces an earlier bundle), bumps
  the session's `rev` and `api/doc` serves the new document (`?rev=` is still
  ignored). Opening the same trace again applies the kept bundle. A failed
  reference query is skipped and named in the job message.
- CLI (E9): `fetch -db` is part of `mtkprof fetch`; `remote.TerminalPrompter`
  is the only terminal prompter (one line of stdin per question when stdin is
  a pipe).
- Not verified (needs dbmint, checklist at the end of `docs/REMOTE.md`): every
  real-database behaviour (PDB visibility, `V$DIAG_TRACE_FILE_CONTENTS` line
  semantics and throughput, TCPS), real OpenSSH/Windows behaviour.

### CLI subcommands (same packages, terminal prompts)

`mtkprof fetch <conn-spec> <remote-path>... [-o dir]`, `mtkprof follow
<conn-spec> <remote-path> | mtkprof report -` (streams), `mtkprof trace
<db-spec> -sid S -serial N -on|-off`, `mtkprof ref -db <db-spec> <trace>
[-o dir]`. `<conn-spec>` is `user@host[:port]` for ssh and
`user@host:port/service` for db; passwords are prompted, never flags. The
CLI's existing commands stay offline.

## 7. Shell (Tauri 2) and desktop UI

Repo `mtkprof-desktop` (private, Apache-2.0).

```
src-tauri/        tauri.conf.json: externalBin ["binaries/mtkprof-engine"] (the mtkprof binary renamed, built by `pnpm build:engine` from the submodule; runs as `mtkprof-engine engine`), CSP connect-src 127.0.0.1:*
                  commands: engine_start (random token → env, parse ready line, health check), engine_restart,
                  pick_files, recent files, window state, open_releases_page
                  plugins: shell, dialog, fs (scoped), store, window-state, log, process, single-instance
                  no keychain, no updater
src/              App shell: session tabs, open/progress, Lines, Connections, Prompts, Annotations, Settings, About
engine/           submodule modern-tkprof; `pnpm build:engine` cross-compiles cmd/mtkprof for the host; CI builds the 3 targets
```

UI work in this repo (so both shells share it):

- Split `web/src` into `lib/` (data, views, components, styles) and `app/`
  (the standalone shell: `main.tsx`, `App.tsx`, `TopBar.tsx`, `urlstate.ts`).
  `lib/index.ts` exports the views, `DataSource`, loaders and the store.
- `attachRemote(doc, apiBase)` already takes a base; make `fetchLines`,
  `probeLines` and `planviz` take the base and an optional auth header from a
  small `ApiClient` (`lib/data/client.ts`: base URL, bearer token, `fetch`
  wrapper with `AbortSignal`). The standalone app uses an unauthenticated
  relative client.
- A `SessionProvider` context (desktop) instead of the single global document.
- `stats.minimap` rendering in the Overview strip and Timeline context (both
  shells).

Desktop-only views:

- **Workspace**: tabs, recent, drag-drop files or a directory; restored on
  start from the cache (a "start empty" setting); live sessions are not
  restored.
- **Open progress**: bytes, lines, statements so far, cancel.
- **Lines** (§ 5).
- **Connections**: list, add/edit (no secret fields), test, browse (`ls`,
  `diag`), fetch with progress, follow (live badge, auto-refresh on `session`
  events), DB sessions list with trace on/off, "fetch reference data".
  Import/export of all definitions as JSON; a configured **team file** path
  (e.g. in a shared repo checkout) is watched and merged read-only.
- **Prompts**: modal driven by `prompt` events (password, passphrase, OTP,
  host-key with fingerprint, confirm); cancel propagates.
- **Annotations**: notes on statements, executions, time windows and lines
  (bookmarks), per trace, keyed by content identity, stored in the app data
  dir (`store` plugin); Markdown and JSON export, JSON import. **Saved pivots
  and filters** are a global library (dims, measures, scope rules), exported
  with the same mechanism as connections.
- **Reports**: download text / JSON / CSV / standalone HTML of a session
  (`api/report`).
- **Settings**: cache location and cap, wipe cache, team connections file,
  plan viz URL, theme, engine path/version. **About**: version, protocol,
  link to the releases page.

## 8. Phases and work packages

Rules as in `docs/PLAN-M1.md`: each package on its own branch, `make test`
green before merge, additive edits only in shared files (`cmd/mtkprof/main.go`,
`internal/slice/slice.go`, `web/src/lib/data/types.ts`), new code in new
files, UI verified by screenshot on Windows first, then macOS and Linux.
Engine answers must stay equal to `serve -spill` (parity test) and the golden
test must stay green. v1 is tagged when phases 1–5 are done; phase 6 is the
release mechanics.

### Phase 1: engine mode (this repo)

| Pkg | Scope | Files | Done when |
|---|---|---|---|
| E1 engine server | `mtkprof engine`: listen, token, origins, health, events (SSE), sessions, jobs with `context` cancellation, prompts plumbing (`prompt` event + `POST /engine/prompts/{id}`), per-session mount of the existing slice mux + `lines` + `doc`; ready line on stdout; exit on stdin EOF | `internal/engine/{server,session,job,events,prompts}.go`, `cmd/mtkprof/engine.go` | two sessions open at once, each answering `/s/{id}/api/*` byte-identical to `serve -spill`; cancel mid-parse frees everything; `httptest` coverage |
| E2 persistent cache | § 3: content identity, `model.Encode/Decode`, `LineIndex.Save/Load`, `Spill.Persist`, `OpenSpill`, manifest, LRU, wipe, `engine cache` CLI | `internal/model/persist.go`, `internal/trace/lineindex.go`, `internal/slice/spill.go`, `internal/engine/cache.go` | `TestCacheRoundTrip` green on every fixture; a 2 GB trace reopens in < 2 s |
| E3 progress + minimap | `model.Options.OnProgress(bytes, lines, statements)` from the builder every 64 MB; job events carry it; `stats.minimap` from the accumulator (§ 4) | `internal/model/builder.go` (hook only), `internal/analyze/accum.go`, `internal/report/doc.go` | progress events on a 1 GB trace; minimap sums equal `/api/profile` totals |
| E4 contract | `api/engine.openapi.yaml`, `contract_test.go`, error envelope, `protocol` constant | `api/`, `internal/engine/contract_test.go` | test fails on an undocumented route |
| E5 docs | ARCHITECTURE § Engine, HANDOFF | `docs/` | |

E1 and E2 run in parallel (E1 starts on temp spill, switches to the cache
when E2 lands). E3 and E4 after E1.

### Phase 2: shell bootstrap (desktop repo) and UI library split (this repo)

| Pkg | Scope | Done when |
|---|---|---|
| U1 lib split | `web/src/lib` + `web/src/app`, `ApiClient`, `SessionProvider`-ready store, minimap strip; `make web` unchanged | `pnpm typecheck`, vitest, standalone HTML and `serve` unchanged (screenshot) |
| S1 repo | `mtkprof-desktop`: Tauri 2 scaffold, submodule (read-only deploy key as CI secret), engine build script, CI matrix (windows x64, macos arm64+x64, linux x64), unsigned installers (NSIS, DMG, AppImage + deb) as private release assets | app opens on all three |
| S2 engine lifecycle | spawn with token, parse ready line, health poll, restart on crash with a toast, exit on quit; `protocol` check | kill -9 the engine → "engine restarted", sessions re-open from cache |
| S3 workspace | open file(s)/directory, recent list, session tabs, progress panel with cancel, restore on start, every current view bound to `/s/{id}/api/` | open two traces, switch tabs, close one, restart → both back |
| S4 settings + about | cache location/cap/wipe, plan viz URL, theme; About with version, protocol, releases link | |

### Phase 3: line drill-down

| Pkg | Scope | Done when |
|---|---|---|
| E6 lines API | `lines annot`, `lines/at`, `at`, `search` (§ 5), `trace.Classify` | unit tests on fixtures: `at` returns the call that `Call.Line` says; search finds every `WAIT #` line of a fixture; a cancelled search stops within 100 ms |
| S5 Lines view | § 5 UI; "show in trace" from every row opens the Lines view at the line with the object highlighted | screenshot on all three OSes; a 2 GB trace scrolls smoothly in WebView2 |

### Phase 4: remote

| Pkg | Scope | Done when |
|---|---|---|
| E7 prompts + ssh | `Prompter`, `mtkprof askpass`, `sshcli` (ls, diag, fetch with resume and gzip, follow), `sshlib` fallback, Windows askpass detection | integration test against dbmint (`ssh -p 2200 oracle@dbmint`): fetch a fixture, compare sha; follow a trace while `run_gen.sh` writes it; password prompt round-trips through the event |
| E8 db | § 6 db: go-ora, tracefiles, sessions, fetch via ADR view (resumable), trace enable/disable, ref fetch + apply; `docs/REMOTE.md` with grants and findings | integration test on dbmint PDB1: list this session's trace, enable trace, run a statement, fetch, open; the applied ref bundle equals `-ref` of a `refscript` run |
| E9 CLI subcommands | `fetch`, `follow`, `trace`, `ref -db` over `internal/remote` with the terminal `Prompter` | `mtkprof fetch` and `follow` work against dbmint; `make release` still cross-compiles everything (no cgo) |
| S6 connections UI | connections (no secrets), prompts modal, remote browser, fetch with progress, follow (live badge), DB sessions + trace on/off, "fetch reference data", import/export, team file watch | screenshots; Windows 11 askpass behaviour recorded |

### Phase 5: analysis extras (v1 completes here)

| Pkg | Scope | Done when |
|---|---|---|
| E10 report endpoint | `api/report` text/JSON/CSV/HTML from the session | outputs byte-equal to the CLI on fixtures |
| S7 reports UI | download buttons, "open standalone HTML" | |
| S8 annotations | notes on statements/executions/windows/lines, per trace by content identity, app data store, Markdown + JSON export, JSON import | re-fetch the same trace under another name → notes present |
| S9 saved pivots/filters | global library, apply to any session, export/import with connections | |
| D1 docs | `docs/DESKTOP.md` user guide (install, SmartScreen/Gatekeeper bypass, connections, team file, cache), `docs/REMOTE.md` | |

### Phase 6: release

Unsigned installers published to the private desktop repo's releases by its local
release script (no GitHub Actions) on
tags; release notes template; both repos tagged together; the About link.
No updater, no signing.

### Post-v1 backlog

Cross-session compare (`/engine/compare`, A/B executions across traces),
partial documents during parse, in-memory fact source loaded from the spill,
detachable windows, wallet / sysdba authentication, LOD tiles if zooming ever
needs them, `oracle/go-oracledb` once stable, publishing the repos.

## 9. Budgets (measure, do not guess)

| | target |
|---|---|
| reopen a cached 2 GB trace | < 2 s to `ready` |
| fresh open, 1 GB | parse at today's speed; progress event every 64 MB |
| pivot on 1 GB / 2 GB spill | ≤ 300 ms / ≤ 600 ms |
| `api/lines` page (2000 lines) | < 20 ms |
| literal search, 2 GB | < 5 s, first hit < 100 ms |
| follow latency (line written on the host → visible) | < 2 s |
| SSH fetch | line speed; resume after a dropped connection without re-reading |
| UI pan/zoom on the minimap and Timeline | 60 fps on WebView2; no jank on WKWebView / WebKitGTK |
| engine RSS idle, 2 GB trace open | < 300 MB |

## 10. Risks

- **Windows askpass**: `ssh.exe` on Windows 11 may ignore `SSH_ASKPASS`; the
  library fallback covers it but must be verified on a real machine early in
  phase 4.
- **Three webviews**: WebView2 (Chromium), WKWebView and WebKitGTK differ;
  heavy views are canvas, never DOM per point; screenshot all three per phase.
- **Unsigned builds**: SmartScreen and Gatekeeper warnings on every install;
  document the bypass; revisit signing if the team grows.
- **No stored secrets**: a DB password is prompted once per connection per
  app run; ssh with keys/agent avoids prompts. Document it so it is not
  mistaken for a bug.
- **Model persistence** must be versioned from day one; a format bump
  invalidates the cache (rebuild, never crash).
- **`V$DIAG_TRACE_FILE_CONTENTS`** is slow and may not show CDB-level traces
  to a PDB user; the UI steers large files to SSH.
- **Remote shell portability**: `tail -c +N`, `gzip -c`, `command -v` must
  behave on AIX and Solaris `sh`; test on dbmint (Linux) and read the AIX/Solaris
  man pages before relying on anything else.
- **Two repos in lockstep**: the submodule pin, the deploy key and the
  `protocol` check are the only guards; release both from the same tag.
- **go-ora** is community-maintained; keep the driver behind an interface.

## 11. Decision log (interview of 2026-10-25)

1. Audience: internal team tool. 2. OS: Windows, macOS, Linux all first-class.
3. Standalone UI: shared core views, engine-dependent views desktop-only.
4. Engine: local only, no remote-engine mode. 5. SSH: system ssh, Go fallback.
6. Fetch: SSH and ADR equal. 7. Oracle auth: user/password over TCP and TCPS
only. 8. Trace on/off and live follow in phase 4. 9. Size ceiling 1–2 GB.
10. Binds persisted, per-open redaction, wipe button. 11. Cache in the user
cache dir, 20 GB LRU. 12. Progress bar first; partial documents deferred.
13. Always spill. 14. Must-haves: line drill-down, trace on/off, live follow +
fetch. 15. One window with tabs. 16. Visual language unchanged. 17. Submodule.
18. Tauri committed, no GPUI revisit. 19. No stored secrets; prompt on use.
20. Default names and Apache-2.0. 21. Private unsigned GitHub releases.
22. `SSH_ASKPASS` bridge. 23. Follow over SSH only. 24. Tiles dropped,
minimap instead. 25. First release after phase 5. 26. Connections import/export
file and team file. 27. CLI fetch subcommands after the engine (in v1, phase 4).
28. Workspace restored on start. 29. No updater; About shows version and link.
30. Phase 5 = report download, annotations + saved pivots, CLI subcommands;
cross-trace compare post-v1. 31. Read-only deploy key; repo stays private.
32. Annotations in app data keyed by content identity, export/import.
33. Saved pivots and filters as a global library.
