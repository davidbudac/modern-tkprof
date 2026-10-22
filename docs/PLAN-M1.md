# Milestone 1 plan and status

Started 2026-10-22. Scope: `docs/HANDOFF.md` § Milestone 1 (text-report
parity, pivot, findings, bind redaction). Work is split into independent
packages, each implemented on its own branch/worktree by an agent and
merged into branch `m1`, then `main`.

| Package | Branch | Owner | Status |
|---|---|---|---|
| A. Findings (`analyze/findings.go`, JSON `stats.findings`, text section, Overview UI) | `m1-findings` | agent | in progress |
| B. Text report sections (executions table, sessions, time buckets) + `pivot` subcommand + Go group-by | `m1-textpivot` | agent | in progress |
| C. Bind redaction `-redact-binds` / `-binds none` on report/html/json/export | `m1-binds` | agent | in progress |
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
