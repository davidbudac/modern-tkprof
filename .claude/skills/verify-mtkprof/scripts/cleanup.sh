#!/usr/bin/env bash
# Kill ONLY the pids launch.sh recorded (never by name), remove scratch + state, KEEP /tmp/verify-mtkprof/evidence.
. "$(dirname "$0")/_common.sh"
[ -f "$STATE" ] || { echo "nothing to clean (no state file)"; exit 0; }
. "$STATE"
for pid in "$ENGINE_PID" "$VITE_PID"; do
  [ -n "$pid" ] || continue
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && { kill -9 "$pid" 2>/dev/null; echo "pid $pid needed SIGKILL"; } || echo "stopped pid $pid"
  else echo "pid $pid already gone"; fi
done
[ -n "${RUN:-}" ] && [ -d "$RUN" ] && case "$RUN" in "$ROOT"/run-*) mkdir -p "$ROOT/evidence/logs"; cp "$RUN"/*.log "$ROOT/evidence/logs/" 2>/dev/null; mv "$ROOT/evidence/logs" "$ROOT/evidence/logs-$(basename "$RUN")"; rm -rf "$RUN";; esac
rm -f "$STATE"
echo "cleanup done; evidence kept in $ROOT/evidence"
