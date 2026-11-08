#!/usr/bin/env bash
# Add the desktop installers to a release, from a Mac (no GitHub Actions: CI is local by decision).
# usage: scripts/release-local.sh <tag> [--dry-run] [--check-only] [--no-appimage]
#
# One version for the CLI and the app: the repository's scripts/release-local.sh <tag> creates the
# GitHub release <tag> with the CLI binaries (and runs this script with --check-only first); this
# script then builds the installers and uploads them to that release.
# Refuses unless: the working tree is clean, HEAD is exactly <tag> (annotated or lightweight) and
# the app version in package.json, src-tauri/Cargo.toml (+ Cargo.lock) and tauri.conf.json
# matches the tag, and the updater's signing key is there (TAURI_SIGNING_PRIVATE_KEY or
# ~/.tauri/mtkprof-updater.key; see README.md § Updates). Then runs scripts/ci-local.sh with every
# leg and smoke, uploads everything in out/ (the installers, the updater artifacts and their .sig,
# their SHA256SUMS as SHA256SUMS-desktop), then latest.json (scripts/updater-manifest.mjs: what the
# installed apps check on start; last, so it never names a file not yet uploaded) and adds the
# installers' checksums to the release notes. It never creates or pushes the tag or creates the release.
#   --dry-run     everything except the upload (prints the commands and the notes addition)
#   --check-only  only the checks above, no build
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
for d in /usr/local/go/bin "$HOME/.local/go/bin" "$HOME/.cargo/bin"; do [ -d "$d" ] && PATH=$d:$PATH; done
export PATH

die() { echo "release-local: $*" >&2; exit 1; }

tag= dry=0 check_only=0 ci_args=() want_appimage=1
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    --check-only) check_only=1 ;;
    --no-appimage) ci_args+=(--no-appimage); want_appimage=0 ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$tag" ] || die "one tag only"; tag=$1 ;;
  esac
  shift
done
[ -n "$tag" ] || die "usage: scripts/release-local.sh <tag> [--dry-run] [--check-only] [--no-appimage]"
case $tag in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "tag '$tag' is not vX.Y.Z" ;; esac
ver=${tag#v}

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
. ci/lib.sh
updater_key
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] \
  || die "no updater signing key (TAURI_SIGNING_PRIVATE_KEY, or the file ~/.tauri/mtkprof-updater.key): the installed apps could not update to this release"
echo "release-local: $tag = HEAD $(git rev-parse --short HEAD), tree clean, versions $ver (package.json, Cargo.toml, Cargo.lock${v_tauri:+, tauri.conf.json})"
[ $check_only -eq 0 ] || exit 0

if [ $dry -eq 0 ]; then
  command -v gh >/dev/null || die "gh not found"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
  git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 \
    || die "tag $tag is not on origin; push it first (git push origin $tag). Not done here on purpose"
  gh release view "$tag" >/dev/null 2>&1 || die "no release $tag on GitHub; publish the CLI first (scripts/release-local.sh $tag at the repository root)"
  ! gh release view "$tag" --json assets -q '.assets[].name' | grep -q '\.dmg$' || die "release $tag already has installers"
fi

# ---- 2. build everything ----
scripts/ci-local.sh ${ci_args[@]+"${ci_args[@]}"} || die "ci-local.sh failed; nothing published (logs in out-logs/)"

[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "the build dirtied the working tree"; }
req=('*_aarch64.dmg' '*_x64.dmg' '*-setup.exe' '*_amd64.deb' SHA256SUMS
  '*_aarch64.app.tar.gz' '*_aarch64.app.tar.gz.sig' '*_x64.app.tar.gz' '*_x64.app.tar.gz.sig' '*-setup.exe.sig' '*_amd64.deb.sig')
[ $want_appimage -eq 0 ] || req+=('*_amd64.AppImage' '*_amd64.AppImage.sig')
for pat in "${req[@]}"; do
  # shellcheck disable=SC2086
  ls out/$pat >/dev/null 2>&1 || die "out/ has no $pat; refusing a partial release"
done

manifest=out-logs/latest.json
node scripts/updater-manifest.mjs "$tag" out > "$manifest" || die "latest.json failed"

# ---- 3. upload to the release ----
cp out/SHA256SUMS out-logs/SHA256SUMS-desktop
files=()
for f in out/*; do [ "$(basename "$f")" = SHA256SUMS ] || files+=("$f"); done
files+=(out-logs/SHA256SUMS-desktop)
add=out-logs/release-notes-desktop.md
{
  echo
  echo "Desktop installers, built and smoke-tested on $(hostname -s) ($(uname -sm)) with desktop/scripts/ci-local.sh; unsigned (see desktop/README.md). SHA-256:"
  echo '```'
  cat out/SHA256SUMS
  echo '```'
} > "$add"
echo "--- added to the release notes ---"; cat "$add"; echo "---"
upload=(gh release upload "$tag" "${files[@]}")
upload_manifest=(gh release upload "$tag" "$manifest")
if [ $dry -eq 1 ]; then
  echo "release-local: dry run, would run:"; printf '  %q' "${upload[@]}"; echo
  printf '  %q' "${upload_manifest[@]}"; echo
  echo "  and append $add to the notes of $tag"
  echo "--- $manifest ---"; cat "$manifest"
  exit 0
fi
"${upload[@]}" || die "upload failed"
"${upload_manifest[@]}" || die "upload of latest.json failed (the installers are up: gh release upload $tag $manifest)"
body=out-logs/release-notes.md
gh release view "$tag" --json body -q .body > "$body" && cat "$add" >> "$body" && gh release edit "$tag" --notes-file "$body" \
  && echo "release-local: installers added to $tag"
