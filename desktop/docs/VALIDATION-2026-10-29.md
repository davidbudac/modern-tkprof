# Investigation workflow follow-up — 2026-10-29

> Written before the 2026-11-02 merge, when this app was the repository `mtkprof-desktop` and pinned the engine as the submodule `engine/`: read `engine/X` as `X` at the repository root (`web/src/lib`, `internal/`, `api/`, `testdata/`); the pin, `git submodule` and `check:deps` steps no longer exist.

Implemented with three GPT-6.1 Sol implementation subagents, followed by independent Sol
reviews and local integration. Scope: window accounting/controls, two-tab comparison,
investigation backups, tab reordering, and current roadmap/user documentation.

## Verified

- Desktop TypeScript check; 137 tests in 15 files pass.
- Shared UI TypeScript check; 246 tests in 26 files pass.
- Engine and report package tests pass, including comparison route/contract checks and
  unchanged comparison semantics for distinct fixtures. These tests use local test servers;
  no external database was accessed.
- Generated API types match the OpenAPI contract. Shared dependency check and diff checks pass.
- Both frontend production builds pass; the standalone UI embedded in the engine was rebuilt.
- The macOS arm64 debug app bundles and signs ad hoc successfully. A separate validation
  identifier, `com.davidbudac.mtkprof.validation20261029`, isolates its settings/cache from the
  user's normal app. Native accessibility inspection confirms the open screen, engine-ready
  state, Settings and disabled comparison button with no traces open. A later read-only
  inspection also confirmed a loaded 21-file trace set, its truncation/continuation warning,
  the new tab controls, and the qualified statement-total label.

Meaningful new regression coverage includes: legitimate 112% whole-call window overlap and
126% recursive overlap; initial remote-query loading; single window-control presentation;
comparison input/lifecycle/identity guards and preserved source filters; backup validation,
merge behavior, open-tab annotation refresh, immediate-close and immediate-export writes;
preservation of disk-only notes when another open tab is stale; and persisted tab order.

## Review findings resolved

Comparison statement links now verify source content identity and retain original filters.
Investigation imports update open stores and merge with disk instead of replacing disk-only
notes. Tab close and export flush pending annotation timers. These fixes have regression tests.

## Remaining validation

Native automation initially lost its active app binding. A refreshed accessibility state
succeeded, but the next click was not executed: automatic approval review failed because
its selected model was at capacity. This was a review-service failure, not an unsafe-action
classification, and no bypass was attempted. Therefore comparison-dialog interactions,
keyboard focus, tab reordering, backup file dialogs, warning dismissal and engine
crash/recovery have **not** been verified in this native build. Unit tests and successful
builds are not substitutes for these checks.
No crash/kill smoke script was run.

Still requires appropriate machines: Windows installation/WebView2 performance/SSH prompts,
Intel macOS runtime smoke, Linux installer installation, and the remote compatibility checks
already listed in engine/docs/REMOTE.md. No publication or release was performed.

## Supported scope

Comparison is a whole-trace snapshot of two ready non-live sessions; source filters are ignored.
It stays through engine restarts but is not restored after quitting the app. Filtered or
persisted comparisons, comparison exports and cross-trace execution comparison remain future
work. Backups include optional metadata and explicit-open path references, not raw trace files.

## Concurrent work

Later in the session, unrelated file-status/truncation changes appeared in the engine model,
shared Files panel and desktop chrome. Those changes are preserved and excluded from this
work's commits. The native build and engine/shared-UI results above were recorded before
those concurrent edits; desktop TypeScript and 137 tests also passed after they appeared.

## Commit status

Changes remain uncommitted. Writing the engine submodule index requires sandbox approval.
The first automatic approval review timed out; the permitted retry failed because the review
model was at capacity. Both staging requests were rejected before execution. No approval
bypass, Git commit, push or release was attempted afterward. The concurrent-work references
above describe the intended commit scope, not completed commits.
