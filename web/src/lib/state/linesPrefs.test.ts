import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LINES_PREFS_DEFAULTS, getLinesPrefs, readLinesPrefs, setLinesPrefs, subscribeLinesPrefs } from './linesPrefs'

const KEY = 'mtk.lines.prefs'
const store = (json?: string) => ({ getItem: (k: string) => (k === KEY ? (json ?? null) : null) })

describe('readLinesPrefs', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readLinesPrefs(store())).toEqual(LINES_PREFS_DEFAULTS)
  })
  it('merges the stored fields over the defaults', () => {
    const p = readLinesPrefs(store(JSON.stringify({ wrap: true, inspectW: 520, mute: ['a', 'b'] })))
    expect(p).toEqual({ ...LINES_PREFS_DEFAULTS, wrap: true, inspectW: 520, mute: ['a', 'b'] })
  })
  it('drops unknown keys', () => {
    const p = readLinesPrefs(store(JSON.stringify({ nope: 1, heat: false })))
    expect(p).toEqual({ ...LINES_PREFS_DEFAULTS, heat: false })
    expect('nope' in p).toBe(false)
  })
  it('falls back to the default for a wrong type', () => {
    const p = readLinesPrefs(store(JSON.stringify({ wrap: 'yes', heat: 0, inspectW: '400', threshold: -1, gapMs: null, mute: [1], follow: true })))
    expect(p).toEqual({ ...LINES_PREFS_DEFAULTS, follow: true })
  })
  it('survives bad JSON, a non-object and a throwing storage', () => {
    expect(readLinesPrefs(store('{oops'))).toEqual(LINES_PREFS_DEFAULTS)
    expect(readLinesPrefs(store('[1,2]'))).toEqual(LINES_PREFS_DEFAULTS)
    expect(readLinesPrefs(store('7'))).toEqual(LINES_PREFS_DEFAULTS)
    expect(readLinesPrefs({ getItem: () => { throw new Error('denied') } })).toEqual(LINES_PREFS_DEFAULTS)
  })
  it('never shares the defaults mute array', () => {
    expect(readLinesPrefs(store()).mute).not.toBe(LINES_PREFS_DEFAULTS.mute)
  })
})

describe('the store', () => {
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
    })
    setLinesPrefs(LINES_PREFS_DEFAULTS)
    mem.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('merges a patch, notifies subscribers and persists', () => {
    const fn = vi.fn()
    const off = subscribeLinesPrefs(fn)
    setLinesPrefs({ wrap: true, mute: ['x'] })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(getLinesPrefs()).toEqual({ ...LINES_PREFS_DEFAULTS, wrap: true, mute: ['x'] })
    expect(JSON.parse(mem.get(KEY)!)).toMatchObject({ wrap: true, mute: ['x'] })
    off()
    setLinesPrefs({ wrap: false })
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('keeps the same snapshot object when nothing changes', () => {
    const before = getLinesPrefs()
    const fn = vi.fn()
    const off = subscribeLinesPrefs(fn)
    setLinesPrefs({ wrap: false, mute: [] })
    expect(fn).not.toHaveBeenCalled()
    expect(getLinesPrefs()).toBe(before)
    off()
  })
  it('ignores invalid values in a patch', () => {
    setLinesPrefs({ inspectW: Number.NaN, threshold: -5 })
    expect(getLinesPrefs()).toEqual(LINES_PREFS_DEFAULTS)
  })
  it('removes the key when the prefs equal the defaults again', () => {
    setLinesPrefs({ gapMs: 250 })
    expect(mem.has(KEY)).toBe(true)
    setLinesPrefs({ gapMs: LINES_PREFS_DEFAULTS.gapMs })
    expect(mem.has(KEY)).toBe(false)
  })
  it('keeps working in memory when storage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') } })
    setLinesPrefs({ hints: false })
    expect(getLinesPrefs().hints).toBe(false)
  })
})
