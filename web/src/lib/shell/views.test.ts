import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store'
import { makeDoc, makeOptDoc, optFileOf } from '../data/testdoc'
import { baseViews, currentView, shownViews, type SessionViewDef } from './views'

describe('baseViews', () => {
  it('lists the ten views in nav order with their labels and keys (the I/O map has a letter; 10053 shares ⌘1 with the Overview it never meets)', () => {
    expect(baseViews.map((v) => [v.id, v.label, v.key])).toEqual([
      ['opt', '10053', 1], ['compare', 'Compare', 0], ['overview', 'Overview', 1], ['lines', 'Trace', 2], ['statements', 'Statements', 3],
      ['waits', 'Waits', 4], ['blocks', 'I/O map', 'i'], ['timeline', 'Timeline', 5], ['sessions', 'Sessions', 6], ['pivot', 'Pivot', 7],
    ])
  })
})

describe('shownViews', () => {
  it('hides Compare and Trace a trace cannot have, keeps appended rows', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    const notes: SessionViewDef = { id: 'annotations', label: 'Notes', key: 8, group: 'tools', render: () => null }
    const ids = shownViews([...baseViews, notes], doc, store.getState()).map((v) => v.id)
    expect(ids).toEqual(['overview', 'statements', 'waits', 'blocks', 'timeline', 'sessions', 'pivot', 'annotations'])
    store.setState({ view: 'lines' })
    expect(currentView(baseViews, doc, store.getState()).id).toBe('overview') // not shown: Overview instead
    store.setState({ view: 'waits' })
    expect(currentView(baseViews, doc, store.getState()).id).toBe('waits')
  })

  it('shows a 10053 document the 10053 view and none of the 10046 views, and Notes / Reports of the desktop', async () => {
    const doc = await makeOptDoc({ file: optFileOf(2) })
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    const tools: SessionViewDef[] = [
      { id: 'annotations', label: 'Notes', key: 8, group: 'tools', render: () => null },
      { id: 'reports', label: 'Reports', key: 9, group: 'tools', render: () => null },
      { id: 'cut', label: 'Cut', group: 'tools', show: (d) => !d.opt && !!d.slice, render: () => null },
    ]
    expect(shownViews([...baseViews, ...tools], doc, store.getState()).map((v) => v.id)).toEqual(['opt', 'annotations', 'reports'])
    expect(store.getState().view).toBe('opt')
    expect(currentView(baseViews, doc, store.getState()).id).toBe('opt')
    // a 10046 view that is asked for is not shown: the 10053 view is
    store.setState({ view: 'statements' })
    expect(currentView(baseViews, doc, store.getState()).id).toBe('opt')
  })

  it('hides the 10053 view from an ordinary document, and from an interleaved one (a 10046 trace with its dumps noted)', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
    Object.assign(doc.diag, { notes: ['2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet'] }) // no `opt`: the engine opens it as 10046
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    const ids = shownViews(baseViews, doc, store.getState()).map((v) => v.id)
    expect(ids).not.toContain('opt')
    expect(ids).toContain('overview')
    expect(store.getState().view).toBe('overview')
  })
})
