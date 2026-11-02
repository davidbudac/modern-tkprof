import { describe, expect, it } from 'vitest'
import type { KeyLike } from '@lib'
import { effectOf, shortcutOf } from './shortcuts'
import type { Route, Tab } from './workspace'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
const cmd = (k: string, mods: Partial<KeyLike> = {}) => key(k, { metaKey: true, ...mods })
const ctrl = (k: string, mods: Partial<KeyLike> = {}) => key(k, { ctrlKey: true, ...mods })

describe('shortcutOf on macOS', () => {
  it('maps ⌘ keys', () => {
    expect(shortcutOf(cmd('w'), true)).toEqual({ kind: 'close' })
    expect(shortcutOf(cmd('W'), true)).toEqual({ kind: 'close' }) // caps lock
    expect(shortcutOf(cmd('t'), true)).toEqual({ kind: 'open' })
    expect(shortcutOf(cmd(','), true)).toEqual({ kind: 'settings' })
  })
  it('picks tabs with ⌃ digits; ⌘ digits are the views', () => {
    expect(shortcutOf(ctrl('1'), true)).toEqual({ kind: 'nth', n: 1 })
    expect(shortcutOf(ctrl('8'), true)).toEqual({ kind: 'nth', n: 8 })
    expect(shortcutOf(ctrl('9'), true)).toEqual({ kind: 'last' })
    expect(shortcutOf(ctrl('0'), true)).toBeNull()
    expect(shortcutOf(cmd('1'), true)).toBeNull()
    expect(shortcutOf(cmd('9'), true)).toBeNull()
  })
  it('steps with ⌘⇧] / ⌘⇧[ (the key is } / { with Shift) and Ctrl+Tab', () => {
    expect(shortcutOf(cmd('}', { shiftKey: true }), true)).toEqual({ kind: 'step', dir: 1 })
    expect(shortcutOf(cmd('{', { shiftKey: true }), true)).toEqual({ kind: 'step', dir: -1 })
    expect(shortcutOf(cmd('x', { shiftKey: true, code: 'BracketRight' }), true)).toEqual({ kind: 'step', dir: 1 })
    expect(shortcutOf(ctrl('Tab'), true)).toEqual({ kind: 'step', dir: 1 })
    expect(shortcutOf(ctrl('Tab', { shiftKey: true }), true)).toEqual({ kind: 'step', dir: -1 })
  })
  it('leaves Ctrl letters, ⌘0, ⌘⇧digits, ⌘[ and Alt chords alone', () => {
    expect(shortcutOf(ctrl('w'), true)).toBeNull()
    expect(shortcutOf(cmd('0'), true)).toBeNull()
    expect(shortcutOf(cmd('3', { shiftKey: true }), true)).toBeNull() // the screenshot
    expect(shortcutOf(cmd('w', { shiftKey: true }), true)).toBeNull()
    expect(shortcutOf(cmd(']'), true)).toBeNull() // history forward (SessionShell)
    expect(shortcutOf(cmd('w', { altKey: true }), true)).toBeNull()
    expect(shortcutOf(cmd('w', { ctrlKey: true }), true)).toBeNull()
    expect(shortcutOf(key('w'), true)).toBeNull()
  })
})

describe('shortcutOf elsewhere', () => {
  it('maps Ctrl keys', () => {
    expect(shortcutOf(ctrl('w'), false)).toEqual({ kind: 'close' })
    expect(shortcutOf(ctrl('t'), false)).toEqual({ kind: 'open' })
    expect(shortcutOf(ctrl(','), false)).toEqual({ kind: 'settings' })
    expect(shortcutOf(key('2', { altKey: true }), false)).toEqual({ kind: 'nth', n: 2 })
    expect(shortcutOf(key('x', { altKey: true, code: 'Digit9' }), false)).toEqual({ kind: 'last' })
    expect(shortcutOf(ctrl('2'), false)).toBeNull() // a view
    expect(shortcutOf(ctrl('Tab'), false)).toEqual({ kind: 'step', dir: 1 })
    expect(shortcutOf(ctrl('Tab', { shiftKey: true }), false)).toEqual({ kind: 'step', dir: -1 })
  })
  it('ignores ⌘, Shift chords and the bracket keys', () => {
    expect(shortcutOf(cmd('w'), false)).toBeNull()
    expect(shortcutOf(ctrl('w', { shiftKey: true }), false)).toBeNull()
    expect(shortcutOf(ctrl('}', { shiftKey: true }), false)).toBeNull()
    expect(shortcutOf(ctrl('w', { altKey: true }), false)).toBeNull()
    expect(shortcutOf(ctrl('Tab', { altKey: true }), false)).toBeNull()
    expect(shortcutOf(key('Tab'), false)).toBeNull()
  })
  it('does not repeat close and open while the key is held', () => {
    expect(shortcutOf(ctrl('w', { repeat: true }), false)).toBeNull()
    expect(shortcutOf(ctrl('t', { repeat: true }), false)).toBeNull()
    expect(shortcutOf(ctrl('Tab', { repeat: true }), false)).toEqual({ kind: 'step', dir: 1 })
  })
})

describe('effectOf', () => {
  const tabs = ['a', 'b', 'c'].map((k) => ({ key: k }) as Tab)
  const at = (k: string): Route => ({ kind: 'tab', key: k })
  const page: Route = { kind: 'page', id: 'about' }
  const open: Route = { kind: 'open' }

  it('closes the current tab; from a page goes to the last tab; the open screen has none', () => {
    expect(effectOf({ kind: 'close' }, tabs, at('b'))).toEqual({ close: 'b' })
    expect(effectOf({ kind: 'close' }, tabs, page)).toEqual({ go: at('c') })
    expect(effectOf({ kind: 'close' }, tabs, page, at('a'))).toEqual({ go: at('a') })
    expect(effectOf({ kind: 'close' }, tabs, page, open)).toEqual({ go: open })
    expect(effectOf({ kind: 'close' }, tabs, page, at('gone'))).toEqual({ go: at('c') })
    expect(effectOf({ kind: 'close' }, [], page)).toEqual({ go: open })
    expect(effectOf({ kind: 'close' }, tabs, open)).toBeNull()
    expect(effectOf({ kind: 'close' }, tabs, at('gone'))).toBeNull()
  })
  it('opens the open screen and Settings', () => {
    expect(effectOf({ kind: 'open' }, tabs, at('a'))).toEqual({ go: open })
    expect(effectOf({ kind: 'settings' }, tabs, at('a'))).toEqual({ go: { kind: 'page', id: 'settings' } })
  })
  it('goes to a tab by position, 9 to the last', () => {
    expect(effectOf({ kind: 'nth', n: 2 }, tabs, at('a'))).toEqual({ go: at('b') })
    expect(effectOf({ kind: 'nth', n: 5 }, tabs, at('a'))).toBeNull()
    expect(effectOf({ kind: 'last' }, tabs, open)).toEqual({ go: at('c') })
    expect(effectOf({ kind: 'last' }, [], open)).toBeNull()
  })
  it('steps with wrap; from the open screen or a page next is the first tab, previous the last', () => {
    expect(effectOf({ kind: 'step', dir: 1 }, tabs, at('a'))).toEqual({ go: at('b') })
    expect(effectOf({ kind: 'step', dir: 1 }, tabs, at('c'))).toEqual({ go: at('a') })
    expect(effectOf({ kind: 'step', dir: -1 }, tabs, at('a'))).toEqual({ go: at('c') })
    expect(effectOf({ kind: 'step', dir: 1 }, tabs, open)).toEqual({ go: at('a') })
    expect(effectOf({ kind: 'step', dir: -1 }, tabs, page)).toEqual({ go: at('c') })
    expect(effectOf({ kind: 'step', dir: 1 }, [], open)).toBeNull()
  })
})
