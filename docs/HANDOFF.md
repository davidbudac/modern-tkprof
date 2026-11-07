# Handoff — state of mtkprof on 2026-11-07

Read this, then `docs/DESIGN.md` (the decisions), `docs/ARCHITECTURE.md` (how the code is shaped) and
`docs/trace-format-19c.md` (what the parser must accept). Desktop: `desktop/CLAUDE.md`, the user guide
`docs/DESKTOP.md`, the remote part `docs/REMOTE.md`. Longer tail: `docs/ROADMAP.md`.

This file holds the current state and what is open. The history (dated round-by-round entries, the desktop
package table, the two-repo workflow, milestones 1 to 6) was pruned on 2026-11-07; older plans cite those
sections, read them with `git show 27932c3:docs/HANDOFF.md`. Per-round detail is also in the plans' logs
(`docs/PLAN-*.md`, `desktop/docs/PLAN-*.md`) and the release notes (`docs/releases/`).

## Where things stand

- `davidbudac/modern-tkprof` is **public**, `main` pushed. One repository, two clients (since 2026-11-02;
  `davidbudac/mtkprof-desktop` is archived): engine + CLI at the root, `web/` (CLI UI and the shared lib
  `web/src/lib`), `desktop/` (Tauri 2). One version and one tag for both.
- Latest release **v0.5.0** (2026-11-02, from `202d152`): CLI binaries (+ `-lite` builds) and the desktop
  installers (DMG arm64/x64, deb, AppImage, NSIS) in one GitHub release; notes `docs/releases/v0.5.0.md`.
  Everything after it (three new views, Lines colour-by / Δ filter, formatted view round 2, the open-list
  round, the Trace pane's round 3) is unreleased.
- Website `site/` is published on GitHub Pages (https://davidbudac.github.io/modern-tkprof/) with
  `scripts/publish-site.sh`; `gh-pages` matches `site/` as of `85d2c95`. Ask before publishing again.
- The plan visualizer (`~/claude_projects/ora_explain_plan_viz`) is pushed, `@davidbudac/ora-plan-core`
  included; mtkprof vendors the built package in `web/vendor/ora-plan-core` (`web/scripts/sync-core.sh`).

| Area | Location | Status |
|---|---|---|
| Streaming 10046 parser (every 19c line kind; 21c, 23ai) | `internal/trace` | 0 unknown lines on all fixtures |
| Dimensional model (statements, cursors, call hierarchy with self time, waits, binds, plans, contexts, wall clock); trace sets, chains, PX slaves | `internal/model` | unit tests |
| Aggregations, findings (configurable thresholds), pivot, compare, IO map | `internal/analyze` | unit tests on fixtures |
| tkprof parity | `internal/golden` | passes on every fixture with a tkprof output (34 in 19c, 19 in 21c, 19 in 23ai) |
| Text report, JSON document (format 3, packed columns), CSV export, plan JSON, ref bundle + DBMS_XPLAN overlay | `internal/report`, `internal/ref` | done |
| CLI: `report`, `pivot`, `html`, `serve` (`-slice`, `-spill`), `json`, `export`, `lint`, `plan`, `refscript`, `compare`, `findings-config`, `fetch`, `follow`, `trace`, `ref -db`, `open`, `mcp`, `engine` (+ `engine cache`) | `cmd/mtkprof` | done |
| Engine: sessions, jobs, SSE, prompts, persistent index cache, remote (ssh, Oracle), live follow, OpenAPI contract | `internal/engine`, `internal/remote`, `api/engine.openapi.yaml` | protocol 1; contract test |
| UI: Overview, Statements (Row flow, Dialogue, Execution Loom), Trace/Lines (raw and formatted), Waits, Blocks, Timeline, Sessions, Pivot, Compare; shell module; motion | `web/src/lib`, `web/src/app` → `internal/ui/dist/index.html` | `pnpm --filter mtkprof-web test` |
| Desktop: tabs, settings, connections, notes and bookmarks, library, reports, assistant, open requests, file associations | `desktop/` | `pnpm typecheck`, `pnpm test` |
| Fixtures: 19.27, 21c XE, 23ai Free + tkprof output + generators | `testdata/` | real traces only |
| CI and releases (no GitHub Actions, by decision) | `scripts/ci-local.sh`, `scripts/release-local.sh`, `desktop/scripts/{ci-local,release-local}.sh` | `ci-local.sh --strict` passes |

## Build, test, run

```
export PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=auto   # Go 1.27 on this machine
make build                                  # bin/mtkprof
make test                                   # go test ./... (unit + golden) and the web tests
make web                                    # builds web/ and copies the single-file UI into internal/ui/dist
scripts/ci-local.sh                         # the whole CI (--strict, --no-release, --no-desktop)
./bin/mtkprof report testdata/traces/19c/plsql_recursive.trc | less
./bin/mtkprof html   testdata/traces/19c/io_waits.trc -o /tmp/io.html
./bin/mtkprof serve  testdata/traces/19c/io_waits.trc            # http://127.0.0.1:8046/
pnpm -r typecheck                                                 # before committing UI changes (lib + desktop)
```

After any change under `web/src`, run `make web` and rebuild Go, otherwise the binary serves the old UI. The
built `internal/ui/dist/index.html` is committed so `go build` alone works. Desktop: the `verify-mtkprof`
skill (dev browser mode, screenshots); `pnpm build:engine` in `desktop/` rebuilds the sidecar.

### Run the engine by hand

```
export MTKPROF_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')   # 48 hex chars; 32+ bytes required
./bin/mtkprof engine -cache /tmp/mtk-cache -detach > /tmp/engine.out &         # without -detach it exits when stdin closes
cat /tmp/engine.out                                                            # {"ready":true,"addr":"127.0.0.1:PORT","version":"…","protocol":1}
H="Authorization: Bearer $MTKPROF_TOKEN"; A=127.0.0.1:PORT
curl -s -XPOST -H "$H" -d '{"paths":["/abs/path/trace.trc"]}' http://$A/engine/sessions   # 202 {session, job}
curl -sN -H "$H" http://$A/engine/events                  # SSE: job (phase, done/total), session, prompt, log
curl -s  -H "$H" http://$A/engine/sessions                # state opening → ready; hit=true when it came from the cache
curl -s  -H "$H" http://$A/s/SESSION_ID/api/doc | head -c 300      # the document (format 3, slice: true)
curl -s  -H "$H" "http://$A/s/SESSION_ID/api/pivot?fact=waits&by=event,stmt"
curl -s  -H "$H" http://$A/engine/cache                   # entries, bytes, cap
curl -s  -XDELETE -H "$H" http://$A/engine/sessions/SESSION_ID    # closes; the cache entry stays
curl -s  -XDELETE -H "$H" http://$A/engine/jobs/JOB_ID            # cancel a running open
./bin/mtkprof engine cache ls -cache /tmp/mtk-cache               # also rm <identity-prefix>, wipe
```

Stop it with SIGTERM to the pid found by port. The per-session endpoints and parameters are those of
`serve -spill`; the schema is `api/engine.openapi.yaml`. Live sessions: `options.follow`, state `live`, `rev`
per snapshot, `api/doc?rev=` long poll (ARCHITECTURE § Engine mode).

## Things that are easy to get wrong

- **tkprof prints exclusive numbers.** Parent calls include their recursive children in `c/e/p/cr/cu`; the
  model keeps both (`E` and `SelfE`, etc.). The golden test compares the *self* columns. Response-time
  rankings in the UI use inclusive elapsed plus idle time between the statement's calls.
- **In-call waits belong to the call whatever their class** (`WaitEla`); `IdleEla`/`IdleUs`/profile idle are
  between-call waits only (a `PL/SQL lock timer` inside a call is not idle time twice).
- **Response time of a scope** is the sum over its sessions of each session's span (attached PX slaves out),
  not the wall clock (`analyze.ResponseOf`, `data/response.ts`).
- **Cursor adoption.** Calls for a cursor number that was never parsed in the file are attributed to the first
  statement later parsed under that number (tkprof's rule), flagged `Cursor.Assumed`. Split traces (`TRACE
  CONTINUED FROM FILE`) are partly excluded from the golden check for this reason (`internal/golden/golden_test.go`).
- **`END OF STMT` inside SQL text** is real (`nasty_sql.trc`); the parser only accepts the terminator once at
  least `len-4` bytes were read. `PARSE ERROR` text has no terminator; it ends after `len+1` bytes or at the
  next trace line.
- **Waits on cursor #0 after `XCTEND`** (log file sync) belong to the commit; the builder routes them to the
  last XCTEND until the next call.
- **`tim=0` is no time** (`timed_statistics=false`): such rows have no clock and are skipped by the Lines
  clock, Δ, gaps and fold threshold.
- **Version quirks**: 23ai writes `obj#=4294967295` where 19c writes `-1` (read as -1); `control file *`
  waits have a `file#` p1 that is not a datafile (`Event.IsFileP1` skips them).
- **Wait classes** come from `internal/ref/data/event_name_19c.csv` (a real `v$event_name` export); idle
  detection uses the `Idle` class.
- **Cache formats**: a persisted struct change bumps its version and `engine.CacheIndexFormat` (now 5); see
  CLAUDE.md.
- **Harness quirks** (Claude Code / T3): `cd` at the start of a Bash call is unreliable, use absolute paths;
  `pkill -f`/`pgrep -f` match the wrapper shell, find servers by port (`ss -ltnp | grep :8046`, `lsof -i` on
  macOS).
- **dbmint lab** (`~/.claude/skills/dbmint-oracle-test`): Oracle 19.27 in a VM, `ssh -p 2200 oracle@dbmint`,
  needs `dangerouslyDisableSandbox`. The VMs do not autostart after a host reboot (port 2200 reset); ask
  before starting them. SQL*Net at `dbmint:21521/pdb1.world`. Schema `MTK` in `PDB1`;
  `testdata/gen/run_gen.sh` regenerates the fixtures idempotently and runs tkprof on them (generator copy in
  `~/mtk_gen`; `docs/REMOTE.md` § Re-running the lab checks). Never run destructive SQL there.
- **Desktop Docker legs** leave the pnpm store in `/.pnpm-store/` (ignored, a cache; safe to delete).

## Measured budgets

| | target | measured |
|---|---|---|
| reopen a cached trace | 2 GB < 2 s | 2 GB: 0.25 s reopen, 13 s fresh open, 146 MB peak RSS (REMOTE.md); `big_loop.trc` (118 MB): 32 ms |
| engine RSS idle | < 300 MB with 2 GB open | 27 MB after a hit on `big_loop.trc` |
| pivot on 1 GB | ≤ 300 ms | 290 ms (spill) |
| `api/lines` page (2000 lines) | < 20 ms | ~2 ms fetch + 1 ms parse on `big_loop.trc` |
| literal search | 2 GB < 5 s | whole `big_loop.trc` 92 ms |
| follow latency | < 2 s | dbmint 149 ms (cli) / 501 ms (lib) |
| SSH fetch | line speed, resume | 117.7 MB in 0.97 s (gzip), resume correct |
| ADR (db) fetch | | 0.39 to ~1 MB/s |
| minimap / Timeline pan, zoom; Lines LRU on 2 GB | 60 fps on WebView2 | **not measured** on WebView2, WKWebView or WebKitGTK |

CLI: 118 MB trace → text report 0.61 s / 220 MB RSS, HTML 12.7 MB in 0.78 s; 1 GB → HTML 7.3 s / 2.1 GB
(1.6 GB `-lowmem`); 10 GB → text report with `-aggregate` 32 s / 454 MB.

## Open

### Needs you (a decision or a machine)

- **Release**: everything since v0.5.0 is unreleased (`scripts/release-local.sh <tag>`, then
  `desktop/scripts/release-local.sh <tag>` on the Mac).
- **Windows 11** has never been run: `ssh.exe` + `SSH_ASKPASS`, the OpenSSH agent pipe, the NSIS installer
  (cross-built only; smoke with `desktop/scripts/smoke.sh x86_64-pc-windows-msvc windows-x64` from Git Bash),
  and the plan's "UI verified by screenshot on Windows" has no record.
- **Installers** are built and smoke-tested as release binaries (v0.5.0: macOS arm64 and x64, Linux), never
  installed and launched; the macOS drag-to-Applications hand install is open.
- **Remote** (`docs/REMOTE.md` § Open): TCPS (dbmint has no TCPS listener; needs a wallet and a listener
  restart), the AIX/Solaris scripts.
- **Visualizer** has no LICENSE file. It shows "0ms" for µs-scale plans (its display rounds to ms).
- **History**: the stray 32 MB `mtkprof` binary (removed in `a89bc12`) is still in the history of the now
  public repo; rewriting it means a force-push.
- Stale remote branches (`assist/*`, `ui/*`, `lines/clock-delta-gutter`, `feat/cut`, `t3/*`,
  `feature/add-cut-worktree-reference`): delete when convenient.

### Trace pane: the formatted Lines view (round 2 2026-11-06, round 3 2026-11-07; DESIGN § Formatted Lines view, `docs/PLAN-FORMATTED-V2.md`, `docs/PLAN-TRACE-PANE-V3.md`)

State after round 3: the toolbar is Raw | Formatted, the search (Options), Hot spot ↑ ↓, Step, Go to ⌘K, the file select
(several files), the state chips (Δ filter, pin, window, raw Highlighting) and the Display and Side panel buttons; the settings
(colour the lanes by, Fold repeats, the Δ column, the Δ filter, Show, line colours, folds, the key) are the side panel's **Display** tab.
The overview row is the **statement picker** (a searchable, virtualised list of the file's statements; `L`, palette "Highlight a
statement…") beside the time track. Rows: Duration bar as the share of the traced time with its 1 % tick, a call's Detail in groups, the
SQL band (wrap on: the whole statement pretty-printed). Embedded UI: `make web` was run at the end of round 3, so `internal/ui/dist` is
current; the embedded CLI UI needs the rebuilt engine (`texts` in `what=frame`) for SQL bands in wrap mode.

Open:

- Blank lines before a `***` timestamp and after a marker group still take a row; only the blanks under a
  BINDS header fold. Finding the others is a read of the whole raw file (a Go pass over `LineIndex`, cached per
  file, would do).
- The `j` / `J` hot-spot list (`api/lines/hot`) still includes idle waits, which are not drawn hot, so `j` can
  land on an unmarked row. Dropping idle there is an engine change.
- Inline binds are decided by count (up to 4, chips cut at 40 characters), not by "values of up to 24
  characters" as the plan says (values are not known up front). `SQL with values →` sits at the end of the
  last bind row, not on its own row.
- Runs look ±60 lines and the bracket ±300 around a row; at a page edge or an unloaded page a wait is drawn as
  inside and the rule is not cut (rows are recomputed when pages load). With folds or the Δ filter on, the
  clock's "line before" is the previous trace line, not the previous displayed row.
- `z` on an opened framing handle does nothing (`Z` is for user folds). The raw view keeps its row tint, the
  cyan number cell of a selected row and the `exec #0` on a CLOSE in `.lv-head`.
- A prebuilt desktop sidecar (`desktop/src-tauri/binaries/`, gitignored) may predate `what=frame` or its `texts`: run
  `pnpm build:engine` before checking the framing folds or the SQL bands in desktop dev mode.
- The call Detail of a hot FETCH is cut at 1280 px with the side panel open (the groups plus the waiting share need
  about 110 ch); the notes cut first, as designed. The gets box on the amber selected row reads as a slightly cooler
  patch in the light theme.
- SQL band, wrap on: with the top of the view inside a tall band its line number has scrolled away, so the left columns
  are blank beside the lines being read (the sticky lane row names the statement); a reveal that must centre a band lands
  on a 20 px line, up to 10 px off; the formatter lays PL/SQL out as it sees it (`set_action ('x')` gets a space before the
  parenthesis) and highlighting is per line, so a block comment or literal that runs over a line break of the pretty text is
  not known to the next line.
- Display tab: Fold repeats and the Δ column are no longer visible controls while the panel is closed (the rows show them);
  only the Show and dim settings have a badge. The picker's "time here" is the statement's elapsed time in the whole trace
  set (as the lane row says it), not the part inside this input file.

### Row flow, Dialogue, Blocks (DESIGN § Three new views, `docs/PLAN-VIEWS.md`)

- Row flow's "table + note" state (STAT lines without `(cr=…)`) is unit-tested only: no 19c setting produces
  it (nine variants probed on 19.27); the bare form is the pre-9.2 trace format.
- On a `timed_statistics=false` trace (`stats_basic.trc`) the statement's response-time bar is empty:
  everything is unaccounted time and the bar does not draw that.
- A rerun of `run_gen.sh px_io` appends to the pooled PX slaves' existing `*_mtk_px_io.trc` files.
- Not built: the mock-up's fetch count on Row flow's client label; plan § 10 (whole-session Dialogue,
  side-by-side Dialogue in `ExecCompare`, 2-D binning for Blocks, …).

### Smaller gaps

- Execution Loom is not available in reports without facts (`-aggregate`, the desktop's HTML export); a
  follow-up could embed the traces of a bounded set of executions. No fixture has one statement run several
  times with real I/O differences except `exec_loom.trc`.
- An engine session's model is the aggregate one: its text report has no executions tables and its JSON/HTML
  documents no fact tables. Sessions are evicted only with `engine -idle D`.
- Live follow: the remote chain tests run on the lib transport only.
- The notes under the trace facts still cover the whole trace set, not the file selection.
- Compare: no per-component profile table in the UI (the text report has one); its dark theme is unreviewed.
- PX matching is exercised on few QC + slave fixtures; cross-file `tim` ordering assumes one host (a note is
  emitted when offsets differ > 2 s).
- The remote (sliced) activity chart applies the context filter to CPU too; the local path never did.
- Statements sorts by one measure at a time (Pivot is the escape hatch); Overview lanes show the top 12
  statements.
- Executions table: exec # is per cursor (SQL*Plus reopens the cursor, so it is 1 on every row); the cursor
  line column disambiguates.
- Binds: collections (dty 123) stay hex; TSTZ region ids are not mapped to names. Literal redaction inside SQL
  text was deliberately not done.
- Plan viz: the "too large for a link" path is untested in the browser.
- Desktop top row: at 1,280 px with one tab, Pivot is under More (trade-off of the tab overflow).
- `commandName` is empty for synthetic statements (commit, LOB, unknown) by design; the UI shows the kind.
