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

# Copy the installers of one Rust target out of its bundle dir into out/ (build.yml's
# "collect installers"), replacing the previous ones of the same kind. The bundle dir is removed
# before each build, so it only holds this version's files.
collect_installers() { # <triple>
  local triple=$1 b=src-tauri/target/$1/release/bundle n=0 f
  case $triple in
    aarch64-apple-darwin) rm -f out/*_aarch64.dmg ;;
    x86_64-apple-darwin) rm -f out/*_x64.dmg ;;
    x86_64-pc-windows-msvc) rm -f out/*-setup.exe ;;
    x86_64-unknown-linux-gnu) rm -f out/*_amd64.deb out/*_amd64.AppImage ;;
  esac
  while IFS= read -r f; do
    cp "$f" out/ && n=$((n + 1))
  done < <(find "$b" -maxdepth 2 -type f \( -name '*.exe' -o -name '*.dmg' -o -name '*.AppImage' -o -name '*.deb' \) 2>/dev/null)
  [ $n -gt 0 ] || { echo "ci: no installer found under $b" >&2; return 1; }
  echo "collected $n installer(s) from $b"
}
