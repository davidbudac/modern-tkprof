# Desktop performance and UX review — validation and implementation handoff

- Reviewed: 2026-11-08
- Version: **v0.6.0**
- Baseline: **`89f91c2b1b3a55e9e3fd055a3d0996798bb75eaf`**
- Handoff branch: **`docs/desktop-performance-ux-review-2026-11-08`**

## Purpose and evidence boundaries

This document records all **12 findings** from the desktop performance and UX re-review. Findings F01–F08 were reported in the earlier review and remain present at the baseline above. F09–F12 were identified while reviewing the new Cut workflow. No fixes have been implemented as part of this review.

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

Suggested order: **F09 → F01 → F02 → F10/F11 → F03 → F08 → F05 → F04/F06 → F07/F12**. F10 and F11 share the Cut plan/query identity problem and should be designed together. F01 and F05 both touch source-query behavior; coordinate their cancellation and retained-data contracts. F09 is independent of preview correctness.

## Tracking

| ID | Priority | Finding | Review disposition | Executor result / evidence / commit |
|---|---|---|---|---|
| F01 | High | Filtered results can describe a different scope | Still present; source-confirmed | Pending |
| F02 | High | File drop ignores displayed opening options | Still present; source-confirmed | Pending |
| F03 | High | Navigation discards unfinished work | Still present; source-confirmed | Pending |
| F04 | Medium | Restore starts all traces concurrently | Still present; performance risk | Pending |
| F05 | Medium | Concurrent identical queries duplicate work | Still present; focused reproduction | Pending |
| F06 | Medium | Statement search filters and sorts synchronously | Still present; performance risk | Pending |
| F07 | Medium | Connections and tables have keyboard gaps | Still present; source-confirmed | Pending |
| F08 | Medium | Failed credential submission loses its prompt | Still present; source-confirmed | Pending |
| F09 | High | Repeated cuts overwrite output and reuse old results | New; source-confirmed plus focused tab-reuse reproduction | Pending |
| F10 | Medium | Cut export can differ from the displayed preview | New; source-confirmed | Pending |
| F11 | Medium | Cut auto-validation uses stale size; reparse cannot cancel | New; source-confirmed performance risk | Pending |
| F12 | Medium | Cut picker can omit its actual target statement | New; source-confirmed | Pending |

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
