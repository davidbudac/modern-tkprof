import { describe, expect, it } from 'vitest'
import type { DiagNode } from './diag'
import { closedCount, foldAll, FOLDED, handleOf, isFoldOpen, setFold, textFolds, unfoldFor } from './diagfold'
import { foldHiding, lineOfRow, rowOfLine, visibleCount } from './folds'

const node = (id: string, from: number, to: number, fold?: string, kind = 'title'): DiagNode => ({ id, kind, title: id, from, to, lines: to - from + 1, hasChildren: false, ...(fold ? { fold } : null) })

// a dump: a Binary Stack Dump of 2,000 lines, a Process Map Dump of 166, a part of 2 lines, and an outer fold with an inner one
const BIN = node('bin', 100, 2099, 'frame data')
const MAP = node('map', 3000, 3165, 'process map')
const TINY = node('tiny', 3200, 3202, 'raw')
const OUT = node('out', 5000, 9000, 'fixed areas')
const IN = node('in', 5100, 6000, 'fixed pga')
const NODES = [BIN, MAP, TINY, OUT, IN]

describe('the folds of the text', () => {
  it('closes every fold with a reason by default and says how many lines and why', () => {
    const f = textFolds(NODES, FOLDED)
    expect(f.folds.map((x) => [x.from, x.to])).toEqual([[100, 2099], [3000, 3165], [5000, 9000]]) // TINY hides two lines: left open; IN is inside OUT
    expect(f.folds[0].summary).toBe('1,999 lines · frame data')
    expect(f.hiddenLines).toBe(1999 + 165 + 4000)
    expect([...f.handles].sort((a, b) => a - b)).toEqual([100, 3000, 5000])
  })

  it('opens one fold, or all, and shows the inner folds of an opened outer one closed', () => {
    const st = setFold(FOLDED, 'out', true)
    expect(isFoldOpen(st, 'out')).toBe(true)
    const f = textFolds(NODES, st)
    expect(f.folds.map((x) => x.from)).toEqual([100, 3000, 5100])
    expect(f.handles.has(5100)).toBe(true)
    expect(textFolds(NODES, foldAll(true)).folds).toEqual([])
    expect(closedCount(NODES, foldAll(false))).toBe(3)
    // closing one again forgets the toggle
    expect(setFold(st, 'out', false)).toEqual(FOLDED)
    expect(setFold(foldAll(true), 'bin', false)).toEqual({ all: true, set: { bin: false } })
  })

  it('opens the folds that hide a line, the inner one too, and nothing for a line in plain text', () => {
    expect(unfoldFor(NODES, FOLDED, 50)).toBe(FOLDED)
    expect(unfoldFor(NODES, FOLDED, 100)).toBe(FOLDED) // the heading is visible
    const a = unfoldFor(NODES, FOLDED, 101)
    expect(isFoldOpen(a, 'bin')).toBe(true)
    const b = unfoldFor(NODES, FOLDED, 5500) // in OUT, then in IN
    expect(isFoldOpen(b, 'out')).toBe(true)
    expect(isFoldOpen(b, 'in')).toBe(true)
    expect(foldHiding(5500, textFolds(NODES, b).folds)).toBeUndefined()
  })

  it('keeps a part of an incident\'s table of contents under its marker line', () => {
    const toc = node('toc', 217, 2291, 'frame data', 'toc') // [TOC00007] at 217, the title at 218
    expect(handleOf(toc)).toBe(218)
    const f = textFolds([toc], FOLDED)
    expect(f.folds[0]).toMatchObject({ from: 218, to: 2291 })
    expect(foldHiding(217, f.folds)).toBeUndefined()
  })

  it('maps rows to lines through the folds and pages only what is in view', () => {
    const f = textFolds(NODES, FOLDED).folds
    const total = 10000
    expect(visibleCount(total, f)).toBe(total - (1999 + 165 + 4000))
    // the row after the heading of the first fold is the line after the fold
    expect(rowOfLine(100, f)).toBe(99)
    expect(lineOfRow(100, f)).toBe(2100)
    // a line inside a fold maps to its heading's row
    expect(rowOfLine(1500, f)).toBe(rowOfLine(100, f))
    // the rows of a window across the fold are the lines the viewer asks the server's pages for: none of the hidden ones
    const lines = Array.from({ length: 20 }, (_, k) => lineOfRow(90 + k, f))
    expect(lines.slice(0, 10)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100])
    expect(lines.slice(10)).toEqual([2100, 2101, 2102, 2103, 2104, 2105, 2106, 2107, 2108, 2109])
  })
})
