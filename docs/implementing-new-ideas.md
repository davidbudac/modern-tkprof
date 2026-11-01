# Execution Loom: implementation specification and agent handoff

Date: 2026-11-01

Repository: /Users/davidbudac/claude_projects/modern-tkprof

Code inspected at commit: 21485afff76c885e2d325c8cab9739e9914eb419

Status: design handoff; no application implementation has been made.

## 1. Task and authorization

The user requested an original, useful trace visualization, explored the Execution Loom concept, and progressively requested:
1. A concrete example of aligned executions.
2. Breakdown by database object.
3. Colour coding by read/wait event.
4. Visualization of consistent versus current reads.
5. This detailed Markdown file for another agent to implement.

This document captures that design. Creating it did not authorize changing the application in this session. The receiving agent should follow its own implementation instruction and applicable repository instructions. The user specifically requires permission before potentially harmful operations. Do not deploy, publish, commit, contact a database, or capture new traces merely because this file exists.

All numerical examples and previews are synthetic. They are not measurements of the user's workload and must not appear as real findings.

## 2. Product purpose

Help an analyst answer:

> At what equivalent point in the work did execution B become slower than execution A, which object-associated waits explain the difference, and did the logical read mix change?

A normal timeline aligns activity by clock time. The Loom aligns executions by equivalent work checkpoints. Two executions may start minutes apart but share the same horizontal checkpoints: Start, Execute, Fetch 1, Fetch 2, etc.

Each execution is a thread. Its vertical position is cumulative database call elapsed time. A widening vertical separation locates additional cost. A constant separation means an earlier delay persists, not that the later phase is itself slower.

Expand the execution into object wait tracks. Preserve event identity using colour, and show logical read mode with a separate patterned count display. The three measurements must remain distinct:
- Call elapsed time: microseconds, displayed in suitable time units.
- Object-associated event waits: microseconds, a subset of explained execution time.
- Consistent/current gets: counts, not duration.

The feature complements statement rankings, execution A/B comparisons, waits, and raw trace lines. It does not replace them.

## 3. Design status and scope

### User-requested core

- Aligned execution threads with a concrete baseline and comparison execution.
- Per-phase inspection and identification of where a gap begins or grows.
- Object-level expansion of attributed waits.
- Stable event colours, including distinct read-event families.
- Consistent-get versus current-get visualization.
- Evidence drill-down and honest treatment of unavailable attribution.

### Recommended first integration, not a user-mandated location

Add a Loom mode within the Statements workbench, near the existing execution comparison. Reuse the current two-execution selection. Keep the existing numerical comparison available.

Start with one statement, one selected execution pair, and comparable call structure. Deliver all requested measurement layers for that bounded case before adding large cohorts.

### Later extensions discussed

- A cohort of dozens/hundreds of comparable executions, with outliers highlighted.
- Object-first navigation: find executions with recorded waits against a chosen object, grouped by SQL.
- Highlight calls where the consistent/current-get mix changes materially.
- Broader repeated workflows containing several SQL statements.

These are design directions, not reasons to delay the bounded core or silently substitute clustering for exact comparison.

### Outside this feature

Do not implement the previously discussed Echo Map, Execution Archipelago, Wait Constellation, or Trace Surgery. Do not add live database dependencies, automatic tuning, or causal claims based only on visual patterns.

## 4. Saved visual references

The previews below are standalone design references, not production components. Open them directly as files; they do not require a server or external assets.

- [01: concrete execution comparison](mockups/execution-loom/01-execution-comparison.html)
- [02: expansion by object](mockups/execution-loom/02-object-breakdown.html)
- [03: object tracks coloured by event](mockups/execution-loom/03-event-colours.html)
- [04: latest composition, including read modes](mockups/execution-loom/04-read-modes.html)

Read all four: the latest preview adds the access-mode layer but does not show every earlier interaction simultaneously. The final application should combine the ideas rather than copy only the last screen.

The mixed-event previews intentionally use a new synthetic variant while retaining elapsed totals. Do not treat every example as one internally identical raw trace. In particular, the original four-read-wait example is not the mixed-event example.

The previews use simplified axes, illustrative intra-phase positions, and host-independent styling added for export. Follow application typography, controls, theme tokens, and navigation in production.

## 5. User journey

1. Open a statement and select two executions using the existing picker.
2. Open Loom. Display SQL identity, execution identifiers, source/session information, plan-hash availability, and bind comparison availability.
3. Choose which execution is the baseline. Do not silently select the fastest execution and call it normal.
4. Show cumulative elapsed threads across matched call checkpoints.
5. Select a checkpoint interval to inspect that phase's individual cost, not merely its cumulative endpoint.
6. Expand Objects for that phase or execution. Rank objects by additional attributed wait time, with explicit signed deltas.
7. Select an object to inspect its recorded waits grouped by event, then exact wait records and source lines.
8. Highlight an event family across object tracks without changing totals or dropping other events from the accounting.
9. Inspect consistent/current-get counts and proportions for the same calls in both executions.
10. Follow a line reference into the existing trace viewer when available. Keep file identity with the line number.

Selecting a phase, object, or event is initially local to the Loom. Do not unexpectedly change the entire application's global filters. Offer an explicit action if applying a selection globally is useful.

## 6. Visual encoding contract

### 6.1 Whole-execution threads

- X: ordered matched work checkpoints; equal checkpoint spacing is acceptable.
- Y: cumulative elapsed time of included outer calls.
- Label the axis "Cumulative call elapsed" with units.
- Begin at zero for each execution.
- A phase is the interval between two checkpoints.
- Highlight the selected phase over the full vertical plotting area.
- Show baseline and selected execution with distinguishable line styles and labels.
- In the basic view, two execution colours are acceptable. When event colouring is active, reserve colour for event identity; distinguish executions using solid/dashed lines or a neutral reference.
- Directly label endpoints and important deltas.
- Tooltips and accessible details show both cumulative value and individual phase value.
- A flat delta after a costly phase must not be described as an additional slowdown.
- A comparison can be faster, slower, equal, or cross over; preserve negative deltas.

The default metric is a sum of call durations, not wall-clock response time. Do not silently include client gaps, parse, close, or other excluded phases. State what is included.

### 6.2 Alignment

Recommended initial checkpoint signature:
- Optional explicitly included PARSE.
- EXEC.
- FETCH calls in recorded order, retaining each call separately.
- Optional explicitly included CLOSE.
- Explicit handling of zero-row terminal fetches.

Require comparable call kind/order and fetch row shape for a direct matched comparison. Show differences rather than forcing equal structure:
- Different fetch counts.
- Different rows per fetch / array sizes.
- Additional calls.
- Missing parse or execution start.
- Partial/truncated captures.
- Calls excluded by the active scope.

Absent is not zero. Do not pad an absent call with zero elapsed and present it as observed.

For the initial implementation, partition incompatible shapes or show an "unmatched phase" marker and an explanation. Do not invent timestamps or spread a fetch proportionally across rows as if that timing were measured. Row-progress alignment may be a later explicitly labelled transformation.

Known plan changes and bind differences should be visible. Missing hashes or bind values must not be interpreted as equality. Same SQL, plan hash, bind, and row count do not prove identical underlying data or work.

### 6.3 Object tracks

- One lane per recorded object identity, with resolved owner/name/type where available.
- Fallback label: obj#N. Preserve partition/subobject labels if present.
- Object-lane Y: cumulative in-call wait time attributed to that object, not total object execution time.
- Use the same checkpoints and the same vertical scale across object lanes for honest comparison.
- Offer an explicitly labelled magnification if small deltas are hard to see; never silently autoscale every object independently.
- Object order should be stable while interacting. Initial ranking can use additional wait duration in the selected phase.
- Retain a visible Unknown object group for missing/unusable object attribution.
- CPU, unaccounted time, and between-call gaps are not object lanes inferred from SQL text.
- Keep object-associated waits and unassigned categories visibly reconcilable to the chosen timing basis.
- If an object is absent from the other run's wait records, say "no recorded attributed waits" rather than "object was not accessed."

Do not collapse object numbers across unrelated databases/containers merely because the numeric obj# is equal. Use the repository's context/reference identity and state limitations where cross-source resolution is unavailable.

### 6.4 Event colours

Keep one stable event-to-colour mapping across all objects, phases, selections, and executions in the document.

Initial families:
- db file sequential read: normally single-block read waits.
- db file scattered read: multiblock read waits.
- direct path read.
- direct path read temp, when present, distinguishable from ordinary direct path read.
- Other recorded events, including contention or cluster events, with their exact names available.

Do not identify an access path or object type solely from an event name. A single-block read is not proof of an index lookup. Use recorded parameter/block counts where relevant.

Two supported presentations:
1. Event-coloured segments on the selected object's cumulative wait thread.
2. A stacked phase bar grouped by event, with widths proportional to wait duration.

For a segmented thread, retain actual event order and source references. Checkpoint endpoints must equal cumulative totals. If event subpositions are placed by sequence within a call, label them as sequence, not wall time. Group only contiguous equivalent events if preserving chronology; do not paint an alphabetically grouped event list as a chronological thread.

The stacked phase bar is an aggregate: explicitly say its segment order is not chronology.

Highlighting an event should dim unrelated marks while keeping total geometry and accounting unchanged. If a separate filter removes events, label the changed metric/scope explicitly.

Direct-path wait duration is recorded waiting, not necessarily all time spent on asynchronous I/O. Wait count is not generally equal to physical read requests or blocks.

### 6.5 Consistent versus current logical gets

Display this as a separate call-level access-mode ribbon, not as a property inferred for each WAIT.

- cr: consistent gets.
- cu: current gets.
- Solid neutral fill: consistent gets.
- Hatched neutral fill: current gets.
- Keep event colours available for event identity.
- For each call, a normalized bar represents cr + cu, with exact counts and percentages beside it.
- If showing both executions, put two labelled bars per matched call or a compact A/B detail with explicit differences.
- Percentages alone are insufficient; display absolute counts too.
- cr + cu = 0: show "No logical gets", not a fabricated all-consistent bar.
- Missing counters: show "Unavailable", distinct from zero.
- Preserve small nonzero values numerically. Do not inflate a tiny segment without marking that the visual is no longer proportional.
- Physical reads p remain a separate count. They are not a third mutually exclusive segment in the cr/cu bar.

Do not label current gets as dirty reads or inconsistent results. Current and consistent are access modes, not clean/dirty buffer states and not cache-hit/cache-miss classifications.

A normal call record does not provide:
- A per-object allocation of its cr/cu counts.
- The access mode of every individual WAIT.
- Clean/dirty state for each buffer accessed.
- A measured cache-hit-time component.

Therefore, do not put hatching onto individual event strokes or per-object wait bars as though the event's mode were known. Do not colour all non-I/O time as cache hits. Do not derive per-object counts by distributing call totals in proportion to wait time.

If future evidence supplies a finer grain, expose provenance and coverage explicitly before enabling a finer visualization.

## 7. Timing and attribution rules

Keep numeric calculations in integer microseconds; convert only for display.

For matched phase k:
- Cumulative A[k] = sum of included A call elapsed values through k.
- Cumulative B[k] = corresponding sum for B.
- Cumulative delta[k] = B[k] - A[k].
- Added delta in phase k = B_call[k].e - A_call[k].e.
- This also equals delta[k] - delta[k-1] for fully matched calls.

For object o and event v:
- Phase wait contribution = sum of eligible WAIT.ela for that call/phase, object and event.
- Object cumulative wait = sum of its phase contributions through the checkpoint.
- Event/object selection must not duplicate a wait in more than one accounting bucket.
- The Unknown object bucket participates in totals.

### Inclusive calls and recursion

The model stores both inclusive and self counters. Parent call values include attached recursive children.

Recommended initial whole-execution metric: recorded inclusive e of the selected cursor's EXEC and FETCH calls. Do not add recursive child e to that sum again.

For object expansion of an inclusive phase, gather eligible in-call waits from the phase and its attached descendants exactly once. Preserve their original call, context, object, event and line identities.

If a self-time view is implemented, self elapsed, self CPU/counters, and the wait set must all use a matching ownership basis. Do not silently mix global self/inclusive settings with a differently defined Loom metric. Label the chosen basis.

Malformed/incomplete hierarchies and waits outside the containing phase require explicit coverage handling, not arbitrary attribution.

### In-call versus between-call waits

Use model attribution flags/timing, not wait class alone. An idle-class event can occur inside a call; a client wait can occur between calls.

Default call-time Loom excludes between-call waits. Show client gaps separately if added later, with a different metric label. Never add a wait to e when it is already contained in e.

### Reconciliation

For a complete phase on a consistent ownership basis:
call elapsed is compared with CPU + eligible in-call waits + residual.

The residual is not measured cache time. If the residual is negative or data cannot reconcile, retain a discrepancy/coverage indicator. Do not hide it by silently clamping while claiming exact accounting.

### Scope and completeness

The existing execution list can be scope-filtered and its FETCH sums can be partial. Preserve this distinction.

Recommended behavior:
- Execution membership follows existing global file/context/time selection.
- A Loom path under an active scope uses included calls and visibly marks clipped or incomplete coverage.
- Do not silently fetch a full out-of-scope execution and label it scoped.
- An explicit "Inspect full execution" action can lift the time restriction for that local analysis, with a clear header.
- Baseline and selected paths must reveal differences in coverage.
- Live snapshots must invalidate or refresh cached details; do not combine identities or data from different revisions.

## 8. Synthetic fixture A: concrete execution comparison

Purpose: validate the first divergence, object attribution, and residual accounting. Cursor already parsed; parse/close/client gaps excluded. Same SELECT, same bind, same returned row counts. No recursive calls in this fixture.

Illustrative SQL:

~~~sql
SELECT order_id, total
FROM orders
WHERE customer_id = :customer_id
ORDER BY order_id
~~~

All duration columns below are milliseconds; convert to microseconds in test inputs.

| Phase | Rows returned in call | A elapsed | B elapsed | A CPU | B CPU | A waits | B waits | A residual | B residual |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Execute | 0 | 90 | 90 | 20 | 20 | 60 | 60 | 10 | 10 |
| Fetch 1 | 100 | 50 | 510 | 8 | 8 | 40 | 500 | 2 | 2 |
| Fetch 2 | 50 | 20 | 20 | 6 | 6 | 12 | 12 | 2 | 2 |
| Total | 150 | 160 | 620 | 34 | 34 | 112 | 572 | 14 | 14 |

Expected cumulative values:
- A: [0, 90, 140, 160] ms.
- B: [0, 90, 600, 620] ms.
- Delta: [0, 0, 460, 460] ms.
- Added phase deltas: [0, 460, 0] ms.

Object names are illustrative reference-bundle labels:

| Phase | Index #42 A waits | Index #42 B waits | Table #73 A waits | Table #73 B waits |
|---|---:|---:|---:|---:|
| Execute | 20 | 20 | 40 | 40 |
| Fetch 1 | 8 | 12 | 32 | 488 |
| Fetch 2 | 4 | 4 | 8 | 8 |
| Total | 32 | 36 | 80 | 536 |

- Index #42: ORDERS_CUSTOMER_IX.
- Table #73: ORDERS.
- Index cumulative A/B: [0,20,28,32] / [0,20,32,36].
- Table cumulative A/B: [0,40,72,80] / [0,40,528,536].
- First-fetch extra waits: index +4 ms; table +456 ms; total +460 ms.
- For this original fixture, all read waits can be db file sequential read.
- First fetch has four read waits in each execution, two associated with each object.
- A index waits 4+4 ms; B index waits 6+6 ms.
- A table waits 16+16 ms; B table waits 244+244 ms.
- This demonstrates a duration change without a wait-count change; it does not prove a storage root cause.

## 9. Synthetic fixture B: mixed-event variant

This is a separate fixture for event colouring, with the same phase totals as fixture A. Do not retain fixture A's four-wait claim or its all-single-block event assumption.

In B's Fetch 1:
- Index #42: 12 ms db file sequential read.
- Table #73: 160 ms db file sequential read.
- Table #73: 28 ms db file scattered read.
- Table #73: 300 ms direct path read.
- Total waits = 500 ms.
- CPU = 8 ms; residual = 2 ms; call elapsed = 510 ms.

For the table's illustrative event thread:
- Execute ends at 40 ms cumulative object wait.
- During Fetch 1, show direct-path group +300, multiblock group +28, then single-block group +160.
- Fetch 1 ends at 528 ms.
- Fetch 2 adds 8 ms, ending at 536 ms.

These group positions demonstrate encoding; a production thread must be derived from ordered records. Durations alone do not establish wait counts, read requests, or physical block counts. If making raw fixture records, declare all those fields deliberately and validate them.

## 10. Synthetic fixture C: access-mode layer

Additional synthetic call counters for the mixed-event illustration:

| Call | cr | cu | cr + cu | Consistent share | Current share |
|---|---:|---:|---:|---:|---:|
| Execute | 600 | 120 | 720 | 83.3333% | 16.6667% |
| Fetch 1 | 2400 | 12 | 2412 | 99.5025% | 0.4975% |
| Fetch 2 | 600 | 0 | 600 | 100% | 0% |

The Fetch 1 illustration also shows p = 64. This is a separate call-wide measurement, not a segment added to the 2,412 logical gets, and not an allocation to #42 or #73.

Only one execution's read counters were illustrated. Do not invent baseline counters in the product or claim the example proves a read-mix change. Tests for A/B changes should supply separately declared baseline data.

Additional tests must include cr=0/cu>0, cr>0/cu=0, both zero, missing counters, and a tiny nonzero cu share.

## 11. Current repository implementation map

Recheck these paths and APIs before editing; this map is a snapshot, not a promise that the checkout is unchanged.

| Path | Relevant responsibility |
|---|---|
| web/src/lib/views/StatementDetail.tsx | Executions picker, two-row selection, ExecCompare integration, scoped statement detail |
| web/src/lib/views/ExecCompare.tsx | Existing A/B aggregates, waits by event, binds and plan comparison |
| web/src/lib/data/derive.ts | Execution identity and EXEC + following FETCH grouping |
| web/src/lib/data/source.ts | DataSource contract; LocalSource, RemoteSource; useSourceQuery |
| web/src/lib/data/doc.ts | Packed fact columns and call/wait indexes |
| web/src/lib/data/types.ts | Shared document types, call kinds, flags and sentinels |
| web/src/lib/data/scopedstmts.ts | Scope helpers and query-key conventions |
| web/src/lib/state/store.ts | Selection, global scope, inclusive flag, live state |
| web/src/lib/components/LineRef.tsx | File-aware trace-line drill-down |
| web/src/lib/components/colors.ts | Existing theme-aware class roles and colour helpers |
| web/src/lib/data/format.ts | Duration/count formatting |
| internal/model/model.go | Call, Wait, inclusive/self counters, attribution fields |
| internal/analyze/analyze.go | ExecutionsOn / EachExecutionIn and scoped execution membership |
| internal/analyze/slice.go | ExecutionDetailOn and existing aggregate detail |
| internal/analyze/facts.go | Fact-source abstraction |
| internal/slice/slice.go | HTTP execution/detail handlers |
| internal/slice/slice_test.go | Endpoint and execution-detail tests |
| internal/slice/spill_test.go | Spill behavior and scoped execution tests |
| docs/ARCHITECTURE.md | Fact semantics, recursion, wait attribution, source modes |
| docs/trace-format-19c.md | Call fields, WAIT parameters, STAT records |
| docs/REF-BUNDLE.md | Object/file names and supplemental plan information |
| api/engine.openapi.yaml | Engine API contract; check whether any new route/schema belongs here |

Current call columns include:
line, kind, cursor, stmt, c, e, p, cr, cu, r, dep, og, plh, tim, parent,
selfE/selfC/selfP/selfCR/selfCU, ctx, execNo, bindSet, waitEla, idleEla, flags.

Current wait columns include:
line, cursor, stmt, call, event, ela, p1, p2, p3, obj, tim, ctx, dep, flags.

Call/Wait record IDs and cursor instance identity matter. Raw cursor numbers can be reused. Execution number alone is not globally unique. Preserve document/revision, cursor instance, execution number, context and file information as needed.

### Critical existing API limitation

ExecDetail currently returns sums for parse, exec and fetch, a total, waits aggregated by event, binds and plan hash. It does not expose an ordered per-fetch object/event breakdown.

Do not reconstruct individual fetches by dividing its aggregate fetch time, or distribute aggregate event waits among calls.

Other tempting shortcuts are also insufficient:
- DataSource.calls() may return a sampled subset of longest calls.
- waitTop() is capped and its UI row type does not carry every attribution field.
- Existing generic wait endpoints have limits.
- A remote execution list may contain only the slowest subset and exposes partial.

The Loom needs a dedicated ordered execution-detail contract, or a backward-compatible extension with equivalent complete semantics.

## 12. Suggested architecture

These are implementation recommendations, not required filenames or wire format.

### Domain/data module

Create a pure transformation layer, e.g. data/executionLoom.ts:
- Normalizes exact ordered calls and waits.
- Determines comparability and phase mapping.
- Produces cumulative curves and per-phase differences.
- Groups eligible waits by object/event.
- Calculates read-mode fractions.
- Preserves provenance, missingness and completeness.
- Does not depend on React or chart rendering.

Keep raw acquisition separate from rendering and from analysis. Use one documented result shape shared conceptually by local and remote providers.

### Source contract

A possible method is executionLoom(stmt, executionIdentity, scope, options, signal).
Naming and whether to extend an existing method are the implementer's decision.

Result should carry:
- Execution identity and source/document revision.
- Inclusion/timing basis and scope semantics.
- Ordered calls with stable IDs, kind, ordinal, timestamps, source refs, counters.
- Ordered waits with call/object/event identity, duration, parameters, flags and source refs.
- Descendant ownership/provenance if included.
- Object and event lookup references.
- Missing/partial/truncated status and reason.
- Complete total counters versus returned row counts if payloads are paged.
- Capabilities for details and source-line availability.

Distinguish unavailable fields from observed zero. Do not send placeholder zeros for unsupported detail.

### Local and remote paths

Support both:
- Embedded/standalone reports with retained facts, through LocalSource.
- Engine/server-side slicing and spill-backed analysis, through RemoteSource and FactSource.

Do not build a feature that works only when the browser has the entire trace. Conversely, do not make standalone HTML require a network service.

Avoid a full-trace scan for every hover or phase click. Fetch/cache execution detail by identity, scope, basis and revision. Use indexed execution access or a bounded scan compatible with spill storage. Abort stale requests.

If a detail response needs paging, preserve aggregate completeness separately from row-list completeness. Never draw a supposedly complete curve from truncated calls or waits.

Use explicit availability states for:
- No retained facts and no supporting endpoint.
- Aggregate-only report.
- Older server lacking the new capability.
- Trace captured without waits.
- Missing object IDs or reference bundle.
- Missing/reduced bind data.
- Incomplete execution capture.

Do not classify an unsupported endpoint as an empty successful result.

### UI

Candidate components:
- ExecutionLoom: state and layout.
- ExecutionLoomChart: aligned threads and phase selection.
- ObjectWaitTracks: object/event expansion.
- ReadModeRibbon: cr/cu count/proportion display.
- LoomEvidence: per-phase values and source-linked records.

Names are illustrative. Prefer existing chart/control/table patterns and dependencies. Do not add a visualization framework merely to reproduce the prototype.

The core should live in the shared web library used by standalone and desktop consumers. A desktop-specific shell change is not required for an initial statement-detail integration. Do not edit the separate desktop repository without task scope.

## 13. Interaction and presentation requirements

- Phase selection by keyboard and pointer; no hover-only essential information.
- Native labelled buttons, with type="button", pressed/selected state, and visible focus.
- Event names remain readable; colour is not the only identifier.
- Consistent/current modes retain distinct labels and texture.
- Both light and dark themes use application tokens, not the mockup's hardcoded palette.
- Stable event colours must not reorder when filtering or changing the baseline.
- Semantic table/detail alternative for chart values.
- Responsive layouts preserve labels and units; stack sections before text becomes too small.
- Scope and inclusion basis remain visible.
- Show source coverage, unknowns, truncation and mismatch close to the affected chart.
- Preserve existing bind redaction/omission. Do not recover or expose hidden values.
- In offline reports without raw line content, show available references and explain unavailable drill-down; do not create a dead action.
- Small object deltas must remain inspectable numerically even on a common scale.
- Long object names must not cause clipped charts or overflowing controls.

## 14. Delivery sequence

1. Verify repo instructions, current data contracts, flags, scope behavior and source modes.
2. Implement/test exact execution call selection and ordered detail acquisition.
3. Implement pure alignment, cumulative elapsed and delta calculations using fixture A.
4. Add a pairwise Loom entry to the existing execution comparison.
5. Add object attribution with Unknown and unassigned categories.
6. Add event-coloured tracks and duration bars using fixture B.
7. Add call-level read-mode ribbons for both executions using fixture C plus explicit baseline data.
8. Finish source-line drill-down, accessibility, theme and partial-data behavior.
9. Validate local/server/spill parity and numerical reconciliation.
10. Only then consider cohort rendering or object-first navigation.

Do not stop at a static screenshot or a hardcoded fixture UI. Synthetic data belong in tests/demo contexts, not the real feature's data path.

## 15. Acceptance criteria

### Numerical and semantic

- Fixture A produces exactly 160/620 ms elapsed, +460 ms in Fetch 1 and +0 ms in Fetch 2.
- Object totals and phase deltas match the fixture exactly.
- Fixture B's event components sum to 500 ms in Fetch 1, and table components to 488 ms.
- Read-mode counts/proportions match fixture C; zero/missing/tiny values remain distinct.
- Event highlighting does not change geometry or reported totals.
- Wait time is not added twice to elapsed.
- Recursive children are not counted twice.
- Between-call waits do not leak into call-time curves.
- Unknown objects and unsupported detail never disappear into invented known categories.
- Physical reads do not become a third cr/cu segment.
- No individual wait or object is labelled consistent/current using only call totals.
- A current get is not described as a dirty read.
- Negative deltas and timing discrepancies remain visible.

### Data shape and integration

- Each FETCH remains independently inspectable.
- Same execution numbers in different cursors/files are not conflated.
- Reused cursor numbers resolve through cursor instances.
- Split-file source links open the correct file.
- Different call shapes and clipped executions are explicit.
- Unknown plan/bind evidence is not described as a match.
- Local and remote outputs agree on shared fixtures.
- Spill mode yields the same results as memory mode.
- Unsupported/aggregate-only sources have a clear unavailable state.
- Existing comparison, filters, bind policy and navigation continue to work.

### Interaction

- User can select a baseline and comparison, phase, object and event.
- First divergence leads to the relevant per-call evidence.
- Read-mode comparison identifies both count and proportion changes.
- Source drill-down includes exact context/file/line information.
- Labels, focus, read-mode hatching, and charts remain legible at desktop and narrow widths.
- Phase/event changes reuse loaded data where possible and cancel stale requests.
- No fabricated causal finding appears merely because an object dominates waits.

## 16. Validation plan for the implementing agent

Use meaningful unit tests for transformations and integration tests for source parity. This handoff itself did not run application tests because it changes no application behavior.

Suggested fixtures/cases:
- Exact examples A/B/C.
- Repeated identical runs and an execution faster than its baseline.
- Missing/extra parse, fetch, close and zero-row terminal fetch.
- Different fetch sizes/row counts and truncated windows.
- No waits captured versus genuinely zero recorded waits.
- Missing obj#, missing names, identical object names with different identities.
- Inclusive parent with recursive children and waits attached at different depths.
- In-call idle-class wait and between-call client wait.
- CPU/waits exceeding elapsed because of incomplete or inconsistent evidence.
- Multiple contexts/files and cursor reuse.
- Large call/wait sets, explicit truncation, abort and live revision refresh.
- CR/CU all-consistent, all-current, zero, missing and very small proportions.
- Optional cross-database/container identity limitations.

Commands to adapt to the actual change:
- In web/: pnpm typecheck and pnpm test.
- Go tests for affected internal/analyze, internal/slice and any model changes.
- Full repository checks required by applicable instructions.
- Build the UI when integration is ready; note that make web installs dependencies and updates embedded assets, so understand its side effects first.

Inspect rendered states in the actual app at suitable desktop and narrow viewports. Verify both themes and keyboard access. Follow the active environment's browser-tool rules. Do not claim a preview was tested merely because a build passed.

For performance, record fixture size, environment and observed timings. Establish a bounded-payload/query approach before making responsiveness promises; no app-specific performance benchmark has been measured for this feature.

## 17. Oracle terminology and evidence sources

Read these alongside local model semantics:
- [Oracle 19c: memory architecture, buffer modes and states](https://docs.oracle.com/en/database/oracle/oracle-database/19/cncpt/memory-architecture.html)
- [Oracle 19c: application tracing and call statistics](https://docs.oracle.com/en/database/oracle/oracle-database/19/tgsql/performing-application-tracing.html)
- [Oracle 19c: data concurrency and consistency](https://docs.oracle.com/en/database/oracle/oracle-database/19/cncpt/data-concurrency-and-consistency.html)
- [Oracle wait-event reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/descriptions-of-wait-events.html)

The last link is the version consulted during concept work. Match documentation to the trace/database version when implementing event-specific interpretation.

Important distinctions:
- Consistent/current buffer access modes differ from clean/dirty buffer state.
- Dirty buffer means modified and not yet written to disk.
- Dirty read means reading another transaction's uncommitted data; Oracle does not permit it.
- Logical access can follow physical I/O; cr/cu and p are not a partition into mutually exclusive hit/miss buckets.
- Wait evidence identifies recorded waiting and associations, not a complete physical I/O history or proven root cause.

## 18. Suggested skills for the receiving agent

Apply only when relevant and follow the current session's available versions:
- implement: execute a scoped implementation from this specification.
- modern-web-guidance and good-css: frontend/CSS work.
- vercel-react-best-practices: React implementation and performance.
- codebase-design: define a deep analysis/data-source boundary.
- diagnosing-bugs: if existing attribution or scope behavior fails a reproduced case.
- dbmint-oracle-test: only if a later task explicitly authorizes database-backed validation; do not contact a database as an assumed prerequisite.
- code-review: review the resulting change against the repository's rules when requested.

Do not start delegated agents merely because this document is for another agent. Follow the receiving session's delegation policy.

## 19. Remaining choices to resolve during implementation

These were not settled by the user:
- Exact entry point and whether Loom is a subview or an expansion of ExecCompare.
- API method/route name and paging limits.
- How many comparable executions to display in a future cohort.
- Baseline-selection defaults beyond an explicit pair.
- Whether to support self-time in the first version.
- Whether to add full-execution inspection outside an active time window.
- Event palette details beyond stable identity and theme compatibility.
- A numeric threshold for highlighting changed read mix; default to displaying exact differences until justified.

Resolve routine choices from existing application patterns. Escalate only decisions that materially change the agreed interpretation or scope.
