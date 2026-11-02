import { expect, it } from 'vitest'
import { createSession } from '@lib'
import { comparisonSource } from './comparisonSource'
import type { Tab } from './workspace'

const source = () => ({ key: 'source', state: 'ready', identity: 'original', session: createSession() }) as Tab
const snapshot = { comparison: { a: 'source', b: 'other', identityA: 'original', identityB: 'other-original' } } as Tab

it('accepts a reopened source only when its content identity matches', () => {
  const a = source()
  expect(comparisonSource(snapshot, 'a', [a])).toBe(a)
  expect(() => comparisonSource(snapshot, 'a', [{ ...a, identity: 'changed' }])).toThrow('changed since this snapshot')
  expect(() => comparisonSource(snapshot, 'a', [{ ...a, identity: '' }])).toThrow('changed since this snapshot')
  expect(() => comparisonSource(snapshot, 'a', [{ ...a, state: 'opening' }])).toThrow('closed or reopening')
  expect(() => comparisonSource(snapshot, 'a', [])).toThrow('closed or reopening')
})

it('resolving a statement source preserves persisted scope and selections', () => {
  const a = source()
  a.session!.store.setState({ files: new Set([1]), contexts: new Set([2]), window: { startTim: 20, endTim: 30 } })
  const before = a.session!.store.getState()
  const target = comparisonSource(snapshot, 'a', [a])
  target.session!.store.actions.selectStmt(4)
  const after = a.session!.store.getState()
  expect(after.files).toBe(before.files)
  expect(after.contexts).toBe(before.contexts)
  expect(after.window).toBe(before.window)
  expect(after.selection.stmt).toBe(4)
})
