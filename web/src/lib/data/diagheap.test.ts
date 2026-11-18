import { describe, expect, it } from 'vitest'
import { memoryDiagSource, type DiagFile } from './diag'
import {
  applyPage, checkText, checkTone, commentRows, flagNotes, heapTree, histLayout, loadMoreChunks, newSel, ReadingUi, readingUiOf, selectRow, selLine, shareOf, shareText, sizeLabel, sortRows, stepKind, stepperText, stepTo,
  toggleSort, typeRows, typesText, type ChunkSel, type SelHost,
} from './diagheap'
import { normalizeHeap, type HeapCheck, type HeapLines, type HeapRun } from './diagreadings'
import { HAS_READINGS_FIXTURE, loadReadingFixtures } from './diagreadingsfixture'

const file: DiagFile = { name: 'h.trc', lines: 10, release: '', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [], outlineTotal: 0 }

describe('sorting', () => {
  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: 10 }, { n: 'c', v: 2 }, { n: 'd', v: undefined as number | undefined }]
  const get = { n: (r: (typeof rows)[number]) => r.n, v: (r: (typeof rows)[number]) => r.v }

  it('sorts numbers and text both ways, keeps ties in the order they came in and puts missing values last either way', () => {
    expect(sortRows(rows, { col: 'v', dir: -1 }, get).map((r) => r.n)).toEqual(['a', 'b', 'c', 'd'])
    expect(sortRows(rows, { col: 'v', dir: 1 }, get).map((r) => r.n)).toEqual(['b', 'c', 'a', 'd'])
    expect(sortRows(rows, { col: 'n', dir: 1 }, get).map((r) => r.n)).toEqual(['a', 'b', 'c', 'd'])
    expect(sortRows(rows, { col: 'n', dir: -1 }, get).map((r) => r.n)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('compares text with numbers inside it as numbers and does not change its input; an unknown column leaves the order', () => {
    const x = [{ n: 'bucket 10' }, { n: 'bucket 9' }, { n: 'Bucket 2' }]
    expect(sortRows(x, { col: 'n', dir: 1 }, { n: (r) => r.n }).map((r) => r.n)).toEqual(['Bucket 2', 'bucket 9', 'bucket 10'])
    expect(x.map((r) => r.n)).toEqual(['bucket 10', 'bucket 9', 'bucket 2'.replace('b', 'B')])
    expect(sortRows(x, { col: '', dir: 1 }, {}).map((r) => r.n)).toEqual(['bucket 10', 'bucket 9', 'Bucket 2'])
  })

  it('flips the column that is sorted and starts another in the direction asked', () => {
    expect(toggleSort({ col: 'bytes', dir: -1 }, 'bytes')).toEqual({ col: 'bytes', dir: 1 })
    expect(toggleSort({ col: 'bytes', dir: 1 }, 'bytes')).toEqual({ col: 'bytes', dir: -1 })
    expect(toggleSort({ col: 'bytes', dir: -1 }, 'comment', 1)).toEqual({ col: 'comment', dir: 1 })
    expect(toggleSort({ col: 'comment', dir: 1 }, 'chunks')).toEqual({ col: 'chunks', dir: -1 })
  })

  it('prints a share with the precision its size needs', () => {
    expect(shareText(0.755)).toBe('75.5%')
    expect(shareText(0.0834)).toBe('8.34%')
    expect(shareText(0.0105)).toBe('1.05%')
    expect(shareText(0.0004)).toBe('<0.1%')
    expect(shareText(0)).toBe('0%')
    expect(shareOf(5, 0)).toBe(0)
    expect(shareOf(5, 4)).toBe(1)
  })
})

describe('the heap tree', () => {
  const run = (node: string, parent: string | undefined, name = node): HeapRun => ({ node, name, desc: `0x${node}`, ...(parent ? { parent } : null), size: 10, from: 1, to: 2 })
  // a, b are top heaps; a has c, d, e; d has f, g; f has h
  const all = [run('a', undefined), run('c', 'a'), run('d', 'a'), run('f', 'd'), run('h', 'f'), run('g', 'd'), run('e', 'a'), run('b', undefined)]

  it('shows the ancestors (the root first), the siblings with the heap itself among them and the heap\'s children, not the whole run', () => {
    const r = heapTree(all, 'd')
    expect(r.map((x) => [x.run.node, x.depth, x.role])).toEqual([['a', 0, 'ancestor'], ['c', 1, 'sibling'], ['d', 1, 'self'], ['f', 2, 'child'], ['g', 2, 'child'], ['e', 1, 'sibling']])
    expect(r.some((x) => x.run.node === 'h')).toBe(false)
  })

  it('shows every ancestor of a deep heap and the other top heaps beside a top heap', () => {
    expect(heapTree(all, 'h').map((x) => [x.run.node, x.depth, x.role])).toEqual([['a', 0, 'ancestor'], ['d', 1, 'ancestor'], ['f', 2, 'ancestor'], ['h', 3, 'self']])
    expect(heapTree(all, 'a').map((x) => [x.run.node, x.depth, x.role])).toEqual([['a', 0, 'self'], ['c', 1, 'child'], ['d', 1, 'child'], ['e', 1, 'child'], ['b', 0, 'sibling']])
  })

  it('is empty for a heap that is not in the run, and survives a parent cycle', () => {
    expect(heapTree(all, 'zz')).toEqual([])
    expect(heapTree([run('x', 'y'), run('y', 'x')], 'x').map((r) => r.run.node)).toEqual(['y', 'x'])
  })
})

describe('the check', () => {
  const c = (state: HeapCheck['state'], extra: Partial<HeapCheck> = {}): HeapCheck => ({ name: 'heap', what: 'w', state, computed: 100, ...extra })

  it('is green when the checks that could be made match, red when one differs, neutral when none could be made', () => {
    expect(checkTone([c('match'), c('match', { name: 'free' })])).toBe('ok')
    expect(checkTone([c('match'), c('none', { name: 'free' })])).toBe('ok')
    expect(checkTone([c('match'), c('differ', { name: 'free', printed: 90, diff: 10 })])).toBe('bad')
    expect(checkTone([c('none'), c('none')])).toBe('none')
    expect(checkTone([])).toBe('none')
  })

  it('says each check in words: the sum and the line it matches, the difference of a differing one, the reason of one that was not made', () => {
    expect(checkText(c('match', { computed: 4707160, line: 679 }), (n) => n.toLocaleString('en-US'))).toEqual({ state: 'match', head: 'Chunks sum to', sum: 4707160, tail: " bytes: matches the dump's Total heap size.", line: 679 })
    expect(checkText(c('differ', { name: 'free', computed: 120, printed: 100, diff: 20, line: 5 }), String)).toMatchObject({ head: 'Free-list chunks sum to', tail: " bytes: the dump's Total free space says 100, a difference of +20.", line: 5 })
    expect(checkText(c('differ', { name: 'perm', computed: 80, printed: 100, diff: -20 }), String).tail).toContain('a difference of -20')
    expect(checkText(c('none', { name: 'perm', reason: 'the heap has no extents' }), String)).toMatchObject({ head: 'Permanent chunks against Permanent space:', tail: ' not checked: the heap has no extents.' })
    expect(checkText(c('none', { name: 'free', reason: 'no extents' }), String, true).tail).toBe(' not checked, for the same reason.')
    expect(checkText(c('match', { name: 'reserved' }), String).head).toBe('Reserved free-list chunks sum to')
    expect(checkText(c('match', { name: 'other', what: 'things against a total' }), String).head).toBe('things against a total sum to')
  })
})

describe('the types of a comment', () => {
  it('shows the biggest and how many more, the whole list as the tooltip', () => {
    expect(typesText([{ type: 'freeable', chunks: 3, bytes: 30 }, { type: 'recreate', chunks: 1, bytes: 5 }])).toEqual({ text: 'freeable +1', title: 'freeable: 3 chunks, 30 bytes\nrecreate: 1 chunks, 5 bytes' })
    expect(typesText([{ type: 'perm', chunks: 1, bytes: 1 }]).text).toBe('perm')
    expect(typesText([]).text).toBe('')
  })
})

describe('the stepper over the chunk lines of a selected row', () => {
  const all = Array.from({ length: 7 }, (_, i) => 100 + i * 10) // 7 chunk lines, pages of 3
  const page = (after: number): HeapLines => {
    const rest = all.filter((l) => l > after)
    const lines = rest.slice(0, 3)
    const more = rest.length - lines.length
    return { node: 'n', lines, more, total: all.length, ...(more > 0 ? { next: lines[lines.length - 1] } : null) }
  }
  const asked: unknown[] = []
  const source = memoryDiagSource(file, {}, ['x'], { readingLines: (_n, q) => { asked.push(q); return page(q.after ?? 0) } })
  const hostOf = (): SelHost & { cur: ChunkSel | null; marks: number } => {
    const h = { cur: null as ChunkSel | null, marks: 0, sel: () => h.cur, set: (s: ChunkSel | null) => { h.cur = s; h.marks++ } }
    return h
  }

  it('selects a row, loads its first page and sits on the first chunk: "1 / 7 · line 100"', async () => {
    const host = hostOf()
    const p = selectRow(source, 'n', host, { key: 'c:koh', label: 'koh', comment: 'koh' })
    expect(host.cur).toMatchObject({ key: 'c:koh', loading: true, lines: [] })
    expect(stepKind(host.cur!, 1)).toBe('none')
    await p
    expect(host.cur).toMatchObject({ lines: [100, 110, 120], total: 7, more: 4, next: 120, i: 0, loading: false })
    expect(stepperText(host.cur!, String)).toBe('1 / 7 · line 100')
    expect(selLine(host.cur!)).toBe(100)
    expect(asked.at(-1)).toEqual({ comment: 'koh' })
  })

  it('steps within the loaded lines, never before the first, and at the last loaded one loads the next page with `after`', async () => {
    const host = hostOf()
    await selectRow(source, 'n', host, { key: 'c:koh', label: 'koh', comment: 'koh' })
    expect(stepKind(host.cur!, -1)).toBe('none')
    host.cur = stepTo(host.cur!, 1)
    host.cur = stepTo(host.cur!, 1)
    expect(selLine(host.cur)).toBe(120)
    expect(stepKind(host.cur, 1)).toBe('load')
    expect(stepTo(host.cur, 1)).toBe(host.cur)
    await loadMoreChunks(source, 'n', host, true)
    expect(asked.at(-1)).toEqual({ comment: 'koh', after: 120 })
    expect(host.cur).toMatchObject({ lines: [100, 110, 120, 130, 140, 150], more: 1, next: 150, i: 3 })
    expect(stepperText(host.cur!, String)).toBe('4 / 7 · line 130')
    host.cur = { ...host.cur!, i: 5 }
    await loadMoreChunks(source, 'n', host, true)
    expect(host.cur).toMatchObject({ lines: all, more: 0, i: 6 })
    expect(stepKind(host.cur!, 1)).toBe('none')
    expect(stepKind(host.cur!, -1)).toBe('step')
    await loadMoreChunks(source, 'n', host)
    expect(host.cur!.lines).toEqual(all)
  })

  it('selecting the selected row again clears it; a type is asked for by type, the blank comment by an empty comment', async () => {
    const host = hostOf()
    await selectRow(source, 'n', host, { key: 't:recr', label: 'recr', type: 'recr' })
    expect(asked.at(-1)).toEqual({ type: 'recr' })
    await selectRow(source, 'n', host, { key: 't:recr', label: 'recr', type: 'recr' })
    expect(host.cur).toBeNull()
    await selectRow(source, 'n', host, { key: 'c:', label: '', comment: '' })
    expect(asked.at(-1)).toEqual({ comment: '' })
  })

  it('drops the answer of a selection that was replaced meanwhile, and says it when the lines cannot be had', async () => {
    const host = hostOf()
    const slow = memoryDiagSource(file, {}, ['x'], { readingLines: () => page(0) })
    const first = selectRow(slow, 'n', host, { key: 'c:a', label: 'a', comment: 'a' })
    host.cur = newSel({ key: 'c:b', label: 'b', comment: 'b' }) // another row was chosen while the first was on its way
    await first
    expect(host.cur).toMatchObject({ key: 'c:b', loading: true, lines: [] })
    const none = memoryDiagSource(file, {}, ['x'])
    const h2 = hostOf()
    await selectRow(none, 'n', h2, { key: 'c:a', label: 'a', comment: 'a' })
    expect(h2.cur).toMatchObject({ loading: false, error: 'this source has no chunk lines' })
  })

  it('merges a page into the selection: the next page after the lines already there', () => {
    const s = applyPage(newSel({ key: 'k', label: 'l' }), { node: 'n', lines: [1, 2], more: 1, next: 2, total: 3 }, false)
    expect(applyPage(s, { node: 'n', lines: [5], more: 0, total: 3 }, true)).toMatchObject({ lines: [1, 2, 5], more: 0, next: 0 })
  })
})

describe('the free-list histogram', () => {
  const bk = (n: number, size: number, chunks: number, bytes: number) => ({ n, size, chunks, bytes })

  it('draws a bar per bucket to the largest, a hairline for an empty one, the chunk count under wide bars and a size label under every few', () => {
    const h = histLayout([bk(0, 56, 2, 112), bk(1, 88, 0, 0), bk(2, 2048, 1, 56), bk(3, 1048576, 1, 224)], 480, 54)
    expect(h.bw).toBe(22)
    expect(h.bars.map((b) => Math.round(b.h))).toEqual([27, 0, 14, 54])
    expect(h.bars.map((b) => b.count)).toEqual([true, true, true, true])
    expect(h.bars[0].label).toBe('56')
    expect(h.bars[1].label).toBe('')
    expect(h.bars[2].label).toBe('2k')
    expect(histLayout(Array.from({ length: 100 }, (_, i) => bk(i, i * 100, 1, 10))).bars.filter((b) => b.label).length).toBeLessThan(40)
    expect(histLayout(Array.from({ length: 100 }, (_, i) => bk(i, i, 1, 10))).bars[0].count).toBe(false)
    expect(histLayout([]).bars).toEqual([])
  })

  it('labels the size of a bucket as the dump counts it', () => {
    expect([56, 1024, 1536, 16384, 1048576, 4194304, 1572864].map(sizeLabel)).toEqual(['56', '1k', '1.5k', '16k', '1m', '4m', '1.5m'])
  })
})

describe('what a reading keeps', () => {
  it('keeps a state per node until it is replaced, and tells the subscribers; the marks are cleared with an empty list', () => {
    const ui = new ReadingUi()
    let n = 0
    ui.subscribe(() => n++)
    const a = ui.get('x', () => ({ tab: 'comment' }))
    expect(ui.get('x', () => ({ tab: 'other' }))).toBe(a)
    ui.set('x', { tab: 'type' })
    expect(ui.get('x', () => ({ tab: 'comment' }))).toEqual({ tab: 'type' })
    expect(ui.get('y', () => ({ tab: 'comment' }))).toEqual({ tab: 'comment' })
    const lines = [3, 5]
    ui.setMarks('x', lines)
    expect(ui.marksOf('x')).toBe(lines)
    expect(ui.marksOf('y')).toBeNull()
    expect(ui.marksOf(null)).toBeNull()
    const v = ui.getVersion()
    ui.setMarks('x', lines)
    expect(ui.getVersion()).toBe(v)
    ui.setMarks('x', [])
    expect(ui.marksOf('x')).toBeNull()
    expect(n).toBe(3)
  })

  it('is one per source', () => {
    const s = {}
    expect(readingUiOf(s)).toBe(readingUiOf(s))
    expect(readingUiOf(s)).not.toBe(readingUiOf({}))
  })
})

describe.skipIf(!HAS_READINGS_FIXTURE)('on the engine\'s readings', () => {
  const fx = loadReadingFixtures()

  it('gives every comment of the pga heap a share of the chunks\' bytes, and the types add up to the heap', () => {
    const h = normalizeHeap(fx.heapPga.reading)
    const rows = commentRows(h)
    expect(rows[0]).toMatchObject({ comment: 'koh-kghu call', chunks: 160, bytes: 3555464 })
    expect(rows[0].share).toBeCloseTo(0.755, 3)
    expect(typeRows(h).reduce((s, r) => s + r.bytes, 0)).toBe(h.bytes)
    expect(sortRows(rows, { col: 'chunks', dir: 1 }, { chunks: (r) => r.chunks })[0].chunks).toBeLessThanOrEqual(rows[0].chunks)
  })

  it('has the check of the pga heap green, the PDB-filtered heap neutral with the reasons, and says what limits the PDB-filtered one', () => {
    const h = normalizeHeap(fx.heapPga.reading)
    expect(h.checks.map((c) => c.state)).toEqual(['match', 'match', 'match'])
    expect(checkTone(h.checks)).toBe('ok')
    const p = normalizeHeap(fx.heapPdb.reading)
    expect(checkTone(p.checks)).toBe('none')
    expect(flagNotes(p, String)[0]).toContain('PDB 3')
    expect(checkText(p.checks[0], String).tail).toContain('only chunks clearly belonging to pdb id 3')
  })

  it('picks the pga heap\'s sub-heap\'s neighbours for its tree', () => {
    const koh = normalizeHeap(fx.heapKoh.reading)
    const t = heapTree(koh.run, koh.node)
    expect(t[0]).toMatchObject({ role: 'ancestor' })
    expect(t.filter((r) => r.role === 'self')).toHaveLength(1)
    expect(t.length).toBeLessThan(koh.run.length + 1)
    expect(t.filter((r) => r.role === 'sibling').length).toBeGreaterThan(2)
  })
})
