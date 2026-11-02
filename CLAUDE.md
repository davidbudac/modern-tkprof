# mtkprof — notes for agents

Read `docs/HANDOFF.md` first, then `docs/DESIGN.md` (decisions; change the
file when a decision changes), `docs/ARCHITECTURE.md`, `docs/trace-format-19c.md`.

## Layout: one engine, two clients

- Engine + CLI: the repository root (`go.mod`, `cmd/mtkprof`, `internal/`, `api/`, `testdata/`).
- `web/`: the CLI's UI (`web/src/app`, embedded in the binary) and the shared lib `web/src/lib`.
- `desktop/`: the Tauri app; imports the lib as `@lib` and builds its sidecar from `cmd/mtkprof`. Read
  `desktop/CLAUDE.md` before working there.
- One pnpm workspace at the root (`pnpm-workspace.yaml`); run `pnpm install` at the root. Versions both
  clients use live in its `catalog:`.
- A lib or API change and the desktop's adaptation go in the same commit.

## Commands

- Go is `/usr/local/go/bin/go` on this machine: `export PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=auto`.
- `scripts/ci-local.sh` is the CI (vet, tests, web build, embedded-UI check, desktop checks, `make release`; `--strict`, `--no-release`, `--no-desktop`). No GitHub Actions.
- Releases: one version and one tag for both clients. `scripts/release-local.sh <tag>` publishes the CLI binaries; `desktop/scripts/release-local.sh <tag>` (on a Mac) adds the installers to the same release.
- `make build` → `bin/mtkprof`; `make test` runs unit + golden tests (must stay green).
- `make web` rebuilds the UI (`web/`, pnpm) and copies it into `internal/ui/dist/`; rebuild Go afterwards. The built UI is committed.
- `pnpm -r typecheck` before committing UI changes: a lib change can break the desktop.
- `api/engine.openapi.yaml` and `internal/engine` routes change together: `go test ./internal/engine` (contract test) fails on any mismatch; breaking changes bump `engine.Protocol`. Then `cd desktop && pnpm gen:api` and commit `desktop/src/engine/api.d.ts`.

## Rules

- tkprof parity is a hard test (`internal/golden`); if numbers must differ from tkprof, document why in the test.
- Real fixtures only: generate new trace scenarios on the dbmint lab with `testdata/gen/run_gen.sh` (see the `dbmint-oracle-test` skill); never hand-write trace files except for unit tests of single lines.
- Cache formats: changing a persisted struct (`internal/model/persist.go`, `internal/analyze/persist.go`, spill index, line index) means bumping its version and `engine.CacheIndexFormat`, and updating `TestCacheIndexFormatCoversParts`; the guard tests fail when a field is added without a bump.
- Pure Go, no cgo: Linux, Windows, AIX and Solaris builds must keep working (`make release`).
- UI changes are verified with a screenshot before committing (desktop: the `verify-mtkprof` skill).
- Commits go to `main` with concise messages; push after each milestone.
- Report to the user briefly (see the user's global CLAUDE.md).

## Harness quirks

- Use absolute paths in Bash heredocs and scripts; `cd` at the start of a call is unreliable.
- Find dev servers by port (`ss -ltnp | grep :8046`), never with `pkill -f`.
- SSH/scp to dbmint needs `dangerouslyDisableSandbox: true`.
