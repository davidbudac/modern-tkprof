#!/usr/bin/env bash
# Runs inside the mtkprof-ci image with the repository at /src, this app at /src/desktop (see scripts/ci-local.sh, which owns the
# docker run and the volumes). usage: ci/in-container.sh <linux|windows> [--skip-smoke] [--no-appimage]
# Records its steps in $CI_RESULTS; exits non-zero when a required step failed.
set -uo pipefail
cd /src/desktop
. ci/lib.sh

leg=${1:?usage: in-container.sh <linux|windows> [--skip-smoke] [--no-appimage]}
shift
smoke=1 appimage=1
for a in "$@"; do
  case $a in
    --skip-smoke) smoke=0 ;;
    --no-appimage) appimage=0 ;;
    *) echo "in-container: unknown option $a" >&2; exit 2 ;;
  esac
done

# the Mac's node_modules do not apply here: /src/node_modules, /src/{web,desktop}/node_modules are volumes
run_step "$leg: pnpm install" pnpm install --frozen-lockfile || exit 1
run_step "$leg: ui and main process" pnpm build || exit 1

linux() {
  local targets=(deb)
  [ $appimage -eq 1 ] && targets+=(AppImage) || skip "linux-x64: appimage" "--no-appimage"
  run_step "linux-x64: engine" pnpm build:engine --target linux-x64 || return 1
  rm -rf release
  run_step "linux-x64: ${targets[*]}" node_modules/.bin/electron-builder --linux "${targets[@]}" --x64 || return 1
  collect_installers || return 1
  if [ $smoke -eq 1 ]; then
    # smoke.sh starts its own Xvfb and dbus session on Linux
    run_step "linux-x64: smoke" bash scripts/smoke.sh release/linux-unpacked/mtkprof-desktop linux-x64 || return 1
  else
    skip "linux-x64: smoke" "--skip-smoke"
  fi
}

windows() {
  run_step "windows-x64: engine" pnpm build:engine --target win-x64 || return 1
  rm -rf release
  # wine runs rcedit, which puts the icon and the version into mtkprof.exe
  run_step "windows-x64: nsis" node_modules/.bin/electron-builder --win nsis --x64 || return 1
  collect_installers || return 1
  skip "windows-x64: smoke" "no Windows to run it on (cross-built on Linux)"
}

case $leg in
  linux) linux ;;
  windows) windows ;;
  *) echo "in-container: unknown leg $leg" >&2; exit 2 ;;
esac
