#!/usr/bin/env bash
# Start the engine sidecar + vite dev server on free ports for ONE verification run.
# Prints the dev URL on success. State goes to /tmp/verify-mtkprof/state.env. Teardown: cleanup.sh.
set -euo pipefail
. "$(dirname "$0")/_common.sh"
mkdir -p "$ROOT"
if [ -f "$STATE" ]; then echo "state file exists ($STATE): run scripts/cleanup.sh first (refusing to double-drive)" >&2; exit 2; fi
[ -x "$ENGINE_BIN" ] || { echo "engine binary missing: $ENGINE_BIN (gitignored; build it: cd $REPO && pnpm build:engine)" >&2; exit 3; }
[ -d "$REPO/node_modules" ] || { echo "node_modules missing: cd $REPO && pnpm install" >&2; exit 3; }
RUN="$ROOT/run-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$RUN/cache"
TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(24))')"
EP="$(free_port)"; VP="$(free_port)"
ORIGIN="http://127.0.0.1:$VP"
# Record state first so cleanup can always find what we started.
cat > "$STATE" <<EOS
RUN=$RUN
TOKEN=$TOKEN
ENGINE_PORT=$EP
VITE_PORT=$VP
ENGINE_PID=
VITE_PID=
URL="$ORIGIN/?engine=127.0.0.1:$EP&token=$TOKEN&mock=db"
EOS
setkv() { sed -i '' "s|^$1=.*|$1=$2|" "$STATE"; }
# -detach: engine would otherwise quit when stdin closes ("stopping (stdin closed)"). </dev/null + -detach is enough;
# MTKPROF_TOKEN must be 32+ chars.
MTKPROF_TOKEN="$TOKEN" nohup "$ENGINE_BIN" engine -detach -listen "127.0.0.1:$EP" -cache "$RUN/cache" -allow-origin "$ORIGIN" </dev/null >"$RUN/engine.log" 2>&1 &
setkv ENGINE_PID $!
# Call vite directly (not via pnpm) so the recorded PID is the server itself, not a wrapper.
cd "$REPO"; nohup node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$VP" --strictPort </dev/null >"$RUN/vite.log" 2>&1 &
echo $! > "$RUN/vite.pid"
setkv VITE_PID "$(cat "$RUN/vite.pid")"
. "$STATE"
for i in $(seq 1 60); do
  H="$(curl -s -m2 "http://127.0.0.1:$ENGINE_PORT/engine/health" || true)"
  V="$(curl -s -m2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VITE_PORT/" || true)"
  if echo "$H" | grep -q "\"protocol\"" && [ "$V" = 200 ]; then
    echo "ready: engine $H"; echo "vite: $ORIGIN (200)"; echo "run dir: $RUN (logs: engine.log, vite.log)"; echo "URL=$URL"; exit 0
  fi
  kill -0 "$ENGINE_PID" 2>/dev/null || { echo "engine died; see $RUN/engine.log" >&2; tail -5 "$RUN/engine.log" >&2; exit 4; }
  kill -0 "$VITE_PID" 2>/dev/null || { echo "vite died; see $RUN/vite.log" >&2; tail -5 "$RUN/vite.log" >&2; exit 4; }
  sleep 1
done
echo "timeout waiting for engine/vite; see $RUN" >&2; exit 5
