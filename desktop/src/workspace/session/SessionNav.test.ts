import { describe, expect, it } from 'vitest'
import type { SessionViewDef } from '@lib'
import { menuHint } from './SessionNav'

const row = (key?: number) => ({ id: 'overview', label: 'x', key, render: () => null }) as SessionViewDef

describe('menuHint', () => {
  it('lists two chords, a run of three or more as a range', () => {
    expect(menuHint([row(8), row(9)], true)).toBe('⌘8 ⌘9')
    expect(menuHint([row(5), row(6), row(7), row(8), row(9)], true)).toBe('⌘5–9')
    expect(menuHint([row(3), row(5), row(6), row(7)], false)).toBe('Ctrl+3 Ctrl+5–7')
  })
  it('skips rows without a key, and is null when none has one', () => {
    expect(menuHint([row(4), row(), row(5), row(6)], true)).toBe('⌘4–6')
    expect(menuHint([row()], true)).toBeNull()
  })
})
