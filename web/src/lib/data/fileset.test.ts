import { describe, expect, it } from 'vitest'
import {
  ctxKey, clickFile, contextsOfFiles, contextsWithin, effectiveContexts, fileTree, formatFilesParam, invert, normalizeFiles, parseFilesParam, selectionSpan, toggleFile,
  type FileSetDoc,
} from './fileset'
import type { FileEntry } from './types'

const f = (idx: number, extra: Partial<FileEntry> = {}): FileEntry => ({ idx, name: `f${idx}`, firstTim: 0, lastTim: 0, ...extra } as FileEntry)

// files: 0 (contexts 0,1), 1 (PX slave of context 0), 2 (context 3), 3 (PX slave of context 3), 4 (PX slave, no coordinator)
const doc: FileSetDoc & { spanUs(): number } = {
  file: { files: [f(0), f(1, { px: true }), f(2), f(3, { px: true }), f(4, { px: true })] },
  contexts: [
    { fileIdx: 0 }, { fileIdx: 0 }, { fileIdx: 1, px: true, parent: 0 }, { fileIdx: 2 },
    { fileIdx: 3, px: true, parent: 3 }, { fileIdx: 4, px: true, parent: -1 },
  ],
  spanUs: () => 9000,
}

describe('effective context filter', () => {
  it('is the contexts of the selected files when no context is picked', () => {
    expect([...effectiveContexts(doc, new Set([0]), null)!].sort()).toEqual([0, 1])
    expect([...effectiveContexts(doc, new Set([1, 2]), null)!].sort()).toEqual([2, 3])
  })
  it('intersects an explicit context selection with the files', () => {
    expect([...effectiveContexts(doc, new Set([0, 2]), new Set([1, 2, 3]))!].sort()).toEqual([1, 3])
    expect(effectiveContexts(doc, new Set([0]), new Set([3]))!.size).toBe(0)
  })
  it('is the explicit selection alone without a file selection, and null with neither', () => {
    expect([...effectiveContexts(doc, null, new Set([4, 1]))!].sort()).toEqual([1, 4])
    expect(effectiveContexts(doc, null, null)).toBeNull()
    expect(effectiveContexts(null, null, new Set([0]))!.has(0)).toBe(true)
  })
  it('no file selected lets nothing through', () => {
    expect(effectiveContexts(doc, new Set(), null)!.size).toBe(0)
    expect(contextsOfFiles(doc, new Set()).size).toBe(0)
  })
  it('contextsWithin drops the picked contexts outside the files', () => {
    expect([...contextsWithin(doc, new Set([0, 3]), new Set([0, 1]))!]).toEqual([0])
    expect(contextsWithin(doc, new Set([3]), new Set([0]))).toBeNull()
    expect([...contextsWithin(doc, new Set([3]), null)!]).toEqual([3])
    expect(contextsWithin(doc, null, new Set([0]))).toBeNull()
  })
})

describe('normalizeFiles', () => {
  it('turns "every file" into null and drops unknown indexes', () => {
    expect(normalizeFiles(doc, new Set([0, 1, 2, 3, 4]))).toBeNull()
    expect(normalizeFiles(doc, new Set([0, 1, 2, 3, 4, 9]))).toBeNull()
    expect([...normalizeFiles(doc, new Set([0, 9]))!]).toEqual([0])
    expect(normalizeFiles(doc, null)).toBeNull()
    expect(normalizeFiles(doc, new Set())!.size).toBe(0)
  })
})

describe('fileTree (PX grouping)', () => {
  it('lists a PX slave file right under its coordinator file', () => {
    expect(fileTree(doc)).toEqual([
      { idx: 0, depth: 0, parent: null }, { idx: 1, depth: 1, parent: 0 },
      { idx: 2, depth: 0, parent: null }, { idx: 3, depth: 1, parent: 2 },
      { idx: 4, depth: 0, parent: null }, // a slave with no coordinator in the set stays on top level
    ])
  })
  it('keeps plain files in input order and puts a slave under the coordinator most of its contexts attach to', () => {
    const d: FileSetDoc = {
      file: { files: [f(0), f(1), f(2, { px: true })] },
      contexts: [{ fileIdx: 0 }, { fileIdx: 1 }, { fileIdx: 2, px: true, parent: 1 }, { fileIdx: 2, px: true, parent: 1 }, { fileIdx: 2, px: true, parent: 0 }],
    }
    expect(fileTree(d).map((n) => [n.idx, n.depth])).toEqual([[0, 0], [1, 0], [2, 1]])
    expect(fileTree(d)[2].parent).toBe(1)
  })
  it('a single file is one row', () => {
    expect(fileTree({ file: {}, contexts: [{ fileIdx: 0 }] })).toEqual([{ idx: 0, depth: 0, parent: null }])
  })
})

describe('clicking files', () => {
  const order = [0, 1, 2, 3, 4]
  const click = (files: Set<number> | null, idx: number, anchor: number | null, mods: Partial<{ toggle: boolean; range: boolean }> = {}) =>
    [...clickFile(doc, files, order, idx, anchor, { toggle: false, range: false, ...mods })].sort()
  it('a plain click selects only that file', () => { expect(click(null, 2, null)).toEqual([2]) })
  it('ctrl/cmd toggles; from "all" it removes the file', () => {
    expect(click(null, 2, null, { toggle: true })).toEqual([0, 1, 3, 4])
    expect(click(new Set([0, 2]), 2, 0, { toggle: true })).toEqual([0])
    expect(click(new Set([0]), 3, 0, { toggle: true })).toEqual([0, 3])
  })
  it('shift extends from the last click over the rows in between', () => {
    expect(click(new Set([1]), 3, 1, { range: true })).toEqual([1, 2, 3])
    expect(click(new Set([4]), 2, 4, { range: true })).toEqual([2, 3, 4])
    expect(click(new Set([1]), 3, null, { range: true })).toEqual([3]) // no anchor: a plain click
  })
  it('invert and toggle helpers', () => {
    expect([...invert(doc, new Set([0, 1]))].sort()).toEqual([2, 3, 4])
    expect(invert(doc, null).size).toBe(0)
    expect([...toggleFile(doc, null, 1)].sort()).toEqual([0, 2, 3, 4])
  })
})

describe('files= URL parameter', () => {
  it('round trips', () => {
    for (const s of [new Set([0, 2]), new Set([3]), new Set([0, 1, 4])]) expect(parseFilesParam(formatFilesParam(s))).toEqual(s)
    expect(formatFilesParam(new Set([2, 0]))).toBe('0,2')
    expect(formatFilesParam(null)).toBe('')
  })
  it('accepts ranges and ignores junk', () => {
    expect([...parseFilesParam('1-3,5')!]).toEqual([1, 2, 3, 5])
    expect([...parseFilesParam('x,2,-1')!]).toEqual([2])
    expect(parseFilesParam('')).toBeNull()
    expect(parseFilesParam('abc')).toBeNull()
    expect(parseFilesParam(null)).toBeNull()
  })
})

describe('ctxKey', () => {
  it('keeps "no filter", "empty filter" and a filter apart (views key their queries on it)', () => {
    expect(ctxKey(null)).toBe('')
    expect(ctxKey(new Set())).toBe('none')
    expect(ctxKey(new Set([3, 1]))).toBe('1,3')
  })
})

describe('selectionSpan', () => {
  // files 0 (qc) 1000-5000, 1 (its PX slave) 2000-3000, 2 (another session) 6000-6500; contexts 0,1 in file 0, 2 in file 1, 3 in file 2
  const sd = {
    ...doc,
    file: { files: [f(0, { firstTim: 1000, lastTim: 5000 }), f(1, { px: true, firstTim: 2000, lastTim: 3000 }), f(2, { firstTim: 6000, lastTim: 6500 })] },
    contexts: [{ fileIdx: 0 }, { fileIdx: 0 }, { fileIdx: 1, px: true, parent: 0 }, { fileIdx: 2 }],
    span: { firstTim: 1000, lastTim: 7000 },
    stats: { contexts: [
      { context: 0, firstTim: 1100, lastTim: 4000 }, { context: 1, firstTim: 4200, lastTim: 4900 },
      { context: 2, firstTim: 2100, lastTim: 2900 }, { context: 3, firstTim: 6100, lastTim: 6400 },
    ] },
  }
  it('is the whole trace without a selection', () => {
    expect(selectionSpan(sd, null, null)).toEqual({ firstTim: 1000, lastTim: 7000 })
  })
  it('is the range of the selected files', () => {
    expect(selectionSpan(sd, new Set([2]), null)).toEqual({ firstTim: 6000, lastTim: 6500 })
    expect(selectionSpan(sd, new Set([0, 2]), null)).toEqual({ firstTim: 1000, lastTim: 6500 })
  })
  it('a PX slave file is its own range; with its coordinator file it is the union', () => {
    expect(selectionSpan(sd, new Set([1]), null)).toEqual({ firstTim: 2000, lastTim: 3000 })
    expect(selectionSpan(sd, new Set([0, 1]), null)).toEqual({ firstTim: 1000, lastTim: 5000 })
  })
  it('is the range of the picked contexts, within the selected files', () => {
    expect(selectionSpan(sd, null, new Set([1, 3]))).toEqual({ firstTim: 4200, lastTim: 6400 })
    expect(selectionSpan(sd, new Set([0]), new Set([1, 3]))).toEqual({ firstTim: 4200, lastTim: 4900 })
    expect(selectionSpan(sd, null, new Set([2]))).toEqual({ firstTim: 2100, lastTim: 2900 })
  })
  it('falls back to the files, then the whole trace, when the contexts have no times', () => {
    const bare = { ...sd, stats: { contexts: [] } }
    expect(selectionSpan(bare, new Set([2]), new Set([3]))).toEqual({ firstTim: 6000, lastTim: 6500 })
    expect(selectionSpan(bare, null, new Set([3]))).toEqual({ firstTim: 1000, lastTim: 7000 })
    expect(selectionSpan(sd, new Set(), null)).toEqual({ firstTim: 1000, lastTim: 7000 })
  })
})
