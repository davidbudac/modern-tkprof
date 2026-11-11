import { describe, expect, it } from 'vitest'
import { sparseText } from './opt'
import { indexDump, pathOf } from './optindex'
import { buildRows, gapText, hiddenByFolds, type OptRow } from './optrows'
import { HAS_FIXTURE, loadFixture } from './optfixture'
import { syntheticDump } from './optsynth'
import { completeText } from './opt'

const all = (rm: ReturnType<typeof buildRows>) => Array.from({ length: rm.count }, (_, i) => rm.at(i))

describe('gapText', () => {
  it('says how many lines are missing and which', () => {
    expect(gapText(2032, 3265)).toBe('1,234 lines not in this report (lines 2032-3265)')
    expect(gapText(7, 7)).toBe('1 line not in this report (line 7)')
  })
})

describe.skipIf(!HAS_FIXTURE)('the rows of the fixture', () => {
  const f = loadFixture()
  const d1 = f.dumps[0]
  const ix1 = indexDump(d1)
  const t1 = completeText(f.lines, d1.viewFrom, d1.viewTo)
  const closed = (fo: { closed: boolean }) => fo.closed

  it('Raw is one row per line, none built', () => {
    const rm = buildRows(ix1, t1, { mode: 'raw', closed, planText: false })
    expect(rm.count).toBe(d1.viewTo - d1.viewFrom + 1)
    expect(rm.at(0)).toEqual({ t: 'raw', line: d1.viewFrom })
    expect(rm.rowOf(d1.viewFrom + 99)).toBe(99)
    expect(rm.rowOf(d1.viewTo + 50)).toBe(rm.count - 1)
  })

  it('Formatted closes the folds (the lines they hide are the fold counts) and makes headings of banners', () => {
    const rm = buildRows(ix1, t1, { mode: 'fmt', closed, planText: false })
    const rows = all(rm)
    const h = hiddenByFolds(rm)
    expect(h.folds).toBe(33)
    expect(h.lines).toBe(6254) // the mock-up's status bar for dump 1: "33 folds closed, 6,254 lines hidden"
    expect(rows.some((r) => r.t === 'head')).toBe(true)
    // a banner is one heading row for its three lines, and the heading keeps the title line
    const head = rows.find((r): r is Extract<OptRow, { t: 'head' }> => r.t === 'head')!
    expect(head.to - head.from).toBe(2)
    expect(head.line).toBe(head.from + 1)
    expect(head.text).toBe('QUERY BLOCK SIGNATURE')
    expect(rm.rowOf(head.from)).toBe(rm.rowOf(head.to))
    // no row hides lines other than a closed fold
    expect(rm.count).toBeLessThan(d1.viewTo - d1.viewFrom + 1)
  })

  it('every line has a row, rows of lines in order never go back', () => {
    const rm = buildRows(ix1, t1, { mode: 'fmt', closed, planText: false })
    // (inside the plan band the rows go by operation, each with its predicates, not by line)
    const plan = d1.plan!
    let prev = 0
    for (let l = d1.viewFrom; l <= d1.viewTo; l += 7) {
      const r = rm.rowOf(l)
      if (l >= plan.from && l <= plan.to) continue
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
    // a line inside a closed fold is the fold's row
    const fold = d1.folds.find((x) => x.closed)!
    const r = rm.at(rm.rowOf(fold.from + 1))
    expect(r.t).toBe('fold')
  })

  it('an open fold has its handle on its first line and its rows back', () => {
    const open = buildRows(ix1, t1, { mode: 'fmt', closed: () => false, planText: false })
    expect(hiddenByFolds(open)).toEqual({ folds: 0, lines: 0 })
    expect(open.count).toBeGreaterThan(buildRows(ix1, t1, { mode: 'fmt', closed, planText: false }).count)
    const fold = d1.folds.find((x) => x.closed && x.kind === 'params')!
    const rows = all(open)
    const withHandle = rows.find((r) => (r.t === 'line' || r.t === 'head') && r.fold?.id === fold.id)
    expect(withHandle).toBeDefined()
  })

  it('nested folds: the fix controls inside the state dump close on their own', () => {
    const state = d1.folds.find((x) => x.kind === 'state')!
    const fix = d1.folds.find((x) => x.kind === 'fix')!
    expect(fix.from).toBeGreaterThanOrEqual(state.from)
    const stateOpen = buildRows(ix1, t1, { mode: 'fmt', closed: (fo) => fo.id !== state.id && fo.closed, planText: false })
    const fixRow = all(stateOpen).find((r) => r.t === 'fold' && r.fold.id === fix.id)
    expect(fixRow).toBeDefined()
  })

  it('SQL statements are pretty-printed in place, one band of rows for the line', () => {
    const v = d1.sql[1]
    const rm = buildRows(ix1, t1, { mode: 'fmt', closed: () => false, planText: false })
    const rows = all(rm).filter((r) => r.t === 'sql' && r.line === v.line)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.map((r) => (r.t === 'sql' ? r.k : -1))).toEqual(rows.map((_, i) => i))
    expect(rows.every((r) => r.t === 'sql' && r.n === rows.length)).toBe(true)
    expect(rm.rowOf(v.line)).toBe(all(rm).findIndex((r) => r.t === 'sql' && r.line === v.line))
  })

  it('the plan is a band of rows (head, columns, operations with query blocks and predicates), or the text', () => {
    const plan = d1.plan!
    const rm = buildRows(ix1, t1, { mode: 'fmt', closed, planText: false })
    const rows = all(rm)
    const k = rows.findIndex((r) => r.t === 'planhead')
    expect(rows[k + 1].t).toBe('plancols')
    expect(rows.filter((r) => r.t === 'planop')).toHaveLength(plan.rows.length)
    expect(rows.filter((r) => r.t === 'planpred').length).toBeGreaterThan(plan.rows.length / 2)
    expect(rows.filter((r) => (r.t === 'planop' || r.t === 'planpred') && r.last)).toHaveLength(1)
    expect(rm.rowOf(plan.rows[3].line)).toBeGreaterThan(k)
    const txt = buildRows(ix1, t1, { mode: 'fmt', closed, planText: true })
    expect(all(txt).some((r) => r.t === 'planop')).toBe(false)
    expect(txt.count).toBeGreaterThan(rm.count)
  })

  it('landmark and fold indexes find the line of their row', () => {
    const lm = d1.landmarks.find((l) => l.kind === 'best-ap')!
    expect(ix1.lmAt.get(lm.line)).toBe(ix1.dump.landmarks.find((x) => x.line === lm.line))
    expect(pathOf(ix1, lm.line).at(-1)!.kind).toBe('table')
  })
})

describe.skipIf(!HAS_FIXTURE)('a digest', () => {
  const f = loadFixture()
  const d = f.dumps[0]
  const ix = indexDump(d)
  const text = sparseText(d.viewFrom, d.viewTo, d.digest, (l) => f.lines[l - 1])

  it('shows a run of missing lines as one gap row, and the lines that are there as rows', () => {
    const rm = buildRows(ix, text, { mode: 'fmt', closed: (x) => x.closed, planText: false })
    const rows = all(rm)
    const gaps = rows.filter((r): r is Extract<OptRow, { t: 'gap' }> => r.t === 'gap')
    expect(gaps.length).toBeGreaterThan(5)
    // the gaps and the lines the rows stand for add up to the dump
    let missing = 0
    for (const g of gaps) missing += g.n
    let present = 0
    for (let l = d.viewFrom; l <= d.viewTo; l++) if (text.get(l) !== undefined) present++
    expect(missing + present).toBe(d.viewTo - d.viewFrom + 1)
    // each gap is maximal: the lines on either side are there
    for (const g of gaps) {
      expect(text.get(g.line)).toBeUndefined()
      expect(text.get(g.to)).toBeUndefined()
      if (g.line > d.viewFrom) expect(text.get(g.line - 1)).toBeDefined()
      if (g.to < d.viewTo) expect(text.get(g.to + 1)).toBeDefined()
    }
    expect(rm.rowOf(gaps[0].line + 1)).toBe(rm.rowOf(gaps[0].line))
  })

  it('Raw shows the same gaps', () => {
    const rm = buildRows(ix, text, { mode: 'raw', closed: () => false, planText: false })
    const rows = all(rm)
    expect(rows.filter((r) => r.t === 'raw').length + rows.reduce((n, r) => n + (r.t === 'gap' ? r.n : 0), 0)).toBe(d.viewTo - d.viewFrom + 1)
    expect(rows.every((r) => r.t === 'raw' || r.t === 'gap')).toBe(true)
  })

  it('the plan and the SQL versions of the digest are drawn from the model', () => {
    const rm = buildRows(ix, text, { mode: 'fmt', closed: (x) => x.closed, planText: false })
    const rows = all(rm)
    expect(rows.some((r) => r.t === 'planop')).toBe(true)
    expect(rows.some((r) => r.t === 'sql')).toBe(true)
  })
})

describe('a dump of 100,000 lines', () => {
  const s = syntheticDump(100_000)
  const ix = indexDump(s.dump)
  const text = completeText(s.lines, 1, s.lines.length)
  it('has its rows in well under a second, in both modes', () => {
    expect(s.lines.length).toBeGreaterThanOrEqual(100_000)
    const t0 = performance.now()
    const fmt = buildRows(ix, text, { mode: 'fmt', closed: (f) => f.closed, planText: false })
    const raw = buildRows(ix, text, { mode: 'raw', closed: (f) => f.closed, planText: false })
    const ms = performance.now() - t0
    expect(fmt.count).toBeGreaterThan(50_000)
    expect(raw.count).toBe(s.lines.length)
    expect(ms).toBeLessThan(1000)
  })
  it('finds the chain of nodes of a line by binary search', () => {
    const t0 = performance.now()
    let depth = 0
    for (let i = 0; i < 20_000; i++) depth += pathOf(ix, 1 + ((i * 4999) % s.lines.length)).length
    expect(performance.now() - t0).toBeLessThan(500)
    expect(depth).toBeGreaterThan(20_000)
  })
})
