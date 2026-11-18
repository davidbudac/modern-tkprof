// Makes the fixture of the call stack and process readings' tests from running `mtkprof serve` servers (one per file):
//
//   mtkprof serve -addr 127.0.0.1:8171 testdata/diag/19c/diag_errorstack_l2.trc &     (8172 diag_procstate, 8173 diag_deadlock,
//   8174 -view diag testdata/traces/19c/diag_in_10046.trc, 8175 diag_sysstate_l1, 8176 testdata/big/diag/diag_oom_incident.trc)
//   node web/dev/diag-stack-fixture.mjs 8171 8172 8173 8174 8175 8176 web/dev/diag-stack.fixture.json.gz
//
// It writes one gzipped JSON { <name>: { node: DiagNode, reading } } of the readings the engine gives: the errorstack's call stack (no error; a dump taken on
// request) and its nested process state, a process state dump of its own, the deadlock's call stack and nested process state, the diagnostic dump of a 10046
// trace (an error: ORA-00942), a process of a system state that blocks a session and one that is blocked, and an incident file's two call stacks. A real answer, not a
// hand-written one: the numbers are the engine's.
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const out = args.pop()
const [pErr, pProc, pDead, p10046, pSys, pInc] = args
if (!out || !pInc) { console.error('usage: node diag-stack-fixture.mjs <ports: errorstack procstate deadlock in10046 sysstate incident> <out.json.gz>'); process.exit(2) }
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json() }
/** The nodes with a reading of `kind` in a file, found by walking the outline (not into state objects and frames). */
async function nodesOf(port, kind) {
  const f = await get(port, '/api/diag/file')
  const found = []
  const walk = async (n, depth) => {
    if (n.reading === kind) found.push(n)
    if (!n.hasChildren || depth > 4 || n.kind === 'so' || n.kind === 'frame') return
    let after = 0
    for (;;) {
      const o = await get(port, `/api/diag/outline?node=${encodeURIComponent(n.id)}&after=${after}`)
      for (const c of o.children) await walk(c, depth + 1)
      if (!o.more) break
      after = o.next
    }
  }
  for (const n of f.outline) await walk(n, 0)
  return found
}
const take = async (port, node) => ({ node, reading: await get(port, `/api/diag/reading?node=${encodeURIComponent(node.id)}`) })

const fx = {}
const err = await nodesOf(pErr, 'callstack'); const errP = await nodesOf(pErr, 'procstate')
fx.errorstack = await take(pErr, err[0]); fx.errorstackProc = await take(pErr, errP[0])
fx.procstate = await take(pProc, (await nodesOf(pProc, 'procstate'))[0])
const dead = await nodesOf(pDead, 'callstack'); const deadP = await nodesOf(pDead, 'procstate')
fx.deadlock = await take(pDead, dead[0]); fx.deadlockProc = await take(pDead, deadP[0])
fx.in10046 = await take(p10046, (await nodesOf(p10046, 'callstack'))[0])
const procs = await nodesOf(pSys, 'procstate')
for (const n of procs) {
  const t = await take(pSys, n)
  const w = (t.reading.sessions ?? []).map((s) => s.wait).find(Boolean)
  if (!fx.sysBlocked && w?.blocked && w.blockers?.length) fx.sysBlocked = t
  if (!fx.sysBlocker && w?.blockedCount > 0 && w.waiters?.length) fx.sysBlocker = t
}
const inc = await nodesOf(pInc, 'callstack')
fx.incident = await take(pInc, inc[0]); fx.incidentDump = await take(pInc, inc[1])
const json = JSON.stringify(fx)
writeFileSync(out, gzipSync(json, { level: 9 }))
console.log(`${out}: ${(gzipSync(json, { level: 9 }).length / 1024).toFixed(0)} KB gzipped, ${Object.keys(fx).join(', ')}`)
