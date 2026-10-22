# Milestone 1 plan and status

Started 2026-10-22. Scope: `docs/HANDOFF.md` § Milestone 1 (text-report
parity, pivot, findings, bind redaction). Work is split into independent
packages, each implemented on its own branch/worktree by an agent and
merged into branch `m1`, then `main`.

| Package | Branch | Owner | Status |
|---|---|---|---|
| A. Findings (`analyze/findings.go`, JSON `stats.findings`, text section, Overview UI) | `m1-findings` | agent | in progress |
| B. Text report sections (executions table, sessions, time buckets) + `pivot` subcommand + Go group-by | `m1-textpivot` | agent | merged |
| C. Bind redaction `-redact-binds` / `-bind-values keep|redact|none` / `-binds none` | `m1-binds` | agent | merged |
| D. Plan-change fixture (`testdata/gen/sc_plan_change.sql`, run on dbmint) | `m1-fixture` | agent | merged (plan_change.trc, plh 254283197 → 3570327658) |
| Integration: merge, golden tests, `make web`, screenshots, docs | `m1` | advisor | pending |

## Integration rules

- `make test` must be green on every branch before it is merged.
- Shared files (`cmd/mtkprof/main.go`, `internal/report/text_report.go`,
  `internal/report/doc.go`, `web/src/data/types.ts`): minimal additive edits
  only; new code goes into new files so merges stay trivial.
- UI changes: `cd web && pnpm typecheck`; `make web` is run once at
  integration (the built `internal/ui/dist/index.html` is not committed on
  package branches to avoid binary-ish conflicts).

## Log

- 2026-10-22 plan written, four packages launched in parallel.
- 2026-10-22 D merged: plan_change fixture, golden green (16 tkprof statements).
- 2026-10-22 C merged: bind redaction as a model post-pass (`model.RedactBinds`), flags on report/html/json/export/serve.
- 2026-10-22 B merged: `analyze.Pivot` (same dims/measures as the UI), `mtkprof pivot`, executions table (`-execs`), SESSIONS and TIME BUCKETS sections; one conflict in `cmdReport` flags resolved by hand.
  Follow-ups noted by the implementer (not in M1): UI Pivot buckets with `pickBucket` while the CLI uses `analyze.TimelineBucket`; JSON `stats` could carry `contexts`; executions table shows the per-cursor exec# (1 for every cursor when SQL*Plus reopens the cursor) and relies on the cursor line column to disambiguate.
