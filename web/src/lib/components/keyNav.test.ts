import { describe, expect, it } from 'vitest'
import { ariaSort, clampPane, isActivateKey, nextIndex, ownsKeys, separatorValues, tableKeyTarget, toggleSort } from './keyNav'

describe('nextIndex', () => {
  it('moves one step and stops at the ends', () => {
    expect(nextIndex('ArrowDown', 1, 5)).toBe(2)
    expect(nextIndex('ArrowUp', 1, 5)).toBe(0)
    expect(nextIndex('ArrowDown', 4, 5)).toBeNull()
    expect(nextIndex('ArrowUp', 0, 5)).toBeNull()
  })
  it('starts an unselected list at the first (Down) or last (Up) item', () => {
    expect(nextIndex('ArrowDown', -1, 5)).toBe(0)
    expect(nextIndex('ArrowUp', -1, 5)).toBe(4)
  })
  it('starts an unselected virtualized list at the first / last visible row', () => {
    expect(nextIndex('ArrowDown', -1, 500, { visible: { start: 120, end: 140 } })).toBe(120)
    expect(nextIndex('ArrowUp', -1, 500, { visible: { start: 120, end: 140 } })).toBe(140)
    expect(nextIndex('ArrowUp', -1, 100, { visible: { start: 0, end: 900 } })).toBe(99)
  })
  it('treats a selection that is not in the list as no selection', () => {
    expect(nextIndex('ArrowDown', 9, 5)).toBe(0)
  })
  it('Home/End jump unless the table leaves them to scrolling', () => {
    expect(nextIndex('Home', 3, 5)).toBe(0)
    expect(nextIndex('End', 1, 5)).toBe(4)
    expect(nextIndex('Home', 0, 5)).toBeNull()
    expect(nextIndex('Home', 3, 5, { homeEnd: false })).toBeNull()
    expect(nextIndex('End', 3, 5, { homeEnd: false })).toBeNull()
  })
  it('ignores other keys and empty lists', () => {
    expect(nextIndex('a', 1, 5)).toBeNull()
    expect(nextIndex('ArrowDown', -1, 0)).toBeNull()
  })
})

describe('keys', () => {
  it('Enter and Space activate', () => {
    expect(isActivateKey('Enter')).toBe(true)
    expect(isActivateKey(' ')).toBe(true)
    expect(isActivateKey('a')).toBe(false)
  })
  it('text fields keep their own keys', () => {
    expect(ownsKeys({ tagName: 'INPUT' })).toBe(false)
    expect(ownsKeys({ tagName: 'select' })).toBe(false)
    expect(ownsKeys({ tagName: 'DIV', isContentEditable: true })).toBe(false)
    expect(ownsKeys({ tagName: 'TD' })).toBe(true)
    expect(ownsKeys({ tagName: 'BUTTON' })).toBe(true)
    expect(ownsKeys(null)).toBe(true)
  })
})

describe('sorting', () => {
  it('a new column starts descending for numbers and ascending for text', () => {
    expect(toggleSort(null, 'n', 'end')).toEqual({ key: 'n', dir: 'desc' })
    expect(toggleSort({ key: 'n', dir: 'asc' }, 't', undefined)).toEqual({ key: 't', dir: 'asc' })
  })
  it('the sorted column flips', () => {
    expect(toggleSort({ key: 'n', dir: 'desc' }, 'n', 'end')).toEqual({ key: 'n', dir: 'asc' })
    expect(toggleSort({ key: 'n', dir: 'asc' }, 'n', 'end')).toEqual({ key: 'n', dir: 'desc' })
  })
  it('announces the state of every sortable header', () => {
    expect(ariaSort({ key: 'a', dir: 'asc' }, 'a', true)).toBe('ascending')
    expect(ariaSort({ key: 'a', dir: 'desc' }, 'a', true)).toBe('descending')
    expect(ariaSort({ key: 'a', dir: 'desc' }, 'b', true)).toBe('none')
    expect(ariaSort(null, 'b', false)).toBeUndefined()
  })
})

describe('pane separator', () => {
  const box = { left: 100, right: 1100, width: 1000 }
  it('measures an end-docked pane from the container end', () => {
    expect(separatorValues('end', 700, box, 220, 0.6)).toEqual({ now: 400, min: 220, max: 600 })
  })
  it('measures a start-docked pane from the container start', () => {
    expect(separatorValues('start', 400, box, 220, 0.4)).toEqual({ now: 300, min: 220, max: 400 })
  })
  it('keeps the value inside the range', () => {
    expect(separatorValues('end', 1050, box, 220, 0.6).now).toBe(220)
    expect(separatorValues('end', 150, box, 220, 0.6).now).toBe(600)
  })
  it('a container narrower than min still yields max >= min', () => {
    expect(separatorValues('end', 150, { left: 100, right: 300, width: 200 }, 220, 0.5)).toEqual({ now: 220, min: 220, max: 220 })
  })
  it('clampPane agrees with the range', () => {
    expect(clampPane(50, 220, 1000, 0.6)).toBe(220)
    expect(clampPane(900, 220, 1000, 0.6)).toBe(600)
    expect(clampPane(333.4, 220, 1000, 0.6)).toBe(333)
  })
})

describe('tableKeyTarget', () => {
  const base = { selectable: true, key: 'ArrowDown', modified: false, defaultPrevented: false, target: { tagName: 'DIV' }, current: -1, count: 500, visible: { start: 120, end: 140 } }
  it('starts and moves the selection of a table with a selection model', () => {
    expect(tableKeyTarget(base)).toBe(120)
    expect(tableKeyTarget({ ...base, key: 'ArrowUp' })).toBe(140)
    expect(tableKeyTarget({ ...base, current: 130 })).toBe(131)
  })
  it('leaves a table whose click is an action to native scrolling', () => {
    expect(tableKeyTarget({ ...base, selectable: false })).toBeNull()
    expect(tableKeyTarget({ ...base, selectable: false, key: 'ArrowUp' })).toBeNull()
  })
  it('leaves Home/End, chords, handled events, embedded controls and the header buttons alone', () => {
    expect(tableKeyTarget({ ...base, key: 'End' })).toBeNull()
    expect(tableKeyTarget({ ...base, modified: true })).toBeNull()
    expect(tableKeyTarget({ ...base, defaultPrevented: true })).toBeNull()
    expect(tableKeyTarget({ ...base, target: { tagName: 'INPUT' } })).toBeNull()
    expect(tableKeyTarget({ ...base, target: { tagName: 'BUTTON', inHeader: true } })).toBeNull()
    expect(tableKeyTarget({ ...base, target: { tagName: 'BUTTON' } })).toBe(120)
  })
})
