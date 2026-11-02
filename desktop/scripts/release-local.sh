#!/usr/bin/env bash
# Publish a release from this machine (no GitHub Actions: CI is local by decision, see README).
# usage: scripts/release-local.sh <tag> [--dry-run] [--check-only] [--notes-file FILE] [--no-appimage]
#
# Refuses unless: the working tree is clean, HEAD is exactly <tag> (annotated or lightweight) and
# the app version in package.json, src-tauri/Cargo.toml (+ Cargo.lock) and tauri.conf.json
# matches the tag. Then runs scripts/ci-local.sh with every leg and smoke, and creates the GitHub
# release as a prerelease with everything in out/ (installers + SHA256SUMS).
# It never creates or pushes the tag: `git tag -a vX.Y.Z && git push origin vX.Y.Z` first
# (gh release create --verify-tag fails when the tag is not on GitHub).
#   --dry-run     everything except `gh release create` (prints the command and the notes)
#   --check-only  only the checks above, no build
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
for d in /usr/local/go/bin "$HOME/.local/go/bin" "$HOME/.cargo/bin"; do [ -d "$d" ] && PATH=$d:$PATH; done
export PATH

die() { echo "release-local: $*" >&2; exit 1; }

tag= dry=0 check_only=0 notes= ci_args=() want_appimage=1
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    --check-only) check_only=1 ;;
    --notes-file) notes=${2:?--notes-file needs a file}; shift ;;
    --no-appimage) ci_args+=(--no-appimage); want_appimage=0 ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$tag" ] || die "one tag only"; tag=$1 ;;
  esac
  shift
done
[ -n "$tag" ] || die "usage: scripts/release-local.sh <tag> [--dry-run] [--notes-file FILE]"
case $tag in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "tag '$tag' is not vX.Y.Z" ;; esac
ver=${tag#v}
[ -z "$notes" ] || [ -f "$notes" ] || die "notes file $notes not found"

# ---- 1. the tag, the tree, the versions ----
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag does not exist locally; create it on the release commit (this script never tags or pushes)"
[ "$(git rev-parse "$tag^{commit}")" = "$(git rev-parse HEAD)" ] \
  || die "HEAD ($(git rev-parse --short HEAD)) is not $tag ($(git rev-parse --short "$tag^{commit}")): git checkout $tag"
[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "working tree is not clean"; }

v_pkg=$(node -p "require('./package.json').version")
v_cargo=$(awk '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version *=/{gsub(/[" ]/,"",$0); sub(/^version=/,"",$0); print; exit}' src-tauri/Cargo.toml)
v_lock=$(awk '/^name = "mtkprof-desktop"$/{getline; gsub(/[" ]/,"",$0); sub(/^version=/,"",$0); print; exit}' src-tauri/Cargo.lock)
v_tauri=$(node -p "const v=require('./src-tauri/tauri.conf.json').version; /^\d/.test(v) ? v : ''")  # a path like ../package.json carries none
bad=0
for pair in "package.json=$v_pkg" "src-tauri/Cargo.toml=$v_cargo" "src-tauri/Cargo.lock=$v_lock"; do
  [ "${pair#*=}" = "$ver" ] || { echo "release-local: ${pair%%=*} has version '${pair#*=}', tag wants $ver" >&2; bad=1; }
done
[ -z "$v_tauri" ] || [ "$v_tauri" = "$ver" ] || { echo "release-local: tauri.conf.json has version '$v_tauri', tag wants $ver" >&2; bad=1; }
[ $bad -eq 0 ] || die "version mismatch"
echo "release-local: $tag = HEAD $(git rev-parse --short HEAD), tree clean, versions $ver (package.json, Cargo.toml, Cargo.lock${v_tauri:+, tauri.conf.json})"
[ $check_only -eq 0 ] || exit 0

if [ $dry -eq 0 ]; then
  command -v gh >/dev/null || die "gh not found"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
  git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 \
    || die "tag $tag is not on origin; push it first (git push origin $tag). Not done here on purpose"
  ! gh release view "$tag" >/dev/null 2>&1 || die "a release $tag already exists on GitHub"
fi

# ---- 2. build everything ----
scripts/ci-local.sh ${ci_args[@]+"${ci_args[@]}"} || die "ci-local.sh failed; nothing published (logs in out-logs/)"

[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "the build dirtied the working tree"; }
req=('*_aarch64.dmg' '*_x64.dmg' '*-setup.exe' '*_amd64.deb' SHA256SUMS)
[ $want_appimage -eq 0 ] || req+=('*_amd64.AppImage')
for pat in "${req[@]}"; do
  # shellcheck disable=SC2086
  ls out/$pat >/dev/null 2>&1 || die "out/ has no $pat; refusing a partial release"
done

# ---- 3. notes and release ----
if [ -z "$notes" ]; then
  notes=out-logs/release-notes.md
  prev=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)
  {
    echo "mtkprof desktop $ver. Engine: $(git -C engine describe --tags --always) ($(git -C engine rev-parse --short HEAD))."
    echo
    echo "Built and smoke-tested on $(hostname -s) ($(uname -sm)) with scripts/ci-local.sh; no CI. Installers are unsigned (see the README)."
    echo
    if [ -n "$prev" ]; then echo "Changes since $prev:"; git log --no-merges --format='- %s' "$prev..$tag"; else git log --no-merges --format='- %s' "$tag"; fi
    echo
    echo "SHA-256:"
    echo '```'
    cat out/SHA256SUMS
    echo '```'
  } > "$notes"
fi
echo "--- release notes ($notes) ---"; cat "$notes"; echo "---"

files=(out/*)
cmd=(gh release create "$tag" --prerelease --verify-tag --title "$tag" --notes-file "$notes" "${files[@]}")
if [ $dry -eq 1 ]; then
  echo "release-local: dry run, would run:"; printf '  %q' "${cmd[@]}"; echo
  exit 0
fi
"${cmd[@]}" && echo "release-local: published $tag"
