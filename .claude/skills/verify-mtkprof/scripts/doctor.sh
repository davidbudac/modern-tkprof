#!/usr/bin/env bash
# Read-only: is the instance launch.sh started worth driving? Exit 0 = yes.
. "$(dirname "$0")/_common.sh"
[ -f "$STATE" ] || { echo "FAIL no state file; run scripts/launch.sh"; exit 1; }
. "$STATE"; bad=0
ok() { echo "ok   $*"; }; no() { echo "FAIL $*"; bad=1; }
chk() { # name pid port
  if [ -n "$2" ] && kill -0 "$2" 2>/dev/null; then ok "$1 pid $2 alive"; else no "$1 pid '$2' not running"; return; fi
  owner=$(lsof -nP -iTCP:"$3" -sTCP:LISTEN -t 2>/dev/null | head -1)
  [ "$owner" = "$2" ] && ok "$1 port $3 owned by our pid" || no "$1 port $3 owned by '$owner', expected $2"
}
chk engine "$ENGINE_PID" "$ENGINE_PORT"; chk vite "$VITE_PID" "$VITE_PORT"
H=$(curl -s -m3 "http://127.0.0.1:$ENGINE_PORT/engine/health"); echo "$H" | grep -q '"protocol"' && ok "engine health $H" || no "engine health: $H"
C=$(curl -s -m3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$ENGINE_PORT/engine/sessions"); [ "$C" = 200 ] && ok "token accepted (GET /engine/sessions 200)" || no "authed GET /engine/sessions -> $C"
C=$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ENGINE_PORT/engine/sessions"); [ "$C" = 401 ] || [ "$C" = 403 ] && ok "no token rejected ($C)" || no "unauthenticated request returned $C (expected 401/403)"
CORS=$(curl -s -m3 -i -H "Origin: http://127.0.0.1:$VITE_PORT" "http://127.0.0.1:$ENGINE_PORT/engine/health" | tr -d '\r' | grep -i '^access-control-allow-origin' || true); [ -n "$CORS" ] && ok "CORS $CORS" || no "no CORS header for the vite origin"
C=$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VITE_PORT/"); [ "$C" = 200 ] && ok "vite serves / (200)" || no "vite -> $C"
[ -f "$PW" ] && ok "playwright module present" || no "playwright missing at $PW"
[ $bad = 0 ] && echo "DOCTOR: worth driving" || echo "DOCTOR: NOT worth driving (cleanup.sh and relaunch)"
exit $bad
