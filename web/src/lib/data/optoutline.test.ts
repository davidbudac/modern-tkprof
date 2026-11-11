import { describe, expect, it } from 'vitest'
import { storeAnnotations } from './opt'
import { indexDump } from './optindex'
import { currentNode, dumpLabel, nodeKey, ordinal, outlineNodes } from './optoutline'
import { HAS_FIXTURE, loadFixture } from './optfixture'

describe('the dump list', () => {
  it('says "dump N", and the nth of a sql_id that repeats', () => {
    expect(dumpLabel({ idx: 0, nth: 1, sqlId: 'a' }, false)).toBe('dump 1')
    expect(dumpLabel({ idx: 2, nth: 2, sqlId: 'a' }, true)).toBe('dump 3 · #2')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd'])
  })
})

describe.skipIf(!HAS_FIXTURE)('the outline of the fixture', () => {
  const f = loadFixture()
  const ix = indexDump(f.dumps[1])
  const open = (...ids: string[]) => new Set(ids.map((id) => nodeKey(1, id)))

  it('lists the children of the open nodes in file order, full depth', () => {
    const phases = ix.root.kids.map((n) => n.id)
    const closed = outlineNodes(ix, open(), 'all')
    expect(closed.map((x) => x.n.id)).toEqual(phases)
    expect(closed.every((x) => x.depth === 1)).toBe(true)
    const cost = ix.phases.find((n) => n.kind === 'phase-cost')!
    const run = cost.kids.find((n) => n.kind === 'run')!
    const deeper = outlineNodes(ix, open(cost.id, run.id), 'all')
    expect(deeper.length).toBe(phases.length + cost.kids.length + run.kids.length)
    const lines = deeper.map((x) => x.n.from)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
    expect(deeper.find((x) => x.n.id === run.kids[0].id)!.depth).toBe(3)
  })

  it('Runs lists the runs alone, in file order', () => {
    const runs = outlineNodes(ix, open(), 'runs')
    expect(runs).toHaveLength(14)
    expect(runs.every((x) => x.n.kind === 'run' && x.depth === 1)).toBe(true)
    expect(runs.map((x) => x.n.n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1))
    // the runs of identical text carry the number of the earlier run
    expect(runs.filter((x) => x.n.sameAs).map((x) => [x.n.n, x.n.sameAs])).toEqual([[5, 1], [6, 2], [11, 7], [12, 8]])
  })

  it('marks the deepest node of the chain that the outline shows', () => {
    const jo = ix.nodes.find((n) => n.kind === 'join-order' && n.n === 3 && n.from > 24000)!
    const run = jo.parent!.parent!
    const all = outlineNodes(ix, open(), 'all')
    expect(currentNode(ix, new Set(all.map((x) => x.n.id)), jo.from)).toBe(ix.root.kids.find((p) => p.from <= jo.from && jo.from <= p.to)!.id)
    const shown = outlineNodes(ix, new Set([...ix.nodes.map((n) => nodeKey(1, n.id))]), 'all')
    expect(currentNode(ix, new Set(shown.map((x) => x.n.id)), jo.from)).toBe(jo.id)
    expect(run.kind).toBe('run')
    expect(currentNode(ix, new Set(), jo.from)).toBeNull()
  })

  it('a join order carries its result text and which one is the best', () => {
    const orders = ix.nodes.filter((n) => n.kind === 'join-order' && n.parent?.parent?.n === 14)
    expect(orders.length).toBeGreaterThan(2)
    expect(orders.filter((n) => n.isBest)).toHaveLength(1)
    expect(orders.every((n) => n.result === 'aborted' || /^cost: [\d.]+$/.test(n.result ?? ''))).toBe(true)
  })
})

describe('bookmarks over the lib\'s store', () => {
  it('maps the bookmarks of one file and calls the store\'s actions', () => {
    const calls: unknown[][] = []
    const actions = {
      addBookmark: (...a: unknown[]) => { calls.push(['add', ...a]) },
      setBookmarkNote: (...a: unknown[]) => { calls.push(['note', ...a]) },
      removeBookmark: (...a: unknown[]) => { calls.push(['remove', ...a]) },
    }
    const a = storeAnnotations([{ file: 0, line: 5, label: 'x', note: 'n' }, { file: 1, line: 9, label: '' }, { file: 0, line: 7, label: '' }], 0, actions, (l) => `line ${l}`)
    expect([...a.bookmarks]).toEqual([[5, 'n'], [7, '']])
    a.toggle(5)
    a.toggle(6)
    a.setNote(7, 'hello')
    a.remove(7)
    expect(calls).toEqual([['remove', 0, 5], ['add', 0, 6, 'line 6'], ['note', 0, 7, 'hello', 'line 7'], ['remove', 0, 7]])
  })
})
