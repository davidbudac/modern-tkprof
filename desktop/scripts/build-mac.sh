#!/usr/bin/env bash
# Build the macOS DMGs (arm64 + x64, or arm64 only) into out/, with the checks and
# the arm64 smoke. A thin wrapper around ci-local.sh (the smoke runs the app with a
# profile of its own, so a running mtkprof may stay open).
#
# usage: scripts/build-mac.sh [--fast] [--arm64] [--skip-smoke] [--open]
#   --fast        leave out the checks (install, typecheck, tests)
#   --arm64       build only the arm64 DMG
#   --skip-smoke  no smoke run
#   --open        reveal out/ in Finder when done
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

legs=checks,macos arm64_only=0 skip_smoke=0 open_out=0
while [ $# -gt 0 ]; do
  case $1 in
    --fast) legs=macos ;;
    --arm64) arm64_only=1 ;;
    --skip-smoke) skip_smoke=1 ;;
    --open) open_out=1 ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-mac: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = Darwin ] || { echo "build-mac: macOS only" >&2; exit 2; }

args=(--only "$legs")
[ $arm64_only -eq 1 ] && args+=(--arm64)
[ $skip_smoke -eq 1 ] && args+=(--skip-smoke)

scripts/ci-local.sh "${args[@]}"
rc=$?

echo
ls -lh out/*.dmg 2>/dev/null
[ $open_out -eq 1 ] && open out
exit $rc
