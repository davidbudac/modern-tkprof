import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store'
import { makeDoc } from '../data/testdoc'
import { baseViews, currentView, shownViews, type SessionViewDef } from './views'

describe('baseViews', () => {
  it('lists the eight views in nav order with their labels and digits', () => {
    expect(baseViews.map((v) => [v.id, v.label, v.key])).toEqual([
      ['compare', 'Compare', 0], ['overview', 'Overview', 1], ['lines', 'Trace', 2], ['statements', 'Statements', 3],
      ['waits', 'Waits', 4], ['timeline', 'Timeline', 5], ['sessions', 'Sessions', 6], ['pivot', 'Pivot', 7],
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
    expect(ids).toEqual(['overview', 'statements', 'waits', 'timeline', 'sessions', 'pivot', 'annotations'])
    store.setState({ view: 'lines' })
    expect(currentView(baseViews, doc, store.getState()).id).toBe('overview') // not shown: Overview instead
    store.setState({ view: 'waits' })
    expect(currentView(baseViews, doc, store.getState())).toBe(baseViews[4])
  })
})
