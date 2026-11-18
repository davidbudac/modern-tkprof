// Makes the fixture of the dump reader's tests and dev harness from a running `mtkprof serve <file> -view diag`:
//
//   mtkprof serve -addr 127.0.0.1:8147 -view diag testdata/diag/19c/diag_errorstack_l2.trc &
//   node web/dev/diag-fixture.mjs http://127.0.0.1:8147 web/dev/diag-errorstack_l2.fixture.json.gz
//
// It asks `api/diag/file`, the children of every node that has some (breadth first, to depth 3 and at most 600 requests) and every line of the file
// (`api/lines?annot=1`), and writes one gzipped JSON: { file, children: { nodeId: DiagNode[] }, lines: string[] }. The line kinds are not kept: the memory
// source derives them from the text. A real file, not a hand-written one: the numbers are the engine's.
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const [base, out] = process.argv.slice(2)
if (!base || !out) { console.error('usage: node diag-fixture.mjs <server base url> <out.json.gz>'); process.exit(2) }
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json() }

const file = await get('/api/diag/file')
const children = {}
let asked = 0
let level = file.outline.filter((n) => n.hasChildren)
for (let depth = 1; depth <= 3 && level.length && asked < 600; depth++) {
  const next = []
  for (const n of level) {
    if (asked++ >= 600) break
    const o = await get(`/api/diag/outline?node=${encodeURIComponent(n.id)}`)
    children[n.id] = o.children
    if (o.more) console.warn(`${n.id}: ${o.more} children not in the fixture`)
    for (const c of o.children) if (c.hasChildren) next.push(c)
  }
  level = next
}
const lines = []
for (let from = 1; from <= file.lines; from += 2000) {
  const p = await get(`/api/lines?annot=1&file=0&from=${from}&n=2000`)
  for (const l of p.lines) lines.push(l.t)
}
if (lines.length !== file.lines) throw new Error(`read ${lines.length} lines of ${file.lines}`)
const json = JSON.stringify({ file, children, lines })
writeFileSync(out, gzipSync(json, { level: 9 }))
console.log(`${out}: ${(gzipSync(json, { level: 9 }).length / 1024).toFixed(0)} KB gzipped, ${asked} outlines, ${lines.length} lines, ${Object.keys(children).length} nodes with children`)
