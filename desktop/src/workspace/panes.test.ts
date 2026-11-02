import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergePanes, parsePanes } from './panes'

// an in-memory workspace.json
const store = new Map<string, unknown>()
vi.mock('../platform', () => ({
  openKV: async () => ({
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))),
    delete: async (k: string) => void store.delete(k),
    keys: async () => [...store.keys()],
  }),
  logInfo: () => {},
}))

const { Workspace } = await import('./workspace')
const set = { paths: ['/t/a.trc', '/t/b.trc'], options: { binds: 'keep' as const } }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('parsePanes', () => {
  it('has none for an old entry', () => {
    expect(parsePanes({ title: 't', set, files: [0, 1] })).toBeUndefined()
    expect(parsePanes(undefined)).toBeUndefined()
    expect(parsePanes('x')).toBeUndefined()
  })
  it('reads the flags and widths', () => {
    expect(parsePanes({ filesOpen: false, filesW: 301.4, inspectorOpen: true, inspectorW: 420, contextOpen: false, assistantOpen: true, assistantW: 380.6 })).toEqual({
      filesOpen: false, filesW: 301, inspectorOpen: true, inspectorW: 420, contextOpen: false, assistantOpen: true, assistantW: 381,
    })
  })
  it('ignores values of the wrong type or out of range', () => {
    expect(parsePanes({ filesOpen: 'no', filesW: -5, inspectorW: NaN, inspectorOpen: 1, contextOpen: null, assistantOpen: 'yes', assistantW: 20 })).toBeUndefined()
    expect(parsePanes({ filesW: 5e6, contextOpen: false })).toEqual({ contextOpen: false })
  })
})

describe('mergePanes', () => {
  it('sets, replaces and resets fields', () => {
    let p = mergePanes(undefined, { filesOpen: false, filesW: 300 })
    expect(p).toEqual({ filesOpen: false, filesW: 300 })
    p = mergePanes(p, { filesOpen: true, inspectorOpen: false })
    expect(p).toEqual({ filesOpen: true, filesW: 300, inspectorOpen: false })
    p = mergePanes(p, { filesW: undefined })
    expect(p).toEqual({ filesOpen: true, inspectorOpen: false })
    expect(mergePanes({ filesOpen: true }, { filesOpen: undefined })).toBeUndefined()
  })
})

describe('workspace.json', () => {
  beforeEach(() => store.clear())

  it('keeps a tab\'s panes and restores them', async () => {
    const a = new Workspace()
    const k = a.open(set, true, false, [1])
    a.setPanes(k, { filesOpen: false, inspectorOpen: false, contextOpen: false })
    a.setPanes(k, { inspectorW: 420 })
    await new Promise((r) => setTimeout(r, 400)) // the width settles
    await flush()
    expect(store.get('open')).toEqual([{ title: 'a.trc (+1)', set, files: [1], filesOpen: false, inspectorOpen: false, contextOpen: false, inspectorW: 420 }])

    const b = new Workspace()
    await b.restore({ startEmpty: false })
    const t = b.getSnapshot().tabs[0]
    expect(t.fileSel).toEqual([1])
    expect(t.panes).toEqual({ filesOpen: false, inspectorOpen: false, contextOpen: false, inspectorW: 420 })
  })

  it('keeps the assistant panel closed by default, and its width once it settles', async () => {
    const w = new Workspace()
    const k = w.open(set, true, false)
    expect(w.tab(k)?.panes?.assistantOpen).toBeUndefined()
    w.setPanes(k, { assistantOpen: true })
    w.setPanes(k, { assistantW: 400 })
    w.setPanes(k, { assistantW: 420 })
    await flush()
    expect((store.get('open') as Record<string, unknown>[])[0].assistantW).toBeUndefined()
    await new Promise((r) => setTimeout(r, 400))
    expect(store.get('open')).toEqual([{ title: 'a.trc (+1)', set, assistantOpen: true, assistantW: 420 }])
  })

  it('panes are per tab', async () => {
    const w = new Workspace()
    const k1 = w.open(set, true, false)
    const k2 = w.open({ ...set, paths: ['/t/c.trc'] }, true, false)
    w.setPanes(k1, { filesOpen: false })
    await flush()
    expect(w.tab(k1)?.panes).toEqual({ filesOpen: false })
    expect(w.tab(k2)?.panes).toBeUndefined()
    expect((store.get('open') as unknown[])[1]).not.toHaveProperty('filesOpen')
  })

  it('loads a workspace.json from before the panes', async () => {
    store.set('open', [{ title: 'a.trc (+1)', set, files: [0] }, { title: 'c.trc', set: { ...set, paths: ['/t/c.trc'] } }])
    store.set('active', 1)
    const w = new Workspace()
    await w.restore({ startEmpty: false })
    const { tabs } = w.getSnapshot()
    expect(tabs.map((t) => t.panes)).toEqual([undefined, undefined])
    expect(tabs[0].fileSel).toEqual([0])
  })

  it('drops a pane entry back to the default', async () => {
    const w = new Workspace()
    const k = w.open(set, true, false)
    w.setPanes(k, { filesOpen: false })
    w.setPanes(k, { filesOpen: undefined })
    await flush()
    expect(w.tab(k)?.panes).toBeUndefined()
    expect((store.get('open') as unknown[])[0]).not.toHaveProperty('filesOpen')
  })
})
