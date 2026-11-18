// Makes the fixture of the system state, hang analysis and deadlock readings' tests from running `mtkprof serve` servers (one per file):
//
//   mtkprof serve -addr 127.0.0.1:8181 testdata/diag/19c/diag_sysstate_l1.trc &       (8182 a copy of testdata/big/diag/diag_sysstate_l266.trc alone in
//   a directory: serve takes the sibling files of a name for one set; 8183 diag_hang, 8184 diag_hang_event, 8185 diag_deadlock)
//   node web/dev/diag-sys-fixture.mjs 8181 8182 8183 8184 8185 web/dev/diag-sys.fixture.json.gz
//
// It writes one gzipped JSON { <name>: { node: DiagNode, reading } } of the readings the engine gives: the system state of level 1 (statements are library handles
// only) and of level 266 (statements with their sql_id), the hang analysis of `oradebug hanganalyze 3` and of the event form, and the deadlock graph. A real answer,
// not a hand-written one: the numbers are the engine's.
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const out = args.pop()
const [pL1, pL266, pHang, pEvent, pDead] = args
if (!out || !pDead) { console.error('usage: node diag-sys-fixture.mjs <ports: sysstate-l1 sysstate-l266 hang hang-event deadlock> <out.json.gz>'); process.exit(2) }
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json() }
/** The top-level node of a file with a reading of `kind`. */
async function take(port, kind) {
  const f = await get(port, '/api/diag/file')
  const node = f.outline.find((n) => n.reading === kind)
  if (!node) throw new Error(`port ${port}: no node with a ${kind} reading`)
  return { node, reading: await get(port, `/api/diag/reading?node=${encodeURIComponent(node.id)}`) }
}
const fx = {
  sysL1: await take(pL1, 'sysstate'),
  sysL266: await take(pL266, 'sysstate'),
  hang: await take(pHang, 'hang'),
  hangEvent: await take(pEvent, 'hang'),
  deadlock: await take(pDead, 'deadlock'),
}
const json = JSON.stringify(fx)
const gz = gzipSync(json, { level: 9 })
writeFileSync(out, gz)
console.log(`${out}: ${(gz.length / 1024).toFixed(0)} KB gzipped, ${Object.keys(fx).join(', ')}`)
