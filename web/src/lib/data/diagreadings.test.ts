import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeCallStack, normalizeHeap, normalizePgaDetail, normalizePgaSummary, normalizeProcState, READING_AHEAD, READING_EMBEDS, READING_KEYS } from './diagreadings'
import { HAS_STACK_FIXTURE, loadStackFixtures } from './diagstackfixture'
import { HAS_READINGS_FIXTURE, loadReadingFixtures } from './diagreadingsfixture'

const GO = ['heap.go', 'pga.go', 'stack.go', 'procstate.go', 'digest.go'].map((f) => fileURLToPath(new URL(`../../../../internal/diag/${f}`, import.meta.url)))

/** The JSON names of the fields of each struct of the Go files: `req` always there, `opt` with omitempty. A struct or a field without a json tag (the scan's own) is not one. */
function goKeys(src: string): Record<string, { req: string[]; opt: string[] }> {
  const out: Record<string, { req: string[]; opt: string[] }> = {}
  for (const m of src.matchAll(/^type (\w+) struct \{\n([\s\S]*?)^\}/gm)) {
    const keys = { req: [] as string[], opt: [] as string[] }
    for (const line of m[2].split('\n')) {
      const t = /`json:"([^",]+)(,omitempty)?"`/.exec(line)
      if (!t) continue
      if (t[2]) keys.opt.push(t[1])
      else keys.req.push(t[1])
    }
    if (keys.req.length + keys.opt.length > 0) out[m[1]] = keys
  }
  return out
}

describe('the twin of the readings in internal/diag/heap.go, pga.go, stack.go, procstate.go and digest.go', () => {
  it.skipIf(!GO.every((f) => existsSync(f)))('has every struct and every JSON name of the Go files, optional where Go says omitempty (a field ahead of Go is listed)', () => {
    const go: Record<string, { req: string[]; opt: string[] }> = {}
    for (const f of GO) Object.assign(go, goKeys(readFileSync(f, 'utf8')))
    for (const [name, k] of Object.entries(go)) {
      const ts = READING_KEYS[name]
      expect(ts, `type ${name} has JSON fields in the Go files and is not in READING_KEYS`).toBeDefined()
      const ahead = READING_AHEAD[name] ?? []
      const here = (xs: string[]) => xs.filter((x) => !ahead.includes(x) || k.req.includes(x) || k.opt.includes(x)).sort()
      expect(here(ts.req), `${name}: required fields`).toEqual([...k.req].sort())
      expect(here(ts.opt), `${name}: omitempty fields`).toEqual([...k.opt].sort())
    }
    for (const name of Object.keys(READING_KEYS)) expect(go[name], `READING_KEYS has ${name}, the Go files do not`).toBeDefined()
  })

  it.skipIf(!HAS_READINGS_FIXTURE)('reads the engine\'s JSON of real readings: every key it has is declared, every required key is there', () => {
    const fx = loadReadingFixtures()
    const walk = (type: string, v: unknown, path: string) => {
      const k = READING_KEYS[type]
      expect(k, `${path}: no ${type} in READING_KEYS`).toBeDefined()
      const o = v as Record<string, unknown>
      for (const key of Object.keys(o)) expect([...k.req, ...k.opt], `${path}.${key} is not in the twin`).toContain(key)
      for (const key of k.req) expect(o, `${path} lacks ${key}`).toHaveProperty(key)
    }
    const each = (type: string, xs: unknown[] | undefined, path: string) => (xs ?? []).forEach((x, i) => walk(type, x, `${path}[${i}]`))
    for (const f of [fx.heapPga, fx.heapKoh, fx.heapPdb]) {
      const h = f.reading as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      walk('HeapReading', h, 'heap')
      walk('HeapFlags', h.flags, 'heap.flags')
      if (h.flags.contents) walk('HeapContents', h.flags.contents, 'heap.flags.contents')
      each('HeapCheck', h.checks, 'checks')
      each('HeapType', h.byType, 'byType')
      each('HeapComment', h.byComment, 'byComment')
      for (const c of h.byComment) each('HeapTypeShare', c.types, 'types')
      each('HeapSub', h.subheaps, 'subheaps')
      each('HeapLargest', h.largest, 'largest')
      each('HeapRun', h.run, 'run')
      walk('HeapFreeLists', h.freeLists, 'freeLists')
      each('HeapBucket', h.freeLists.buckets, 'buckets')
      if (h.permanent) walk('HeapPermanent', h.permanent, 'permanent')
    }
    walk('HeapLines', fx.heapPga.lines, 'lines')
    const s = fx.pgaSummary.reading as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    walk('PGASummary', s, 'summary')
    each('PGAUse', s.top, 'top')
    each('PGABlock', s.private, 'private')
    for (const b of s.private) each('PGABlockRow', b.rows, 'rows')
    each('PGAInstance', s.instance, 'instance')
    each('PGAKV', s.swap, 'swap')
    walk('PGAProcesses', s.processes, 'processes')
    each('PGAProc', s.processes.all, 'all')
    for (const p of s.processes.all) if (p.session) walk('PGASession', p.session, 'session')
    walk('PGAEstimated', s.estimated, 'estimated')
    each('PGAUse', s.estimated.rows, 'estimated.rows')
    const d = fx.pgaDetail.reading as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    walk('PGADetail', d, 'detail')
    each('PGAUse', d.rows, 'detail.rows')
  })

  it.skipIf(!HAS_STACK_FIXTURE)('reads the engine\'s JSON of real call stack and process readings: every key it has is declared, every required key is there', () => {
    const fx = loadStackFixtures()
    const keysOf = (type: string): string[] => {
      const k = READING_KEYS[type]
      return [...k.req, ...k.opt, ...(READING_EMBEDS[type] ?? []).flatMap(keysOf)]
    }
    const walk = (type: string, v: unknown, path: string) => {
      const k = READING_KEYS[type]
      expect(k, `${path}: no ${type} in READING_KEYS`).toBeDefined()
      const o = v as Record<string, unknown>
      for (const key of Object.keys(o)) expect(keysOf(type), `${path}.${key} is not in the twin`).toContain(key)
      for (const key of [...k.req, ...(READING_EMBEDS[type] ?? []).flatMap((e) => READING_KEYS[e].req)]) expect(o, `${path} lacks ${key}`).toHaveProperty(key)
    }
    const each = (type: string, xs: unknown[] | undefined | null, path: string) => (xs ?? []).forEach((x, i) => walk(type, x, `${path}[${i}]`))
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (const f of [fx.errorstack, fx.deadlock, fx.in10046, fx.incident, fx.incidentDump]) {
      const c = f.reading as any
      walk('CallStack', c, 'callstack')
      walk('DumpStart', c.start, 'start')
      if (c.error) { walk('DumpError', c.error, 'error'); each('DumpLine', c.error.lines, 'error.lines'); if (c.error.signal) walk('DumpSignal', c.error.signal, 'signal'); if (c.error.incident) walk('DumpIncident', c.error.incident, 'incident') }
      each('DumpLine', c.barriers, 'barriers')
      if (c.statement) walk('DumpStatement', c.statement, 'statement')
      each('PLSQLFrame', c.plsql, 'plsql')
      each('StackFrame', c.frames, 'frames')
      each('DumpCursor', c.cursors, 'cursors')
      for (const cu of c.cursors) each('DumpBind', cu.binds, 'binds')
      each('DumpLink', c.links, 'links')
    }
    for (const f of [fx.errorstackProc, fx.procstate, fx.deadlockProc, fx.sysBlocker, fx.sysBlocked]) {
      const p = f.reading as any
      walk('ProcState', p, 'procstate')
      if (p.process) walk('ProcInfo', p.process, 'process')
      each('ProcSession', p.sessions, 'sessions')
      for (const s of p.sessions) {
        if (!s.wait) continue
        walk('ProcWait', s.wait, 'wait')
        each('WaitEntry', s.wait.stack, 'stack')
        each('SessionRef', s.wait.blockers, 'blockers')
        if (s.wait.finalBlocker) walk('SessionRef', s.wait.finalBlocker, 'finalBlocker')
        each('ProcWaiter', s.wait.waiters, 'waiters')
        for (const w of s.wait.waiters) if (w.rowWait) walk('RowWait', w.rowWait, 'rowWait')
        each('WaitHistory', s.wait.history, 'history')
      }
      walk('ProcObjects', p.objects, 'objects')
      each('ObjectType', p.objects.byType, 'byType')
      each('ProcEnqueue', p.enqueues, 'enqueues')
      each('ProcTransaction', p.transactions, 'transactions')
      for (const t of p.transactions) each('BlockRow', t.blocks, 'blocks')
      each('ProcDMLLock', p.dmlLocks, 'dmlLocks')
      each('ProcLibObject', p.locks, 'locks')
      each('ProcLibObject', p.pins, 'pins')
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
})

describe('what Go leaves null', () => {
  it('is made empty', () => {
    const h = normalizeHeap({ kind: 'heap', node: 'n', name: 'x', checks: null, byType: null, byComment: [{ comment: 'a', types: null, chunks: 1, bytes: 2, line: 3 }], subheaps: null, largest: null, run: null, flags: null, freeLists: { present: true, buckets: null } } as never)
    expect(h.checks).toEqual([])
    expect(h.byType).toEqual([])
    expect(h.byComment[0].types).toEqual([])
    expect(h.subheaps).toEqual([])
    expect(h.largest).toEqual([])
    expect(h.run).toEqual([])
    expect(h.flags).toEqual({})
    expect(h.freeLists.buckets).toEqual([])
    expect(h.subheapsTotal).toBe(0)
    const s = normalizePgaSummary({ kind: 'pga-summary', node: 'n', top: null, private: null, instance: null, swap: null, processes: { line: 1, top: null, all: null } } as never)
    expect([s.top, s.private, s.instance, s.swap, s.processes!.top, s.processes!.all]).toEqual([[], [], [], [], [], []])
    expect(normalizePgaDetail({ kind: 'pga-detail', node: 'n', rows: null } as never).rows).toEqual([])
  })
})

describe('what Go leaves null in the call stack and process readings', () => {
  it('is made empty', () => {
    const c = normalizeCallStack({ kind: 'callstack', node: 'n', error: { lines: null }, barriers: null, plsql: null, frames: null, cursors: [{ sqlId: 'a', binds: null }], links: null, notes: null } as never)
    expect([c.error?.lines, c.barriers, c.plsql, c.frames, c.links, c.notes]).toEqual([[], [], [], [], [], []])
    expect(c.cursors[0].binds).toEqual([])
    const p = normalizeProcState({ kind: 'procstate', node: 'n', sessions: [{ key: '1.2', wait: { stack: null, blockers: null, waiters: [{ params: null }], history: null } }], objects: { total: 0, depth: 0, byType: null }, enqueues: null, transactions: [{ blocks: null }], dmlLocks: null, locks: null, pins: null, notes: null } as never)
    expect([p.enqueues, p.dmlLocks, p.locks, p.pins, p.notes, p.objects.byType]).toEqual([[], [], [], [], [], []])
    expect(p.transactions[0].blocks).toEqual([])
    expect(p.sessions[0].wait).toMatchObject({ stack: [], blockers: [], history: [] })
    expect(p.sessions[0].wait!.waiters[0].params).toEqual([])
  })
})
