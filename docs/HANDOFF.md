# Handoff — state of mtkprof on 2026-11-08

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
  `web/src/lib`), `desktop/` (Tauri 2 on `main`; Electron on branch `electron`, see below). One version and one tag for both.
- Latest release **v0.6.0** (2026-11-08, from `89f91c2`): CLI binaries (+ `-lite` builds), the desktop
  installers (DMG arm64/x64, deb, AppImage, NSIS) and, new, the signed updater artifacts and `latest.json`
  in one GitHub release; notes `docs/releases/v0.6.0.md`. The first release with the app's auto-updater
  (signing key `~/.tauri/mtkprof-updater.key` on the release Mac; `desktop/README.md` § Updates).
- **2026-11-08 desktop review round** (`docs/REVIEW-DESKTOP-PERFORMANCE-UX-2026-11-08.md`): 14 findings on
  transitions, work preservation, opening, prompts, keyboard and the Cut view, all fixed on `main` after v0.6.0 in one
  multi-agent run (five parallel worktrees, reviewed, merged); the tracking table there has the evidence per finding,
  DESIGN § Transitions and § Cut the decisions. Unreleased. Anyone running the Tauri app or the `verify-mtkprof` skill
  needs `pnpm build:engine` in `desktop/` first: the sidecar binary is gitignored and predates the engine changes.
- **Electron shell** (2026-11-09, branch `electron`, not merged; DESIGN § Desktop app): `desktop/src-tauri`
  (Rust) replaced by `desktop/electron/` (TypeScript main process, preload bridge `window.mtkprof`, esbuild),
  packaged by electron-builder (`electron-builder.yml`); the UI reaches the shell only through `src/shell.ts`.
  Verified: typecheck, `pnpm test` (313, with the shell's ported Rust tests), a dev-run smoke with the
  fixture (start, simulated crash, restart, re-open from the cache, "Engine restarted" toast, both engines
  gone after quit; screenshots by the app itself, `MTKPROF_SMOKE_SHOTS`). Not yet run: `electron-builder`
  packaging (DMG/NSIS/AppImage/deb), `scripts/ci-local.sh` legs and the Docker image, the native dialogs,
  drag-drop and Finder "Open With" by hand, Windows at all. The updater only checks and opens the release
  page (DESIGN § Updates). `MTKPROF_PROFILE=<dir>` gives dev and smoke runs their own data, cache and logs.
- **Folder picker** (2026-11-08, DESIGN § Opening a folder): a folder no longer opens all its traces;
  the desktop lists them with a quick peek (`internal/peek`, `POST /engine/files`, `POST /engine/peek`)
  and opens what the user picks. Cutting from the picker before loading (for very large files) is the
  agreed next step, not started. With it: the 11g marker fix (`*** SESSION ID:(15.1335) 2013-05-10
  07:26:55.095` kept the time in the value) and `CacheIndexFormat` 7. Unreleased.
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
| UI: Overview, Statements (Row flow, Dialogue, Execution Loom), Trace/Lines (raw and formatted), Waits, I/O map, Timeline, Sessions, Pivot, Compare; shell module; motion | `web/src/lib`, `web/src/app` → `internal/ui/dist/index.html` | `pnpm --filter mtkprof-web test` |
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
- **Cache formats**: a persisted struct change bumps its version and `engine.CacheIndexFormat` (now 7); see
  CLAUDE.md.
- **An engine session's model has no waits** (aggregation-only): anything that needs the waits' obj# or file#
  reads `Model.WaitRefIDs` (the accumulator keeps them since 2026-11-08), not `m.Waits`.
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
| I/O map routes (spill) | the order of `io/map` | `nbstest3` (284 MB, 386 k block waits) / `testcdb` (161 MB, 319 k): `io/map` 29 / 27 ms, `+reads=1` 42 / 32 ms, `io/hot` 90 / 63 ms, `io/density` 300 × 80 55 / 50 ms (`MTK_BIG=1 MTK_BIG_DIR=… go test ./internal/slice -run IOBig -v`); over HTTP from the engine binary, nbstest3 reopened from the cache: 30 / 88 / 74 ms, engine RSS 46 MB before and 52 MB after five I/O queries |
| hot-block counting, bounded | idle RSS < 300 MB | generated (`MTK_SCALE=1 go test ./internal/analyze -run IOHotScale -v`): 214 M block reads over 214 M distinct blocks 0.4 s, 98 MB peak heap, exact; 4 M scattered reads over 1.4 M blocks (prunes) 1.5 s, 85 MB, the hot blocks exact |
| follow latency | < 2 s | dbmint 149 ms (cli) / 501 ms (lib) |
| SSH fetch | line speed, resume | 117.7 MB in 0.97 s (gzip), resume correct |
| ADR (db) fetch | | 0.39 to ~1 MB/s |
| minimap / Timeline pan, zoom; Lines LRU on 2 GB | 60 fps on WebView2 | **not measured** on WebView2, WKWebView or WebKitGTK |

CLI: 118 MB trace → text report 0.61 s / 220 MB RSS, HTML 12.7 MB in 0.78 s; 1 GB → HTML 7.3 s / 2.1 GB
(1.6 GB `-lowmem`); 10 GB → text report with `-aggregate` 32 s / 454 MB.

## Open

### Needs you (a decision or a machine)

- **Release**: bump the app version, tag, `scripts/release-local.sh <tag>`, then
  `desktop/scripts/release-local.sh <tag>` on the Mac (needs the updater key).
- **Updater on Windows and Linux**: v0.6.0 → next is the first real update there; the macOS install and
  relaunch were tested end to end against a local feed, Windows (NSIS passive) and Linux (AppImage, deb
  via pkexec) never.
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

### Left by the 2026-11-08 desktop review (reviewers' should-fix items and app-only checks)

- `web/src/app/TopBar.tsx` still keeps `topw` for the waits-tab count under a window (same class as F01, outside the list).
- The open screen's picker and paths box do not apply the single-file follow rule that drops apply (F02).
- Whether a note editor is open is still component state: after a tab switch the draft comes back when the editor is
  reopened, not by itself (F03). The same note has two draft keys in the views and the Annotations page.
- Same-statement scope changes in Statement detail keep the previous rows without a stale marking (F14).
- Native keyboard and VoiceOver walkthrough in the Tauri app (F07: is the live region spoken, does Tab reach the sort
  buttons in WKWebView). Two cut tabs side by side and `pruneCuts` on a real profile (F09) are Tauri-only checks too.
- No fixture has more than 300 statements (max 210): the F12 picker past rank 300 was tested in vitest only.
- Optional: a server-side singleflight in `slice.Server.wrap` (F05); whole-engine RSS during a cut check in the app (F13).
- `ToolbarMenu` measures its popover during the drop-in animation, so its shift-back-into-view under-detects overflow
  (seen on the Cut statement picker, worked around with an end alignment and a viewport-bound width).

### Trace pane: the formatted Lines view (round 2 2026-11-06, round 3 and 3b 2026-11-07; DESIGN § Formatted Lines view, `docs/PLAN-FORMATTED-V2.md`, `docs/PLAN-TRACE-PANE-V3.md`)

State after round 3b (all five batches done; `internal/ui/dist` rebuilt at the end of batch 5, so the embedded CLI UI is current and needs the rebuilt engine for `api/lines/stmts`
and the `texts` of `what=frame`): the toolbar is Raw | Formatted, the search (Options), Hot spot ↑ ↓, Step, Go to ⌘K, the file select (several files), the state chips (Δ filter,
Fold repeats, lane colours, statement filter, pin, window, raw Highlighting) and the Display and Side panel buttons. The **side panel** has six icon tabs (the active name is the
heading) and its **Display** tab holds the settings (icon toggle grids for Show and Rows, the Δ filter's modes, folds as icon buttons, lane colours as a labelled list). The overview row is the **statement picker**
(searchable, virtualised, multi-select: Space highlight, `f` filter, `a` / `A` all; `L`, `l`, `F`) beside the time track. The pane keeps an ordered **set of highlighted statements**
(per file, colours from the categorical palette, kept while in the set; every other statement is neutral) that tints every line of the statement's cursors in both views, and a
**statement filter** (only those lines, the rest folded; the view's own folds are kept inside the kept runs). The **line map** beside the scroll bar shows where the highlighted
statements' lines are (one binned request per change of the set), the selected line, the visible range and quiet ticks for hits, bookmarks and hot spots; `m` / `M` step between the
runs of the highlighted statements. Rows: Duration bar as the share of the traced time with its 1 % tick, a call's Detail in groups that compact before they cut, the SQL band (wrap on: the
whole statement pretty-printed, its line number and `SQL` tag kept in view in a tall band).

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
- A prebuilt desktop sidecar (`desktop/binaries/`, gitignored; `desktop/src-tauri/binaries/` on `main`) may predate `what=frame`, its `texts` or `api/lines/stmts`: run
  `pnpm build:engine` before checking the framing folds, the SQL bands, the highlight, the filter or the line map in desktop dev mode.
- The gets box on the amber selected row reads as a slightly cooler patch in the light theme. With the side panel open at 1280 px the groups of a call's Detail are clipped
  (the waiting share and the hard-parse pill stay whole); only the panel's width gives more room.
- SQL band, wrap on: a reveal that must centre a band lands on a 20 px line, up to 10 px off; highlighting is per line of the pretty text, so a block comment or literal that runs
  over a line break is not known to the next line. `tightCalls` is a list of words: a call after a keyword of its list keeps the formatter's space.
- The line map has no error, cursor or commit ticks any more (they came with the density layer's `lines/profile` request; the engine route stays and the UI does not ask for it).
  A statement with more than 7 highlighted shares colours (slots repeat); pixel rows that hold several statements share the strip's 10 px in stripes of at least 2 px.
- `api/lines/stmts` assigns a statement to a PARSING IN CURSOR block the parser did not register (three in the SQLT fixture, about 100
  lines, its first PL/SQL block's `len=` is never reached) the way `annot=2` does not (the lines take the cursor before them in the page ids and the call
  before them in the route): the equality test allows them for that fixture only. Lines in no cursor (blank, `***`) take the previous call's statement, so a highlight or filter keeps them with it;
  only the `=====` rule above a cursor goes with that cursor. A filtered view of far-apart rows loads one page per row (a big file and a statement that ran everywhere: up to ~100 pages of
  2,000 lines; the screen waits for them).
- Toolbar: with every optional chip on at once (Δ filter, Fold repeats, lanes, statement filter, the pin, a window, a file select) the search is at its least width at 1100 px (128 px or more from 1280 px).
  With a filter on, the Go-to label folds to `⌘K` below 1792 px. `m` with a statement highlighted in a file that has none of its lines says so; with the engine's run list cut (100,000 runs) the
  steps stop at the last run it sent.

### The I/O map (2026-11-08; DESIGN § The I/O map, `docs/PLAN-IOMAP.md`)

The Blocks view, rebuilt and renamed: ⌘I, a toolbar like the Trace pane's, a zoom of its own (drag by shape, wheel, keys,
a navigator, "Use as time window"), titled axes, panels per file or per object, a linear or packed block axis, ten colour
modes with a legend that highlights, object names from the bundle or the plans (schema / PDB / partition / obj# options),
and a side panel (Objects, Statements, Distributions, Display). Engine: the aggregate model keeps the waits' obj# and file#,
so a bundle (and the desktop's "Fetch reference data") names datafiles and the objects only waits mention; cache format 6.

Round 3 (2026-11-08, DESIGN § The I/O map: density and hot blocks, `docs/PLAN-IOMAP-2.md`): three engine answers over every
matching wait, not the sample: `/api/io/density` (the waits counted into the cells of the view's layout, drawn under the marks;
toolbar *Density* auto / on / off, Display: waits / blocks / time, √ / log, marks on or off, a cell tooltip), `/api/io/hot` (block
reads per block in bounded memory: a roaring-like seen set, counters for re-read blocks, a Misra-Gries prune; the hottest runs
recounted exactly; the side panel's new *Hot blocks* tab, click to zoom and highlight; exact Objects and Statements tabs), and
`/api/io/map?reads=1` (the colour mode *Re-reads*). TS twins with one shared case (`ioblocks-case.json`); no protocol bump, no cache
format change.

Open:

- `site/docs.html` is updated in the repository but not published (ask before `scripts/publish-site.sh`).
- No real trace with millions of block I/O waits: `testdata/big` tops out at 386 k (nbstest3); the bounded counting is measured on
  generated streams only (`TestIOHotScale*`). A dbmint scenario for it would need the lab VMs (ask first).
- Density on a packed axis (panels per object, or *packed*) bins over the segments the sample's runs give: a wait outside them is
  not drawn (the panel's `out` count), as its mark would not be.
- The standalone report's `ioHotOf` takes ~310 ms per 400 k block waits on the main thread (the per-object and per-statement distinct
  sets cost most); it runs while Objects, Hot blocks or Statements shows, again on each zoom.
- Distinct blocks per object and statement are approximate past the owners' 32 MB cap (`distinctExact`; the UI says so); a block read
  by two object groups (a `n<file>` wait and an object) counts for each. A hot run merges adjacent blocks whatever their object.
- The Distributions tab still counts the rows drawn (every k-th wait is an unbiased sample for histograms; it says ≈).
- The re-reads colour of a multiblock read is its most read block's count (one hot block colours a 128-block read).
- The assistant's `show` tool does not offer the I/O map (`internal/assist/tools_show.go` lists the other views).
- Other views still name objects from the bundle only (`doc.objectName`); the plan-line fallback of `data/objnames.ts`
  is the I/O map's.
- The navigator shows the unzoomed answer, sampled at the marks limit (5,000 rows when zoomed on arrival); its bars are
  waits, not time. In I/O order the main axis restarts at 0 inside a zoom (the engine does not say how many waits came
  before the range).
- PDB of an object = the container of its first wait's session; obj# are keyed without the container, so the same obj#
  in two PDBs of one trace set are one object.
- Not measured: wheel zoom on 100,000 marks on WebView2 / WebKitGTK.

### Import names (2026-11-08; DESIGN § Enrichment, `docs/REF-BUNDLE.md` § Paste)

`refscript -paste` writes a names script (one read-only PL/SQL block printing tagged CSV lines; DBA_ views, else ALL_,
with notes); the desktop's *Import names* dialog (the I/O map's Objects and Display tabs, the statement inspector,
Connections › Reference data) hands it out and takes the pasted output; the engine merges it into the trace's kept
bundle (`GET api/ref`, `GET api/ref/script`, `POST api/ref/paste`). `-ref names.txt` reads a saved output in the CLI.
Run on the lab as SYSDBA and as MTK (`internal/ref/testdata/paste_io_waits_*.txt`, also the 2,500-id chunked script).
Every ref job (paste, directory, database) applies the stored bundle to all open sessions of the trace: another tab of the
same files reloads with the names.

Open:

- The CLI's `serve` and the standalone HTML take no paste (their views point to `-ref`).
- Not tried: SQL Developer, SQLcl and Toad/DBeaver (DBMS_OUTPUT must be on there); only SQL*Plus 19c on the lab.

### Row flow, Dialogue, Blocks (DESIGN § Three new views, `docs/PLAN-VIEWS.md`)

- Row flow's "table + note" state (STAT lines without `(cr=…)`) is unit-tested only: no 19c setting produces
  it (nine variants probed on 19.27); the bare form is the pre-9.2 trace format.
- On a `timed_statistics=false` trace (`stats_basic.trc`) the statement's response-time bar is empty:
  everything is unaccounted time and the bar does not draw that.
- A rerun of `run_gen.sh px_io` appends to the pooled PX slaves' existing `*_mtk_px_io.trc` files.
- Not built: the mock-up's fetch count on Row flow's client label; plan § 10 (whole-session Dialogue,
  side-by-side Dialogue in `ExecCompare`, 2-D binning for the I/O map, …).

### Cut (2026-11-06; DESIGN § Cut, ARCHITECTURE § Cut, DESKTOP § Cut)

A new trace file from a part of a trace set (a window, sessions or files, one statement; a join of a set's
files), desktop only: engine `internal/cut`, routes `api/cut`, `api/cut/check`, `api/cut/file` (additive,
protocol stays 1), the desktop's Cut view (Tools menu, `desktop/src/workspace/session/cut/`). Every fixture
of 19c/21c/23ai and the multisession, parallel and workload sets passes the re-parse check (whole, mask,
none, per session, quarter windows, executions, statements); a whole cut equals its source plus the
provenance lines. Rules found on the way: a cursor is restated before its BINDS block, not only its calls;
statement text must be followed by `len=`; a copied source timestamp anchors only when nothing between it
and the next `tim` was left out, else a generated one follows it.

Open:

- Not run in the Tauri window (native save dialog, *Open as new tab*).
- tkprof on cut files not compared yet (dbmint).
- Interleaving a join by time (trcsess's order) is not offered.
- An implicit cursor (open before tracing, never parsed) whose number collides with another process's in a
  join would take that cursor's statement.

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
