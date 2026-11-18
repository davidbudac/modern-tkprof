import { describe, expect, it, vi } from 'vitest'
import { memoryDiagSource, type DiagFile, type DiagNode, type DiagSource } from './diag'
import { DiagOutlineStore, nodeIn, outlineStoreOf } from './diagoutline'
import { syntheticDiag, SYN_PART, SYN_SECTION } from './diagsynth'
import { HAS_DIAG_FIXTURE, loadDiagFixture } from './diagfixture'
import { digestDiagSource } from './diagsource'

const node = (id: string, from: number, to: number, kids = false, extra: Partial<DiagNode> = {}): DiagNode => ({ id, kind: 'title', title: id, from, to, lines: to - from + 1, hasChildren: kids, ...extra })
const fileOf = (outline: DiagNode[], total = outline.length, lines = 1000): DiagFile => ({ name: 'f.trc', lines, release: '', version: '19.27', tested: true, records10046: 0, sections: [], unplaced: 0, outline, outlineTotal: total })

const ids = (s: DiagOutlineStore) => s.rows().map((r) => (r.t === 'node' ? r.node.id : `${r.t}:${r.parent}`))

describe('the outline store', () => {
  const top = [node('a', 1, 100, true), node('b', 101, 200, true), node('c', 201, 300)]
  const kids = { a: [node('a1', 1, 50, true), node('a2', 51, 100)], a1: [node('a1x', 1, 25), node('a1y', 26, 50)], b: [node('b1', 101, 200)] }
  const src = () => memoryDiagSource(fileOf(top, 3, 300), kids, ['x'])

  it('starts with the top level and loads the children of a node when it is opened', async () => {
    const s = new DiagOutlineStore(src())
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    await s.openNode('a')
    expect(ids(s)).toEqual(['a', 'a1', 'a2', 'b', 'c'])
    expect(s.isOpen('a')).toBe(true)
    await s.toggle('a')
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    expect(s.kidsOf('a')?.nodes).toHaveLength(2) // closed, not forgotten
    await s.toggle('a')
    expect(ids(s)).toEqual(['a', 'a1', 'a2', 'b', 'c'])
  })

  it('asks the source once for a node however often it is opened, and shows a note while it is on its way', async () => {
    const source = src()
    const outline = vi.spyOn(source, 'outline')
    const s = new DiagOutlineStore(source)
    const p1 = s.openNode('a')
    expect(s.rows().map((r) => r.t)).toEqual(['node', 'note', 'node', 'node'])
    const p2 = s.openNode('a')
    await Promise.all([p1, p2])
    s.closeNode('a')
    await s.openNode('a')
    expect(outline).toHaveBeenCalledTimes(1)
  })

  it('does not open a node without children', async () => {
    const s = new DiagOutlineStore(src())
    await s.openNode('c')
    expect(s.isOpen('c')).toBe(false)
  })

  it('keeps a failure on the node and asks again the next time', async () => {
    let fail = true
    const source: DiagSource = { ...src(), outline: (id, after) => (fail ? Promise.reject(new Error('503 down')) : src().outline(id, after)) }
    const s = new DiagOutlineStore(source)
    await s.openNode('a')
    const r = s.rows()
    expect(r[1]).toMatchObject({ t: 'note', error: true, text: '503 down' })
    fail = false
    s.closeNode('a')
    await s.openNode('a')
    expect(ids(s)).toEqual(['a', 'a1', 'a2', 'b', 'c'])
  })

  it('expands the loaded nodes to a depth and collapses to the way to a node', async () => {
    const s = new DiagOutlineStore(src())
    await s.expand(3)
    expect(ids(s)).toEqual(['a', 'a1', 'a1x', 'a1y', 'a2', 'b', 'b1', 'c'])
    await s.expand(1)
    s.collapse('a1y')
    expect(ids(s)).toEqual(['a', 'a1', 'a1x', 'a1y', 'a2', 'b', 'c']) // a and a1 hold a1y, so both are open
  })

  it('finds the nodes that hold a line, as far as they are loaded', async () => {
    const s = new DiagOutlineStore(src())
    expect(s.pathAt(30).map((n) => n.id)).toEqual(['a'])
    await s.expand(3)
    expect(s.pathAt(30).map((n) => n.id)).toEqual(['a', 'a1', 'a1y'])
    expect(s.nodeAt(75)?.id).toBe('a2')
    expect(s.nodeAt(250)?.id).toBe('c')
    expect(s.pathAt(0)).toEqual([])
    expect(s.pathAt(5000)).toEqual([])
    expect(s.pathTo('a1y').map((n) => n.id)).toEqual(['a', 'a1', 'a1y'])
    expect(s.pathTo('nope')).toEqual([])
  })

  it('opens the ancestors of a node to show its row', async () => {
    const s = new DiagOutlineStore(src())
    await s.expand(3)
    s.collapse()
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    s.revealNode('a1y')
    expect(ids(s)).toEqual(['a', 'a1', 'a1x', 'a1y', 'a2', 'b', 'c'])
  })

  it('lists the first line of every loaded node with its depth, the shallowest where nodes start on one line', async () => {
    const s = new DiagOutlineStore(src())
    await s.expand(3)
    const h = s.headings()
    expect(h.get(1)).toBe(0) // a, a1 and a1x all start at line 1
    expect(h.get(26)).toBe(2)
    expect(h.get(51)).toBe(1)
    expect(h.get(201)).toBe(0)
    expect(h.get(2)).toBeUndefined()
  })

  it('opens the sections of a file with few of them at first sight, and none of a file with many', async () => {
    const few = new DiagOutlineStore(src())
    await few.openFirst()
    expect(ids(few)).toEqual(['a', 'a1', 'a2', 'b', 'b1', 'c'])
    const many = Array.from({ length: 5 }, (_, i) => node(`m${i}`, i * 10 + 1, i * 10 + 10, true))
    const s = new DiagOutlineStore(memoryDiagSource(fileOf(many), {}, ['x']))
    await s.openFirst()
    expect(ids(s)).toEqual(many.map((n) => n.id))
  })

  it('notifies subscribers when something changes', async () => {
    const s = new DiagOutlineStore(src())
    const fn = vi.fn()
    const off = s.subscribe(fn)
    const v = s.getVersion()
    await s.openNode('a')
    expect(fn).toHaveBeenCalled()
    expect(s.getVersion()).toBeGreaterThan(v)
    off()
    fn.mockClear()
    s.closeNode('a')
    expect(fn).not.toHaveBeenCalled()
  })

  it('keeps one store per source', () => {
    const source = src()
    expect(outlineStoreOf(source)).toBe(outlineStoreOf(source))
    expect(outlineStoreOf(src())).not.toBe(outlineStoreOf(source))
  })
})

describe('paging', () => {
  const syn = syntheticDiag(5_000_000) // 5,000 sections: 2,000 in the file's outline, the rest a page away

  it('shows "N of M shown · load more" and loads the next page with `after`', async () => {
    const s = new DiagOutlineStore(syn.source)
    let r = s.rows()
    expect(r).toHaveLength(2001)
    expect(r.at(-1)).toMatchObject({ t: 'more', parent: 'root', shown: 2000, total: 5000 })
    await s.loadMore('root')
    r = s.rows()
    expect(r).toHaveLength(4001)
    expect(r.at(-1)).toMatchObject({ t: 'more', shown: 4000, total: 5000 })
    await s.loadMore('root')
    expect(s.rows()).toHaveLength(5000)
    expect(s.rows().at(-1)).toMatchObject({ t: 'node' })
    expect(s.kidsOf('root')?.more).toBe(0)
  })

  it('asks for the page after the ones it has, whatever the page size', async () => {
    const calls: [string, number | undefined][] = []
    const source: DiagSource = { ...syn.source, outline: (id, after) => { calls.push([id, after]); return syn.source.outline(id, after) } }
    const s = new DiagOutlineStore(source)
    await s.loadMore('root')
    await s.loadMore('root')
    expect(calls).toEqual([['root', 2000], ['root', 4000]])
  })

  it('pages the children of an opened node the same way', async () => {
    const many = Array.from({ length: 7 }, (_, i) => node(`k${i}`, i * 10 + 1, i * 10 + 10))
    const source = memoryDiagSource(fileOf([node('p', 1, 70, true)], 1, 70), { p: many }, ['x'], { pageSize: 3 })
    const s = new DiagOutlineStore(source)
    await s.openNode('p')
    expect(s.rows().at(-1)).toMatchObject({ t: 'more', parent: 'p', shown: 3, total: 7 })
    await s.loadMore('p')
    await s.loadMore('p')
    expect(ids(s)).toEqual(['p', ...many.map((n) => n.id)])
  })

  it('holds a hundred thousand lines of a node, not the file: only what was asked for is loaded', async () => {
    const s = new DiagOutlineStore(syn.source)
    expect(s.loaded).toBe(2000)
    await s.openNode('syn:0')
    expect(s.loaded).toBe(2000 + SYN_SECTION / SYN_PART)
    expect(s.nodeAt(250)?.id).toBe('syn:0:2')
    expect(s.nodeAt(SYN_SECTION * 3000)?.id).toBeUndefined() // a section of the second page: not loaded
    await s.loadMore('root')
    await s.loadMore('root')
    expect(s.nodeAt(SYN_SECTION * 3000)?.id).toBe('syn:2999')
  })
})

describe('the standalone report (the digest)', () => {
  const top = [node('a', 1, 100, true), node('b', 101, 200, true), node('c', 201, 300)]
  const digest = { outline: [{ ...top[0], children: [node('a1', 1, 50, true), node('a2', 51, 100)] }, { ...top[1], children: [node('b1', 101, 150)], more: 40 }, { ...top[2], children: [] }] }
  const source = digestDiagSource({ file: fileOf(top, 3, 300), digest })

  it('shows what the digest holds without asking for it', () => {
    const s = new DiagOutlineStore(source)
    expect(s.kidsOf('a')?.nodes.map((n) => n.id)).toEqual(['a1', 'a2'])
  })

  it('says how many children it does not hold, and refuses a node below the digest\'s depth in words', async () => {
    const s = new DiagOutlineStore(source)
    await s.openNode('b')
    expect(s.rows().at(-2)).toMatchObject({ t: 'note', text: '40 more not in this report' })
    await s.openNode('a')
    await s.openNode('a1')
    const r = s.rows()
    const note = r[r.findIndex((x) => x.t === 'node' && x.node.id === 'a1') + 1]
    expect(note).toMatchObject({ t: 'note' })
    expect((note as { text: string }).text).toMatch(/not in it/)
  })
})

describe('on a real file', () => {
  it.skipIf(!HAS_DIAG_FIXTURE)('the errorstack: the top level tiles the file, its parts lie inside their node, and a line finds its path', async () => {
    const f = loadDiagFixture()
    const s = new DiagOutlineStore(f.source())
    await s.expand(3)
    // the top level tiles the file
    const top = s.top()
    expect(top[0].from).toBe(1)
    expect(top.at(-1)!.to).toBe(f.file.lines)
    for (let i = 1; i < top.length; i++) expect(top[i].from).toBe(top[i - 1].to + 1)
    // every loaded node lies inside its parent
    for (const r of s.rows()) {
      if (r.t !== 'node') continue
      const p = s.parentOf(r.node.id)
      if (p) { const pn = s.node(p)!; expect(r.node.from).toBeGreaterThanOrEqual(pn.from); expect(r.node.to).toBeLessThanOrEqual(pn.to) }
    }
    const stack = s.nodeAt(54)
    expect(stack?.title).toBe('Call Stack Trace')
    expect(s.pathAt(54).map((n) => n.title)).toEqual(['Diagnostic dump (level 2)', 'Call Stack Trace'])
    expect(s.headings().get(50)).toBe(1)
    expect(s.headings().get(32)).toBe(0)
  })
})

describe('nodeIn', () => {
  it('finds the node of a sorted, non-overlapping list that holds a line', () => {
    const l = [node('a', 1, 10), node('b', 11, 20), node('c', 31, 40)]
    expect(nodeIn(l, 1)?.id).toBe('a')
    expect(nodeIn(l, 10)?.id).toBe('a')
    expect(nodeIn(l, 11)?.id).toBe('b')
    expect(nodeIn(l, 25)).toBeUndefined()
    expect(nodeIn(l, 40)?.id).toBe('c')
    expect(nodeIn([], 1)).toBeUndefined()
  })
})
