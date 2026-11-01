import { describe, expect, it } from 'vitest'
import type { Store, View } from '../state/store'
import { FilesChoices, filesChoicesOf, filesDefaultOpen, showsInspector } from './viewPanes'
import { inShellFilesWrite, shellFilesWrite } from './filesRoom'

describe('showsInspector', () => {
  it('is only for Waits and Timeline', () => {
    const on: View[] = ['waits', 'timeline']
    const off: View[] = ['overview', 'statements', 'sessions', 'pivot', 'lines', 'annotations', 'reports', 'compare']
    for (const v of on) expect(showsInspector(v)).toBe(true)
    for (const v of off) expect(showsInspector(v)).toBe(false)
  })
})

describe('filesDefaultOpen', () => {
  it('opens in Overview, Timeline, Sessions and Lines', () => {
    for (const v of ['overview', 'timeline', 'sessions', 'lines'] as View[]) expect(filesDefaultOpen(v)).toBe(true)
  })
  it('folds in Statements, Waits, Pivot, Notes and Reports', () => {
    for (const v of ['statements', 'waits', 'pivot', 'annotations', 'reports'] as View[]) expect(filesDefaultOpen(v)).toBe(false)
  })
})

describe('FilesChoices', () => {
  it('uses the default until the user chooses, then the choice, per view', () => {
    const c = new FilesChoices()
    expect(c.wanted('overview')).toBe(true)
    expect(c.wanted('waits')).toBe(false)
    c.record('waits', true)
    c.record('overview', false)
    expect(c.wanted('waits')).toBe(true)
    expect(c.wanted('overview')).toBe(false)
    expect(c.wanted('pivot')).toBe(false) // untouched
    expect(c.has('waits')).toBe(true)
    expect(c.has('pivot')).toBe(false)
  })
})

describe('filesChoicesOf', () => {
  it('is per store and seeds a restored state for the starting view only', () => {
    const a = {} as Store, b = {} as Store
    const ca = filesChoicesOf(a, 'overview', false)
    expect(ca.wanted('overview')).toBe(false)
    expect(ca.wanted('timeline')).toBe(true)
    expect(filesChoicesOf(a, 'waits', true)).toBe(ca) // later calls do not re-seed
    expect(ca.wanted('waits')).toBe(false)
    expect(filesChoicesOf(b, 'overview', null).wanted('overview')).toBe(true)
  })
})

describe('shellFilesWrite', () => {
  it('marks the write while it runs and clears it after, even when it throws', () => {
    const s = {} as Store
    let seen = false
    shellFilesWrite(s, () => { seen = inShellFilesWrite(s) })
    expect(seen).toBe(true)
    expect(inShellFilesWrite(s)).toBe(false)
    expect(() => shellFilesWrite(s, () => { throw new Error('x') })).toThrow()
    expect(inShellFilesWrite(s)).toBe(false)
  })
})
