import { describe, expect, it } from 'vitest'
import { createStore } from '@lib/state/store'
import { makeDoc } from '@lib/data/testdoc'
import { apply, hashOf } from './urlstate'

describe('URL hash: files=', () => {
  it('round trips a file selection and leaves it out for all files', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    expect(hashOf(doc, store.getState())).toBe('')
    store.actions.setFiles(new Set([2, 0]))
    expect(hashOf(doc, store.getState())).toBe('#files=0%2C2')

    const other = createStore()
    other.setLoaded({ doc, compare: null })
    apply(other, doc, '#view=waits&files=0%2C2')
    expect([...other.getState().files!]).toEqual([0, 2])
    expect(other.getState().view).toBe('waits')
    expect(hashOf(doc, other.getState())).toBe('#view=waits&files=0%2C2')
    apply(other, doc, '#view=waits') // Back to a hash without files: everything again
    expect(other.getState().files).toBeNull()
  })

  it('treats every file / unknown files as no selection and drops contexts outside the files', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    apply(store, doc, '#files=0,1,2')
    expect(store.getState().files).toBeNull()
    apply(store, doc, '#files=9')
    expect(store.getState().files).toBeNull()
    store.actions.setContexts(new Set([0, 3]))
    apply(store, doc, '#files=0')
    expect([...store.getState().contexts!]).toEqual([0])
  })
})
