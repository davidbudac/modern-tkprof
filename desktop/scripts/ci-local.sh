#!/usr/bin/env bash
# Local CI, by decision (GitHub Actions costs money): checks, then the installers of every
# platform, collected in out/ with out/SHA256SUMS. Smoke screenshots go to out-smoke/, per-leg
# logs and results.tsv to out-logs/.
#
#   checks    install, api types up to date, cargo fmt, typecheck, tests   (host)
#   macos     arm64 + x64 DMG (--arm64 skips x64), arm64 smoke (x64 smoke only with Rosetta 2) (host, Darwin)
#   linux     deb + AppImage and the smoke, in the Docker image  (amd64 container)
#   windows   NSIS installer cross-built with cargo-xwin, no smoke possible        (amd64 container)
#
# usage: scripts/ci-local.sh [--only checks,macos,linux,windows] [--arm64] [--skip-smoke]
#                            [--no-appimage] [--keep-going] [--no-docker-build]
#   --arm64       macOS leg builds only the arm64 DMG
# Stops at the first failed step unless --keep-going. Exit status: 0 when nothing failed.
# Needs on the host: node 24 + pnpm, go (version of ../go.mod; an older go downloads it),
# rust with the apple targets (macos), docker (linux, windows; amd64 image, Rosetta on Apple Silicon).
# The Linux and Windows legs run in the image built from ci/Dockerfile; the repository (the engine,
# web/ and desktop/) is mounted at /src, and the node_modules folders, desktop/src-tauri/target and the caches live in named volumes mtkprof-ci-*.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD

for d in /usr/local/go/bin "$HOME/.local/go/bin" "$HOME/.cargo/bin"; do
  [ -d "$d" ] && PATH=$d:$PATH
done
export PATH

legs=checks,macos,linux,windows only_given=0
macos_x64=1 skip_smoke=0 appimage=1 keep_going=0 docker_build=1
while [ $# -gt 0 ]; do
  case $1 in
    --only) legs=${2:?--only needs a list}; only_given=1; shift ;;
    --only=*) legs=${1#--only=}; only_given=1 ;;
    --arm64) macos_x64=0 ;;
    --skip-smoke) skip_smoke=1 ;;
    --no-appimage) appimage=0 ;;
    --keep-going) keep_going=1 ;;
    --no-docker-build) docker_build=0 ;;
    -h | --help) sed -n '2,/^set -u/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "ci-local: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
for l in ${legs//,/ }; do
  case $l in checks | macos | linux | windows) ;; *) echo "ci-local: unknown leg '$l' (checks,macos,linux,windows)" >&2; exit 2 ;; esac
done
want() { case ",$legs," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

mkdir -p out out-logs out-smoke
: > out-logs/results.tsv
export CI_RESULTS=out-logs/results.tsv
. ci/lib.sh
updater_key
updater_build_args
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then echo "ci-local: updater artifacts on (signing key found)"
else echo "ci-local: no updater signing key (TAURI_SIGNING_PRIVATE_KEY, ~/.tauri/mtkprof-updater.key): installers without updater artifacts"; fi
t_start=$SECONDS

# a full run replaces everything in out/; a subset only the installers of its own legs
if [ $only_given -eq 0 ]; then rm -f out/*; fi
rm -f out/SHA256SUMS

summary() {
  local rc=$?
  trap - EXIT
  # regular files only: a folder left in out/ (a quick build's .app) failed the whole sum and a release with it
  (cd out && find . -maxdepth 1 -type f ! -name '.*' ! -name SHA256SUMS | sed 's|^\./||' | sort | tr '\n' '\0' \
    | if command -v sha256sum >/dev/null; then xargs -0 sha256sum --; else xargs -0 shasum -a 256 --; fi) 2>/dev/null \
    > out-logs/SHA256SUMS.tmp && mv out-logs/SHA256SUMS.tmp out/SHA256SUMS || rm -f out-logs/SHA256SUMS.tmp
  printf '\n== ci-local summary (%ss) ==\n' $((SECONDS - t_start))
  awk -F'\t' '{ printf "%-28s %-8s %6s  %s\n", $1, toupper($2), $3, $4 }' out-logs/results.tsv
  printf '\nArtifacts in out/:\n'
  (cd out && ls -l | awk 'NR>1 { printf "  %-48s %10.1f MiB\n", $NF, $5/1048576 }')
  if grep -q "$(printf '\tfail\t')" out-logs/results.tsv; then
    rc=1
    echo; echo "ci-local: FAILED (logs in out-logs/)"
  fi
  exit $rc
}
trap summary EXIT

fail() { echo "ci-local: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "$1 not found in PATH ($2)"; }
# leg <name> <function>: run a leg with its output tee'd into out-logs/<name>.log; abort the run on
# failure unless --keep-going
leg() {
  local name=$1 rc before after
  before=$(grep -c "$(printf '\tfail\t')" "$CI_RESULTS")
  "$2" 2>&1 | tee "out-logs/$name.log"
  rc=${PIPESTATUS[0]}
  if [ $rc -ne 0 ]; then
    echo "ci-local: leg '$name' failed (log out-logs/$name.log)" >&2
    after=$(grep -c "$(printf '\tfail\t')" "$CI_RESULTS")
    [ "$after" -gt "$before" ] || record "$name" fail - "see out-logs/$name.log"
    [ $keep_going -eq 1 ] || exit 1
  fi
}

# ---- checks (install, api types, cargo fmt, typecheck, test) ----
checks() {
  need pnpm "pnpm install, any 10+ switches to the packageManager pin"
  need cargo "rustup"
  run_step "checks: pnpm install" pnpm install --frozen-lockfile || return 1
  # src/engine/api.d.ts is generated from ../api/engine.openapi.yaml and committed
  run_step "checks: api types" bash -c 'pnpm gen:api && git diff --exit-code -- src/engine/api.d.ts || { echo "run pnpm gen:api and commit src/engine/api.d.ts"; exit 1; }' || return 1
  run_step "checks: cargo fmt" cargo fmt --manifest-path src-tauri/Cargo.toml --check || return 1
  run_step "checks: typecheck" pnpm typecheck || return 1
  run_step "checks: test" pnpm test || return 1
}

# ---- macos ----
can_run() { # <triple>: can this host execute binaries of that target?
  case $1 in
    aarch64-apple-darwin) [ "$(uname -m)" = arm64 ] ;;
    x86_64-apple-darwin) [ "$(uname -m)" = x86_64 ] || arch -x86_64 /usr/bin/true 2>/dev/null ;;
  esac
}
macos_target() { # <triple> <name>
  local t=$1 n=$2
  rustup target list --installed 2>/dev/null | grep -qx "$t" || { echo "rust target $t missing: rustup target add $t"; return 1; }
  rm -rf "src-tauri/target/$t/release/bundle"
  run_step "$n: engine" pnpm build:engine --target "$t" || return 1
  # app: its mtkprof.app.tar.gz is the macOS updater artifact
  run_step "$n: dmg" pnpm tauri build --target "$t" --bundles app,dmg --ci ${updater_args[@]+"${updater_args[@]}"} || return 1
  collect_installers "$t" || return 1
  if [ $skip_smoke -eq 1 ]; then
    skip "$n: smoke" "--skip-smoke"
  elif can_run "$t"; then
    # launches the app and takes screenshots: needs a GUI session and Screen Recording permission
    # for the app running this shell (screencapture fails with "could not create image from display")
    run_step "$n: smoke" scripts/smoke.sh "$t" "$n" > "out-logs/$n-smoke.log" 2>&1 || { tail -n 30 "out-logs/$n-smoke.log"; return 1; }
  else
    skip "$n: smoke" "this Mac cannot run $t (no Rosetta 2: softwareupdate --install-rosetta --agree-to-license)"
  fi
}
macos() {
  if [ "$(uname -s)" != Darwin ]; then skip "macos" "not a Mac"; return 0; fi
  need go "Go of ../go.mod"
  macos_target aarch64-apple-darwin macos-arm64 || return 1
  if [ $macos_x64 -eq 1 ]; then
    macos_target x86_64-apple-darwin macos-x64 || return 1
  else
    skip "macos-x64" "--arm64"
  fi
}

# ---- docker legs ----
IMG=mtkprof-ci:local
docker_prepare() {
  need docker "install Docker or OrbStack (orbctl start)"
  docker info >/dev/null 2>&1 || { echo "docker daemon not reachable (OrbStack: orbctl start). Inside a sandbox the docker socket may be blocked."; return 1; }
  if [ $docker_build -eq 1 ]; then
    local go node pnpm_v
    go=$(awk '/^go /{print $2; exit}' ../go.mod)
    pnpm_v=$(node -p "require('../package.json').packageManager.replace(/^pnpm@/, '').replace(/\+.*/, '')")
    node=24
    run_step "docker: image $IMG" docker build --platform linux/amd64 \
      --build-arg NODE_MAJOR=$node --build-arg PNPM_VERSION="$pnpm_v" --build-arg GO_VERSION="$go" \
      -t $IMG -f ci/Dockerfile ci || return 1
  fi
}
docker_leg() { # <linux|windows>
  local args=("$1")
  [ $skip_smoke -eq 1 ] && args+=(--skip-smoke)
  [ $appimage -eq 0 ] && args+=(--no-appimage)
  # the node_modules folders and src-tauri/target are volumes so the Mac's and Linux's files never
  # mix; dist/ and src-tauri/binaries/ are rebuilt on every run. GOFLAGS: a worktree under the
  # repository (.claude/worktrees/*) has a .git file naming a host path, so go's VCS stamping fails
  # in the container; the engine's version comes from -ldflags anyway
  docker run --rm --platform linux/amd64 \
    -v "$(dirname "$ROOT")":/src \
    -v mtkprof-ci-node_modules:/src/node_modules \
    -v mtkprof-ci-node_modules-web:/src/web/node_modules \
    -v mtkprof-ci-node_modules-desktop:/src/desktop/node_modules \
    -v mtkprof-ci-target:/src/desktop/src-tauri/target \
    -v mtkprof-ci-cargo-registry:/usr/local/cargo/registry \
    -v mtkprof-ci-cargo-git:/usr/local/cargo/git \
    -v mtkprof-ci-xwin:/xwin-cache \
    -v mtkprof-ci-go:/root/go \
    -v mtkprof-ci-gocache:/root/.cache/go-build \
    -v mtkprof-ci-pnpm:/root/.local/share/pnpm \
    -e CI_RESULTS=/src/desktop/$CI_RESULTS \
    -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    -e GOFLAGS=-buildvcs=false \
    $IMG bash /src/desktop/ci/in-container.sh "${args[@]}"
}
linux() { docker_leg linux; }
windows() { docker_leg windows; }

want checks && leg checks checks
if want linux || want windows; then leg docker docker_prepare; fi
want macos && leg macos macos
want linux && leg linux linux
want windows && leg windows windows
exit 0
