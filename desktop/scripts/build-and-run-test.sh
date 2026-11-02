#!/usr/bin/env bash
# Build the current working tree as a separate macOS test app, then open it.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  '') ;;
  --build-only) ;;
  -h|--help)
    echo 'Usage: scripts/build-and-run-test.sh [--build-only]'
    echo 'Builds mtkprof Test with separate settings/cache, then opens it.'
    echo 'Quit any running mtkprof Test before rebuilding. The normal app can stay open.'
    exit 0
    ;;
  *) echo 'Usage: scripts/build-and-run-test.sh [--build-only]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'Too many arguments.' >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo 'This script requires macOS.' >&2; exit 1; }

for tool_dir in /opt/homebrew/bin /usr/local/go/bin "$HOME/.local/go/bin" "$HOME/.cargo/bin"; do
  if [[ -d "$tool_dir" ]]; then PATH="$tool_dir:$PATH"; fi
done
export PATH
for tool in node pnpm cargo rustc go; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
for tool in node_modules/.bin/tsc node_modules/.bin/vite node_modules/.bin/tauri engine/web/node_modules/.bin/vite; do
  [[ -x "$tool" ]] || { echo "Missing $tool. Install dependencies in this repo and engine/web first." >&2; exit 1; }
done

# Do not silently focus an older running build or replace its bundle while in use.
if pgrep -f '/mtkprof Test\.app/Contents/MacOS/mtkprof-desktop([[:space:]]|$)' >/dev/null; then
  echo 'mtkprof Test is already running. Quit it with Cmd+Q, then run this script again.' >&2
  exit 1
fi

# Use the installed pnpm instead of downloading the packageManager pin during Tauri's checks.
export npm_config_manage_package_manager_versions=false
export CARGO_TARGET_DIR="$PWD/src-tauri/target"

echo 'Checking TypeScript…'
node_modules/.bin/tsc --noEmit

echo 'Building the engine UI and sidecar…'
(cd engine/web && node_modules/.bin/vite build)
cp engine/web/dist/index.html engine/internal/ui/dist/index.html
node scripts/build-engine.mjs

echo 'Building mtkprof Test…'
node_modules/.bin/tauri build --debug --bundles app --ci --config \
  '{"productName":"mtkprof Test","identifier":"com.davidbudac.mtkprof.test20261029","build":{"beforeBuildCommand":"node_modules/.bin/vite build"},"app":{"windows":[{"label":"main","title":"mtkprof Test","width":1400,"height":900,"minWidth":1100,"minHeight":700,"resizable":true}]}}'

test_app="$CARGO_TARGET_DIR/debug/bundle/macos/mtkprof Test.app"
codesign --verify --deep --strict "$test_app"
printf '\nBuilt: %s\n' "$test_app"
if [[ "${1:-}" != --build-only ]]; then
  open "$test_app"
fi
