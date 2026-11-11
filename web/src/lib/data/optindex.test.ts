import { describe, expect, it } from 'vitest'
import { LM_DEFAULTS, LM_KINDS, enabledLandmarks, foldOf, indexDump, landmarkCounts, lmSwitches, pathOf, stepLine } from './optindex'
import { HAS_FIXTURE, loadFixture } from './optfixture'

describe('landmark kinds', () => {
  it('are on by default as the user confirmed: verdicts, final cost, best access path and join method, aborted join orders, hint errors; refusals off', () => {
    expect(LM_DEFAULTS).toEqual({ verdict: true, 'final-cost': true, 'best-ap': true, 'best-jm': true, aborted: true, 'hint-error': true, refused: false })
    expect(LM_KINDS.map((k) => k.k).sort()).toEqual(Object.keys(LM_DEFAULTS).sort())
  })
  it('lays stored switches over the defaults, ignoring what it does not know', () => {
    expect(lmSwitches(null)).toEqual(LM_DEFAULTS)
    expect(lmSwitches({ refused: true, aborted: false, nonsense: true, verdict: 3 as unknown as boolean })).toEqual({ ...LM_DEFAULTS, refused: true, aborted: false })
  })
  it('a kind that is off is not listed', () => {
    const d = { landmarks: [{ line: 1, kind: 'refused', tone: 'rejected', text: '' }, { line: 2, kind: 'best-ap', tone: 'kept', text: '' }, { line: 3, kind: 'aborted', tone: 'rejected', text: '' }] }
    expect(enabledLandmarks(d, LM_DEFAULTS).map((l) => l.line)).toEqual([2, 3])
    expect(enabledLandmarks(d, { ...LM_DEFAULTS, refused: true }).map((l) => l.line)).toEqual([1, 2, 3])
    expect(enabledLandmarks(d, { ...LM_DEFAULTS, 'best-ap': false, aborted: false })).toEqual([])
    expect(landmarkCounts(d)).toEqual({ refused: 1, 'best-ap': 1, aborted: 1 })
  })
})

describe('stepLine', () => {
  const l = [10, 20, 30]
  it('steps to the next and previous line of the list, wrapping round', () => {
    expect(stepLine(l, 0, 1)).toBe(10)
    expect(stepLine(l, 10, 1)).toBe(20)
    expect(stepLine(l, 15, 1)).toBe(20)
    expect(stepLine(l, 30, 1)).toBe(10)
    expect(stepLine(l, 20, -1)).toBe(10)
    expect(stepLine(l, 10, -1)).toBe(30)
    expect(stepLine(l, 99, -1)).toBe(30)
    expect(stepLine([], 5, 1)).toBe(0)
  })
})

describe.skipIf(!HAS_FIXTURE)('the index of the fixture', () => {
  const f = loadFixture()
  const ix = indexDump(f.dumps[0])
  it('knows its nodes, their parents and the chain holding a line', () => {
    expect(ix.nodes.length).toBe(309) // dump 1's share of the mock-up's 527 nodes
    expect(ix.root.kind).toBe('dump')
    const run = ix.nodes.find((n) => n.kind === 'run' && n.final)!
    const p = pathOf(ix, run.from + 3)
    expect(p[0]).toBe(ix.root)
    expect(p.at(-1)!.from).toBeLessThanOrEqual(run.from + 3)
    expect(p.map((n) => n.kind)).toContain('run')
    for (let i = 1; i < p.length; i++) expect(p[i].parent).toBe(p[i - 1])
    expect(ix.byId.get(run.id)).toBe(run)
    expect(pathOf(ix, 1).map((n) => n.kind)).toEqual(['dump', 'file-header'])
  })
  it('knows the folds and the fold that holds a line', () => {
    const fold = ix.dump.folds.find((x) => x.kind === 'params')!
    expect(foldOf(ix, fold.from + 5)?.id).toBe(fold.id)
    expect(ix.foldsAt.get(fold.from)).toContainEqual(fold)
    const state = ix.dump.folds.find((x) => x.kind === 'state')!
    const fix = ix.dump.folds.find((x) => x.kind === 'fix')!
    expect(foldOf(ix, fix.from + 1)?.id).toBe(fix.id) // the inner one
    expect(foldOf(ix, state.from + 1)?.id).toBe(state.id)
  })
  it('the outermost node of a line is the one that starts at it', () => {
    const t = ix.nodes.find((n) => n.kind === 'table')!
    expect(ix.startAt.get(t.from)!.lvl).toBeLessThanOrEqual(t.lvl)
  })
})
