import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CUT_MAX_AGE_MS, cutFileName, cutStamp, cutsToDelete, namesIn } from './cuts'
import { Workspace } from './workspace'

const kv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../platform', () => ({
  inTauri: false,
  logInfo: vi.fn(),
  openKV: async () => ({ get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => { kv.set(k, v) }, delete: async (k: string) => { kv.delete(k) }, keys: async () => [...kv.keys()] }),
}))

beforeEach(() => kv.clear())

const at = new Date(2026, 10, 8, 9, 5, 7) // 2026-11-08 09:05:07 local

describe('cut file names (F09)', () => {
  it('stamps yyyymmdd-hhmmss in local time', () => {
    expect(cutStamp(at)).toBe('20261108-090507')
  })

  it('a name of its own: -2, -3 in the same second; a cut of a cut is named after the trace', async () => {
    const taken = new Set<string>()
    const next = async (stem: string) => {
      const n = await cutFileName(stem, at, (x) => taken.has(x))
      taken.add(n)
      return n
    }
    expect(await next('io_waits')).toBe('io_waits-cut-20261108-090507.trc')
    expect(await next('io_waits')).toBe('io_waits-cut-20261108-090507-2.trc')
    expect(await next('io_waits-cut-20261108-090507-2')).toBe('io_waits-cut-20261108-090507-3.trc')
    // the same basename from another folder gets its own name too
    expect(await next('io_waits')).toBe('io_waits-cut-20261108-090507-4.trc')
    expect(await cutFileName('a:b', at, () => false)).toBe('a_b-cut-20261108-090507.trc')
  })

  it('two cuts open two tabs; the same file opened again shows its tab', async () => {
    const ws = new Workspace()
    const taken = new Set<string>()
    const paths: string[] = []
    for (let i = 0; i < 2; i++) {
      const n = await cutFileName('io_waits', at, (x) => taken.has(x))
      taken.add(n)
      paths.push(`/cache/cuts/${n}`)
    }
    const a = ws.openOrShow({ paths: [paths[0]], options: { binds: 'keep' } })
    const b = ws.openOrShow({ paths: [paths[1]], options: { binds: 'keep' } })
    expect(a).not.toBe(b)
    expect(ws.getSnapshot().tabs.map((t) => t.set.paths[0])).toEqual(paths)
    // reopening an existing file intentionally still deduplicates
    expect(ws.openOrShow({ paths: [paths[0]], options: { binds: 'keep' } })).toBe(a)
    expect(ws.getSnapshot().tabs).toHaveLength(2)
  })
})

describe('cuts retention (F09)', () => {
  const now = Date.UTC(2026, 10, 8)
  const day = 24 * 60 * 60 * 1000

  it('deletes the files older than a week that no tab references', () => {
    const entries = [
      { name: 'old-unref.trc', mtime: now - 8 * day },
      { name: 'old-open.trc', mtime: now - 30 * day },
      { name: 'old-recent.trc', mtime: now - 9 * day },
      { name: 'new-unref.trc', mtime: now - 6 * day },
      { name: 'unknown-age.trc', mtime: null },
      { name: 'left.trc.part', mtime: now - 8 * day },
      { name: 'edge.trc', mtime: now - CUT_MAX_AGE_MS },
    ]
    expect(cutsToDelete(entries, new Set(['old-open.trc', 'old-recent.trc']), now)).toEqual(['old-unref.trc', 'left.trc.part'])
    expect(cutsToDelete([], new Set(), now)).toEqual([])
  })

  it('references are the names of the cuts folder among the paths of the tabs', () => {
    const got = namesIn('C:\\Users\\me\\AppData\\Local\\mtkprof\\cuts', [
      'C:\\Users\\me\\AppData\\Local\\mtkprof\\cuts\\a-cut-20261101-120000.trc',
      'C:/Users/me/AppData/Local/mtkprof/cuts/b-cut-20261101-120000.trc',
      'C:\\traces\\c-cut-20261101-120000.trc',
      'C:\\Users\\me\\AppData\\Local\\mtkprof\\cuts\\sub\\d.trc',
    ])
    expect([...got].sort()).toEqual(['a-cut-20261101-120000.trc', 'b-cut-20261101-120000.trc'])
    expect([...namesIn('/Users/me/Library/Caches/mtkprof/cuts/', ['/Users/me/Library/Caches/mtkprof/cuts/x.trc'])]).toEqual(['x.trc'])
  })
})
