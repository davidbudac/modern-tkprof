# mtkprof — notes for agents

Read `docs/HANDOFF.md` first, then `docs/DESIGN.md` (decisions; change the
file when a decision changes), `docs/ARCHITECTURE.md`, `docs/trace-format-19c.md`.

## Commands

- Go lives at `~/.local/go/bin` on this machine: `export PATH=$HOME/.local/go/bin:$PATH`.
- `scripts/ci-local.sh` is the CI (vet, tests, web build, embedded-UI check, `make release`; `--strict`, `--no-release`); `scripts/release-local.sh <tag>` publishes. No GitHub Actions.
- `make build` → `bin/mtkprof`; `make test` runs unit + golden tests (must stay green).
- `make web` rebuilds the UI (`web/`, pnpm) and copies it into `internal/ui/dist/`; rebuild Go afterwards. The built UI is committed.
- `cd web && pnpm typecheck` before committing UI changes.
- `api/engine.openapi.yaml` and `internal/engine` routes change together: `go test ./internal/engine` (contract test) fails on any mismatch; breaking changes bump `engine.Protocol`.

## Rules

- tkprof parity is a hard test (`internal/golden`); if numbers must differ from tkprof, document why in the test.
- Real fixtures only: generate new trace scenarios on the dbmint lab with `testdata/gen/run_gen.sh` (see the `dbmint-oracle-test` skill); never hand-write trace files except for unit tests of single lines.
- Cache formats: changing a persisted struct (`internal/model/persist.go`, `internal/analyze/persist.go`, spill index, line index) means bumping its version and `engine.CacheIndexFormat`, and updating `TestCacheIndexFormatCoversParts`; the guard tests fail when a field is added without a bump.
- Pure Go, no cgo: Linux, Windows, AIX and Solaris builds must keep working (`make release`).
- UI changes are verified with a screenshot before committing.
- Commits go to `main` with concise messages; push after each milestone.
- Report to the user briefly (see the user's global CLAUDE.md).

## Harness quirks

- Use absolute paths in Bash heredocs and scripts; `cd` at the start of a call is unreliable.
- Find dev servers by port (`ss -ltnp | grep :8046`), never with `pkill -f`.
- SSH/scp to dbmint needs `dangerouslyDisableSandbox: true`.
