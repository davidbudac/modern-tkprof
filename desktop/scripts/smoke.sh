#!/usr/bin/env bash
# CI smoke test: launch a packaged app (electron-builder's unpacked dir: release/mac-arm64/mtkprof.app,
# release/linux-unpacked/mtkprof-desktop) with MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=<k>
# MTKPROF_SMOKE_OPEN=<fixture> and a profile of its own (MTKPROF_PROFILE: no settings, tabs or keys
# of the user's, and its own single-instance lock, so a running mtkprof does not get in the way).
# The app opens the fixture on start and the shell kills its engine once, k seconds after it is
# first ready, as a crash would; the app then opens the fixture again on the new engine. The app
# takes the screenshots itself (MTKPROF_SMOKE_SHOTS: the window's own pixels, 3 s after each
# "session ready") and logs the toasts showing then. The steps wait for the app's log lines, not clocks.
# Screenshots: out-smoke/<name>-ready.png before the kill (the fixture's Overview, the green engine
# dot), out-smoke/<name>-restarted.png after it (toast "Engine restarted", the fixture re-opened).
# Fails unless the log shows the kill, a second ready engine, the session ready twice and the toast,
# and every engine the app started is gone after it quits.
# usage: scripts/smoke.sh <app executable> <name>
set -u
exe=$1 name=$2
mkdir -p out-smoke
out=$PWD/out-smoke
log=$out/$name.log
profile=$out/$name-profile
rm -rf "$profile" "$out/$name-shots"

fixture=$(cd .. && pwd)/testdata/traces/19c/io_waits.trc
case "$(uname -s)" in Linux | Darwin) ;; *) fixture=$(cygpath -w "$fixture") ;; esac
export MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=15 MTKPROF_SMOKE_OPEN=$fixture \
  MTKPROF_PROFILE=$profile MTKPROF_SMOKE_SHOTS=$out/$name-shots

wait_log() { # <pattern> <count> <timeout s>: until the log has <count> lines matching <pattern>
  for _ in $(seq "$3"); do
    [ "$(grep -c "$1" "$log" 2>/dev/null)" -ge "$2" ] && return 0
    sleep 1
  done
  echo "smoke: timed out waiting for '$1' #$2"
}

args=()
case "$(uname -s)" in
  Linux)
    Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 &
    xvfb=$!
    sleep 2
    export DISPLAY=:99
    # Chromium's sandbox needs user namespaces, which a root container does not give
    [ "$(id -u)" = 0 ] && args+=(--no-sandbox)
    dbus-run-session -- "$exe" ${args[@]+"${args[@]}"} >"$log" 2>&1 &
    ;;
  *) "$exe" >"$log" 2>&1 & ;;
esac
app=$!

wait_log 'ready on 127.0.0.1' 1 90
wait_log 'screenshot session-1' 1 60
wait_log 'ready on 127.0.0.1' 2 45
wait_log 'screenshot session-2' 1 60
cp "$out/$name-shots/session-1.png" "$out/$name-ready.png" 2>/dev/null
cp "$out/$name-shots/session-2.png" "$out/$name-restarted.png" 2>/dev/null
pids=$(grep -o 'ready on 127.0.0.1:[0-9]* (pid [0-9]*)' "$log" | grep -o 'pid [0-9]*' | grep -o '[0-9]*')

kill $app 2>/dev/null
case "$(uname -s)" in Linux) sleep 4; kill $xvfb ;; *) sleep 4 ;; esac
cat "$log"

ok=0
test -s "$out/$name-ready.png" && test -s "$out/$name-restarted.png" || { echo "smoke: missing screenshot"; ok=1; }
grep -q 'simulated crash' "$log" || { echo "smoke: the engine was not killed"; ok=1; }
n=$(grep -c 'ready on 127.0.0.1' "$log")
[ "$n" -ge 2 ] || { echo "smoke: engine ready $n time(s), want 2 (start + restart)"; ok=1; }
n=$(grep -c 'session ready' "$log")
[ "$n" -ge 2 ] || { echo "smoke: session ready $n time(s), want 2 (open + re-open after the restart)"; ok=1; }
grep -q 'screenshot session-2.png; toasts: .*Engine restarted' "$log" || { echo "smoke: no 'Engine restarted' toast after the restart"; ok=1; }
# the app quit must stop the engine too
for p in $pids; do
  if kill -0 "$p" 2>/dev/null; then echo "smoke: engine pid $p outlived the app"; ok=1; fi
done
exit $ok
