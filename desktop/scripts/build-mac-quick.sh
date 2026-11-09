#!/usr/bin/env bash
# Build the macOS arm64 app as fast as possible, for local iteration: no checks, no tests, no
# smoke, no typecheck; the engine, the UI and the main process, then electron-builder's unpacked
# app (release/mac-arm64/mtkprof.app), and with --dmg the DMG in out/ too. Not an artifact to ship.
# For a run with its own settings, cache and keys (the old "mtkprof Test" app):
#   MTKPROF_PROFILE=/tmp/mtk-test pnpm app
#
# usage: scripts/build-mac-quick.sh [--dmg] [--open] [--run]
#   --dmg   also build the DMG and copy it to out/
#   --open  reveal the result in Finder when done
#   --run   launch the built app when done
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

for d in /usr/local/go/bin "$HOME/.local/go/bin"; do
  [ -d "$d" ] && PATH=$d:$PATH
done
export PATH

target=dir open_out=0 run_app=0
while [ $# -gt 0 ]; do
  case $1 in
    --dmg) target=dmg ;;
    --open) open_out=1 ;;
    --run) run_app=1 ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-mac-quick: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "build-mac-quick: macOS only" >&2; exit 2; }

t0=$SECONDS
node scripts/build-engine.mjs --target mac-arm64 || exit 1
node_modules/.bin/vite build >/dev/null || exit 1
node scripts/build-electron.mjs || exit 1
node_modules/.bin/electron-builder --mac "$target" --arm64 || exit 1
app=release/mac-arm64/mtkprof.app
if [ $target = dmg ]; then
  mkdir -p out && cp release/*.dmg out/
  ls -lh out/*.dmg
fi
echo "build-mac-quick: $app in $((SECONDS - t0)) s"
[ $open_out -eq 1 ] && open -R "$app"
[ $run_app -eq 1 ] && open "$app"
exit 0
