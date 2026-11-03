import { describe, expect, it } from 'vitest'
import { digitOf, viewKeyAria, viewKeyLabel, viewKeyOf, viewOfKey, type KeyLike } from './viewKeys'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('viewKeyOf', () => {
  it('maps ⌘ digits and ⌥⌘ arrows on macOS', () => {
    expect(viewKeyOf(key('2', { metaKey: true }), true)).toEqual({ kind: 'view', key: 2 })
    expect(viewKeyOf(key('0', { metaKey: true }), true)).toEqual({ kind: 'view', key: 0 })
    expect(viewKeyOf(key('ArrowRight', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'step', dir: 1 })
    expect(viewKeyOf(key('ArrowLeft', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'step', dir: -1 })
    expect(viewKeyOf(key('2', { ctrlKey: true }), true)).toBeNull() // a tab
    expect(viewKeyOf(key('3', { metaKey: true, shiftKey: true }), true)).toBeNull() // the screenshot
    expect(viewKeyOf(key('2'), true)).toBeNull()
  })
  it('maps Ctrl digits and Ctrl+PageUp/PageDown elsewhere', () => {
    expect(viewKeyOf(key('4', { ctrlKey: true }), false)).toEqual({ kind: 'view', key: 4 })
    expect(viewKeyOf(key('PageDown', { ctrlKey: true }), false)).toEqual({ kind: 'step', dir: 1 })
    expect(viewKeyOf(key('PageUp', { ctrlKey: true }), false)).toEqual({ kind: 'step', dir: -1 })
    expect(viewKeyOf(key('4', { metaKey: true }), false)).toBeNull()
    expect(viewKeyOf(key('4', { altKey: true }), false)).toBeNull()
  })
})

describe('viewOfKey', () => {
  const shown = [{ id: 'overview', key: 1 }, { id: 'lines', key: 2 }, { id: 'waits', key: 4 }] as const
  const views = [...shown]
  it('goes to the view with that digit; a hidden one is nothing', () => {
    expect(viewOfKey({ kind: 'view', key: 2 }, views, 'overview')).toBe('lines')
    expect(viewOfKey({ kind: 'view', key: 1 }, views, 'overview')).toBe('overview')
    expect(viewOfKey({ kind: 'view', key: 3 }, views, 'overview')).toBeNull()
  })
  it('steps in nav order and wraps', () => {
    expect(viewOfKey({ kind: 'step', dir: 1 }, views, 'overview')).toBe('lines')
    expect(viewOfKey({ kind: 'step', dir: 1 }, views, 'waits')).toBe('overview')
    expect(viewOfKey({ kind: 'step', dir: -1 }, views, 'overview')).toBe('waits')
  })
  it('gives a row without a key no digit, but steps through it', () => {
    const rows = [{ id: 'overview', key: 1 }, { id: 'waits', key: 4 }, { id: 'blocks' }, { id: 'timeline', key: 5 }] as const
    for (let d = 0; d <= 9; d++) expect(viewOfKey({ kind: 'view', key: d }, rows, 'overview')).toBe(d === 1 ? 'overview' : d === 4 ? 'waits' : d === 5 ? 'timeline' : null)
    expect(viewOfKey({ kind: 'step', dir: 1 }, rows, 'waits')).toBe('blocks')
    expect(viewOfKey({ kind: 'step', dir: 1 }, rows, 'blocks')).toBe('timeline')
    expect(viewOfKey({ kind: 'step', dir: -1 }, rows, 'timeline')).toBe('blocks')
  })
})

describe('viewKeyLabel / viewKeyAria', () => {
  it('write a digit as the platform chord, nothing for a row without a key', () => {
    expect(viewKeyLabel(3, true)).toBe('⌘3')
    expect(viewKeyLabel(0, false)).toBe('Ctrl+0')
    expect(viewKeyAria(3, true)).toBe('Meta+3')
    expect(viewKeyAria(7, false)).toBe('Control+7')
    expect(viewKeyLabel(undefined, true)).toBe('')
    expect(viewKeyAria(undefined, false)).toBe('')
  })
})

describe('digitOf', () => {
  it('reads the code first, then the key', () => {
    expect(digitOf(key('&', { code: 'Digit1', shiftKey: true }))).toBe(1)
    expect(digitOf(key('7'))).toBe(7)
    expect(digitOf(key('a', { code: 'KeyA' }))).toBeNull()
  })
})
