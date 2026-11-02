#!/usr/bin/env bash
# Runs inside the mtkprof-ci image with the repo at /src (see scripts/ci-local.sh, which owns the
# docker run and the volumes). usage: ci/in-container.sh <linux|windows> [--skip-smoke] [--no-appimage]
# Records its steps in $CI_RESULTS; exits non-zero when a required step failed.
set -uo pipefail
cd /src
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

# the Mac's node_modules does not apply here: /src/node_modules is a volume
run_step "$leg: pnpm install" pnpm install --frozen-lockfile || exit 1

linux() {
  local t=x86_64-unknown-linux-gnu
  rm -rf "src-tauri/target/$t/release/bundle"
  run_step "linux-x64: engine" pnpm build:engine --target $t || return 1
  run_step "linux-x64: deb" pnpm tauri build --target $t --bundles deb --ci || return 1
  if [ $appimage -eq 1 ]; then
    # linuxdeploy is itself an AppImage: run it extracted, without FUSE
    if ! APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true run_step "linux-x64: appimage" \
      pnpm tauri build --target $t --bundles appimage --ci > out-logs/linux-appimage.log 2>&1; then
      tail -n 30 out-logs/linux-appimage.log
      echo "linux-x64: appimage failed (full log out-logs/linux-appimage.log; --no-appimage to build the deb only)"
      return 1
    fi
  else
    skip "linux-x64: appimage" "--no-appimage"
  fi
  collect_installers $t || return 1
  if [ $smoke -eq 1 ]; then
    # smoke.sh starts its own Xvfb and dbus session on Linux
    run_step "linux-x64: smoke" bash scripts/smoke.sh $t linux-x64 || return 1
  else
    skip "linux-x64: smoke" "--skip-smoke"
  fi
}

windows() {
  local t=x86_64-pc-windows-msvc
  rm -rf "src-tauri/target/$t/release/bundle"
  run_step "windows-x64: engine" pnpm build:engine --target $t || return 1
  run_step "windows-x64: nsis" pnpm tauri build --runner cargo-xwin --target $t --bundles nsis --ci || return 1
  collect_installers $t || return 1
  skip "windows-x64: smoke" "no Windows to run it on (cross-built on Linux)"
}

case $leg in
  linux) linux ;;
  windows) windows ;;
  *) echo "in-container: unknown leg $leg" >&2; exit 2 ;;
esac
