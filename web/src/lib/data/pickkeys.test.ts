import { describe, expect, it } from 'vitest'
import { pickerKey, selectAllTo, triState } from './pickkeys'

const key = (k: string, extra: Record<string, boolean> = {}) => ({ key: k, ...extra })

describe('the picker\'s keys in the filter box', () => {
  it('type: letters, space, f, a, A and / are text there, not commands', () => {
    for (const k of ['a', 'f', ' ', 'A', '/', 'x', '1', 'Backspace', 'ArrowLeft']) expect(pickerKey('filter', key(k))).toEqual({ mode: 'filter', handled: false })
  })
  it('↓ moves into the list (the first row stays focused), ↑ does nothing', () => {
    expect(pickerKey('filter', key('ArrowDown'))).toEqual({ mode: 'list', handled: true })
    expect(pickerKey('filter', key('ArrowUp'))).toEqual({ mode: 'filter', handled: true })
  })
  it('PgDn and PgUp go to the list and move a page', () => {
    expect(pickerKey('filter', key('PageDown'))).toEqual({ mode: 'list', act: { do: 'move', to: 'nextPage' }, handled: true })
    expect(pickerKey('filter', key('PageUp')).act).toEqual({ do: 'move', to: 'prevPage' })
  })
  it('Enter goes to the first line of the focused statement, Esc closes, Tab stays in the popover', () => {
    expect(pickerKey('filter', key('Enter')).act).toEqual({ do: 'go' })
    expect(pickerKey('filter', key('Escape')).act).toEqual({ do: 'close' })
    expect(pickerKey('filter', key('Tab'))).toEqual({ mode: 'filter', handled: true })
  })
})

describe('the picker\'s keys in the list', () => {
  it('Space toggles the highlight, f the filter, a / A select or deselect all listed for each', () => {
    expect(pickerKey('list', key(' ')).act).toEqual({ do: 'highlight' })
    expect(pickerKey('list', key('f')).act).toEqual({ do: 'filter' })
    expect(pickerKey('list', key('a')).act).toEqual({ do: 'allHighlight' })
    expect(pickerKey('list', key('A', { shiftKey: true })).act).toEqual({ do: 'allFilter' })
    for (const k of [' ', 'f', 'a', 'A']) expect(pickerKey('list', key(k))).toMatchObject({ mode: 'list', handled: true })
  })
  it('the arrows, pages, Home and End move', () => {
    expect(pickerKey('list', key('ArrowDown')).act).toEqual({ do: 'move', to: 'next' })
    expect(pickerKey('list', key('ArrowUp')).act).toEqual({ do: 'move', to: 'prev' })
    expect(pickerKey('list', key('PageDown')).act).toEqual({ do: 'move', to: 'nextPage' })
    expect(pickerKey('list', key('PageUp')).act).toEqual({ do: 'move', to: 'prevPage' })
    expect(pickerKey('list', key('Home')).act).toEqual({ do: 'move', to: 'first' })
    expect(pickerKey('list', key('End')).act).toEqual({ do: 'move', to: 'last' })
  })
  it('↑ on the first row goes back to the filter box', () => {
    expect(pickerKey('list', key('ArrowUp'), true)).toEqual({ mode: 'filter', handled: true })
  })
  it('Enter goes, Esc closes', () => {
    expect(pickerKey('list', key('Enter')).act).toEqual({ do: 'go' })
    expect(pickerKey('list', key('Escape')).act).toEqual({ do: 'close' })
  })
  it('/ returns to the filter box without typing; any other printable key, and Backspace, return and type', () => {
    expect(pickerKey('list', key('/'))).toEqual({ mode: 'filter', handled: true })
    expect(pickerKey('list', key('s'))).toEqual({ mode: 'filter', handled: false })
    expect(pickerKey('list', key('7'))).toEqual({ mode: 'filter', handled: false })
    expect(pickerKey('list', key('Backspace'))).toEqual({ mode: 'filter', handled: false })
  })
  it('leaves keys with a modifier (⌘K, Ctrl+A, …) and non-printable keys alone', () => {
    expect(pickerKey('list', key('a', { metaKey: true }))).toEqual({ mode: 'list', handled: false })
    expect(pickerKey('list', key('f', { ctrlKey: true }))).toEqual({ mode: 'list', handled: false })
    expect(pickerKey('list', key('Shift'))).toEqual({ mode: 'list', handled: false })
    expect(pickerKey('list', key('F5'))).toEqual({ mode: 'list', handled: false })
    expect(pickerKey('filter', { key: 'a', isComposing: true })).toEqual({ mode: 'filter', handled: false })
  })
})

describe('the select-all boxes', () => {
  const on = new Set([2, 4])
  it('are none, some or all of the listed statements', () => {
    expect(triState([1, 3], (id) => on.has(id))).toBe('none')
    expect(triState([1, 2, 3], (id) => on.has(id))).toBe('some')
    expect(triState([2, 4], (id) => on.has(id))).toBe('all')
    expect(triState([], (id) => on.has(id))).toBe('none')
  })
  it('switch everything on, or off when everything already is', () => {
    expect(selectAllTo('none', 3)).toBe(true)
    expect(selectAllTo('some', 3)).toBe(true)
    expect(selectAllTo('all', 3)).toBe(false)
    expect(selectAllTo('all', 0)).toBe(true)
  })
})
