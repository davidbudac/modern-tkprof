# Helpers shared by scripts/ci-local.sh (host) and ci/in-container.sh (inside the image).
# Source it from the repo root. Every step is recorded as one TSV line
#   <step>\t<pass|fail|skipped>\t<seconds>\t<detail>
# in $CI_RESULTS (out-logs/results.tsv); ci-local.sh prints the summary table from it.

CI_RESULTS=${CI_RESULTS:-out-logs/results.tsv}
mkdir -p "$(dirname "$CI_RESULTS")" out

say() { printf '\n==> %s\n' "$*"; }

record() { # <step> <status> <seconds> [detail]
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$CI_RESULTS"
}

skip() { # <step> <reason>
  say "$1: skipped ($2)"
  record "$1" skipped - "$2"
}

# run_step <step> <command...>: run, time and record it; the output goes to the terminal (the
# caller tees a whole leg into out-logs/<leg>.log). Returns the command's status.
run_step() {
  local step=$1 t0 rc
  shift
  say "$step"
  t0=$SECONDS
  "$@"
  rc=$?
  if [ $rc -eq 0 ]; then
    record "$step" pass $((SECONDS - t0))
  else
    record "$step" fail $((SECONDS - t0)) "exit $rc"
    echo "ci: step '$step' failed (exit $rc)" >&2
  fi
  return $rc
}

# The updater's signing key (desktop/README.md § Updates): TAURI_SIGNING_PRIVATE_KEY (the key or
# a path to it), else ~/.tauri/mtkprof-updater.key. Exported as the key's text, so the Docker
# legs get it too. Without a key the builds have no updater artifacts (fine for local builds; the
# release refuses).
updater_key() {
  local k=${TAURI_SIGNING_PRIVATE_KEY:-}
  [ -n "$k" ] || [ ! -f "$HOME/.tauri/mtkprof-updater.key" ] || k=$HOME/.tauri/mtkprof-updater.key
  [ -z "$k" ] || [ ! -f "$k" ] || k=$(cat "$k")
  if [ -n "$k" ]; then
    export TAURI_SIGNING_PRIVATE_KEY=$k TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}
  fi
}
# the `tauri build` arguments that add the signed updater artifacts when there is a key
updater_args=()
updater_build_args() {
  updater_args=()
  [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || updater_args=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
}

# Copy the installers of one Rust target out of its bundle dir into out/ (build.yml's
# "collect installers"), replacing the previous ones of the same kind, with the updater's files
# when they were built: the installers' .sig (Windows, Linux) and on macOS mtkprof.app.tar.gz and its
# .sig, renamed mtkprof_<v>_<arch>.app.tar.gz like the DMG next to them. The bundle dir is removed
# before each build, so it only holds this version's files.
collect_installers() { # <triple>
  local triple=$1 b=src-tauri/target/$1/release/bundle n=0 f arch=
  case $triple in
    aarch64-apple-darwin) arch=aarch64; rm -f out/*_aarch64.dmg out/*_aarch64.app.tar.gz* ;;
    x86_64-apple-darwin) arch=x64; rm -f out/*_x64.dmg out/*_x64.app.tar.gz* ;;
    x86_64-pc-windows-msvc) rm -f out/*-setup.exe out/*-setup.exe.sig ;;
    x86_64-unknown-linux-gnu) rm -f out/*_amd64.deb out/*_amd64.AppImage out/*_amd64.deb.sig out/*_amd64.AppImage.sig ;;
  esac
  while IFS= read -r f; do
    cp "$f" out/ && n=$((n + 1))
  done < <(find "$b" -maxdepth 2 -type f \( -name '*.exe' -o -name '*.dmg' -o -name '*.AppImage' -o -name '*.deb' \
    -o -name '*.exe.sig' -o -name '*.AppImage.sig' -o -name '*.deb.sig' \) 2>/dev/null)
  [ $n -gt 0 ] || { echo "ci: no installer found under $b" >&2; return 1; }
  if [ -n "$arch" ] && [ -f "$b/macos/mtkprof.app.tar.gz" ]; then
    local dmg ver
    dmg=$(cd out && ls ./*_"$arch".dmg | head -n 1)
    ver=${dmg#./mtkprof_}; ver=${ver%_"$arch".dmg}
    cp "$b/macos/mtkprof.app.tar.gz" "out/mtkprof_${ver}_$arch.app.tar.gz" || return 1
    cp "$b/macos/mtkprof.app.tar.gz.sig" "out/mtkprof_${ver}_$arch.app.tar.gz.sig" || return 1
    n=$((n + 2))
  fi
  echo "collected $n file(s) from $b"
}
