import { describe, expect, it } from 'vitest'
import { pieceKey } from './cutkeys'

describe('Cut piece labels keyboard', () => {
  it('Enter and Space select the focused piece', () => {
    expect(pieceKey('Enter', 2, 5)).toEqual({ kind: 'select' })
    expect(pieceKey(' ', 0, 5)).toEqual({ kind: 'select' })
  })
  it('arrows and j/k move one piece', () => {
    expect(pieceKey('ArrowDown', 1, 5)).toEqual({ kind: 'move', to: 2 })
    expect(pieceKey('j', 1, 5)).toEqual({ kind: 'move', to: 2 })
    expect(pieceKey('ArrowUp', 1, 5)).toEqual({ kind: 'move', to: 0 })
    expect(pieceKey('k', 1, 5)).toEqual({ kind: 'move', to: 0 })
  })
  it('Home and End go to the ends', () => {
    expect(pieceKey('Home', 3, 5)).toEqual({ kind: 'move', to: 0 })
    expect(pieceKey('End', 1, 5)).toEqual({ kind: 'move', to: 4 })
  })
  it('does not move past either end or on the spot', () => {
    expect(pieceKey('ArrowUp', 0, 5)).toBeNull()
    expect(pieceKey('k', 0, 5)).toBeNull()
    expect(pieceKey('ArrowDown', 4, 5)).toBeNull()
    expect(pieceKey('Home', 0, 5)).toBeNull()
    expect(pieceKey('End', 4, 5)).toBeNull()
  })
  it('ignores other keys and an empty list', () => {
    expect(pieceKey('a', 1, 5)).toBeNull()
    expect(pieceKey('Tab', 1, 5)).toBeNull()
    expect(pieceKey('ArrowDown', 0, 0)).toBeNull()
  })
})
