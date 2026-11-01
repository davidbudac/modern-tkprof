#!/usr/bin/env bash
# Publish the website (site/) to GitHub Pages from the gh-pages branch.
# No GitHub Actions: the branch is the history of site/ as of the committed
# HEAD (git subtree split), pushed as a fast-forward, and Pages serves it.
#
#   scripts/publish-site.sh [--dry-run]
#
# Refuses when site/ has uncommitted changes. On the first run it also turns
# Pages on for the repository (source: gh-pages, /). Never force-pushes.
#   --dry-run   split and show what would be pushed, push nothing
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="davidbudac/modern-tkprof"
URL="https://davidbudac.github.io/modern-tkprof/"
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

cd "$ROOT"
if [ -n "$(git status --porcelain -- site)" ]; then
  echo "site/ has uncommitted changes; commit them first" >&2
  exit 1
fi

SPLIT="$(git subtree split -q --prefix=site HEAD)"
echo "site/ at $(git rev-parse --short HEAD) -> gh-pages commit ${SPLIT:0:12}"

if [ "$DRY" = 1 ]; then
  git ls-tree --name-only "$SPLIT"
  exit 0
fi

git push origin "$SPLIT:refs/heads/gh-pages"

if ! gh api "repos/$REPO/pages" >/dev/null 2>&1; then
  echo "turning on GitHub Pages (gh-pages, /)"
  gh api -X POST "repos/$REPO/pages" -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null
fi

echo "published; Pages rebuilds in a minute or so: $URL"
