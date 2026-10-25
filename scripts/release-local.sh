#!/usr/bin/env bash
# Local release for mtkprof (replaces the release job of the former GitHub
# Actions workflow). Builds on this machine and uploads with the gh CLI.
#
#   scripts/release-local.sh <tag> [--dry-run] [--notes-file FILE] [--skip-ci]
#
# Refuses unless the working tree is clean and HEAD is exactly <tag> (the tag
# must already exist locally). Runs scripts/ci-local.sh --strict --no-release,
# then `make release VERSION=<tag>`, then
# `gh release create <tag> --title <tag> --notes-file ... dist/mtkprof-* dist/SHA256SUMS`.
# Never pushes tags (push the tag yourself first if gh should not create it:
# gh creates a missing remote tag at the default branch head, so push it) and
# never touches GitHub Actions.
#   --dry-run     do everything except `gh release create`
#   --notes-file  release notes; default: generated from git log since the previous tag
#   --skip-ci     skip ci-local.sh (not recommended)
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG=""; DRY=0; NOTES=""; SKIP_CI=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --skip-ci) SKIP_CI=1 ;;
    --notes-file) shift; NOTES="${1:-}"; [ -n "$NOTES" ] || { echo "--notes-file needs a file" >&2; exit 2; } ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$TAG" ] || { echo "only one tag allowed" >&2; exit 2; }; TAG="$1" ;;
  esac
  shift
done
[ -n "$TAG" ] || { echo "usage: scripts/release-local.sh <tag> [--dry-run] [--notes-file FILE] [--skip-ci]" >&2; exit 2; }

for d in "$HOME/.local/go/bin" /usr/local/go/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
cd "$ROOT"

die() { echo "refusing: $*" >&2; exit 1; }

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG does not exist locally"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
HEAD_SHA="$(git rev-parse HEAD)"
TAG_SHA="$(git rev-parse "refs/tags/$TAG^{commit}")"
[ "$HEAD_SHA" = "$TAG_SHA" ] || die "HEAD ($(git rev-parse --short HEAD)) is not tag $TAG ($(git rev-parse --short "$TAG_SHA")); git checkout $TAG"
if [ "$DRY" = 0 ]; then
  command -v gh >/dev/null || die "gh CLI not found"
  ! gh release view "$TAG" >/dev/null 2>&1 || die "GitHub release $TAG already exists"
fi

if [ "$SKIP_CI" = 0 ]; then
  echo "==> scripts/ci-local.sh --strict --no-release"
  "$ROOT/scripts/ci-local.sh" --strict --no-release
fi

echo "==> make release VERSION=$TAG"
rm -rf "$ROOT/dist"
make release VERSION="$TAG"
ls "$ROOT"/dist/mtkprof-* >/dev/null
( cd "$ROOT/dist" && shasum -a 256 -c SHA256SUMS )

GENERATED=0
if [ -z "$NOTES" ]; then
  NOTES="$(mktemp -t mtkprof-notes)"; GENERATED=1
  PREV="$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)"
  {
    echo "mtkprof $TAG"
    echo
    if [ -n "$PREV" ]; then echo "Changes since $PREV:"; git log --no-merges --pretty='- %s (%h)' "$PREV..$TAG"
    else echo "Changes:"; git log --no-merges --pretty='- %s (%h)' "$TAG"; fi
    echo
    echo "Binaries are unsigned; verify with SHA256SUMS."
  } > "$NOTES"
fi
[ -f "$NOTES" ] || die "notes file $NOTES not found"
echo "==> release notes ($NOTES)"; cat "$NOTES"

if [ "$DRY" = 1 ]; then
  echo "==> dry run: would run: gh release create $TAG --title $TAG --notes-file $NOTES dist/mtkprof-* dist/SHA256SUMS"
  ls -l "$ROOT"/dist
else
  echo "==> gh release create $TAG"
  gh release create "$TAG" --title "$TAG" --notes-file "$NOTES" "$ROOT"/dist/mtkprof-* "$ROOT/dist/SHA256SUMS"
fi
[ "$GENERATED" = 1 ] && rm -f "$NOTES"
exit 0
