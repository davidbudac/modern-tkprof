#!/usr/bin/env bash
# CI smoke test: launch the built app (target/<triple>/release, the sidecar sits next to it) with
# MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=<k> MTKPROF_SMOKE_OPEN=<fixture>: the app opens the
# fixture on start, and the shell kills its engine once, k seconds after it is first ready, as a
# crash would; the app then opens the fixture again on the new engine. The steps wait for the
# app's log lines ("ready on 127.0.0.1" from the engine, "session ready" from the UI), not clocks.
# Screenshots: out-smoke/<name>-ready.png before the kill (the fixture's Overview, the green engine
# dot), out-smoke/<name>-restarted.png after it (toast "Engine restarted", the fixture
# re-opened). Fails unless the log shows the kill, a second ready
# engine and the session ready twice.
# usage: scripts/smoke.sh <rust-target-triple> <name>
set -u
triple=$1 name=$2
dir=src-tauri/target/$triple/release
mkdir -p out-smoke
out=$PWD/out-smoke
log=$out/$name.log

fixture=$(cd .. && pwd)/testdata/traces/19c/io_waits.trc
case "$(uname -s)" in Linux | Darwin) ;; *) fixture=$(cygpath -w "$fixture") ;; esac
export MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=15 MTKPROF_SMOKE_OPEN=$fixture

wait_log() { # <pattern> <count> <timeout s>: until the log has <count> lines matching <pattern>
  for _ in $(seq "$3"); do
    [ "$(grep -c "$1" "$log" 2>/dev/null)" -ge "$2" ] && return 0
    sleep 1
  done
  echo "smoke: timed out waiting for '$1' #$2"
}
wait_ready() { wait_log 'ready on 127.0.0.1' "$@"; }
wait_session() { wait_log 'session ready' "$@"; }

shoot() { # <file>
  case "$(uname -s)" in
    Linux) import -window root "$1" || xwd -root -silent | convert xwd:- "$1" ;;
    Darwin) screencapture -x "$1" ;;
    *) powershell -NoProfile -Command "
      Add-Type -AssemblyName System.Windows.Forms,System.Drawing
      \$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      \$bmp = New-Object System.Drawing.Bitmap \$b.Width, \$b.Height
      [System.Drawing.Graphics]::FromImage(\$bmp).CopyFromScreen(\$b.Location, [System.Drawing.Point]::Empty, \$b.Size)
      \$bmp.Save('$(cygpath -w "$1")')" ;;
  esac
}

case "$(uname -s)" in
  Linux)
    Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 &
    xvfb=$!
    sleep 2
    export DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
    # single-instance needs a D-Bus session bus, which a desktop session has and CI does not
    dbus-run-session -- "$dir/mtkprof-desktop" >"$log" 2>&1 &
    ;;
  Darwin) "$dir/mtkprof-desktop" >"$log" 2>&1 & ;;
  *) "$dir/mtkprof-desktop.exe" >"$log" 2>&1 & ;;
esac
app=$!

wait_ready 1 90
wait_session 1 60
sleep 3 # the Overview renders, the engine provider polls health
shoot "$out/$name-ready.png"
wait_ready 2 45
wait_session 2 60
sleep 3 # the toast shows for 10 s
shoot "$out/$name-restarted.png"

case "$(uname -s)" in
  Linux) pkill -x mtkprof-desktop || kill $app; sleep 2; kill $xvfb ;;
  Darwin) kill $app ;;
  *) taskkill //F //IM mtkprof-desktop.exe >/dev/null 2>&1 || kill $app ;;
esac
sleep 4
ls -la "$dir" out-smoke
cat "$log"

ok=0
test -s "$out/$name-ready.png" && test -s "$out/$name-restarted.png" || { echo "smoke: missing screenshot"; ok=1; }
grep -q 'simulated crash' "$log" || { echo "smoke: the engine was not killed"; ok=1; }
n=$(grep -c 'ready on 127.0.0.1' "$log")
[ "$n" -ge 2 ] || { echo "smoke: engine ready $n time(s), want 2 (start + restart)"; ok=1; }
n=$(grep -c 'session ready' "$log")
[ "$n" -ge 2 ] || { echo "smoke: session ready $n time(s), want 2 (open + re-open after the restart)"; ok=1; }
# the app quit must stop the engine too
if pgrep -x mtkprof-engine >/dev/null 2>&1 || tasklist 2>/dev/null | grep -qi mtkprof-engine; then
  echo "smoke: the engine outlived the app"; ok=1
fi
exit $ok
