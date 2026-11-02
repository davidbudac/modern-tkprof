#!/usr/bin/env bash
# Build the macOS arm64 app as fast as possible, for local iteration: no checks, no tests, no
# smoke, no typecheck. Cargo links with thin LTO and 16 codegen units (about 20 s instead of the
# 80 s of the release profile). That setting change would invalidate the normal release cache, so
# the build uses its own target dir, src-tauri/target-quick (gitignored); both caches stay warm.
# The result is a dev-quality build of the release profile, not an artifact to ship.
#
# usage: scripts/build-mac-quick.sh [--app] [--open] [--run]
#   --app   build only the .app bundle (skips the DMG creation, fastest)
#   --open  reveal the result in Finder when done
#   --run   launch the built .app when done (quits a running mtkprof first: single-instance)
# Without --app the DMG is built and copied to out/ (like ci-local.sh does).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

for d in /usr/local/go/bin "$HOME/.local/go/bin" "$HOME/.cargo/bin"; do
  [ -d "$d" ] && PATH=$d:$PATH
done
export PATH

bundle=dmg open_out=0 run_app=0
while [ $# -gt 0 ]; do
  case $1 in
    --app) bundle=app ;;
    --open) open_out=1 ;;
    --run) run_app=1 ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-mac-quick: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = Darwin ] || { echo "build-mac-quick: macOS only" >&2; exit 2; }
fail() { echo "build-mac-quick: $*" >&2; exit 1; }
for c in pnpm cargo rustup go; do
  command -v "$c" >/dev/null || fail "$c not found in PATH"
done

triple=aarch64-apple-darwin
rustup target list --installed 2>/dev/null | grep -qx "$triple" || fail "rust target $triple missing: rustup target add $triple"

export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_TARGET_DIR=$PWD/src-tauri/target-quick
b=$CARGO_TARGET_DIR/$triple/release/bundle

t_start=$SECONDS
rm -rf "$b/dmg"/*.dmg "$b/macos/mtkprof.app" 2>/dev/null

echo "== engine =="
pnpm build:engine --target "$triple" || fail "engine build failed"

# vite build alone, tauri's default beforeBuildCommand would also run the typecheck (tsc -b)
echo "== tauri build ($bundle) =="
pnpm tauri build --target "$triple" --bundles "$bundle" --ci \
  --config '{"build":{"beforeBuildCommand":"pnpm exec vite build"}}' || fail "tauri build failed"

if [ "$bundle" = dmg ]; then
  result=$(find "$b/dmg" -maxdepth 1 -type f -name '*.dmg' 2>/dev/null | head -n 1)
  [ -n "$result" ] || fail "no dmg found under $b/dmg"
  mkdir -p out && rm -f out/*_aarch64.dmg && cp "$result" out/ && echo "copied to out/$(basename "$result")"
else
  result=$b/macos/mtkprof.app
  [ -d "$result" ] || fail "no app found at $result"
fi

printf '\nbuilt %s in %ss\n' "$result" $((SECONDS - t_start))
[ $open_out -eq 1 ] && open -R "$result"

if [ $run_app -eq 1 ]; then
  app=$b/macos/mtkprof.app
  [ -d "$app" ] || fail "--run needs the .app bundle (not found: $app)"
  if pgrep -x mtkprof-desktop >/dev/null; then
    echo "build-mac-quick: quitting the running mtkprof (single-instance)"
    osascript -e 'quit app "mtkprof"' >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x mtkprof-desktop >/dev/null || break; sleep 1; done
    pgrep -x mtkprof-desktop >/dev/null && fail "mtkprof is still running; quit it first"
  fi
  open "$app"
fi
