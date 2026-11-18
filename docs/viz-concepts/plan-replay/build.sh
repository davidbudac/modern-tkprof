#!/bin/sh
# Plan replay prototype (2026-11-17/18): replays single executions from public fixtures on their STAT plans.
# Writes replay.html next to this script (generated, not committed); open it in a browser.
# Keys: space play/pause, ←/→ chapters; drag the lanes to seek. URL: ?scene=N, ?t=<ms>&pause, ?fit=<seconds>.
set -e
D=$(cd "$(dirname "$0")" && pwd)
T="$D/../../../testdata/traces/19c"
X="python3 -I $D/extract.py"
$X "Hash join that spills" 7r10y07tqpg98 "$T/io_waits.trc" > "$D/s1.json"
$X "Sort that spills, then 202 fetches" 52nzchs09dgn1 "$T/io_waits.trc" > "$D/s2.json"
$X "All in the buffer cache (adaptive plan)" 8a01tvd45h89r "$T/opt_interleaved.trc" > "$D/s3.json"
$X "PX: coordinator and 4 slaves" cznmg6kxgvkpu "$T/px_io.trc" "$T"/px_io_slave_p00[0-3].trc > "$D/s4.json"
python3 -I - "$D" <<'PY'
import json, os, sys
d = sys.argv[1]
short = ['Hash join', 'Sort', 'Cached', 'PX']
scenes = []
for i, s in enumerate(short):
    sc = json.load(open(os.path.join(d, f's{i + 1}.json'))); sc['short'] = s; scenes.append(sc)
src = open(os.path.join(d, 'replay.src.html')).read()
open(os.path.join(d, 'replay.html'), 'w').write(src.replace('/*DATA*/', json.dumps(scenes, separators=(',', ':'))))
PY
rm "$D"/s[1-4].json
echo "$D/replay.html"
