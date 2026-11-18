// Makes the fixture of the readings' tests from running `mtkprof serve -view diag` servers (one per file):
//
//   mtkprof serve -addr 127.0.0.1:8161 testdata/diag/19c/diag_heap_sub.trc &        (and diag_heap_large_pdb, diag_pga_summary, diag_pga_detail on the next ports)
//   node web/dev/diag-readings-fixture.mjs 8161 8162 8163 8164 web/dev/diag-readings.fixture.json.gz
//
// It writes one gzipped JSON { <name>: { node: DiagNode, reading, lines?: [...] } } of the readings the engine gives for chosen nodes: the first heap of
// diag_heap_sub (sub-heaps, the three checks, free lists, permanent chunks), its first sub-heap, the second heap dump of diag_heap_large_pdb (a PDB-filtered
// one), the PGA summary and the PGA detail. For the first heap it also keeps the chunk lines of its largest comment (`api/diag/reading/lines`). A real
// answer, not a hand-written one: the numbers are the engine's.
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const out = args.pop()
const [pSub, pPdb, pSum, pDet] = args
if (!out || !pDet) { console.error('usage: node diag-readings-fixture.mjs <port sub> <port pdb> <port summary> <port detail> <out.json.gz>'); process.exit(2) }
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json() }
const readingsOf = async (port) => (await get(port, '/api/diag/file')).outline.filter((n) => n.reading)
const take = async (port, node) => ({ node, reading: await get(port, `/api/diag/reading?node=${encodeURIComponent(node.id)}`) })

const fx = {}
const sub = await readingsOf(pSub)
fx.heapPga = await take(pSub, sub[0])
fx.heapKoh = await take(pSub, sub[1])
const top = fx.heapPga.reading.byComment[0]
fx.heapPga.lines = await get(pSub, `/api/diag/reading/lines?node=${encodeURIComponent(sub[0].id)}&comment=${encodeURIComponent(top.comment)}`)
fx.heapPga.linesOf = top.comment
const pdb = await readingsOf(pPdb)
fx.heapPdb = await take(pPdb, pdb[1])
fx.pgaSummary = await take(pSum, (await readingsOf(pSum))[0])
fx.pgaDetail = await take(pDet, (await readingsOf(pDet))[0])
const json = JSON.stringify(fx)
writeFileSync(out, gzipSync(json, { level: 9 }))
console.log(`${out}: ${(gzipSync(json, { level: 9 }).length / 1024).toFixed(0)} KB gzipped, ${Object.keys(fx).join(', ')}`)
