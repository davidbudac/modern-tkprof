#!/usr/bin/env node
// Measures what the desktop's workspace restore costs the engine (review finding F04): opens several
// distinct traces at once ("concurrent", what the app did before) or N at a time in order ("queued",
// the OpenQueue, N = 2 by default) on a cold, isolated cache, and records for each run
//   - time until the FIRST trace (the active tab) is ready, its document fetched (what the user waits for)
//   - total time until all are ready
//   - the engine's peak RSS (polled with `ps`)
//
//   node desktop/scripts/restore-bench.mjs [--bin bin/mtkprof] [--limit 2] [--runs 3] [--cold] file.trc file.trc ...
//
// Each run starts its own engine on a fresh cache directory under the OS temp dir (removed after), so
// nothing of the user's cache is touched. "Ready" is the session state `ready` plus a GET of `api/doc`,
// as the app's `load` does. The files must have distinct content (identical ones are coalesced by the
// engine and would not show the cost).
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  if (i < 0) return def
  return args.splice(i, 2)[1]
}
const bin = resolve(opt('--bin', 'bin/mtkprof'))
const limit = Number(opt('--limit', '2'))
const runs = Number(opt('--runs', '3'))
const files = args.filter((a) => !a.startsWith('--')).map((f) => resolve(f))
if (files.length < 2) {
  console.error('usage: restore-bench.mjs [--bin PATH] [--limit N] [--runs N] file.trc file.trc ...')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rss = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024 // MiB
  } catch {
    return 0
  }
}

async function oneRun(mode) {
  const cache = mkdtempSync(join(tmpdir(), 'mtk-bench-'))
  const token = randomBytes(24).toString('hex')
  const child = spawn(bin, ['engine', '-cache', cache], { env: { ...process.env, MTKPROF_TOKEN: token }, stdio: ['pipe', 'pipe', 'ignore'] })
  try {
    const addr = await new Promise((ok, fail) => {
      let buf = ''
      child.stdout.on('data', (d) => {
        buf += d
        const line = buf.split('\n')[0]
        if (buf.includes('\n')) ok(JSON.parse(line).addr)
      })
      child.on('exit', () => fail(new Error('engine exited')))
    })
    const base = `http://${addr}`
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    let peak = rss(child.pid)
    const poll = setInterval(() => (peak = Math.max(peak, rss(child.pid))), 25)

    const ready = async (path) => {
      const r = await fetch(`${base}/engine/sessions`, { method: 'POST', headers: h, body: JSON.stringify({ paths: [path] }) })
      const { session } = await r.json()
      for (;;) {
        const s = await (await fetch(`${base}/engine/sessions/${session.id}`, { headers: h })).json()
        if (s.state === 'failed') throw new Error(`${path}: ${s.error}`)
        if (s.state === 'ready') break
        await sleep(5)
      }
      await (await fetch(`${base}/s/${session.id}/api/doc`, { headers: h })).arrayBuffer()
    }

    const t0 = performance.now()
    let first = 0
    const timed = async (f, i) => {
      await ready(f)
      if (i === 0) first = performance.now() - t0
    }
    if (mode === 'concurrent') await Promise.all(files.map(timed))
    else {
      // N at a time, in order: a worker takes the next file when it finishes one
      let next = 0
      await Promise.all(
        Array.from({ length: limit }, async () => {
          while (next < files.length) {
            const i = next++
            await timed(files[i], i)
          }
        }),
      )
    }
    const total = performance.now() - t0
    clearInterval(poll)
    peak = Math.max(peak, rss(child.pid))
    return { first, total, peak }
  } finally {
    child.kill('SIGTERM')
    await sleep(100)
    rmSync(cache, { recursive: true, force: true })
  }
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
console.log(`engine ${bin}\nfiles ${files.length}: ${files.map((f) => f.split('/').pop()).join(', ')}\ncold cache per run, ${runs} runs, median`)
for (const mode of ['concurrent', 'queued']) {
  const rs = []
  for (let i = 0; i < runs; i++) rs.push(await oneRun(mode))
  const f = (k) => med(rs.map((r) => r[k]))
  console.log(
    `${mode.padEnd(10)}${mode === 'queued' ? ` (limit ${limit})` : ''}  first ready ${f('first').toFixed(0)} ms   all ready ${f('total').toFixed(0)} ms   peak RSS ${f('peak').toFixed(0)} MiB   [runs: ${rs.map((r) => `${r.first.toFixed(0)}/${r.total.toFixed(0)}/${r.peak.toFixed(0)}`).join(' ')}]`,
  )
}
