import { beforeEach, describe, expect, it, vi } from 'vitest'

const entries = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../platform', () => ({ openKV: async () => ({
  get: async (key: string) => entries.get(key),
  set: async (key: string, value: unknown) => { entries.set(key, value) },
  delete: async (key: string) => { entries.delete(key) },
  keys: async () => [...entries.keys()],
}) }))
import { exportAnnotations, importAnnotations, saveNotes } from './annotations'

beforeEach(() => entries.clear())
describe('investigation annotation persistence', () => {
  const note = (id: string, updated: number) => ({ id, kind: 'window' as const, note: id, from: 1, to: 2, created: 1, updated })
  it('merges newer entries and preserves unrelated traces and metadata', async () => {
    entries.set('a', { notes: [note('same', 10), note('local', 1)], bookmarks: [{ file: 0, line: 1, label: 'local', updated: 10 }], other: 'retain' })
    entries.set('unrelated', { notes: [note('other', 1)] })
    await importAnnotations({ a: { notes: [note('same', 2), note('new', 3)], bookmarks: [{ file: 0, line: 1, label: 'old', updated: 1 }, { file: 0, line: 2, label: 'new' }] } })
    const exported = await exportAnnotations()
    expect(exported.a.notes?.map((n) => [n.id, n.updated])).toEqual([['local', 1], ['new', 3], ['same', 10]])
    expect(exported.a.bookmarks?.map((b) => b.label)).toEqual(['local', 'new'])
    expect(exported.a.other).toBe('retain')
    expect(exported.unrelated.notes).toEqual([note('other', 1)])
  })
  it('serializes imports behind pending note edits', async () => {
    const edit = saveNotes('a', [note('edit', 3)])
    const imported = importAnnotations({ a: { notes: [note('import', 4)] } })
    await Promise.all([edit, imported])
    expect((await exportAnnotations()).a.notes?.map((n) => n.id)).toEqual(['edit', 'import'])
  })
})
