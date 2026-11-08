# Desktop performance and UX review — validation and implementation handoff

- Reviewed: 2026-11-08
- Version: **v0.6.0**
- Baseline: **`89f91c2b1b3a55e9e3fd055a3d0996798bb75eaf`**
- Handoff branch: **`docs/desktop-performance-ux-review-2026-11-08`**
- Second review: 2026-11-08, Claude (Fable 5.1), at `710a9f8` (same source tree as the baseline for every file cited). Every finding was re-read against the code; the verdicts, corrections and additions are the blockquotes headed **Second review** under each finding, the new findings F13–F14, and the implementation plan at the end.

## Purpose and evidence boundaries

This document records all **14 findings**: the 12 of the desktop performance and UX re-review (F01–F08 were reported in the earlier review and remain present at the baseline above; F09–F12 were identified while reviewing the new Cut workflow) and two added by the second review of 2026-11-08 (F13, F14). No fixes have been implemented as part of either review.

The next agent should validate each finding against its current checkout, fix confirmed issues, and record the evidence and commit for each disposition. Proposed fixes below are design directions, not proof that one implementation is required.

The review combined a primary performance/code review with two independent UX assessments. Evidence consists of current source inspection, existing automated tests, and focused in-memory reproductions. It does **not** establish rendered layout, screen-reader behavior, perceived latency, large-trace memory use, or successful native update installation.

Evidence labels used below:

- **Source-confirmed:** the control/data flow is present in the code. End-to-end UI behavior still needs a targeted reproduction.
- **Focused reproduction:** a narrow probe exercised the implementation with mocked dependencies; this is not a complete desktop test.
- **Performance risk:** avoidable work or missing bounds are established, but the user-visible cost has not been measured.

Source line numbers refer to the baseline and will drift. Links are relative to this document; use the named functions and expressions to locate the current implementation.

## Execution guidance

1. Check the current branch, working tree, and relevant instructions before editing. Preserve unrelated work. The user's repository instruction requires permission before potentially harmful actions.
2. Reproduce with disposable trace fixtures, mocked failures, and an isolated app profile when appropriate. Do not overwrite a user's traces, clear real credentials, install an update, or restart a working user's engine merely to validate this report.
3. Mark each item **confirmed**, **fixed**, **not reproducible**, or **deferred with evidence**. A passing existing suite alone does not invalidate a finding.
4. For correctness fixes, add a regression test that exercises the failure and then verifies the intended behavior. For performance risks, measure representative workloads before choosing a larger redesign.
5. Keep changes scoped. Preserve useful existing behavior: virtualized lists, bounded line caching, cancellation of stale requests, per-trace navigation history, pane persistence, and explicit progress/error surfaces.
6. Record exact commands, relevant results, remaining runtime checks, and implementation commit(s) in the tracking table. Do not mark an item fixed solely because a code path looks different.

Suggested order: **F09 → F01 → F02 → F10/F11 → F03 → F08 → F05 → F04/F06 → F07/F12**. F10 and F11 share the Cut plan/query identity problem and should be designed together. F01 and F05 both touch source-query behavior; coordinate their cancellation and retained-data contracts. F09 is independent of preview correctness. *Second review:* the implementation plan at the end of this document supersedes this order with seven phases (Cut correctness first, then scope trust, opening, work preservation, prompts, search cost, keyboard); it keeps the pairings named here.

## Tracking

| ID | Priority | Finding | Review disposition | Executor result / evidence / commit |
|---|---|---|---|---|
| F01 | High | Filtered results can describe a different scope | Still present; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 2 |
| F02 | High | File drop ignores displayed opening options | Still present; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 3 |
| F03 | High | Navigation discards unfinished work | Still present; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 4 |
| F04 | Medium | Restore starts all traces concurrently | Still present; performance risk | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 3 |
| F05 | Medium | Concurrent identical queries duplicate work | Still present; focused reproduction | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 2 |
| F06 | Medium | Statement search filters and sorts synchronously | Still present; performance risk | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 6 |
| F07 | Medium | Connections and tables have keyboard gaps | Still present; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 7 |
| F08 | Medium | Failed credential submission loses its prompt | Still present; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 5 |
| F09 | High | Repeated cuts overwrite output and reuse old results | New; source-confirmed plus focused tab-reuse reproduction | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 1 |
| F10 | Medium | Cut export can differ from the displayed preview | New; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 1 |
| F11 | Medium | Cut auto-validation uses stale size; reparse cannot cancel | New; source-confirmed performance risk | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 1 |
| F12 | Medium | Cut picker can omit its actual target statement | New; source-confirmed | Pending · confirmed 2026-11-08 at 710a9f8 · plan phase 1 |
| F13 | Medium | `/api/cut/check` is unbounded on the engine: full-facts build, no size or concurrency guard | New (second review); source-confirmed | Pending · plan phase 1 |
| F14 | Medium | Statement detail retains another statement's executions and waits while loading | New (second review); source-confirmed | Pending · plan phase 2 |

## F01 — Filtered results can represent the wrong scope

**Impact:** A DBA changes the time window, files, or session contexts and can read statistics or findings from a previous selection as though they describe the new one. This undermines the reliability of the analysis, even if the next successful response eventually corrects it.

**Evidence:**

- [source.ts](../web/src/lib/data/source.ts), `useSourceQuery`, lines 763–782: a matching `keep` string retains previous data across query-key changes; `loading` becomes true.
- [Waits.tsx](../web/src/lib/views/Waits.tsx), lines 18–23: the profile query uses constant `keep='profile'`. The view renders retained results. When no data is available after a failed query, it uses `doc.stats.events` instead.
- The Waits header/table at lines 38–41 does not communicate pending or failed query state. Consequently, that fallback silently presents whole-trace numbers under an active scope.
- [scopedfindings.ts](../web/src/lib/data/scopedfindings.ts), lines 24–31: constant `keep='findings'` retains old results, and existing `q.data` produces `narrowed: true`, including while loading.
- [Findings.tsx](../web/src/lib/views/Findings.tsx), line 30: the narrowed branch labels those findings using the current selection.

**Important qualification:** The main Findings view does show a whole-set fallback notice for certain failures and unsupported endpoints. Do not describe all its error states as silent. The retained-data transition is the confirmed gap. Some consumers, including Statements, consume `.findings` without the notice; inspect those while fixing the contract.

**Reproduce:**

1. Use a remote source with two scopes that yield visibly different values.
2. Load scope A completely; delay the response for scope B.
3. Switch to B and inspect Waits and Findings before its response arrives.
4. Separately reject the Waits profile request while a narrow scope remains selected.

**Fix direction:** Make the provenance of displayed data explicit. Either clear data on incompatible scope changes or retain it with its original scope and a visible stale/loading state. Never silently substitute whole-trace statistics for a failed scoped query. Preserve useful retained data during a same-scope live revision without mislabeling it.

**Acceptance checks:**

- A→B pending results are blank/loading or explicitly labeled as A; they are never presented as settled B results.
- Failure and unsupported-endpoint states identify any whole-trace fallback.
- Late A responses cannot replace B results.
- Empty selections and same-scope live refreshes work correctly.
- Test the transition in a mounted hook/view harness: the current static-render readiness tests do not exercise a settled A→pending B transition.

> **Second review — confirmed, with two additions.**
>
> - The three code points hold as described: `useSourceQuery` returns the previous answer whenever the `keep` strings match, whatever the key; `Waits` falls back to `doc.stats.events` when a scoped profile fails (silently: no notice, the header still says "Wait events" with the window active); `useScopedFindings` reports `narrowed: true` for retained data of another scope while the new one loads, and `Findings` labels it with the *current* selection.
> - Who uses `keep` today (grep `useSourceQuery(` in `web/src/lib`): `profile` (Waits), `findings` (scoped findings), `top` (`useScopeResponse` in `ResponseMini.tsx`: the response-time bar of the shell header shows the previous session selection's numbers while the new one loads), `roles` (Overview, Lanes, Statements: colours only, harmless), `spans` (Lanes), `hlmarks` (Lines), `waits` (StatementContext, StatementDetail), `executions` and `detail` (StatementDetail). The last three retain across *statements*, not scopes: see F14.
> - `useScopedStatements` deliberately passes no `keep` ("Never retain another scope's totals") and shows an explicit notice on failure: that is the contract the other consumers should get, so the fix is a hook-level one, not per view.
> - Acceptance check "late A responses cannot replace B" already holds: the effect aborts the stale request and the resolution path checks `ac.signal.aborted`. The regression test should lock it in rather than fix it.
> - The hook already knows when it is showing another key's data (`st.key !== key`); the smallest contract change is a `stale: boolean` on `QueryState` plus a rule that a view must never label stale data with the current scope. Clearing on scope change (no `keep`) is right for numbers; keeping with a visible stale state is right for decoration.
> - Test harness: both vitest projects run in the `node` environment with `renderToStaticMarkup` only, so a settled-A → pending-B transition cannot be mounted. Either add `jsdom` to the workspace catalog, or extract the pure "what to show" selection from the hook (`queryView(st, source, key, keep)`) and unit-test that. The plan takes the second route.

## F02 — File drop ignores the opening screen's options

**Impact:** The same file is opened differently depending on whether the user chooses it with the picker or drops it. Bind values may be retained despite selecting redaction or omission on screen; follow mode can also be ignored. This report does not claim an external disclosure occurred.

**Evidence:**

- [OpenScreen.tsx](../desktop/src/workspace/OpenScreen.tsx), lines 20–34: local `binds`, `salt`, and `follow` state forms the options used by picker/path submission.
- Line 71 invites users to drop files anywhere on the window.
- [App.tsx](../desktop/src/App.tsx), `DropTarget`, lines 112–118: drop reads global `settings.binds`/`settings.salt` and passes no `follow` option.

**Reproduce:** Set global defaults to keep binds. On the opening screen choose redact or none, then drop a disposable trace containing identifiable test bind values. Compare the opening request with the picker path. Repeat with follow selected and a supported single-file trace.

**Fix direction:** Use one authoritative opening-options contract for all input methods on the opening screen. Define the behavior of drops from other pages explicitly; global defaults may still be appropriate there.

**Acceptance checks:**

- Picker, text path, and drop produce equivalent options for the same visible choices.
- Redaction salt and follow constraints are applied consistently.
- Settings changes and opening-screen unmount/remount do not accidentally leave stale options in a global drop listener.
- Drops outside the opening screen have documented, predictable behavior.

> **Second review — confirmed.** `DropTarget` in `App.tsx` reads `settings.binds`/`settings.salt` and never passes `follow`; `OpenScreen` keeps `binds`, `salt`, `follow` in component state that nothing else can read. A third opener, the connections bridge (`WithConnections.openPaths`), also uses the global defaults: that one is defensible (no opening screen is visible) and should be documented as such rather than changed.
>
> Fix shape: lift the three options out of `OpenScreen` into the workspace snapshot (`openOptions`, not persisted), let `DropTarget` use them when `route.kind === 'open'` and the global defaults otherwise, and say which applies in the drop overlay text ("opens with the options above" / "opens with the default options"). `follow` must stay single-file: a multi-path drop with follow on should fall back to a plain open with a notice, not fail.

## F03 — Navigation discards unfinished work

**Impact:** Switching trace tabs, visiting a desktop page, or closing the assistant can discard unsent text. Statement list controls also reset, forcing users to reconstruct their investigation.

**Evidence:**

- [App.tsx](../desktop/src/App.tsx), `Routed`, lines 94–96: only the active keyed `TabView` is mounted.
- [TabView.tsx](../desktop/src/workspace/TabView.tsx), line 43: the comment explicitly documents remounting; lines 74–77 conditionally mount the assistant.
- [ChatPanel.tsx](../desktop/src/assist/ChatPanel.tsx), line 303: draft is component-local `useState('')`.
- [Note.tsx](../web/src/lib/components/Note.tsx), line 19: unsaved note text is component-local state.
- [Statements.tsx](../web/src/lib/views/Statements.tsx), lines 42–44: search, hide-SYS, and sort are local state.

**Qualification:** Sent chat messages, saved notes, session selection, and persisted pane settings are distinct. Do not claim those are all lost.

**Reproduce:** Type an unsent message or unsaved note, switch to another trace and back, or visit Settings and return. Separately collapse/reopen the assistant. Set a statement search/sort and repeat a trace-tab switch.

**Fix direction:** Store drafts and investigation controls at an appropriate per-trace/session scope that survives view unmounting. Key note drafts by note/target identity. Avoid keeping every heavy view mounted merely to retain text. Decide separately whether process-restart recovery is desired; navigation preservation does not require persisting sensitive draft text to disk.

**Acceptance checks:**

- Drafts survive tab/page changes and assistant collapse.
- Drafts do not leak between traces or note targets.
- Sending/saving/cancelling clears the appropriate draft deliberately.
- Closing a trace has a defined draft-disposal or recovery policy.
- Search, sort, and hide-SYS survive navigation, and document refreshes handle obsolete selections safely.

> **Second review — confirmed.** `Routed` keys `TabView` by tab, so every switch remounts the whole tab body; `ChatPanel` keeps `draft` in `useState`; `NoteEditor` keeps `draft` in `useState`; `Statements` keeps `q`, `hideSys`, `sortKey` in `useState`. The per-tab session store (`web/src/lib/state/store.ts`) does survive the switch, as the review says.
>
> Where the state should live (all of these homes already exist, so no new lifecycle is needed):
> - Chat draft: the per-tab chat store, `chatOf(tab.key, identity)` in `desktop/src/assist/conversation.ts`, which `Workspace.close` already drops with `closeChat`. Add `draft` to its snapshot, cleared on send.
> - Statement list controls: the session store, next to `inclusive` (which already survives). The CLI's web UI gets the same benefit. Keep `listW` where it is (`usePersisted`).
> - Note drafts: a `noteDrafts: Map<string, string>` in the session store keyed by `${kind}:${target}` (`NoteEditor` is mounted from Lines, Timeline, StatementDetail and the desktop's AnnotationsView). Save/cancel/delete clear the key. Nothing goes to disk.

## F04 — Workspace restoration starts every saved trace concurrently

**Impact:** A workspace containing many distinct cold, large traces can start simultaneous parsing/indexing and document loading. This can create CPU, disk, and memory competition before the active trace becomes usable. The review did not measure peak memory or demonstrate an out-of-memory failure.

**Evidence:**

- [workspace.ts](../desktop/src/workspace/workspace.ts), `restore`, lines 646–655: maps every saved trace into `open()` immediately.
- `open()`, line 475: starts asynchronously without a queue. `bind()`, lines 178 and 185, also starts eligible tabs together during binding/restart.
- [session.go](../internal/engine/session.go), line 288: each open launches `go s.runOpen(ss)`.
- [cache.go](../internal/engine/cache.go), `OpenTrace`, lines 731–780: concurrent builds are coalesced by identical content identity; this does not bound work across distinct traces.

**Validate:** Use a controlled workspace with several distinct traces. Measure active-tab-ready time, concurrent opens/builds, peak process memory, and total restore time for cold and warm caches. Use an isolated cache rather than clearing the user's cache.

**Fix direction:** Restore the active trace first, then use a bounded queue or lazy background opening. Consider whether a global engine build limit should also protect multi-file opening and restart paths.

**Acceptance checks:**

- Concurrency is bounded across distinct restoration requests.
- Active-tab priority works; failures or cancellation do not stall the queue.
- Closing a queued tab prevents its later opening.
- Engine restart and warm-cache restoration remain correct.
- Report measured tradeoffs rather than asserting a universally faster queue size.

> **Second review — confirmed, plus one more path.** `restore` maps every saved set into `open()`, each of which calls `start()` at once; `bind()` after an engine restart does the same for every tab (`for (const t of this.snap.tabs) ... void this.start(t.key)`). On the engine, `POST /engine/sessions` launches `go s.runOpen(ss)` per session with no semaphore; `Cache.OpenTrace` coalesces only identical content identities.
>
> `start()` already handles a tab closed meanwhile (it deletes the session it just got), so a client-side queue only has to re-check `this.tab(key)` when dequeuing. Recommendation: a small `OpenQueue` in `workspace.ts` with the active tab first and two concurrent starts, used by `restore` and the restart branch of `bind`, and no engine change until a measurement says otherwise. Measure with three or more distinct fixtures from `testdata/traces/19c` on a cold isolated cache (`-cache /tmp/...`): time to active-tab ready, total restore time, peak RSS of the engine.

## F05 — Concurrent identical queries duplicate backend work

**Impact:** Multiple consumers asking for the same uncached data can trigger repeated engine scans and duplicate serialization/transport work. The result cache only helps once one request has completed.

**Evidence:** [source.ts](../web/src/lib/data/source.ts), `RemoteSource.get`, lines 524–540: checks the completed-response cache, then independently fetches and decodes; no in-flight request map exists. Some query endpoints perform substantial scans, including findings in [findings_on.go](../internal/analyze/findings_on.go).

**Focused reproduction:** The actual `RemoteSource` implementation was bundled in memory and supplied a mocked client returning `{findings: []}` after a short delay. `Promise.all([source.findings(scope), source.findings(scope)])` produced **2 transport calls**. A third call after completion left the count at **2**, confirming that completed caching works. This was not an engine latency benchmark.

**Fix direction:** Coalesce in-flight requests by the complete request identity within the appropriate document/source revision. Preserve the existing bounded completed-response cache. [linecache.ts](../web/src/lib/data/linecache.ts) offers a local reference for shared loads and cancellation behavior; reuse the principle, not necessarily the implementation.

**Acceptance checks:**

- Two simultaneous identical requests make one transport call and both receive the result.
- Different query parameters and document revisions remain isolated.
- Cancelling one consumer does not cancel work still needed by another.
- When every consumer cancels, unnecessary transport work can stop.
- Failed/aborted requests do not poison future retries, and in-flight entries are removed after settlement.
- Existing completed-cache eviction behavior is retained.

> **Second review — confirmed, and it happens in the app today, not only in a probe.** `roles:${scopeKey(scope)}` is asked with the identical key by Overview, Lanes and Statements; on every scope change the ones mounted fire separate `api/statements/roles` requests. The engine has the same shape: `slice.Server.wrap` caches a response by URL only after it completes, so concurrent identical requests each compute.
>
> Fix in `RemoteSource.get` first (one place, ~20 lines): an `inflight: Map<key, {promise, controller, waiters}>`; a consumer's abort removes one waiter and aborts the shared request only when none are left (`linecache.ts` has this pattern). A server-side singleflight in `wrap` is a later, optional step.

## F06 — Statement search does full synchronous processing on each keystroke

**Impact:** Searching a large set of distinct, long SQL statements can occupy the UI thread. List virtualization bounds rendered rows but does not bound filtering and sorting cost.

**Evidence:** [Statements.tsx](../web/src/lib/views/Statements.tsx), lines 53–63: a memo dependent on the query filters all statistics, lowercases SQL IDs/text during matching, and sorts the resulting array. Each keystroke changes the dependency. Virtualization begins at line 82.

**Validate:** Profile query changes using representative statement counts and SQL lengths. Include broad matches that retain most rows. Separate input responsiveness, filter/sort time, and DOM rendering time. No latency threshold or timing was established by this review.

**Fix direction:** Precompute normalized search text per document, separate stable sorting from query filtering where semantics permit, and defer expensive result updates while keeping typing responsive. Introduce a worker only if measurements justify it.

**Acceptance checks:**

- Search results, ordering, tie-breaking, hide-SYS, and inclusive/self semantics remain unchanged.
- Search text updates immediately; any delayed results have a clear pending state if needed.
- Indexes refresh when the document changes and are not retained indefinitely for closed traces.
- Compare measured interaction costs before and after on the same workload.

> **Second review — confirmed, severity unmeasured.** The memo lowercases `sqlId` and `text` of every statement per keystroke and sorts the result; it also re-runs on `inclusive`, `sort` and `stats` changes, which is fine. Plan: a `WeakMap<TraceDoc, string[]>` of pre-lowercased `sqlId + ' ' + text`, and `useDeferredValue(q)` so typing stays responsive while the list lags one frame. Measure first on the fixture with the most statements (`ls -S testdata/traces/*/` and the `statements` count in `api/doc`) and record the numbers in the tracking table; a worker is not justified without them.

## F07 — Connections and tables have keyboard navigation gaps

**Impact:** Keyboard-only users cannot reliably select another connection, begin row selection in an unselected table, or activate column sorting.

**Evidence:**

- [ConnectionsView.tsx](../desktop/src/connections/ConnectionsView.tsx), lines 82–106: connection options are click-handled `<li role="option">` elements without focus/key handling.
- [DataTable.tsx](../web/src/lib/components/DataTable.tsx), lines 61–65: keyboard handling returns immediately when `selectedKey == null`.
- Lines 74–76: sortable `<th>` elements have click handlers but no keyboard-operable control.

**Reproduce:** With multiple connections, use only Tab/arrows/Enter to select a noninitial connection. Focus a table with no selected row and press an arrow. Attempt to change its sort without a mouse.

**Fix direction:** Use native interactive controls or complete the chosen listbox/table keyboard pattern. Define initial selection, focus movement, selection announcement, and sorting controls rather than adding arbitrary tab stops to everything.

**Acceptance checks:**

- Keyboard users can choose any connection and see where focus is.
- An initially unselected table supports starting and moving selection, including virtualized offscreen rows.
- Sort controls are reachable and announce their state.
- Embedded row controls retain their own keyboard behavior.
- Validate with a native desktop keyboard walkthrough and, where available, a screen reader.

**Related new surface:** Cut's piece labels/bands at [CutView.tsx](../desktop/src/workspace/session/cut/CutView.tsx), lines 470–475 and 542, use mouse interaction to choose the explanation/source jump. Include a keyboard-operable way to inspect those pieces when addressing accessibility. This is an extension of the same category, not a claim that the entire Cut workflow is inaccessible.

> **Second review — confirmed, with more of the same kind.**
>
> - `ConnectionsView`: `<li role="option">` with `onClick` only; no `tabIndex`, no key handler, no `aria-activedescendant`.
> - `DataTable`: `onKey` returns when `selectedKey == null`; `<th>` has `aria-sort` and `onClick` but no focusable control; the scroll container has `tabIndex={0}` without a role or name; `<tr aria-selected>` is ignored by assistive technology outside a `grid`/`listbox`.
> - `Statements`: the search input has only a placeholder (confirmed, no label); list rows are `role="button" tabIndex={-1}`, acceptable because `j`/`k`/arrows work from anywhere outside inputs, but say so in a `title` or a visible hint.
> - `ResizeHandle`: `role="separator"`, `aria-orientation`, `aria-label`, `tabIndex` are there; `aria-valuenow/min/max` are not (the review's lower-confidence note holds).
> - Cut pieces (`Bands`, label groups): `onMouseEnter`/`onClick` only. A `tabIndex={0}` + Enter/arrow on the label groups, which are already the readable targets, is enough.

## F08 — Failed credential submissions disappear without recovery

**Impact:** A job can remain waiting for credentials after its prompt has disappeared, leaving no visible retry path.

**Evidence:** [PromptHost.tsx](../desktop/src/prompts/PromptHost.tsx), lines 62–74: `send()` dispatches `answered` before awaiting the keychain/API operation. Non-404 errors are only logged. The engine can replay open prompts on stream reconnection, but that is not immediate recovery while the stream stays connected.

**Reproduce:** With fake credentials and a mocked transport, reject prompt submission with a non-404 error while keeping the event stream connected. Inspect the prompt queue and user-visible state. Test API-key/keychain and ordinary remote prompt paths separately.

**Fix direction:** Keep an explicit submitting state until acknowledgement or an authoritative closed event. On failure, show an actionable error and retry. Avoid logging or unnecessarily persisting secrets. A 404 can still mean that the prompt was answered elsewhere or expired.

**Acceptance checks:**

- Double submission is prevented while a request is pending.
- A non-404 failure leaves an actionable prompt/error instead of silently removing it.
- Successful responses and authoritative close events remove it exactly once.
- Expiry, cancellation, queue advancement, and reconnect replay work without duplicate prompts.
- Credentials are neither logged nor stored in general-purpose draft state.

> **Second review — confirmed exactly.** `send()` dispatches `answered` before the await; a non-404 error is only `console.warn`ed; the queue reducer has no in-flight state. Two more notes: in the app an `apikey` answer goes through `assistKeyStoreAndAnswer`, which stores the key in the keychain before (or regardless of) the engine accepting it, so a transport failure leaves a stored key and an open prompt; and a retry after a failure that did reach the engine is safe because the engine answers 404 for an already-answered prompt (treat 404 as "closed", as today).
>
> Fix: two reducer actions, `sending {id}` and `failed {id, error}`; the modal disables its buttons while sending and shows the error with the fields kept, Retry re-sends, Cancel sends a cancel. `queue.test.ts` covers the reducer; the modal's error state needs a screenshot.

## F09 — Repeated cuts overwrite prior output and show old parsed results

**Impact:** “Open as new tab” can overwrite an earlier generated cut but show the already-open session for its old contents. Users may believe they are analyzing the new selection. Earlier generated cut files are not preserved. The original input trace is not the file being overwritten in this path.

**Evidence:**

- [CutView.tsx](../desktop/src/workspace/session/cut/CutView.tsx), line 132: deterministic `${traceStem(doc, tab)}-cut.trc` output name.
- Lines 151–154: `openNew()` writes that name under the `cuts` cache directory.
- [files.ts](../desktop/src/files.ts), `writeCached`, lines 45–52: joins the fixed directory/name and writes to that path.
- `CutView.openTab()`, line 141, calls `ws.openOrShow()`.
- [workspace.ts](../desktop/src/workspace/workspace.ts), lines 479–485: an existing paths/options match is activated without a new parse or document refresh. Content identity is not checked there.
- [useTab.ts](../desktop/src/workspace/session/useTab.ts), `traceStem`: directory information is removed, so unrelated input traces sharing a basename can also collide.

**Reproduce:**

1. Open source A, choose window A1, and use “Open as new tab.” Wait for its results.
2. Return to A, choose a different window A2, and open another cut.
3. Compare the number of tabs, generated output path/content, and displayed statistics.
4. Repeat with two input traces in different directories that share a basename.

**Focused reproduction:** The actual Workspace class was transpiled in memory with storage/dependencies mocked. Two `openOrShow()` calls using the same cut path/options returned the same key, left the tab count at **1**, and retained the first session object. File replacement itself is source-confirmed; no user's files were overwritten by the review.

**Fix direction:** Give every generated cut a unique cache pathname, preserving a readable display name if desired. Do not reuse or replace files referenced by existing sessions. Review cleanup/retention independently so newly unique outputs do not grow without a policy.

**Acceptance checks:**

- Different cuts open independent parsed results and leave earlier cut files unchanged.
- Equal basenames from different sources cannot collide.
- Failed writes do not leave a previous valid cut truncated or replaced.
- Reopening an existing saved file intentionally can still use the ordinary deduplication behavior.
- Closing/restarting the app handles generated-file lifetime predictably.

> **Second review — confirmed, and the consequence is worse than described.** Besides the tab reuse, the first cut's *open engine session* reads its lines from the path: the engine's line endpoints go through `trace.LineIndex` (`OpenLineIndex`/`LoadLineIndex` in `internal/trace/lineindex.go`) which opens the trace file by path, so overwriting `<stem>-cut.trc` in place makes the already-open tab's Lines and Trace views read the *new* bytes at the *old* offsets (garbage lines; needs a reproduction). A later reopen of that tab from the cache fails `LoadLineIndex`'s check ("is not the file the index was built from") and rebuilds, which is the expected guard working.
>
> Two more paths share the root cause: "Save as…" to a path that is already open followed by "Open it in a new tab" takes the same `openOrShow` route; and `openOrShow` is the right behaviour for files opened from the Finder or the CLI, so the fix is a unique name, not a change to `openOrShow`.
>
> Fix: `cuts/<stem>-cut-<yyyymmdd-hhmmss>[-n].trc` (`safeFileName` already applied), the display name unchanged in the header. Retention: on startup, delete files in the app's `cuts` folder that no tab in `workspace.json` references and that are older than 7 days (the folder is app-owned; say so in `docs/DESKTOP.md`). Write to a temporary name and rename, so a failed write cannot truncate anything.

## F10 — Cut exports can differ from the preview being displayed

**Impact:** Users can approve/export a cut while viewing a plan for different options or a different selection. The export request uses the current query; the problem is that its preview is stale and undisclosed.

**Evidence:** [CutView.tsx](../desktop/src/workspace/session/cut/CutView.tsx):

- `useJSON`, lines 32–45, retains `st.data` while a changed path is loading.
- Lines 112–113 assign that retained plan to `p`.
- Lines 185–208 render the map and cards from `p`; the planning message at lines 188–189 appears only if no plan exists.
- Export buttons at lines 182–183 check only `!p` and `busy`.
- `fetchFile()`, lines 134–136, requests the new `query`.

**Reproduce:** Load one plan, delay the next plan request, change the window/statement/bind/edge options, and activate Save or Open before the new plan arrives. Compare the plan shown with the outgoing export query. Use a stubbed destination in an automated test.

**Fix direction:** Associate each plan with the query and source revision that produced it. Either block export until a current plan is ready or explicitly bind export to the reviewed plan. Make retained previews visibly pending. Check out-of-order completion and the success path's missing abort guard while updating `useJSON`.

**Acceptance checks:**

- A pending or failed plan cannot silently authorize an export based on a different query.
- Preview, selection labels, validation, and export refer to the same selection/options.
- Rapid changes and late responses cannot regress the displayed plan.
- Same-query document/client changes refresh or invalidate data appropriately.
- F11 uses the same current-plan identity contract.

> **Second review — confirmed.** `useJSON` returns `st.data` while `st.path !== path`; `p` is that retained plan; "Save as…" and "Open as new tab" are enabled on `!!p`; the export fetches the *new* query. One more hole in `useJSON`: its success path sets state without checking `ac.signal.aborted` (benign today because an aborted `fetch` rejects, but a settled `r.json()` racing the abort can still land).
>
> Fix: make `useJSON` return `{ data, path: forPath, loading, error }` and let the view compute `const current = plan.path === planPath ? plan.data : undefined`; buttons and `autoCheck` use `current`; the map keeps drawing the retained plan dimmed with a "Planning…" badge so the layout does not jump. F11 and F12 use the same `current`.

## F11 — Cut automatic validation uses stale size, and reparse cannot cancel

**Impact:** Changing a small cut to a large cut can start an expensive automatic validation even though the new output exceeds the intended automatic-check size. Once its reparse has started, aborting the request does not stop that phase. Repeated changes can leave obsolete CPU/memory work running. Actual peak memory and overlap were not measured.

**Evidence:**

- [CutView.tsx](../desktop/src/workspace/session/cut/CutView.tsx), lines 112–116: `autoCheck` uses `p.bytes < (256 << 20)`, but `p` can be the retained previous plan. The check URL uses the new query with a 300 ms debounce.
- [plan.go](../internal/cut/plan.go), `Cutter.Check`, lines 321–339: writes a temporary cut, then calls `model.Build(path, model.Options{})` at line 335.
- [builder.go](../internal/model/builder.go), `Build`, and [files.go](../internal/model/files.go), `BuildFiles`: that parse is not passed the request context. Default options also build full facts rather than an aggregation-only result.
- The temporary output is removed on return; this finding is not a claim that temp files are permanently leaked.

**Reproduce/measure:**

1. Settle a small plan that qualifies for automatic validation.
2. Expand to an output over 256 MiB and delay the new plan beyond the validation debounce.
3. Verify whether `/api/cut/check` is requested before the new plan size is known.
4. Separately instrument a check after it reaches reparse, cancel/change the UI selection, and observe whether that obsolete parse stops.

**Fix direction:** Require a current-query plan before evaluating automatic-check eligibility. Make the expensive parse phase cancellation-aware and consider bounding/coalescing validation work. Decide whether comparison can use a lower-memory build without weakening its correctness checks. Keep explicit user-requested validation of large outputs available with appropriate progress/cancel behavior.

**Acceptance checks:**

- A stale small plan never causes automatic validation of a new large selection.
- Manual validation targets the current selection and reports its status accurately.
- Cancellation reaches every expensive phase, including reparse, and temp files are cleaned up.
- Obsolete checks do not accumulate during repeated edits.
- Record representative CPU/memory/concurrency measurements before asserting the performance impact is resolved.

> **Second review — confirmed, with a server-side half that the review only hints at (now F13).** `autoCheck` reads `p.bytes` of the retained plan; the 256 MiB guard exists only in the client; `Cutter.Check` calls `model.Build(path, model.Options{})`, a full-facts build with no context. It also runs for `p.lines === 0` plans (an empty cut: pointless temp file and parse).
>
> The engine already has the cancellation pattern this needs: `internal/engine/session.go` wraps the spill sink in a `cancelSink` that checks the context every 4096 facts and unwinds the build with a panic recovered by `buildFiles`, because "the builder has no context of its own". The cleaner fix is a `Ctx context.Context` on `model.Options` checked in `progressReader.Read` (`internal/model/progress.go`; `BuildFiles` wraps the reader only when `OnProgress` is set, so wrap it when either is set): every build becomes cancellable at I/O granularity, the engine can drop `cancelSink` later, and `Check` passes its request context. `compare()` needs only per-(statement, call kind) counts and µs, wait count and µs, the first wall clock, statement and unknown-line counts: an `Aggregate` build with a small `Sink` gives a bounded-memory check without weakening it.

## F12 — Cut's statement picker can omit its actual target

**Impact:** The selected statement can be absent from the dropdown even while its ID is used to generate the cut. Statements outside the first 300 also cannot be chosen directly from this picker.

**Evidence:** [CutView.tsx](../desktop/src/workspace/session/cut/CutView.tsx):

- Line 97 sorts statement statistics by elapsed time and slices to 300; despite its comment, it does not ensure the selected statement is first/included.
- Line 98 accepts the current `selStmt` as `pick`, even outside those choices.
- Line 104 puts `pick` in the request.
- Lines 175–179 render options only from the truncated array.

**Reproduce:** Use a fixture with more than 300 statements. Select one below rank 300 elsewhere, enter Cut, and choose “One statement.” Inspect the request's statement ID and the available options. The exact native WebView rendering of a select value without a matching option was not observed; do not assume it always appears blank or always displays the first option.

**Fix direction:** Always include the actual selected statement and provide searchable access to the full statement set. Ensure the visible choice and request target have one authoritative identity.

**Acceptance checks:**

- A selected statement outside the top 300 is visible and correctly identified.
- Every eligible statement can be chosen without first navigating to another view.
- Empty traces, missing SQL IDs, and document changes are handled deliberately.
- Changing the visible selection always changes the exported statement ID accordingly.

> **Second review — confirmed.** `stmtChoices` is the top 300 by elapsed, `pick` can be a `selStmt` outside it, the request carries `pick`, the `<select>` lists only `stmtChoices`. Also: `stmt` state set on one live snapshot can name a statement the next snapshot does not have; guard with `doc.statements[pick]`.
>
> Fix: always put the picked statement first in the options (one `unshift` when absent), and replace the bare `<select>` with the lib's typed statement picker (`web/src/lib/data/stmtpick.ts`, the Lines view's: a `PickRow` list filtered by what the user types, already tested) over *all* statements, so every statement is reachable without leaving the view.

## F13 — `/api/cut/check` is unbounded on the engine (new, second review)

**Impact:** The 256 MiB automatic-check limit lives only in the client. Any `/api/cut/check` request, including a manual one on a multi-gigabyte cut, makes the engine write the whole cut to a temp file and parse it with a **full-facts** `model.Build` (every call, wait and bind set in memory), while the engine's own sessions use the aggregation-only build with a disk spill for exactly that reason. Several checks can run at once (one per request; the slice server's URL cache dedupes only completed answers). Peak memory was not measured; the shape is established.

**Evidence:**

- [cut.go](../internal/slice/cut.go), `cutCheck`: parses the selection and calls `Cutter.Check` with the request context, no size check, no limiter.
- [plan.go](../internal/cut/plan.go), `Cutter.Check`: `model.Build(path, model.Options{})` (full facts, no context).
- [session.go](../internal/engine/session.go), `buildSession`: the engine's sessions build with `Aggregate` + a spill tee and a `cancelSink`; `Check` uses none of it.
- [slice.go](../internal/slice/slice.go), `wrap`: `s.cached(key)` only after completion.

**Fix direction:** Give `model.Options` a `Ctx` checked in `progressReader.Read` (one place, every build cancellable at I/O granularity); make `Check` an `Aggregate` build with a small sink that accumulates what `compare()` needs (per statement and call kind: count, µs; waits: count, µs; the first wall clock; statements, unknown lines); a `maxCheckBytes` server limit (bad request above it unless `force=1`), and one in-flight check per session (a later identical request waits for the running one, a different one cancels it: the UI only ever wants the current query's answer).

**Acceptance checks:**

- A check cancelled mid-parse (client abort) stops within one read buffer and removes its temp file (`go test` with a context cancelled from the sink).
- The numbers of the aggregate check equal the full-build check on every cut fixture (`internal/cut` tests compare both).
- Engine RSS during a check of the largest fixture is bounded by the dimensions, not the facts (log it in the tracking table).
- The contract test (`internal/engine`, `api/engine.openapi.yaml`) covers any new parameter; `engine.Protocol` is untouched (additive).

## F14 — Statement detail retains another statement's data while loading (new, second review)

**Impact:** Picking another statement shows, for the duration of the request, the previous statement's executions page, wait list and execution detail under the new statement's heading. On a local engine this is one frame; on a remote or slow session it is readable and wrong. Same mechanism as F01, different axis (statement instead of scope).

**Evidence:** [StatementDetail.tsx](../web/src/lib/views/StatementDetail.tsx): `useSourceQuery(source, 'waits:${stats.id}:…', …, 'waits')`, `useSourceQuery(source, 'executions:${id}:…', …, 'executions')`, `useSourceQuery(source, 'detail:${stmt}:…', …, 'detail')` (template literals in the source); [StatementContext.tsx](../web/src/lib/views/StatementContext.tsx) the same `waits` keep. `keep` is constant, so the retained answer is another statement's whenever `id` changes.

**Fix direction:** Part of the F01 contract: either include the statement id in the `keep` string (retain across scope changes of the *same* statement only) or render the `stale` state. The executions table should show its skeleton rather than another statement's rows.

**Acceptance checks:** switching statements never shows rows whose statement differs from the heading; a live refresh of the same statement keeps its rows visible; the `queryView` unit test covers the `keep`-with-id case.

## Implementation plan (second review, 2026-11-08)

### Ground rules

- Branch from `main` (the review branch holds only this document; merge it first or cherry-pick). One commit per finding or per tightly coupled pair, pushed after each phase; concise messages; the tracking table above updated in the same commit (`confirmed` → `fixed`, with the test names and, where asked, the numbers).
- Every phase ends with: `pnpm -r typecheck`, `pnpm test` in `web/` and in `desktop/`, `go test ./internal/cut ./internal/slice ./internal/engine ./internal/model`, `make web` + Go rebuild when `web/src` changed (the built UI is committed), and for UI changes a screenshot via the `verify-mtkprof` skill (dev browser mode). `scripts/ci-local.sh --no-release` before the last push of a phase.
- The lib (`web/src/lib`) and the desktop's adaptation change in the same commit. An engine route or parameter change goes with `api/engine.openapi.yaml`, `go test ./internal/engine`, `pnpm gen:api` and the committed `desktop/src/engine/api.d.ts`.
- Test harness decision: both vitest projects run in `node` with `renderToStaticMarkup`; do not add `jsdom` for this work. Extract the pure decision functions (`queryView`, the open queue, the plan-identity selector, the `useJSON` reducer) and unit-test those; keep the mounted transitions for the screenshot step.
- Measure before redesigning (F04, F06, F11/F13): the review recorded no numbers, so the first commit of those items adds the measurement (a small script or a `go test -bench`), and the tracking table records workload, cache state and result.
- Execution model (per the user's global instructions): each phase is a self-contained brief for a lower-tier coding subagent (Sonnet); the orchestrator reviews the diff against the acceptance checks here before the commit.

### Phase 1 — Cut correctness (F09, F10, F11, F12, F13) · High

1. **F10 first, it is the identity everything else keys on.** `useJSON` returns `{ data, path, loading, error }`; add the `aborted` guard on the success path. In `CutView`: `const planPath = '/api/cut?' + query`, `const current = plan.path === planPath ? plan.data : undefined`; `p` (for drawing) stays the retained plan, with `className="cut-stage pending"` and a "Planning…" badge while `plan.loading`; Save/Open/`autoCheck`/`FileCard` use `current`. Unit test: a pure `planView(st, path)` selector, cases: settled same path, pending other path (data retained, `current` undefined), error.
2. **F11 client half:** `autoCheck = !!current && current.lines > 0 && current.bytes < 256 << 20`. The check URL is built from the same `query` as `current`, so the stale-size case disappears with (1). Keep `checkWanted === query` for manual checks.
3. **F12:** options = `[picked, ...top300 without picked]` when `picked` is not in the top 300; guard `doc.statements[pick]`; replace the `<select>` with the `stmtpick` picker over all statements (typed filter). Screenshot with `testdata/traces/19c` fixture that has > 300 statements (check `api/doc` statements count; generate on dbmint with `run_gen.sh` only if none has).
4. **F09:** `fileName` for the cache copy = `${stem}-cut-${stamp}.trc` (`yyyymmdd-hhmmss`, plus `-2`, `-3` on a same-second collision); the header and the Save default keep `${stem}-cut.trc`. `writeCached` writes `name.part` then renames (add `rename` from `@tauri-apps/plugin-fs`). Retention: `Workspace.restore` (or a `cuts.ts` helper it calls) lists the `cuts` folder and removes files older than 7 days not referenced by any restored tab; document in `docs/DESKTOP.md`. Test: `workspace.test.ts` already mocks `platform`; add a case that two `openOrShow` calls with distinct paths yield two tabs, and a `cuts` retention unit test over a mocked directory listing.
5. **F13 (engine):** `model.Options.Ctx` checked in `progressReader.Read` (returns `ctx.Err()`; `BuildFiles` wraps the reader when `Ctx` or `OnProgress` is set; `model.Build` already delegates to `BuildFiles`), `Cutter.Check` passes `ctx` and builds `Aggregate` with a `checkSink` that accumulates the `compare()` inputs; `compare()` takes that aggregate instead of `m2`; `maxCheckBytes` (default 1 GiB, `force=1` overrides) in `cutCheck`; one in-flight check per `slice.Server` (a mutex plus a cancel of the previous request's context when the query differs). Tests: `internal/cut` (aggregate check equals full check on every cut fixture; cancellation stops within a read and removes the temp file), `internal/engine/cut_test.go` (a `force=1` round trip), the contract test for the new parameter. Measurement: engine RSS during a check on the largest 19c fixture before and after, logged in the table. Later, optionally, replace `cancelSink` in `session.go` with `Options.Ctx` (not in this phase).
6. Phase exit: screenshots of the Cut view in pending state, with a > 300th statement picked, and two cut tabs open side by side; tracking rows F09–F13 updated.

### Phase 2 — Scope trust (F01, F14, F05) · High

1. **F01/F14 contract:** extract `queryView(st, source, key, keep): QueryState & { stale: boolean }` from `useSourceQuery` into `source.ts` (pure), test it in `source-query.test.ts`: settled same key; pending, same keep, other key → `stale: true`; pending, no keep → `data: undefined`; same lineage new source → retained, `stale: false`; error path. Then the consumers:
   - `Waits`: drop the `keep` (numbers), show a skeleton while loading, and on error a `callout` "Wait profile of the selection unavailable (…): showing the whole trace" above the table (mirror `useScopedStatements`' notice).
   - `useScopedFindings`: `narrowed: q.data !== undefined && !q.stale`; while stale, return the whole-trace findings with `loading: true` (the `Findings` header already renders "the selection's are on their way"). `Statements` consumes `.findings` for its per-row counts: that is fine once `narrowed` is honest.
   - `useScopeResponse`: no `keep` (numbers); `ResponseMini` renders a dimmed previous bar from its own `useRef` if a visible placeholder is wanted, labelled by `aria-busy`.
   - `StatementDetail`/`StatementContext`: `keep` becomes `waits:${id}`, `executions:${id}`, `detail:${stmt}` (retain across scope and live refresh of the same statement only).
   - Decorative consumers (`roles`, `spans`, `hlmarks`) keep their behaviour.
2. **F05:** in `RemoteSource.get`, an `inflight` map keyed by the URL: the first caller creates `{ controller, promise, waiters: 1 }`, later callers join, each caller's `signal` decrements on abort and aborts the shared controller when `waiters === 0`; settlement deletes the entry before resolving (so a retry after failure is a new request). Test in `source-query.test.ts` with a mocked `ApiClient` (the review's probe: two concurrent calls → one fetch; a third after settlement → cache; one of two aborting → request continues; both aborting → request aborted; failure → next call fetches again).
3. Phase exit: screenshots of Waits and Findings in the pending and the error state (mock a 500 via the dev browser's engine or a stubbed client); `make web`; tracking rows F01, F05, F14.

### Phase 3 — Opening (F02, F04) · High / Medium

1. **F02:** `openOptions: OpenOptions` on the workspace snapshot (`setOpenOptions`, not persisted; initialised from settings when the open screen mounts, as today). `OpenScreen` reads/writes it instead of local state; `DropTarget` uses `route.kind === 'open' ? ws.getSnapshot().openOptions : defaultsFromSettings`, and `follow` only when exactly one path was dropped (else a `toast` "Follow needs one file; opened without follow"). Overlay text says which options apply. Test: `workspace.test.ts` for `setOpenOptions` and a pure `dropOptions(route, openOptions, settings, paths)` selector.
2. **F04:** measurement first (`desktop/scripts/` or a Go benchmark: open 3–4 distinct fixtures concurrently vs. queued on a cold `-cache` dir; record active-ready time, total, RSS). Then an `OpenQueue` in `workspace.ts` (active tab first, concurrency 2, re-check `this.tab(key)` on dequeue, a failed or cancelled start releases its slot) used by `restore` and by `bind`'s restart branch. `open()` from the user stays immediate. Test: the queue as a pure class with fake `start` promises (order, bound, closed-tab skip, failure release).
3. Phase exit: screenshots are not needed for F04; one for the drop overlay text. Tracking rows F02, F04 with the numbers.

### Phase 4 — Work preservation (F03) · High

1. Chat draft → `ChatSession` snapshot (`draft`, `setDraft`), cleared by `send`; `conversation.test.ts` gains a case; `closeChat` already disposes it.
2. Statement list controls → session store: `stmtList: { q: string; hideSys: boolean; sort: SortKey }` with `setStmtList(patch)`; `Statements` reads it; `store.test.ts` covers the action; the CLI UI gets it for free (its `urlstate` does not need to carry it).
3. Note drafts → session store `noteDrafts: Record<string, string>` keyed `${kind}:${target}`; `NoteEditor` takes `draftKey` and reads/writes through the store (`web/src/lib/components/Note.tsx`); save/cancel/delete clear the key; the four mount sites pass their key. Closing a tab drops the store with the session (defined disposal: drafts die with the tab; say so in `docs/DESKTOP.md`).
4. Phase exit: screenshot sequence (type, switch tab, come back) for the chat and a note; tracking row F03.

### Phase 5 — Prompts (F08) · Medium

1. `queue.ts`: `QueuedPrompt.sending?: boolean; failure?: string`; actions `sending {id}`, `failed {id, error}`; `answered` unchanged. `PromptHost.send`: dispatch `sending`, await, on success dispatch `answered`, on 404 dispatch `answered` (closed elsewhere), on other errors dispatch `failed` and keep the modal; `PromptModal` disables inputs while `sending`, shows `failure` with a Retry (re-sends the same body kept in a ref, never logged) and Cancel. For `apikey` in the app: answer the engine first, store in the keychain only on success (swap the order inside `assistKeyStoreAndAnswer` or split it).
2. Tests: `queue.test.ts` (reducer transitions, double-submit guard, reset during sending); a screenshot of the failed state with a mocked 500.

### Phase 6 — Statement search cost (F06) · Medium

1. Measurement: a vitest micro-benchmark (or a `console.time` in the dev browser) of the `rows` memo on the fixture with the most statements at three needles (no match, broad, exact); record in the table.
2. If the broad case is above ~16 ms: `searchText` per doc in a `WeakMap<TraceDoc, string[]>` (lowercased `sqlId + ' ' + text`), `useDeferredValue(q)` for the filter, and a stable pre-sort per `(sort, inclusive)` memo so the needle filter does not re-sort. Semantics unchanged (hide-SYS, inclusive/self, tie-break on `elapsed`); re-measure and record.

### Phase 7 — Keyboard and assistive technology (F07) · Medium

1. `ConnectionsView`: a roving `tabIndex` listbox (`aria-activedescendant`, Up/Down/Home/End/Enter), focus ring via the existing `:focus-visible` tokens.
2. `DataTable`: `role="grid"` on the table with `aria-label` passed by the caller, `<th>` content wrapped in a `<button>` with the `aria-sort` kept on the `th`; Down on an unselected table selects the first visible row; `tr role="row"`.
3. `Statements`: `aria-label="Filter statements"` on the search input; a hint for `j`/`k`.
4. `ResizeHandle`: `aria-valuenow/min/max` from the current width.
5. Cut label groups: `tabIndex={0}`, Enter selects, Up/Down move; `aria-pressed` on the selected one.
6. Exit: a keyboard-only walkthrough in the dev browser (Playwright `keyboard.press` script in the `verify-mtkprof` run) with screenshots of the focus states; VoiceOver pass on macOS noted as done or deferred.

### Not planned, by decision

- Removing the "side-tab" detector findings: they are semantic state styling (the review says so). No change.
- A worker for statement search, a global engine build limiter, process-restart recovery of drafts: only if the phase 6 / phase 3 measurements or a user request call for them.

## Validation performed during the re-review

At the baseline commit:

| Check | Result | What it establishes |
|---|---|---|
| Desktop Vitest suite | 23 files, **234 tests passed** | Existing desktop unit coverage |
| Shared web Vitest suite | 71 files, **873 tests passed** | Existing shared data/UI unit coverage |
| Focused Go Cut tests | `internal/cut` and `internal/engine` passed; `internal/slice` had no matching tests | Existing Cut behavior covered by matching tests |
| RemoteSource mocked transport probe | 2 simultaneous identical calls → 2 fetches; later repeat → cache hit | F05 duplication and functioning completed cache |
| Workspace mocked dependency probe | Same path/options → same tab and unchanged session | F09 tab reuse without refresh |
| Cut pending-state expression probe | Retained preview, exports enabled, auto-check eligible | Supports F10/F11 state analysis, not rendered behavior |

Commands used for the existing test suites:

```sh
# From desktop/
./node_modules/.bin/vitest run

# From web/
./node_modules/.bin/vitest run

# From repository root
go test ./internal/cut ./internal/slice ./internal/engine -run 'TestCut' -count=1
```

These passing tests do not prove the reported interactions are correct. Several involve mounted component transitions, failure injection, concurrent requests, or native file behavior beyond the existing assertions.

## UX assessment and detector disposition

The interface is specific to an Oracle trace-analysis workflow: scope controls, ranked statements, evidence/provenance, and a separate assistant support the intended DBA audience. Cut's explanation of retained/borrowed/generated lines is useful. The largest remaining UX problems concern trust during transitions and preservation of work, rather than decoration.

The source detector command was:

```sh
/Users/davidbudac/.agents/skills/impeccable/scripts/impeccable detect --json desktop/src web/src/lib
```

It returned exit 2 with **14 findings: 13 warnings and 1 advisory**:

- **12 `side-tab` warnings:** `desktop/src/app.css:161,188,220`; `desktop/src/connections/connections.css:208`; `desktop/src/prompts/prompts.css:20`; `web/src/lib/styles/app.css:458,578`; `blockmap.css:57`; `lines.css:458,460`; `loom.css:16`; `timeline.css:6` (the latter files are also under `web/src/lib/styles/`). These represent warning/error states, selection/zoom state, idle gaps, or evidence caveats. The lines gap marker was counted twice. No extra decorative defect was promoted.
- **1 `gradient-text` warning:** `web/src/lib/styles/motion.css:108`, a status shimmer overlay with readable underlying text and reduced-motion gating, not a gradient heading.
- **1 `bounce-easing` advisory:** `web/src/lib/styles/motion.css:14`, a slight number-change overshoot with reduced-motion gating. No demonstrated defect or measured performance problem.

Do not remove semantic styling simply to make this detector clean.

## Remaining validation limits and lower-confidence observations

- No app launch, browser inspection, CDP overlay, native updater installation, screenshot comparison, screen-reader session, or large-trace benchmark was performed. The desktop uses Tauri/WKWebView on macOS; the detector here was a source scan.
- Prompt modal focus containment/restoration and Cut piece keyboard navigation deserve an actual keyboard walkthrough. The latter has concrete source evidence under F07; focus-management observations were not promoted to a separately validated defect.
- Statement search has a placeholder but no explicit accessible label in the inspected source. Confirm its accessible name and add a real label if absent when handling F07.
- The resizable separator supports arrow keys, but its adjustable value is not exposed through `aria-valuenow`/min/max. Validate the desired assistive-technology interaction while preserving its working keyboard resizing.
- No additional high-confidence updater-specific defect was found in the inspected paths. Source includes explicit download/install/error states and an attempt to restart the engine after installation failure. This is not proof that native updating succeeds.
- The review did not assign a rendered visual-quality score. Do not turn provisional source observations into claims about contrast, density, layout, or frame rate.

## Completion record for the executing agent

Update the tracking table rather than deleting unresolved findings. For each completed item, record:

1. Reproduction or invalidation evidence against the actual execution baseline.
2. The behavior changed and relevant commit(s).
3. Regression tests and any native/manual verification.
4. Measured performance results where applicable, including workload and cache conditions.
5. Remaining limitations or explicitly deferred decisions.

Keep the original review baseline in this document so future agents can distinguish historical findings from the behavior of later versions.
