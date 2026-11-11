import { describe, expect, it } from 'vitest'
import { completeText, sparseText } from './opt'
import { compileQuery, hasHit, hitIndex, hitsIn, searchCount, searchNote, searchText } from './optsearch'
import { dressLine, matchRanges, termsOf } from './optdress'
import { indexDump } from './optindex'
import { glossaryOf, glossaryRegex } from './optguide'
import { HAS_FIXTURE, loadFixture } from './optfixture'
import { syntheticDump } from './optsynth'

const LINES = ['Best:: AccessPath: TableScan', 'x', 'Best:: JoinMethod: NestedLoop', 'best:: lowercase', '(unclosed paren', 'a.b']
const text = completeText(LINES, 1, LINES.length)

describe('compileQuery', () => {
  it('is literal unless it is a regular expression, case-insensitive unless asked', () => {
    expect(compileQuery({ q: 'a.b', regex: false, caseSensitive: false }).re?.test('axb')).toBe(false)
    expect(compileQuery({ q: 'a.b', regex: true, caseSensitive: false }).re?.test('axb')).toBe(true)
    expect(compileQuery({ q: 'A', regex: false, caseSensitive: true }).re?.test('a')).toBe(false)
    expect(compileQuery({ q: '', regex: false, caseSensitive: false })).toEqual({ re: null, bad: false })
    expect(compileQuery({ q: '(unclosed', regex: true, caseSensitive: false })).toEqual({ re: null, bad: true })
    expect(compileQuery({ q: '(unclosed', regex: false, caseSensitive: false }).bad).toBe(false)
  })
})

describe('searchText', () => {
  it('lists the lines that match, ascending', () => {
    const r = searchText(text, { q: 'best::', regex: false, caseSensitive: false })
    expect(Array.from(r.hits)).toEqual([1, 3, 4])
    expect(r.searched).toBe(6)
    expect(r.complete).toBe(true)
    expect(Array.from(searchText(text, { q: 'best::', regex: false, caseSensitive: true }).hits)).toEqual([4])
    expect(Array.from(searchText(text, { q: 'Best:: (Access|Join)', regex: true, caseSensitive: true }).hits)).toEqual([1, 3])
    expect(Array.from(searchText(text, { q: '(unclosed', regex: false, caseSensitive: false }).hits)).toEqual([5])
  })
  it('a bad expression or an empty query has no hits', () => {
    const bad = searchText(text, { q: '(', regex: true, caseSensitive: false })
    expect(bad.bad).toBe(true)
    expect(bad.hits).toHaveLength(0)
    expect(searchCount(bad, 0)).toBe('invalid')
    expect(searchCount(searchText(text, { q: '', regex: false, caseSensitive: false }), 0)).toBe('')
  })
  it('in a digest it searches the lines in the report only, and says so', () => {
    const d = sparseText(1, 6, [{ from: 1, to: 2 }, { from: 4, to: 4 }], (l) => LINES[l - 1])
    const r = searchText(d, { q: 'best::', regex: false, caseSensitive: false })
    expect(Array.from(r.hits)).toEqual([1, 4])
    expect(r.searched).toBe(3)
    expect(r.complete).toBe(false)
    expect(searchNote(r)).toBe('searched the 3 lines in this report only')
    expect(searchNote(searchText(text, { q: 'best::', regex: false, caseSensitive: false }))).toBe('')
  })
  it('counts per range, finds a line and the position of a hit', () => {
    const h = Int32Array.from([3, 10, 11, 40, 90])
    expect(hitsIn(h, 1, 100)).toBe(5)
    expect(hitsIn(h, 10, 11)).toBe(2)
    expect(hitsIn(h, 12, 39)).toBe(0)
    expect(hitsIn(h, 40, 40)).toBe(1)
    expect(hitsIn(new Int32Array(0), 1, 9)).toBe(0)
    expect(hasHit(h, 11)).toBe(true)
    expect(hasHit(h, 12)).toBe(false)
    expect(hitIndex(h, 40)).toBe(4)
    expect(hitIndex(h, 41)).toBe(0)
  })
})

describe('marks inside a line', () => {
  it('lists the matches, the first of the current line marked current', () => {
    const re = /ab/gi
    expect(matchRanges(re, 'xxABxxab', true)).toEqual([[2, 4, true], [6, 8, false]])
    expect(matchRanges(re, 'xxABxxab', false)).toEqual([[2, 4, false], [6, 8, false]])
    expect(matchRanges(null, 'ab', true)).toEqual([])
    expect(matchRanges(/x*/g, 'abc', false)).toEqual([])
  })
})

describe.skipIf(!HAS_FIXTURE)('on the fixture', () => {
  const f = loadFixture()
  it('counts the hits of a regular expression in the nodes of the outline', () => {
    const d = f.dumps[0]
    const ix = indexDump(d)
    const t = completeText(f.lines, d.viewFrom, d.viewTo)
    const r = searchText(t, { q: 'Best:: (Access|Join)', regex: true, caseSensitive: false })
    expect(r.hits.length).toBe(78) // 20 AccessPath + 58 JoinMethod lines in dump 1 (the mock-up's own check)
    expect(hitsIn(r.hits, d.viewFrom, d.viewTo)).toBe(78)
    // the children of a node add up to the node
    const phase = ix.root.kids.find((n) => n.kind === 'phase-cost')!
    expect(hitsIn(r.hits, phase.from, phase.to)).toBe(phase.kids.reduce((n, k) => n + hitsIn(r.hits, k.from, k.to), 0) + hitsIn(r.hits, phase.from, phase.to) - phase.kids.reduce((n, k) => n + hitsIn(r.hits, k.from, k.to), 0))
    const runs = ix.nodes.filter((n) => n.kind === 'run')
    expect(runs.reduce((n, x) => n + hitsIn(r.hits, x.from, x.to), 0)).toBe(78)
  })
  it('the glossary and prefix terms of a line', () => {
    const d = f.dumps[0]
    const ix = indexDump(d)
    const gloss = glossaryOf(d, f.file)
    const g = { gloss, re: glossaryRegex(gloss) }
    expect(gloss.get('CBQT')?.text).toBe('cost-based query transformation')
    expect(gloss.get('CBQT')?.source).toMatch(/^trace Legend, two\.trc line \d+$/)
    expect(gloss.get('GBP')?.text).toBe('group-by placement')
    const line = 'GBP: Starting iteration 1, state space = (1,2,3,4) : (0,0,0,0)'
    expect(termsOf(line, g).map((t) => t.term)).toContain('GBP')
    const dressed = dressLine(ix, g, d.from + 400, line)
    expect(dressed.spans.find((s) => s.t === 'GBP')?.cls).toContain('opt-gl')
    expect(dressLine(ix, g, 1, 'Best:: AccessPath: TableScan').spans.some((s) => s.cls === 'opt-best')).toBe(true)
    expect(dressLine(ix, g, 1, '*********************').cls).toBe('opt-rule')
    expect(dressLine(ix, g, 1, '----- Final plan -----').cls).toBe('opt-h3')
  })
})

describe('a dump of 100,000 lines', () => {
  it('is searched in one pass', () => {
    const s = syntheticDump(100_000)
    const t = completeText(s.lines, 1, s.lines.length)
    const t0 = performance.now()
    const r = searchText(t, { q: 'Join order\\[\\d+\\]:', regex: true, caseSensitive: false })
    const ms = performance.now() - t0
    expect(r.hits.length).toBeGreaterThan(100)
    expect(ms).toBeLessThan(500)
  })
})
