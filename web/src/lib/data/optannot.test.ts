import { describe, expect, it } from 'vitest'
import { bookmarkToAnnotation, annotationToBookmark } from './annotations'
import { storeAnnotations } from './opt'
import { lineLabel } from './optdoc'
import { makeOptDoc, optFileOf } from './testdoc'
import { createStore } from '../state/store'

const file = optFileOf(3)

/** The view's adapter over the store as OptTab builds it: from the store's current bookmarks, for input file 0. */
async function setup() {
  const store = createStore()
  store.setLoaded({ doc: await makeOptDoc({ file }), compare: null })
  const adapter = () => storeAnnotations(store.getState().bookmarks, 0, store.actions, (l) => lineLabel(file, l))
  return { store, adapter }
}

describe('bookmarks and notes of a 10053 tab, through the real store', () => {
  it('bookmarks a line with the dump as its label, and takes it away', async () => {
    const { store, adapter } = await setup()
    adapter().toggle(55)
    expect(store.getState().bookmarks).toEqual([{ file: 0, line: 55, label: 'dump 3 · sqlid2' }])
    expect([...adapter().bookmarks]).toEqual([[55, '']])
    adapter().toggle(55)
    expect(store.getState().bookmarks).toEqual([])
    expect(adapter().bookmarks.size).toBe(0)
  })

  it('sets a note (bookmarking the line), clears it without losing the bookmark, and removes the bookmark with its note', async () => {
    const { store, adapter } = await setup()
    adapter().setNote(31, 'the join order that won')
    expect(adapter().bookmarks.get(31)).toBe('the join order that won')
    expect(store.getState().bookmarks[0]).toMatchObject({ file: 0, line: 31, label: 'dump 2 · sqlid1', note: 'the join order that won' })
    adapter().setNote(31, '')
    expect([...adapter().bookmarks]).toEqual([[31, '']])
    adapter().setNote(31, 'again')
    adapter().remove(31)
    expect(store.getState().bookmarks).toEqual([])
  })

  it('shows only the bookmarks of file 0', async () => {
    const { store, adapter } = await setup()
    store.actions.addBookmark(1, 12, 'other file')
    store.actions.addBookmark(0, 12, 'this one')
    expect([...adapter().bookmarks.keys()]).toEqual([12])
  })

  it('keeps the bookmarks sorted and persists them as line annotations (what the desktop writes to annotations.json)', async () => {
    const { store, adapter } = await setup()
    adapter().setNote(60, 'b')
    adapter().toggle(11)
    const marks = store.getState().bookmarks
    expect(marks.map((b) => b.line)).toEqual([11, 60])
    const back = marks.map((b) => annotationToBookmark(bookmarkToAnnotation(b)))
    expect(back).toEqual(marks.map((b) => ({ ...b })))
  })
})
