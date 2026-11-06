import { describe, expect, it } from 'vitest'
import { FOCUS_PX, MIN_PIECE_PX, layoutOutput, layoutSources, lineY, placeLabels, rowLabels, type CutPiece, type CutRun } from './cutlayout'

const piece = (p: Partial<CutPiece>): CutPiece => ({ kind: 'kept', file: 0, n: 1, o0: 1, o1: 1, head: [], ...p })

describe('layoutSources', () => {
  it('gives small borrowed ranges FOCUS_PX in place and keeps the column height', () => {
    const plan = {
      files: [{ idx: 0, name: 'a.trc', lines: 16428, runs: [] }],
      pieces: [piece({ kind: 'before', from: 131, to: 134, n: 4 }), piece({ kind: 'after', from: 16413, to: 16416, n: 4 }), piece({ kind: 'kept', from: 9785, to: 10387, n: 603 })],
    }
    const { cols } = layoutSources(plan, 30, 600)
    const c = cols[0]
    expect(c.focus).toEqual([[131, 134], [16413, 16416]])
    expect(c.h).toBeCloseTo(600, 5)
    expect(lineY(c, 135) - lineY(c, 131)).toBeCloseTo(FOCUS_PX, 5)
    expect(lineY(c, 1)).toBe(30)
    expect(lineY(c, 16429)).toBeCloseTo(630, 5)
    // monotone
    let prev = -1
    for (let l = 1; l <= 16429; l += 97) { const y = lineY(c, l); expect(y).toBeGreaterThanOrEqual(prev); prev = y }
  })
  it('stacks several files with a gap and stretches the borrowed lines of each', () => {
    const plan = {
      files: [{ idx: 0, name: 'b.trc', lines: 230, runs: [] }, { idx: 1, name: 'a.trc', lines: 263, runs: [] }],
      pieces: [piece({ kind: 'before', file: 1, from: 30, to: 30, lines: [24, 30] })],
    }
    const { cols } = layoutSources(plan, 0, 600, 34)
    expect(cols[1].y0).toBeCloseTo(cols[0].h + 34, 5)
    expect(cols[0].h + cols[1].h + 34).toBeCloseTo(600, 5)
  })
})

describe('layoutOutput', () => {
  it('draws kept lines at the source scale and small blocks MIN_PIECE_PX tall', () => {
    const { y, h } = layoutOutput([piece({ kind: 'header', n: 22 }), piece({ kind: 'kept', n: 6000 }), piece({ kind: 'generated', n: 1 })], 0.03, 10, 600)
    expect(y[0]).toEqual([10, 10 + MIN_PIECE_PX])
    expect(y[1][1] - y[1][0]).toBeCloseTo(180, 5)
    expect(h).toBeCloseTo(2 * MIN_PIECE_PX + 180, 5)
  })
  it('shrinks kept lines when the blocks would not fit', () => {
    const { h } = layoutOutput([piece({ kind: 'kept', n: 100000 }), piece({ kind: 'before', n: 3 })], 0.03, 0, 600)
    expect(h).toBeLessThanOrEqual(600.0001)
  })
})

describe('placeLabels', () => {
  it('keeps labels apart and inside the range', () => {
    expect(placeLabels([10, 12, 13], 10, 0, 100)).toEqual([10, 20, 30])
    expect(placeLabels([95, 96, 97], 10, 0, 100)).toEqual([80, 90, 100])
  })
})

describe('rowLabels', () => {
  it('labels each row by the run covering most of it, and never hides a borrowed line', () => {
    const runs: CutRun[] = [{ f: 1, t: 20, l: 'H' }, { f: 131, t: 134, l: 'B' }, { f: 500, t: 1000, l: 'K' }]
    const r = rowLabels(runs, 1, 1000, 10) // 100 lines a row
    expect(r[0]).toBe('H') // only 20 of 100 lines, but a borrowed label shows
    expect(r[1]).toBe('B')
    expect(r[2]).toBe('.')
    expect(r[5]).toBe('K')
    expect(r[9]).toBe('K')
  })
})
