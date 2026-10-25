#!/usr/bin/env bash
# Local CI for mtkprof (replaces the former GitHub Actions workflow).
#
#   scripts/ci-local.sh [--strict] [--no-release] [--no-web] [--no-go]
#
# Steps: go vet, go test ./... (unit, golden, engine contract), web install /
# typecheck / test / build, embedded-UI check, cross-build of every release
# target (make release with a throwaway version).
#   --strict      a stale internal/ui/dist/index.html (differs from a fresh web
#                 build) fails the run; without it only a loud warning is shown
#   --no-release  skip the cross-build check
#   --no-web      skip the web steps
#   --no-go       skip go vet / go test
# Exit status 0 only when every step passed.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRICT=0; RELEASE=1; WEB=1; GO_STEPS=1
for a in "$@"; do
  case "$a" in
    --strict) STRICT=1 ;;
    --no-release) RELEASE=0 ;;
    --no-web) WEB=0 ;;
    --no-go) GO_STEPS=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

for d in "$HOME/.local/go/bin" /usr/local/go/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
cd "$ROOT" || exit 2

command -v go >/dev/null || { echo "go not found (looked in ~/.local/go/bin, /usr/local/go/bin, PATH)" >&2; exit 2; }
if [ "$WEB" = 1 ]; then
  command -v pnpm >/dev/null || { echo "pnpm not found (use --no-web to skip the web steps)" >&2; exit 2; }
fi

NAMES=(); RESULTS=(); TIMES=(); FAILED=0
record() { NAMES+=("$1"); RESULTS+=("$2"); TIMES+=("$3"); [ "$2" = FAIL ] && FAILED=1; }

# step <name> <command...>: run, time, record; keeps going after a failure.
step() {
  local name="$1"; shift
  echo; echo "==> $name"
  local t0=$SECONDS
  if "$@"; then record "$name" ok $((SECONDS - t0)); else record "$name" FAIL $((SECONDS - t0)); return 1; fi
}

# web/tsconfig.tsbuildinfo is tracked but rewritten by typecheck; put it back
# afterwards if it was clean before, so a CI run leaves the tree clean.
git diff --quiet -- web/tsconfig.tsbuildinfo 2>/dev/null && TSBI_CLEAN=1 || TSBI_CLEAN=0
web_steps() {
  local rc=0
  ( cd "$ROOT/web" && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build ) || rc=$?
  [ "$TSBI_CLEAN" = 1 ] && git checkout -q -- web/tsconfig.tsbuildinfo 2>/dev/null
  return $rc
}

embedded_ui() {
  if [ ! -f "$ROOT/web/dist/index.html" ]; then
    echo "web/dist/index.html missing (web build did not run)"; return 1
  fi
  if diff -q "$ROOT/web/dist/index.html" "$ROOT/internal/ui/dist/index.html" >/dev/null 2>&1; then
    echo "internal/ui/dist/index.html matches a fresh web build"; return 0
  fi
  echo "################################################################"
  echo "WARNING: internal/ui/dist/index.html differs from a fresh web build."
  echo "         Run 'make web' and commit the result."
  echo "################################################################"
  UI_STALE=1
  [ "$STRICT" = 1 ]
}

release_check() {
  local v="ci-local-$(date +%Y%m%d%H%M%S)"
  rm -rf "$ROOT/dist"
  make -C "$ROOT" release VERSION="$v" || return 1
  local n; n=$(ls "$ROOT"/dist/mtkprof-* 2>/dev/null | wc -l | tr -d ' ')
  echo "built $n binaries in dist/ (version $v)"
  [ "$n" -ge 7 ] && [ -s "$ROOT/dist/SHA256SUMS" ] || { echo "expected 7 binaries and SHA256SUMS"; return 1; }
  rm -rf "$ROOT/dist"   # throwaway: dist/ is build output, release-local.sh rebuilds it
}

UI_STALE=0
T_ALL=$SECONDS
echo "go: $(go version)"
if [ "$GO_STEPS" = 1 ]; then
  step "go vet ./..." go vet ./...
  step "go test ./... (unit, golden, engine contract)" go test ./...
fi
if [ "$WEB" = 1 ]; then
  step "web: install, typecheck, test, build" web_steps
  step "embedded UI up to date$([ "$STRICT" = 1 ] && echo ' (strict)')" embedded_ui
fi
[ "$RELEASE" = 1 ] && step "make release (cross-build check)" release_check

echo; echo "==================== ci-local summary ===================="
for i in "${!NAMES[@]}"; do
  printf '  %-4s %5ss  %s\n' "${RESULTS[$i]}" "${TIMES[$i]}" "${NAMES[$i]}"
done
[ "$UI_STALE" = 1 ] && echo "  WARNING: embedded UI is stale (run 'make web'; --strict makes this fatal)"
echo "  total $((SECONDS - T_ALL))s"
if [ "$FAILED" = 0 ]; then echo "RESULT: PASS"; exit 0; else echo "RESULT: FAIL"; exit 1; fi
