#!/bin/sh
# Install the mtkprof CLI binary from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/davidbudac/modern-tkprof/main/install.sh | sh
#
# Runs on Linux, macOS, AIX and Solaris (POSIX sh, no bash needed).
# Environment (all optional):
#   MTKPROF_VERSION      release tag to install, e.g. v0.5.0 (default: latest)
#   MTKPROF_INSTALL_DIR  where to install (default: /usr/local/bin,
#                        falling back to ~/.local/bin when not writable)
#   MTKPROF_LITE=1       the -lite build (no Oracle client code):
#                        linux, aix, solaris only
#   MTKPROF_DRY_RUN=1    print the asset and URL, download nothing
set -eu

REPO=davidbudac/modern-tkprof

say() { printf 'mtkprof install: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

# --- pick the release asset for this machine ---------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  AIX)    os=aix ;;     # the only AIX asset is aix-ppc64
  SunOS)  os=solaris ;; # the only Solaris asset is solaris-amd64
  *) die "unsupported system: $os (Windows binaries: see the releases page)" ;;
esac
case "$os:$arch" in
  aix:*)     arch=ppc64 ;;
  solaris:i86pc) arch=amd64 ;;
  solaris:*) die "no Solaris build for $arch (x86-64 only)" ;;
  *)
    case "$arch" in
      x86_64|amd64)  arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) die "unsupported CPU: $arch" ;;
    esac ;;
esac
prefix=mtkprof
if [ -n "${MTKPROF_LITE:-}" ]; then
  [ "$os" != darwin ] || die "no -lite build for macOS"
  prefix=mtkprof-lite
fi
asset=$prefix-$os-$arch

if [ -n "${MTKPROF_VERSION:-}" ]; then ref=download/$MTKPROF_VERSION; else ref=latest/download; fi
base=https://github.com/$REPO/releases/$ref
url=$base/$asset

if [ "${MTKPROF_DRY_RUN:-}" = 1 ]; then
  say "$asset -> $url"
  exit 0
fi

# --- download -------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required (or download $url by hand)"
tmp=$(mktemp -d 2>/dev/null) || tmp=
if [ -z "$tmp" ]; then
  tmp=${TMPDIR:-/tmp}/mtkprof-install.$$
  mkdir -m 700 "$tmp" || die "cannot create a temp directory"
fi
trap 'rm -rf "$tmp"' EXIT INT TERM
say "downloading $url"
curl -fL --retry 3 -o "$tmp/$asset" "$url"

# --- verify the checksum against the release's SHA256SUMS -------------------
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" \
  || die "could not fetch $base/SHA256SUMS"
want=$(awk -v a="$asset" '$2 == a { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "$asset is not in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
elif command -v openssl >/dev/null 2>&1; then
  got=$(openssl dgst -sha256 "$tmp/$asset" | awk '{print $NF}')
else
  die "no sha256 tool (sha256sum, shasum, openssl): verify $asset against SHA256SUMS by hand"
fi
[ "$got" = "$want" ] || die "sha256 mismatch: got $got, expected $want"

# --- install ---------------------------------------------------------------
# A missing directory is placeable when its parent is writable (recursively).
writable() {
  if [ -d "$1" ]; then [ -w "$1" ]; else writable "$(dirname "$1")"; fi
}
dest=${MTKPROF_INSTALL_DIR:-/usr/local/bin}
sudo_=""
if ! writable "$dest"; then
  if [ -z "${MTKPROF_INSTALL_DIR:-}" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo_="sudo"
  elif [ -z "${MTKPROF_INSTALL_DIR:-}" ]; then
    dest=$HOME/.local/bin
    say "/usr/local/bin is not writable: installing to $dest instead"
  else
    die "$dest is not writable"
  fi
fi
$sudo_ test -d "$dest" || $sudo_ mkdir -p "$dest"
bin=$dest/mtkprof
$sudo_ cp "$tmp/$asset" "$bin"
$sudo_ chmod 755 "$bin"

if "$bin" version >/dev/null 2>&1; then
  say "installed $("$bin" version) to $bin"
else
  say "installed to $bin (could not run it: check CPU/OS support and permissions)"
fi
case ":$PATH:" in
  *":$dest:"*) ;;
  *) say "not on PATH: export PATH=\"$dest:\$PATH\"" ;;
esac
