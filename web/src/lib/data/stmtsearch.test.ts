import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import { filterStatements, rankStatements, searchIndex, statementRows, stmtSorts, type StmtRowsOpts } from './stmtsearch'
import type { RawDocument, StmtStats } from './types'

/** The rows memo as it was before the search index (Statements.tsx, F06): the reference for the semantics and the "before" timing. */
function baselineRows(doc: TraceDoc, stats: StmtStats[], o: StmtRowsOpts): StmtStats[] {
  const sort = stmtSorts.find((s) => s.id === o.sort)!
  const needle = o.q.trim().toLowerCase()
  const list = stats.filter((s) => {
    if (s.allCalls.count === 0 && (o.narrowed || s.errors === 0)) return false
    const st = doc.statements[s.id]
    if (o.hideSys && st.parsingUserId === 0 && s.minDepth > 0) return false
    if (needle && !(st.sqlId.toLowerCase().includes(needle) || st.text.toLowerCase().includes(needle))) return false
    return true
  })
  return list.sort((a, b) => sort.of(b, o.inclusive) - sort.of(a, o.inclusive) || b.elapsed - a.elapsed)
}

/** The fixture document with the most statements: `findings-workload` (89 statements; the others have 16 to 32). */
const loadRaw = () => JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('./testdata/findings-workload.json.gz', import.meta.url)))).toString('utf8')).doc as RawDocument
const load = () => TraceDoc.fromRaw(loadRaw())

/** The fixture's statements repeated `copies` times with distinct ids and long text, the way a large trace has thousands of distinct statements. */
async function scaled(copies: number): Promise<TraceDoc> {
  const raw = loadRaw()
  const base = raw.statements, bs = raw.stats.statements
  const statements = [], stats = []
  for (let c = 0; c < copies; c++)
    for (let i = 0; i < base.length; i++) {
      const id = c * base.length + i
      statements.push({ ...base[i], id, sqlId: `${base[i].sqlId}${c.toString(36)}`, text: `${base[i].text} /* copy ${c} */ ${'x'.repeat(400)}` })
      stats.push({ ...bs[i], id })
    }
  return TraceDoc.fromRaw({ ...raw, statements, stats: { ...raw.stats, statements: stats } } as RawDocument)
}

const time = (f: () => unknown, runs = 30) => {
  f()
  const t: number[] = []
  for (let i = 0; i < runs; i++) { const a = performance.now(); f(); t.push(performance.now() - a) }
  t.sort((a, b) => a - b)
  return t[Math.floor(t.length / 2)]
}

const ids = (r: StmtStats[]) => r.map((x) => x.id)

describe('statementRows', () => {
  it('equals the unindexed filter-then-sort for every sort, mode, filter and needle', async () => {
    const doc = await load()
    const stats = doc.stats.statements
    const needles = ['', '  ', 'select', 'SELECT ', 'from', doc.statements[3].sqlId.toUpperCase(), doc.statements[3].sqlId.slice(2, 6), 'zzzzqq', 'a b', '\n']
    let n = 0
    for (const sort of stmtSorts) for (const inclusive of [false, true]) for (const hideSys of [false, true]) for (const narrowed of [false, true]) for (const q of needles) {
      const o: StmtRowsOpts = { sort: sort.id, inclusive, hideSys, narrowed, q }
      expect(ids(statementRows(doc, stats, o))).toEqual(ids(baselineRows(doc, stats, o)))
      n++
    }
    expect(n).toBe(12 * 2 * 2 * 2 * 10)
    // the fixture has real rows to compare (not just empty lists)
    expect(statementRows(doc, stats, { sort: 'resp', inclusive: false, hideSys: false, narrowed: false, q: 'select' }).length).toBeGreaterThan(10)
  })

  it('ties on the sort key go by elapsed time, then keep the order of the statistics', async () => {
    const doc = await load()
    const stats = doc.stats.statements.slice(0, 4).map((s, i) => ({ ...s, executions: 5, elapsed: [10, 30, 30, 20][i] }))
    expect(ids(rankStatements(stats, 'execs', false))).toEqual([stats[1].id, stats[2].id, stats[3].id, stats[0].id])
  })

  it('hide-SYS and the empty-call rule hold with a needle; the needle matches sql_id or text, not across them', async () => {
    const doc = await load()
    const stats = doc.stats.statements
    const base = { sort: 'resp' as const, inclusive: false, narrowed: false, q: '' }
    const withSys = statementRows(doc, stats, { ...base, hideSys: false })
    const noSys = statementRows(doc, stats, { ...base, hideSys: true })
    expect(noSys.length).toBeLessThan(withSys.length)
    expect(noSys.every((s) => !(doc.statements[s.id].parsingUserId === 0 && s.minDepth > 0))).toBe(true)
    const narrowedStats = stats.map((s, i) => (i === 0 ? { ...s, allCalls: { ...s.allCalls, count: 0 }, errors: 1 } : s))
    expect(ids(statementRows(doc, narrowedStats, { ...base, hideSys: false, narrowed: false }))).toContain(0) // errors keep a call-less statement in the whole-trace table
    expect(ids(statementRows(doc, narrowedStats, { ...base, hideSys: false, narrowed: true }))).not.toContain(0)
    const st = doc.statements[5]
    expect(ids(statementRows(doc, stats, { ...base, hideSys: false, q: st.sqlId }))).toContain(5)
    expect(ids(statementRows(doc, stats, { ...base, hideSys: false, q: st.sqlId.slice(-3) + st.text.slice(0, 3) }))).not.toContain(5) // a needle spanning the two fields matches neither
  })

  it('builds the index once per document, parallel to its statements', async () => {
    const doc = await load()
    const ix = searchIndex(doc)
    expect(ix).toHaveLength(doc.statements.length)
    expect(searchIndex(doc)).toBe(ix)
    expect(ix[0]).toBe(doc.statements[0].sqlId.toLowerCase() + '\u0000' + doc.statements[0].text.toLowerCase())
    expect(searchIndex(await load())).not.toBe(ix) // another document (a live snapshot): another index
  })

  it('filtering a ranked list does not re-rank it', async () => {
    const doc = await load()
    const ranked = rankStatements(doc.stats.statements, 'resp', false)
    const out = filterStatements(doc, ranked, { narrowed: false, hideSys: false, q: 'select' })
    expect(ids(out)).toEqual(ids(ranked).filter((id) => out.some((x) => x.id === id)))
  })
})

// The measurement builds a 53k-statement document: 2 to 5 s, and over the 5 s default on a loaded machine (it timed out in
// CI while the desktop checks ran beside it). It is opt-in: MTKPROF_MEASURE=1 pnpm test -- stmtsearch. The equivalence it
// also asserts is covered on the real fixture by the tests above.
describe('statement list cost per keystroke (measurement)', () => {
  it.skipIf(!process.env.MTKPROF_MEASURE)('reports the rows computation before (baseline) and after (index + stable ranking) on the fixture and on scaled documents', { timeout: 120_000 }, async () => {
    const out: string[] = []
    for (const [label, doc] of [['workload fixture', await load()], ['x60 (5.3k stmts, ~500 B text)', await scaled(60)], ['x600 (53k stmts)', await scaled(600)]] as const) {
      const stats = doc.stats.statements
      const ranked = rankStatements(stats, 'resp', false)
      for (const [needle, what] of [['zzzzqq', 'no match'], ['s', 'broad'], [doc.statements[0].sqlId, 'exact sql_id']] as const) {
        const o: StmtRowsOpts = { narrowed: false, hideSys: false, q: needle, sort: 'resp', inclusive: false }
        const before = time(() => baselineRows(doc, stats, o))
        const after = time(() => filterStatements(doc, ranked, o)) // a keystroke: the ranking is memoized
        expect(ids(filterStatements(doc, ranked, o))).toEqual(ids(baselineRows(doc, stats, o)))
        out.push(`${label}: ${stats.length} stmts, ${what}: before ${before.toFixed(2)} ms, after ${after.toFixed(2)} ms`)
      }
    }
    console.log(out.join('\n'))
    expect(out.length).toBe(9)
  })
})
