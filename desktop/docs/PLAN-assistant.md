# Assistant plan

> Written before the 2026-11-02 merge, when this app was the repository `mtkprof-desktop` and pinned the engine as the submodule `engine/`: read `engine/X` as `X` at the repository root (`web/src/lib`, `internal/`, `api/`, `testdata/`); the pin, `git submodule` and `check:deps` steps no longer exist.

DBAs who analyse a 10046 trace in mtkprof get a way to hand what mtkprof sees, plus their notes and a case description, to an LLM agent.
They can copy a Markdown brief out, or chat in the app with an OpenAI-compatible endpoint, `claude -p`, or `codex exec`.
Every claim in an answer links back into the views, and the agent can move the view ("show me").
The rule the program enforces is this. Nothing leaves the machine without consent per trace and provider, binds are masked by default, every tool result is visible in the chat, and a key never sits in a file or in the webview unless the user types it.
PRs in order are E1 (brief), D1 (Copy brief dialog), E2 (tool layer and MCP bridge), E3 (conversations and the HTTP backend), E4 (CLI backends), D2 (keychain and Assistant settings), D3 (chat panel), D4 (show me and save as note).
E PRs land in the engine submodule repo `modern-tkprof`. D PRs land in `mtkprof-desktop` and pin the submodule at the merged E commit.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md` (local copy under `~/.claude/plugins/cache/cursor-plugins/pstack/<version>/skills/poteto-mode/playbooks/`). The operator lands every PR. All eight PRs stop at verified and merge-ready.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:docs/PLAN-assistant.md` in `mtkprof-desktop`.
  - [ ] `git -C engine show origin/main:docs/DESIGN.md` and `git -C engine show origin/main:CLAUDE.md`.
  - [ ] `git show origin/main:.claude/skills/verify-mtkprof/SKILL.md` (the control skill for desktop lanes).
  - [ ] The pstack files `skills/poteto-mode/playbooks/autopilot-stack.md`, `skills/poteto-mode/playbooks/autopilot-full.md`, `skills/swarm/SKILL.md`, and `skills/poteto-mode/playbooks/opening-a-pr.md`. pstack is a plugin, not a repo here, so read the local copies.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owners use `subagent_type` `pstack:poteto-agent`, the `feature, refactoring` model line, and `isolation` `worktree`.
- [ ] Follow this dependency graph. Base each PR on its parent branch, because the execution playbook stacks.
  - [ ] E1 is first. It branches from `modern-tkprof` `main`.
  - [ ] D1 after E1. It branches from `mtkprof-desktop` `main` and pins `engine` at the E1 head.
  - [ ] E2 after E1. E3 after E2. E4 after E3.
  - [ ] D2 after D1 and E4. D3 after D2. D4 after D3.
- [ ] Hold the file boundaries.
  - [ ] E PRs touch only `engine/**` (the `modern-tkprof` repo).
  - [ ] D PRs touch only `src/**`, `src-tauri/**`, `docs/**`, `package.json`, `pnpm-lock.yaml`, and the `engine` submodule pointer.
- [ ] Hold the review gate. D1, D2, D3, and D4 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use `gh pr create --base <base-branch>` in the PR's repo. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
  - [ ] Engine PRs run `go vet ./...`, `go test ./...`, and `cd web && pnpm typecheck` in `engine/`. Go is `/usr/local/go/bin/go` on this Mac with `GOTOOLCHAIN=auto`. The `~/.local/go/bin` path in `engine/CLAUDE.md` does not exist here.
  - [ ] Desktop PRs run `scripts/ci-local.sh --only checks` (typecheck, vitest, `check:deps`, `gen:api` staleness, `cargo fmt --check`).
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. These repos have no Bugbot check today, so record "none present" when that holds.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Stop at verified and hand each PR to the operator, per autopilot-stack step 1. After a lower PR lands, retarget its child to trunk and keep the child's verdict only when `git patch-id` at the verdict SHA matches the new head.

### Boot recipe, for every live lane

Claude Code has no cloud VMs. Each live lane runs in its own git worktree at the PR head. Engine lanes drive the CLI and HTTP API with `curl` and `jq` (the `control-cli` role). Desktop lanes drive the app in dev browser mode through `.claude/skills/verify-mtkprof` (the `control-ui` role).

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`. For a D PR, also run `git submodule update --init engine`.
- [ ] Start the backend and the surface. Wait for ready.
  - [ ] Engine lanes build with `cd engine && go build -o /tmp/lane-<n>/mtkprof ./cmd/mtkprof`. Start it with `MTKPROF_TOKEN=lane<n> /tmp/lane-<n>/mtkprof engine -detach </dev/null`, read `addr` from the `{"ready":true,...}` line, and open the fixture with `POST /engine/sessions`.
  - [ ] Desktop lanes set `VERIFY_MTKPROF_ROOT=/tmp/verify-mtkprof-<pr-id>-<n>`, run `doctor.sh`, then `launch.sh`, and wait for its `ready:` line.
  - [ ] Lanes that need a model use the fakes from E3 and E4 (`engine/internal/assist/fake`) unless the lane says "real backend". A real-backend lane needs network, so run it outside the Bash sandbox.
- [ ] Deliver input only through the control skill's commands. Engine lanes use `curl -H "Authorization: Bearer lane<n>"`. Desktop lanes use `drive.mjs`. The read-only diagnostics are `GET /engine/health`, `GET /engine/jobs`, the engine log, and `doctor.sh`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. A CLI lane saves its terminal capture as `<slug>.txt` beside it.
- [ ] Run `cleanup.sh` with the lane's `VERIFY_MTKPROF_ROOT` and kill the lane's engine by PID, never with `pkill -f`.

## Render a scope-aware trace brief (E1)

**Depends on.** None.

**Files.**

- [ ] Create `engine/internal/report/brief.go` and `engine/internal/report/brief_test.go`.
- [ ] Create `engine/internal/report/testdata/brief_basic_binds.md` (byte-pinned, with an `-update-brief` flag like `refscript_pin_test.go`).
- [ ] Edit `engine/cmd/mtkprof/main.go` (new `brief` case and usage line).
- [ ] Edit `engine/internal/engine/session.go` (`sessionRoutes` and a `handlers` entry for `POST /api/brief`).
- [ ] Edit `engine/api/engine.openapi.yaml` and `engine/internal/engine/contract_test.go` (session route count 27 to 28, `BriefRequest` schema).
- [ ] Edit `engine/docs/DESIGN.md` (the assistant amendment in Appendix D, item 1).

**Build.**

- [ ] Add `report.Brief(ctx, m, src, filter, BriefOptions) (string, error)` in `brief.go`. It builds on `analyze.ProfileOfOn`, `analyze.StatementsOn`, `analyze.FindingsOnWith`, and the plan and executions readers, not on `writeText`, because `writeText` ignores scope.
  - [ ] Sections in order are a header (DB version, files, sessions, window, response time), the resource profile, the top statements that make up 80% of response time with SQL, call table, plan, and execution summary, the findings with evidence, the notes next to the object they annotate, the case text, and closing instructions for an agent.
  - [ ] `BriefOptions` carries `Case string`, `Notes []Note`, `MaxStatements int`, `MaxSQLChars int`, `MaxPlanLines int`, and `Binds` (`keep`, `mask`, `none`). It returns the Markdown plus `EstTokens int` (bytes over 4).
  - [ ] `mask` replaces each bind value with its type, length, and a hash salted per brief, so the same value matches inside one brief and differs across briefs.
- [ ] Serve it as `POST /s/{id}/api/brief` with a JSON body (case, notes, options, scope as `from`, `to`, `contexts`). POST, because notes and case text do not fit a cacheable GET.
- [ ] Add `mtkprof brief [report flags] -case file -notes file trace.trc` in `main.go`.

**You see.**

- [ ] `mtkprof brief testdata/traces/19c/basic_binds.trc` prints Markdown that starts with `# Trace brief` and ends with a `## For the agent` section, and stderr prints `estimated tokens: <n>`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `brief_test.go` pins the Markdown for `basic_binds.trc` against `testdata/brief_basic_binds.md`, and asserts that a window scope drops statements outside it and that `mask` leaves no raw bind value from the trace in the output. Run `go test ./internal/report -run Brief`.
- [ ] `contract_test.go` passes with the new route and schema. Run `go test ./internal/engine`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `mtkprof report testdata/traces/19c/basic_binds.trc` at trunk and head, and `mtkprof brief` at head. Trunk lacks `brief`, so record that and gate the brief output. Save `report-vs-brief.txt`. Pass when both reports are byte-identical and the head brief exits 0 with both section markers.
- [ ] Lane 2. Open `basic_binds.trc` in the engine and `POST /s/{id}/api/brief` with an empty body. Save `brief-route.txt`. Pass when the response is 200, `text/markdown`, and equals the CLI output for the same trace.
- [ ] Lane 3. Post a window that covers only the second half of `multisession_a.trc`. Save `brief-window.txt`. Pass when the header names that window and every listed statement has time inside it in `/api/statements?from&to`.
- [ ] Lane 4. Post `contexts` for one session of `multisession_a.trc` plus `multisession_b.trc`. Save `brief-contexts.txt`. Pass when only that session's statements and findings appear.
- [ ] Lane 5. Brief `bind_types.trc` with `binds=mask`. Save `brief-mask.txt`. Pass when no `value=` string from the trace's BINDS blocks appears in the output (grep each one) and masked hashes repeat for repeated values.
- [ ] Lane 6. Brief `bind_types.trc` with `binds=none`. Save `brief-none.txt`. Pass when the output has no bind section at all.
- [ ] Lane 7. Post two notes (a statement note and a window note) and a case text. Save `brief-notes.txt`. Pass when each note prints under its statement or window and the case text prints once before the agent section.
- [ ] Lane 8. Brief `big_loop.trc` with default caps. Save `brief-caps.txt`. Pass when the statement count is at most `MaxStatements`, no SQL block exceeds `MaxSQLChars`, and the token estimate prints.
- [ ] Lane 9. Brief `plan_change.trc`. Save `brief-planchange.txt`. Pass when the plan-change finding and both plan hashes appear.
- [ ] Lane 10. Call the route without the token and with a closed session id. Save `brief-errors.txt`. Pass when the answers are 401 and 404 with the engine error envelope.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `mtkprof report` at trunk and head on `big_loop.trc`. Also the diff-added work, the wall time of `mtkprof brief` on `big_loop.trc` at head, and its token estimate.
- [ ] Probe. Run `hyperfine -w 2 -r 10` on the two report binaries interleaved, then on `brief` at head.
- [ ] Baseline. Record the trunk `report` time first.
- [ ] Rule. Head `report` fails when it is more than 5% slower than trunk. `brief` fails when its mean exceeds the head `report` mean or its estimate exceeds 30,000 tokens with default caps.

**Review gate.** None. E1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it in `modern-tkprof` bottom-up after the verdict.

## Add the Copy brief dialog (D1)

**Depends on.** E1.

**Files.**

- [ ] Create `src/workspace/session/BriefDialog.tsx` and `src/workspace/session/brief.test.ts`.
- [ ] Edit `src/workspace/session/SessionNav.tsx` (the **Copy brief…** button next to the view tabs).
- [ ] Edit `src/engine/api.d.ts` (`pnpm gen:api`) and the `engine` submodule pointer.

**Build.**

- [ ] Add `BriefDialog` as a `<dialog>.showModal()` card, like `CompareTabsDialog` in `src/workspace/CompareTabs.tsx`. It holds a case text box, toggles for notes, binds (`mask` by default), and plans, a preview, the token estimate, **Copy**, and **Save .md**.
- [ ] Build the request from `scopeOf(store.getState())`, `State.annotations`, and `State.bookmarks`. Copy with `copyText` from `@lib/data/clipboard`. Save with `saveAs` and `traceStem` from `src/files.ts`.

**You see.**

- [ ] Clicking **Copy brief…** on `basic_binds.trc` opens the dialog. The preview shows `# Trace brief`, and **Copy** shows "Copied" with the token estimate.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `brief.test.ts` asserts that the request body carries the store scope, the notes, and `binds: "mask"` by default. Run `pnpm test -- brief`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open `basic_binds.trc` and screenshot the workspace header at trunk and head. Trunk lacks the button, so record that and gate the dialog. Save `header.png`. Pass when the head header matches trunk apart from the new button and the dialog opens.
- [ ] Lane 2. Open the dialog and wait for the preview. Save `dialog.png`. Pass when the preview starts with `# Trace brief` and the token estimate shows.
- [ ] Lane 3. Set a time window in Overview, then open the dialog. Save `dialog-window.png`. Pass when the preview header names that window.
- [ ] Lane 4. Add a note on a statement, then open the dialog. Save `dialog-note.png`. Pass when the preview shows the note under that statement.
- [ ] Lane 5. Turn the notes toggle off. Save `dialog-no-notes.png`. Pass when the preview no longer shows the note.
- [ ] Lane 6. On `bind_types.trc`, keep binds masked, then switch to keep. Save `dialog-binds.png`. Pass when masked values show type and hash and kept values show the trace values.
- [ ] Lane 7. Click **Copy** and read the clipboard through Playwright. Save `copy.png`. Pass when the clipboard text equals the preview text.
- [ ] Lane 8. Click **Save .md** (the browser download path in dev mode). Save `save.png`. Pass when the downloaded file is named after the trace stem and equals the preview.
- [ ] Lane 9. Press Esc and reopen. Save `reopen.png`. Pass when the dialog closes on Esc and the case text persists for the tab.
- [ ] Lane 10. Open the dialog at a 1000x700 viewport. Save `narrow.png`. Pass when nothing clips and the buttons stay reachable.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from opening `big_loop.trc` to the Overview ready mark, at trunk and head. Also the diff-added work, the time from the button click to the preview rendered on `big_loop.trc`.
- [ ] Probe. `drive.mjs` timing with five interleaved runs per side, then five dialog opens at head.
- [ ] Baseline. Record the trunk open-to-ready time first.
- [ ] Rule. Head fails when open-to-ready is more than 5% slower than trunk, or when click-to-preview exceeds 1.5 s.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4, and 6 screenshots into `/tmp/mtkprof-assistant-review/D1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree with Playwright `recordVideo`. Save it as `/tmp/mtkprof-assistant-review/D1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it after E1 lands. The submodule pointer then names the merged E1 commit.

## Expose analysis tools and an MCP bridge (E2)

**Depends on.** E1.

**Files.**

- [ ] Create `engine/internal/assist/tools.go`, `engine/internal/assist/redact.go`, `engine/internal/assist/tools_test.go`, and `engine/internal/assist/redact_test.go`.
- [ ] Create `engine/internal/assist/mcp.go` and `engine/internal/assist/mcp_test.go`.
- [ ] Edit `engine/cmd/mtkprof/main.go` (new `mcp` case).
- [ ] Edit `engine/internal/engine/session.go`, create `engine/internal/engine/assist.go`, and edit `api/engine.openapi.yaml` and `contract_test.go`.

**Build.**

- [ ] Add a registry `assist.Tools`, a table of `Tool{Name, Description, Schema json.RawMessage, Run func(ctx, Env, json.RawMessage) (Result, error)}`. `Env` holds the session model, source, scope, and redaction mode.
  - [ ] Tools are `overview`, `statements`, `statement`, `executions`, `pivot`, `timeline`, `lines`, `search_lines`, `notes`, and `current_view`. Each wraps the function behind the matching slice route and returns compact JSON capped at 8,000 tokens.
  - [ ] `statement` and `executions` take `sql_id` with an `@N` fallback, the stable ids `urlstate.ts` uses, never raw array positions.
- [ ] Add `assist.Redactor` in `redact.go`. It masks bind values in tool results and masks `value=` lines inside BINDS blocks in `lines` and `search_lines`, using `trace/classify.go` and `/api/lines/blocks?what=binds`. Session redaction is fixed at load, so this layer covers sessions opened with `binds=keep`.
- [ ] Serve `GET /engine/assist/tools` and `POST /s/{id}/api/assist/tools/{name}` (a `handlers` entry, because slice handlers are GET only).
- [ ] Add `mtkprof mcp`, a stdio MCP server (`initialize`, `tools/list`, `tools/call`) that forwards to those routes with `MTKPROF_ENGINE`, `MTKPROF_TOKEN`, `MTKPROF_SESSION`, and `MTKPROF_CONVERSATION` from env, like `sshcli/askpass.go`. It never reads stdin the way `engine` does.

**You see.**

- [ ] `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | mtkprof mcp` (env set) prints the ten tools with their schemas.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tools_test.go` runs every tool on `basic_binds.trc` and asserts its result fits its cap and agrees with the matching slice route. Run `go test ./internal/assist`.
- [ ] `redact_test.go` asserts that no BINDS `value=` string from `bind_types.trc` survives `executions`, `lines`, or `search_lines` with masking on. Run `go test ./internal/assist -run Redact`.
- [ ] `mcp_test.go` drives the stdio server through the three MCP methods against an `httptest` engine. Run `go test ./internal/assist -run MCP`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Fetch `/api/statements` and `/api/findings` for `basic_binds.trc` at trunk and head. Trunk lacks the tools, so record that and gate `statements` and `overview` at head. Save `regression.txt`. Pass when the slice routes are byte-identical across trunk and head and the head tools agree with them.
- [ ] Lane 2. `GET /engine/assist/tools`. Save `tools-list.txt`. Pass when ten tools return and each schema parses as JSON Schema.
- [ ] Lane 3. Run `statement` by `sql_id` on `basic_binds.trc`. Save `tool-statement.txt`. Pass when the call table matches `/api/statements` for that statement.
- [ ] Lane 4. Run `executions` with masking on `bind_types.trc`. Save `tool-exec-mask.txt`. Pass when no raw bind value appears.
- [ ] Lane 5. Run `lines` over a BINDS block of `bind_types.trc`. Save `tool-lines-mask.txt`. Pass when every `value=` line is masked and other lines are unchanged.
- [ ] Lane 6. Run `pivot` (waits by event) with a window scope. Save `tool-pivot.txt`. Pass when the totals equal `/api/pivot` with the same scope.
- [ ] Lane 7. Run `executions` on `big_loop.trc` with `limit` 10,000. Save `tool-cap.txt`. Pass when the result is truncated at the cap and says so.
- [ ] Lane 8. Pipe a `tools/call` for `overview` into `mtkprof mcp`. Save `mcp-call.txt`. Pass when the reply content matches the `overview` route.
- [ ] Lane 9. Real backend. Run the Appendix A recipe for `claude -p` with `mtkprof mcp` as the only server. Save `mcp-claude.txt`. Pass when the init event lists only `mcp__mtkprof__*` tools and the answer cites statement data from `basic_binds.trc`.
- [ ] Lane 10. Call a tool with a bad argument and an unknown tool name. Save `tool-errors.txt`. Pass when both answer 400 with the engine error envelope and the MCP bridge maps them to `isError` results.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p50 and p95 latency of `GET /api/statements` on `big_loop.trc` at trunk and head. Also the diff-added work, the p50 and p95 of `POST .../assist/tools/statements` with the same scope.
- [ ] Probe. 200 interleaved requests per route with `curl -w '%{time_total}'`, after one warm request.
- [ ] Baseline. Record the trunk `/api/statements` p50 and p95 first.
- [ ] Rule. Head fails when `/api/statements` p95 is more than 10% above trunk, or when the tool p95 exceeds the route p95 plus 25 ms.

**Review gate.** None. E2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it in `modern-tkprof` after E1.

## Run conversations over an OpenAI-compatible endpoint (E3)

**Depends on.** E2.

**Files.**

- [ ] Create `engine/internal/assist/conversation.go`, `engine/internal/assist/openai.go`, `engine/internal/assist/stream.go`, and `engine/internal/assist/system_prompt.md` (embedded).
- [ ] Create `engine/internal/assist/fake/openai.go` (a scripted OpenAI-compatible server for tests and lanes) and tests beside each file.
- [ ] Edit `engine/internal/remote/prompt.go` (kind `apikey`), `engine/internal/engine/assist.go`, `api/engine.openapi.yaml`, and `contract_test.go`.

**Build.**

- [ ] Model a conversation as a state machine in `conversation.go` with states `idle`, `running`, `waiting_key`, `cancelled`, and `failed`. It holds the provider definition (no secret), session id, scope, redaction mode, messages, usage, and a backend handle.
- [ ] Add `Backend` as an interface with `Turn(ctx, Conversation, Message, emit func(Event)) error`, and the first implementation in `openai.go`. It uses stdlib `net/http` with no client timeout and a per-request context, streams SSE, runs tool calls through `assist.Tools`, and retries 429 and 5xx twice with backoff.
- [ ] Ask for the key with `prompts.Ask` and kind `apikey`, with the provider id in `Prompt.Connection`. Keep it in memory per provider, and drop it on `DELETE /engine/assist/providers/{id}/key`.
- [ ] Stream each turn as NDJSON on the `POST /engine/assist/conversations/{c}/messages` response, never on the global `/engine/events` broadcaster, whose 256-event buffer drops every subscriber on overflow. Events are `text` (coalesced to 50 ms), `tool_call`, `tool_result` (the exact payload sent to the model), `intent`, `usage`, `done`, and `error`.
- [ ] Add a `show` tool to the registry. It validates its target (view, `sql_id`, exec, window, contexts, line, or pivot) and emits an `intent` event on the conversation's open turn.
- [ ] Add `POST /engine/assist/conversations` (create, with case text, notes, current view, provider, and consent flag) and `DELETE /engine/assist/conversations/{c}` (cancel).

**You see.**

- [ ] Against `fake/openai.go`, `curl -N -X POST .../messages` prints `tool_call overview`, `tool_result`, streamed `text`, and `done` with usage, each one per line.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `conversation_test.go` covers every state transition, including cancel during a tool call and a key prompt cancelled by the user. Run `go test ./internal/assist -run Conversation`.
- [ ] `openai_test.go` runs a two-tool round trip, a 429 retry, and a malformed tool-call recovery against the fake. Run `go test ./internal/assist -run OpenAI`.
- [ ] `contract_test.go` passes with the new routes, the `apikey` kind, and the event schemas. Run `go test ./internal/engine`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open a session and follow `/engine/events` while a prompt-driven SSH connection test runs, at trunk and head. Trunk lacks conversations, so record that and gate one fake-backed turn at head while the event stream stays connected. Save `events.txt`. Pass when trunk and head show the same prompt events and head's stream survives a 500-delta turn.
- [ ] Lane 2. Create a conversation against the fake and send one message. Save `turn.txt`. Pass when the stream shows `tool_call`, `tool_result`, `text`, and `done` in order.
- [ ] Lane 3. Start a turn with no key held. Save `key-prompt.txt`. Pass when a `prompt` event with kind `apikey` appears, the turn waits, and answering it through `POST /engine/prompts/{id}` resumes it.
- [ ] Lane 4. Cancel with `DELETE` during a slow fake tool call. Save `cancel.txt`. Pass when the stream ends with `error` code `cancelled` within one second and the fake sees the request closed.
- [ ] Lane 5. Make the fake answer 429 twice, then 200. Save `retry.txt`. Pass when the turn completes and the log shows two retries.
- [ ] Lane 6. Script the fake to call `show` with a `sql_id`. Save `intent.txt`. Pass when an `intent` event carries the validated target and an unknown `sql_id` returns a tool error instead.
- [ ] Lane 7. Real backend. Point the provider at a local OpenAI-compatible server (Ollama or LM Studio) if one is running. Otherwise use the Claude OpenAI-compatible endpoint with the operator's key. Save `real-openai.txt`. Pass when a turn on `basic_binds.trc` calls at least one tool and ends `done`.
- [ ] Lane 8. Forget the provider key and send again. Save `forget.txt`. Pass when a fresh `apikey` prompt appears.
- [ ] Lane 9. Close the session mid-turn. Save `session-close.txt`. Pass when the turn ends with `error` code `session_closed` and the engine log shows no panic.
- [ ] Lane 10. Inspect the bytes the fake received. Save `sent.txt`. Pass when every `tool_result` event equals what the fake received, and no bind value from `bind_types.trc` appears with masking on.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Event-stream delivery latency of a `job` event at trunk and head. Also the diff-added work, the engine overhead per turn, which is time to the first `text` event minus the fake's scripted delay.
- [ ] Probe. Fifty interleaved runs per side of a fixed fake script, with timestamps from the client.
- [ ] Baseline. Record the trunk `job` event latency first.
- [ ] Rule. Head fails when `job` latency p95 rises more than 10%, or when engine overhead p95 exceeds 50 ms.

**Review gate.** None. E3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it in `modern-tkprof` after E2.

## Add the claude and codex CLI backends (E4)

**Depends on.** E3.

**Files.**

- [ ] Create `engine/internal/assist/claudecli.go`, `engine/internal/assist/codexcli.go`, `engine/internal/assist/proc_unix.go`, and `engine/internal/assist/proc_windows.go`.
- [ ] Create `engine/internal/assist/fake/claude` and `engine/internal/assist/fake/codex` (scripts that replay recorded JSONL from Appendix A) and tests.
- [ ] Edit `engine/internal/engine/assist.go`, `api/engine.openapi.yaml`, and `contract_test.go` (`GET /engine/assist/backends`).

**Build.**

- [ ] Add a `claude` backend that runs one long-lived process per conversation and feeds each message on stdin.
  - [ ] Args are `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --mcp-config <file> --allowedTools mcp__mtkprof__<each tool> --setting-sources "" --no-session-persistence --system-prompt <file> --model <m>`.
  - [ ] It runs in an empty temp cwd. The MCP config file is mode 0600 and names `mtkprof mcp` through `os.Executable()`. The token goes in the MCP server's `env` block, never in argv.
  - [ ] It maps `stream_event` deltas, `tool_use`, and `result` usage to conversation events.
- [ ] Add a `codex` backend, labelled experimental in the UI. It runs `codex exec --json --ephemeral --sandbox read-only --skip-git-repo-check -c web_search=disabled` with the user's own Codex home. It never links, copies, or reads `auth.json`.
  - [ ] It turns off the features `shell_tool`, `unified_exec`, `apps`, `plugins`, `browser_use`, `computer_use`, `in_app_browser`, `memories`, and `tool_suggest` with `--disable`.
  - [ ] Before each run, it reads the `[mcp_servers.*]` table names from `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and passes `-c mcp_servers.<name>.enabled=false` for each. It only reads the file. Plugin-provided servers are not in that table, and `--disable plugins` covers them.
  - [ ] It adds the mtkprof server with `-c mcp_servers.mtkprof.command=...`, `args`, `env`, and `default_tools_approval_mode="approve"`.
  - [ ] `--ephemeral` keeps trace data out of `~/.codex/sessions`, so `exec resume` is unavailable. Each follow-up turn resends the conversation so far as the prompt, capped by the conversation's token budget.
  - [ ] Settings offers two fallbacks for users whose setup still leaks tools. One is a separate mtkprof Codex login in an mtkprof-owned `CODEX_HOME` with `cli_auth_credentials_store = "keyring"`. The other is an OpenAI API key from the keychain, passed as `CODEX_API_KEY`.
- [ ] Spawn both like `remote/sshcli/client.go`, with `exec.CommandContext`, a filtered env, `Setsid` or `CreateNoWindow`, process-group kill on cancel, `WaitDelay` 2 s, and bounded stderr.
- [ ] Add `GET /engine/assist/backends`. It reports each CLI's path, version, and login state (`claude auth status`, `codex login status`), or "not found".

**You see.**

- [ ] With `fake/claude` first on `PATH`, a turn streams the same event sequence as the E3 fake. With the real `claude`, a turn on `basic_binds.trc` returns an answer that names a `sql_id` from the trace.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `claudecli_test.go` and `codexcli_test.go` replay the recorded JSONL through the fakes and assert the event mapping, the exact argv, the 0600 config mode, and cleanup of the temp dirs. Run `go test ./internal/assist -run CLI`.
- [ ] Cross-compile with `make release` (or `GOOS=windows`, `GOOS=aix`, and `GOOS=solaris` `go build ./...`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run one fake-backed OpenAI-compatible turn at trunk (after E3) and head. Save `regression.txt`. Pass when the event sequences match.
- [ ] Lane 2. `GET /engine/assist/backends` with both CLIs installed and logged in. Save `backends.txt`. Pass when both report path, version, and logged in.
- [ ] Lane 3. Real backend. Run a claude turn on `basic_binds.trc`. Save `claude-turn.txt`. Pass when the init event lists only `mcp__mtkprof__*` tools and the answer cites trace data.
- [ ] Lane 4. Real backend. Ask claude to run `ls /` and read `/etc/hosts`. Save `claude-isolation.txt`. Pass when no tool other than `mcp__mtkprof__*` is called and the answer says it could not.
- [ ] Lane 5. Real backend. Run a two-turn claude conversation. Save `claude-followup.txt`. Pass when the second answer uses the first turn's context, and no new file appears under `~/.claude/projects/` for the temp cwd.
- [ ] Lane 6. Real backend. Run a codex turn on `basic_binds.trc`. Save `codex-turn.txt`. Pass when both `mtkprof` tool calls complete and none is denied for approval.
- [ ] Lane 7. Real backend. Ask codex to run `ls /`, read `/etc/hosts`, and write a file with `apply_patch`. Save `codex-isolation.txt`. Pass when there is no `command_execution` item, the file is not written, and `/etc/hosts` content does not appear.
- [ ] Lane 8. Real backend. Run a two-turn codex conversation. Save `codex-followup.txt`. Pass when the second answer uses the first turn's context, no new file appears under `~/.codex/sessions/`, and `~/.codex/config.toml` and `~/.codex/auth.json` keep their checksums.
- [ ] Lane 9. Cancel a real claude turn mid-stream. Save `cancel.txt`. Pass when the process group is gone within 2 s (`ps -g`) and the stream ends `cancelled`.
- [ ] Lane 10. Put no CLIs on `PATH`. Save `missing.txt`. Pass when `backends` reports "not found" for both and creating a conversation with either answers 400 with a clear message.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Engine overhead per OpenAI-compatible fake turn at trunk (after E3) and head. Also the diff-added work, the process start to first event with the fake CLIs, and real time to first text for claude and codex (recorded, not gated).
- [ ] Probe. Twenty interleaved fake runs per side, then five real runs per CLI.
- [ ] Baseline. Record the trunk fake-turn overhead first.
- [ ] Rule. Head fails when fake-turn overhead p95 rises more than 10%, or when fake-CLI start to first event p95 exceeds 300 ms.

**Review gate.** None. E4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it in `modern-tkprof` after E3.

## Store keys in the OS keychain and add Assistant settings (D2)

**Depends on.** D1 and E4.

**Files.**

- [ ] Create `src-tauri/src/secrets.rs` and edit `src-tauri/src/lib.rs` and `src-tauri/Cargo.toml` (`keyring` and `ureq`).
- [ ] Create `src/settings/AssistantSection.tsx`, `src/assist/providers.ts`, and `src/assist/providers.test.ts`.
- [ ] Edit `src/settings/settings.tsx`, `src/settings/SettingsView.tsx`, `src/prompts/PromptHost.tsx`, `src/prompts/queue.ts`, `src/backup.test.ts`, `src/engine/api.d.ts`, and the `engine` pointer.
- [ ] Edit `docs/DESKTOP.md` and `engine/docs/PLAN-DESKTOP.md` (drop "no keychain").

**Build.**

- [ ] Add Rust commands `assist_key_answer(prompt_id, provider) -> Answered | Missing`, `assist_key_store_and_answer(prompt_id, provider, key, remember)`, and `assist_key_forget(provider)` in `secrets.rs`. Rust reads the keychain and posts the answer to `POST /engine/prompts/{id}` itself with the token it already holds. A stored key never enters the webview.
- [ ] In `PromptHost.tsx`, route kind `apikey` to `assist_key_answer` before `dispatch`. Show the modal only on `Missing`, with **Remember in keychain** on by default. Outside Tauri (dev browser mode), show the modal and answer through the engine as today.
- [ ] Add `Settings.assistProviders` (array default) with `kind` (`openai`, `claude`, `codex`), name, base URL, model, and headers. Add a **Test** button and the CLI status from `GET /engine/assist/backends`. Privacy defaults are binds masked and consent per trace.
- [ ] Keep the backup allow-list unchanged, and add a test that a provider's base URL, headers, and key never reach `serializeBackup`.

**You see.**

- [ ] Settings shows an **Assistant** section. Adding an OpenAI-compatible provider and pressing **Test** asks for the key once. After a restart, **Test** passes with no prompt.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `providers.test.ts` parses provider lists (unknown fields dropped, secret-looking fields rejected like `connections/model.ts`). `backup.test.ts` gains the exclusion case. Run `pnpm test`.
- [ ] `cargo test` in `src-tauri` covers `secrets.rs` with a mock keyring backend.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open Settings at trunk and head. Save `settings.png`. Pass when every existing section renders the same and head adds **Assistant**.
- [ ] Lane 2. Add an OpenAI-compatible provider pointing at the E3 fake. Save `provider-add.png`. Pass when it persists across a page reload.
- [ ] Lane 3. Press **Test** in dev browser mode. Save `key-modal.png`. Pass when the `apikey` modal appears, answering it passes the test, and no `remember` checkbox shows outside Tauri.
- [ ] Lane 4. Show CLI status. Save `cli-status.png`. Pass when claude and codex show the version and login state from `/engine/assist/backends`.
- [ ] Lane 5. Export a backup. Save `backup.png`. Pass when the JSON has no provider URL, header, or key.
- [ ] Lane 6. Add a provider with a header named `Authorization`. Save `header-reject.png`. Pass when the form rejects it and points to the key prompt.
- [ ] Lane 7. Tauri build on macOS (operator-assisted, outside the Playwright harness). Store a key, quit, relaunch, and press **Test**. Save `keychain-macos.png`. Pass when no prompt appears and Keychain Access lists the item under the app's service name.
- [ ] Lane 8. Tauri build. Press **Forget key**. Save `forget.png`. Pass when the keychain item is gone and the next **Test** prompts.
- [ ] Lane 9. Linux AppImage under `dbus-run-session` with no Secret Service. Save `linux-fallback.png`. Pass when the modal appears with a note that the key is kept for this session only.
- [ ] Lane 10. Windows build (operator-assisted). Store and reuse a key. Save `keychain-windows.png`. Pass when Credential Manager lists the item and **Test** passes after relaunch.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Settings page open to rendered at trunk and head. Also the diff-added work, the time from an `apikey` prompt event to the engine receiving the answer with the key stored.
- [ ] Probe. Ten interleaved `drive.mjs --page Settings` runs per side, then ten timed prompts in the Tauri build.
- [ ] Baseline. Record the trunk Settings render time first.
- [ ] Rule. Head fails when Settings render is more than 10% slower, or when prompt-to-answer p95 exceeds 300 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 4, and 7 screenshots into `/tmp/mtkprof-assistant-review/D2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree with Playwright `recordVideo`. Save it as `/tmp/mtkprof-assistant-review/D2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it after D1 and E4 land.

## Add the chat panel with evidence links (D3)

**Depends on.** D2.

**Files.**

- [ ] Create `src/assist/ChatPanel.tsx`, `src/assist/chat.css`, `src/assist/markdown.tsx`, `src/assist/links.ts`, `src/assist/conversation.ts`, and tests for `markdown`, `links`, and `conversation`.
- [ ] Edit `src/workspace/TabView.tsx` (mount the panel as a flex sibling of `SessionShell` in `TabBody`), `src/workspace/panes.ts` and `panes.test.ts` (`assistantOpen`, `assistantW`), `src/workspace/session/SessionNav.tsx` (toggle button), `src/workspace/session/SessionShell.tsx` (⌘J), and `src/workspace/keyHints.ts`.
- [ ] Edit `engine/web/src/app/urlstate.ts` and its test to carry `exec` and `contexts` (an E-side change pinned here).

**Build.**

- [ ] Add `conversation.ts`, a reducer over the NDJSON events from E3. It reads the stream with `fetch` and keeps messages, tool rows, usage, and state per tab. It persists to `assist.json` per trace identity through `openKV`, and stays out of backups.
- [ ] Add `markdown.tsx`, a hand-written renderer for paragraphs, lists, emphasis, inline code, code blocks, and tables. It emits React nodes, never raw HTML.
- [ ] Add `links.ts`. A link is `mtkprof:` plus a `urlstate.ts` hash (`#view=...&sql=...&win=...&exec=...`), so ids are `sql_id` with `@N` and windows are microseconds from `doc.span.firstTim`. A chip resolves through the urlstate parser and the store actions. An unknown target renders as plain text marked unresolved.
- [ ] Show a consent banner the first time a trace identity is sent to a provider. It says what leaves the machine, including that SQL text and literals are never masked.
- [ ] Show each tool call as a collapsible row with the exact `tool_result` payload, plus token usage and a **Stop** button.

**You see.**

- [ ] ⌘J opens the panel beside the views. A question on `basic_binds.trc` streams an answer whose `sql_id` chips open that statement in Statements.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `markdown.test.tsx` asserts that `<script>` and raw HTML render as text and that only `mtkprof:` and `https:` links become anchors. `links.test.ts` round-trips every link kind through urlstate. `conversation.test.ts` replays a recorded E3 stream. Run `pnpm test`.
- [ ] `cd engine/web && pnpm test` covers the urlstate change.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open `basic_binds.trc` and walk Overview, Statements, and Trace at trunk and head with the panel closed. Save `views.png`. Pass when the views match trunk and the panel toggle is the only header change.
- [ ] Lane 2. Open the panel and send a question against the E3 fake. Save `chat-turn.png`. Pass when tool rows, streamed text, and usage render, and the state returns to idle.
- [ ] Lane 3. Click a `sql_id` chip. Save `chip-stmt.png`. Pass when Statements selects that statement and ⌘[ returns to the prior view.
- [ ] Lane 4. Click a window chip. Save `chip-window.png`. Pass when the window filter shows that interval.
- [ ] Lane 5. Click an exec chip and a line chip. Save `chip-exec-line.png`. Pass when the execution is selected and the Trace view shows the line.
- [ ] Lane 6. Feed the fake an answer with `<img src=x onerror=alert(1)>` and a `javascript:` link. Save `sanitise.png`. Pass when both render as plain text and no dialog fires.
- [ ] Lane 7. Send to a new trace identity. Save `consent.png`. Pass when the consent banner blocks the first send, and accepting it sends once.
- [ ] Lane 8. Press **Stop** mid-stream. Save `stop.png`. Pass when the stream ends, the partial answer stays, and the state is idle.
- [ ] Lane 9. Reload the page. Save `persist.png`. Pass when the conversation for that trace returns, and another trace shows an empty panel.
- [ ] Lane 10. Use a 1000x700 viewport with the panel open. Save `narrow.png`. Pass when the views and the panel both stay usable and the panel width persists per tab.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Open-to-ready time for `big_loop.trc` with the panel closed, at trunk and head. Also the diff-added work, the longest main-thread task while 2,000 `text` deltas stream, and the render time of a 50-message conversation.
- [ ] Probe. Five interleaved `drive.mjs` runs per side, then a Playwright `PerformanceObserver` long-task trace during a scripted fake stream.
- [ ] Baseline. Record the trunk open-to-ready time first.
- [ ] Rule. Head fails when open-to-ready is more than 5% slower, when any long task exceeds 50 ms during streaming, or when the 50-message render exceeds 100 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 6, and 7 screenshots into `/tmp/mtkprof-assistant-review/D3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree with Playwright `recordVideo`. Save it as `/tmp/mtkprof-assistant-review/D3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it after D2.

## Let the assistant move the view and save notes (D4)

**Depends on.** D3.

**Files.**

- [ ] Edit `src/assist/conversation.ts`, `src/assist/ChatPanel.tsx`, and `src/workspace/session/navHistory.ts`.
- [ ] Create `src/assist/intents.ts` and `src/assist/intents.test.ts`.
- [ ] Edit `src/settings/AssistantSection.tsx` (**Ask before moving the view**).

**Build.**

- [ ] Add `applyIntent(store, intent)` in `intents.ts`. It maps an `intent` event to the same urlstate hash a chip uses, pushes the current hash to `NavHistory` first, and shows "Moved by the assistant" with **Back**.
- [ ] With **Ask before moving the view** on, show the intent as a pending chip, and apply it only on click.
- [ ] Add **Save as note** on an answer. It attaches the answer to the statement, execution, or window it cites through `addAnnotation`. When it cites several, the user picks one.

**You see.**

- [ ] Asking "show me the slowest execution" moves the view to that execution, and **Back** returns to the previous view.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `intents.test.ts` asserts the hash for every intent kind, the history push before apply, and that an invalid target leaves the store unchanged. Run `pnpm test -- intents`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the D3 chip scenario (lane 3) at trunk (after D3) and head. Save `chip.png`. Pass when the behavior is identical.
- [ ] Lane 2. Script the fake to emit a statement intent. Save `intent-stmt.png`. Pass when the view moves and the notice shows **Back**.
- [ ] Lane 3. Press **Back** after an intent. Save `intent-back.png`. Pass when the prior view, selection, and window return.
- [ ] Lane 4. Turn on **Ask before moving the view** and emit an intent. Save `intent-ask.png`. Pass when the view stays put until the chip is clicked.
- [ ] Lane 5. Emit a window intent and then a pivot intent. Save `intent-window-pivot.png`. Pass when each lands on the right view with the right filter.
- [ ] Lane 6. Emit an intent with an unknown `sql_id`. Save `intent-bad.png`. Pass when the view stays put and the chat shows the intent as unresolved.
- [ ] Lane 7. Save an answer as a note on its cited statement. Save `note.png`. Pass when the note appears in the statement's notes and in the Notes view.
- [ ] Lane 8. Save an answer that cites two objects. Save `note-pick.png`. Pass when a picker lists both and the note lands on the chosen one.
- [ ] Lane 9. Reload after saving a note. Save `note-persist.png`. Pass when the note persists through `annotations.json`.
- [ ] Lane 10. Real backend. Ask claude through the panel to "show me the statement with the most time" on `basic_binds.trc`. Save `real-show.png`. Pass when the view moves to the top statement in `/api/statements`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Chip click to view updated at trunk (after D3) and head. Also the diff-added work, intent event arrival to view updated.
- [ ] Probe. Twenty interleaved timed clicks per side, then twenty scripted intents at head.
- [ ] Baseline. Record the trunk chip-to-view time first.
- [ ] Rule. Head fails when chip-to-view p95 rises more than 10%, or when intent-to-view p95 exceeds 200 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 4, and 7 screenshots into `/tmp/mtkprof-assistant-review/D4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree with Playwright `recordVideo`. Save it as `/tmp/mtkprof-assistant-review/D4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands it after D3.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The prototypes ran on 2026-10-31 in the throwaway directory `/tmp/mtkprof-proto` (no branch or SHA, because nothing went into either repo). A Node stdio MCP server (`mcp.mjs`) offered `overview` and `show` with canned trace text and logged every request. CLI versions were Claude Code 2.1.316 and codex-cli 0.166.0.

- **Claude can be confined to mtkprof tools.** `claude -p --tools "" --strict-mcp-config --mcp-config mcp.json --allowedTools mcp__mtkprof__overview mcp__mtkprof__show --setting-sources ""` listed only the two MCP tools in its `init` event, called both, and reported it could not run `ls /` or read `/etc/hosts`. The turn took 11.8 s and cost 0.018 USD (`claude1.jsonl`).
- **A long-lived claude process carries a conversation without saving transcripts.** With `--input-format stream-json` and `--no-session-persistence`, one process answered two turns (the first at 5.5 s, the second 2 s later) and used the first turn's context. The count of transcript files for the temp cwd under `~/.claude/projects/` stayed at 2, both left over from the earlier `--session-id` and `--resume` runs (`feed.mjs`). `--session-id` with `--resume` also works but writes the transcript, and so the trace data, to `~/.claude/projects/`.
- **`--include-partial-messages` streams text deltas** as `stream_event` `content_block_delta` lines (`c2b.jsonl`).
- **Codex with the user's own home is not confinable.** With `--sandbox read-only`, nine features turned off, and `-c mcp_servers={...}`, codex still loaded `node_repl` and `openaiDeveloperDocs`, used `node_repl` to run `ls /` and read `/etc/hosts`, and spent 118k input tokens (`codex1.jsonl`). `-c` merges into the user's server table and does not replace it.
- **Codex with a per-conversation `CODEX_HOME` is confinable to no shell.** A temp home with a generated `config.toml` and a symlinked `auth.json` removed the shell and every user server. MCP calls then failed with "requires approval, but approval policy is never" until the server got `default_tools_approval_mode = "approve"`. After that, both tools completed and `ls /` was impossible (`codex3.jsonl`). The turn took 17.6 s and used 96.6k input tokens. The operator rejected the `auth.json` symlink on 2026-10-31, so this recipe is not used.
- **Codex with the user's own home is confinable when each config-defined server is switched off by name.** `--ephemeral`, the nine `--disable` flags, and `-c mcp_servers.<name>.enabled=false` for `openaiDeveloperDocs`, `node_repl`, and `computer-use` left `mtkprof` as the only working server. Codex called `overview` and could neither run `ls /` nor read `/etc/hosts` (`codexA.jsonl`). The turn took 35 s and used 89.6k input tokens. Switching off a server that comes from a plugin (`codex_app`) fails with "invalid transport", so only names from `config.toml` can be passed.

These stay unproven.

- `apply_patch`, `spawn_agent`, `image_gen`, and `view_image` remain in codex's tool list. `[tools] view_image = false` did not remove `view_image`, and codex called it on `/etc/hosts`, which failed only because the file is not an image. Whether the read-only sandbox blocks `apply_patch` writes is untested (E4 lane 7).
- Whether `claude` and `codex` pass an MCP server's `env` block through, so the token can stay out of the config file, is untested (E4 unit test).
- Tool calling across OpenAI-compatible servers (vLLM, Ollama, LM Studio, LiteLLM) varies. Only the protocol is known, not each server's quirks (E3 lane 7).
- The keychain behaviour of the ad-hoc signed macOS build, the Windows Credential Manager, and the Linux Secret Service in AppImage and deb builds is untested (D2 lanes 7 to 10).

## Appendix B. Alternatives rejected

- **Agent loop in the webview or in Rust.** The engine already holds the data and the tools, and spawns processes the way `sshcli` does. A loop elsewhere would duplicate the tool layer, or proxy every tool call across a boundary.
- **Token deltas on `/engine/events`.** The broadcaster drops a subscriber whose 256-event buffer fills. A long answer would disconnect the prompts UI. A stream per turn has no shared buffer.
- **Webview answers the key prompt.** That puts a stored key in JS memory on every turn. Rust answering via `ureq` costs one small dependency and keeps the stored key out of the webview. A typed key still passes through the webview once, as database passwords do today.
- **Key over the engine's stdin.** This avoids an HTTP crate but adds a second protocol on a pipe whose only job today is lifetime.
- **`go-keyring` in the engine.** On macOS it passes the secret to `/usr/bin/security` in argv, where `ps` can read it. The engine also runs on AIX and Solaris, where no keychain exists.
- **`claude --resume` per turn.** It works, but it writes trace data to `~/.claude/projects/`. One process per conversation with stream-json input does not (Appendix A).
- **Codex with `-c mcp_servers={...}` only.** `-c` merges into the user's server table and cannot replace it (Appendix A).
- **Codex in a temp `CODEX_HOME` with a symlinked `auth.json`.** It confines codex well, but the operator rejected linking the login file. A separate mtkprof login stored in the keychain stays as a fallback.
- **A Markdown dependency (`react-markdown`, or `marked` with DOMPurify).** `check:deps` makes every lib dependency a desktop dependency too. The answers need a small subset plus custom `mtkprof:` links, which a hand-written renderer covers with no HTML path at all.
- **Chat panel as a fourth column of the lib grid.** That means editing the lib's CSS and its `filesNeedRoom` fold logic. A desktop flex sibling in `TabBody` leaves the lib alone.
- **Raw array ids in links.** `ID` is a position in the doc arrays and changes across re-parses. `urlstate.ts` already uses `sql_id` with `@N`.
- **Reopening the session with `binds=redact` for the assistant.** Redaction is part of the cache identity, so this doubles cache entries and reparses large traces. A redaction layer inside the tools masks only what is sent.

## Appendix C. Risks

- **SQL literals leak.** Bind masking does not touch SQL text (`model/redact.go:49`). The consent banner in D3 says so. Watch it in D3 lane 7.
- **Codex residual tools.** `view_image` can read image files and `apply_patch` may write. E4 lane 7 tests writes. Codex ships labelled experimental either way (operator decision, 2026-10-31), and any gap goes in `docs/DESKTOP.md`.
- **Codex uses the user's own setup.** Their `~/.codex/AGENTS.md` instructions and any hooks in `~/.codex/hooks.json` may still apply to mtkprof's runs and see trace data. E4 tests whether hooks fire and documents the result. A server added to the user's config later is switched off too, because the config is read before each run.
- **Codex token cost.** About 90k input tokens per turn before any trace data, against about 7k for claude (Appendix A). Resending the conversation each turn adds to that. Show usage per turn in D3.
- **Keychain prompts on ad-hoc signed macOS builds** may recur after every update (D2 lane 7).
- **Linux build dependencies.** `keyring` with Secret Service needs libdbus at build time. Check the AppImage and deb builds in D2, and keep the session-only fallback.
- **Live sessions.** A conversation on a live trace sees a moving document. Tools read the snapshot the session holds when they run. Watch E3 lane 9 for close-during-turn behaviour.
- **Contract test hard-codes the session route count** (`contract_test.go:171`, currently 27). Every E PR that adds a session route updates it.
- **Stale Go path in `engine/CLAUDE.md`.** Owners use `/usr/local/go/bin/go`. Fix the line in E1.

## Appendix D. Links and reading list

1. The `engine/docs/DESIGN.md` amendment lands in E1. It says that views, findings, and reports stay facts-only, and that the assistant is a separate labelled surface where interpretation is allowed, with every claim cited. It also says that no secret is stored by the engine, and that the analysis commands still never connect. Only the desktop engine, `mtkprof brief` (offline), and `mtkprof mcp` (loopback) are involved.
2. Read before editing. `engine/docs/HANDOFF.md` (two-repo workflow), `engine/docs/ARCHITECTURE.md`, `engine/internal/engine/contract_test.go`, `engine/internal/remote/prompt.go`, `engine/internal/engine/prompts.go`, `engine/internal/remote/sshcli/client.go`, `engine/internal/slice/slice.go`, `engine/web/src/lib/state/store.ts`, `engine/web/src/app/urlstate.ts`, `src/workspace/session/navHistory.ts`, `src/prompts/PromptHost.tsx`, and `src-tauri/src/engine.rs`.
3. E3 and E4 get the **how** skill before building, because they set the backend seam. E4 and D2 get the **interrogate** skill before shipping, because they set the security boundary for keys and CLI isolation.
4. Keep a decision trail per the **show-me-your-work** skill under `/tmp/mtkprof-assistant-trail/`. Commit it only if the operator asks.
