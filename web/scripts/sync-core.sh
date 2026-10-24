#!/usr/bin/env bash
# Copy the built @davidbudac/ora-plan-core from a checkout of ora-explain-plan-viz into web/vendor/.
# Looked up in $ORA_PLAN_VIZ, ../../github/ora-explain-plan-viz, ../../ora-explain-plan-viz and ~/github/ora-explain-plan-viz.
# Run `npm run build:core` there first. Then `pnpm install` here to refresh node_modules, and commit.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dst="$here/vendor/ora-plan-core"
src=""
for c in "${ORA_PLAN_VIZ:-}" "$here/../../github/ora-explain-plan-viz" "$here/../../ora-explain-plan-viz" "$HOME/github/ora-explain-plan-viz"; do
  if [ -n "$c" ] && [ -d "$c/packages/ora-plan-core/dist" ]; then src="$c/packages/ora-plan-core"; break; fi
done
if [ -z "$src" ]; then echo "no built ora-plan-core found (set ORA_PLAN_VIZ to the ora-explain-plan-viz checkout; run npm run build:core there)" >&2; exit 1; fi
mkdir -p "$dst"
repo="$(cd "$src/../.." && pwd)"
sha="$(git -C "$repo" rev-parse --short=12 HEAD)"
rm -rf "$dst/dist"
cp "$src/package.json" "$dst/package.json"
cp -r "$src/dist" "$dst/dist"
cat > "$dst/README.md" <<README
# Vendored @davidbudac/ora-plan-core

Built output of \`packages/ora-plan-core\` in https://github.com/davidbudac/ora-explain-plan-viz
(same owner), copied verbatim; do not edit. Inherits that repository's licence.

- source commit: \`$sha\`$(git -C "$repo" diff --quiet -- packages/ora-plan-core || echo " (+ uncommitted changes)")
- resync: \`web/scripts/sync-core.sh\` (finds the checkout in \`\$ORA_PLAN_VIZ\`, next to the repo or in \`~/github\`;
  run \`npm run build:core\` there first), then \`pnpm install\` and commit.
README
echo "synced ora-plan-core @ $sha"
