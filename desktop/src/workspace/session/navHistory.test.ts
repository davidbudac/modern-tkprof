import { describe, expect, it } from 'vitest'
import { createStore, type Store } from '@lib/state/store'
import { makeDoc } from '@lib/data/testdoc'
import { NavHistory, navHistoryOf, noteUserInput } from './navHistory'

const calls = [{ ctx: 0, stmt: 0, kind: 2, e: 1 }, { ctx: 0, stmt: 1, kind: 2, e: 1 }]

async function setup(): Promise<{ store: Store; nav: NavHistory }> {
  const store = createStore()
  store.setLoaded({ doc: await makeDoc(calls), compare: null })
  return { store, nav: new NavHistory(store) }
}

describe('NavHistory', () => {
  it('starts without anywhere to go', async () => {
    const { nav } = await setup()
    expect(nav.canBack).toBe(false)
    expect(nav.canForward).toBe(false)
  })

  it('pushes on a view change; back and forward restore view and selection', async () => {
    const { store, nav } = await setup()
    store.actions.setView('waits')
    store.actions.selectStmt(1)
    expect(store.getState().view).toBe('statements')
    expect(nav.canBack).toBe(true)
    nav.back()
    expect(store.getState().view).toBe('waits')
    expect(store.getState().selection.stmt).toBeNull()
    expect(nav.canForward).toBe(true)
    nav.back()
    expect(store.getState().view).toBe('overview')
    expect(nav.canBack).toBe(false)
    nav.forward()
    nav.forward()
    expect(store.getState().view).toBe('statements')
    expect(store.getState().selection.stmt).toBe(1)
    expect(nav.canForward).toBe(false)
  })

  it('replaces the entry when only the window changes', async () => {
    const { store, nav } = await setup()
    store.actions.setView('timeline')
    store.actions.setWindow({ startTim: 1100, endTim: 1200 })
    store.actions.setWindow({ startTim: 1100, endTim: 1500 })
    nav.back() // one step: the window did not add entries
    expect(store.getState().view).toBe('overview')
    expect(nav.canBack).toBe(false)
    nav.forward()
    expect(store.getState().view).toBe('timeline')
    expect(store.getState().window).toEqual({ startTim: 1100, endTim: 1500 })
  })

  it('replaces the entry when the first statement is picked', async () => {
    const { store, nav } = await setup()
    store.actions.setView('statements')
    store.actions.selectStmt(0)
    store.actions.selectStmt(1)
    nav.back()
    expect(store.getState().selection.stmt).toBe(0)
    nav.back()
    expect(store.getState().view).toBe('overview')
  })

  it('drops the forward entries on a new push', async () => {
    const { store, nav } = await setup()
    store.actions.setView('waits')
    store.actions.setView('timeline')
    nav.back()
    expect(nav.canForward).toBe(true)
    noteUserInput()
    store.actions.setView('sessions')
    expect(nav.canForward).toBe(false)
    nav.back()
    expect(store.getState().view).toBe('waits')
  })

  it('keeps the history through a new document of the same trace without applying anything', async () => {
    const { store, nav } = await setup()
    store.actions.setView('waits')
    store.actions.setView('timeline')
    const next = await makeDoc(calls)
    store.swapDoc({ doc: next, compare: null })
    expect(store.getState().doc).toBe(next)
    expect(store.getState().view).toBe('timeline')
    expect(nav.canBack).toBe(true)
    nav.back()
    expect(store.getState().view).toBe('waits')
    expect(store.getState().doc).toBe(next)
    nav.back()
    expect(store.getState().view).toBe('overview')
    expect(nav.canBack).toBe(false)
  })

  it('does not record what the views write on their own after back()', async () => {
    const { store, nav } = await setup()
    store.actions.setView('statements')
    store.actions.selectStmt(0)
    store.actions.setView('waits')
    noteUserInput()
    nav.back()
    store.actions.pickStmt(1) // a view re-picking a row once its stats arrive
    store.actions.setView('timeline')
    expect(nav.canForward).toBe(true)
    nav.forward()
    expect(store.getState().view).toBe('waits')
    expect(nav.canForward).toBe(false)
    nav.back()
    expect(store.getState().view).toBe('statements')
    expect(store.getState().selection.stmt).toBe(0)
  })

  it('records again, dropping the forward entries, after the next user input', async () => {
    const { store, nav } = await setup()
    store.actions.setView('waits')
    store.actions.setView('timeline')
    nav.back()
    store.actions.pickStmt(1) // settling
    expect(nav.canForward).toBe(true)
    noteUserInput()
    store.actions.setView('sessions')
    expect(nav.canForward).toBe(false)
    nav.back()
    expect(store.getState().view).toBe('waits')
    expect(nav.canForward).toBe(true)
  })

  it('restores the desktop views Notes and Reports', async () => {
    const { store, nav } = await setup()
    store.actions.setView('annotations')
    store.actions.setView('reports')
    store.actions.setView('waits')
    noteUserInput()
    nav.back()
    expect(store.getState().view).toBe('reports')
    nav.back()
    expect(store.getState().view).toBe('annotations')
    expect(nav.canBack).toBe(true)
    nav.forward()
    nav.forward()
    expect(store.getState().view).toBe('waits')
  })

  it('does nothing going back at the start or forward at the end', async () => {
    const { store, nav } = await setup()
    const before = store.getState()
    nav.back()
    nav.forward()
    expect(store.getState()).toBe(before)
    store.actions.setView('waits')
    nav.forward()
    expect(store.getState().view).toBe('waits')
  })

  it('caps the entries', async () => {
    const { store, nav } = await setup()
    for (let i = 0; i < 150; i++) store.actions.setView(i % 2 ? 'waits' : 'timeline')
    let steps = 0
    while (nav.canBack) { nav.back(); steps++ }
    expect(steps).toBe(99)
  })

  it('tells subscribers when the buttons change', async () => {
    const { store, nav } = await setup()
    let n = 0
    nav.subscribe(() => n++)
    const first = nav.getSnapshot()
    store.actions.setView('waits')
    expect(n).toBe(1)
    expect(nav.getSnapshot()).not.toBe(first)
    expect(nav.getSnapshot()).toEqual({ canBack: true, canForward: false })
  })

  it('records a move nobody clicked as an entry of its own, after the views as they stand', async () => {
    const { store, nav } = await setup()
    store.actions.setView('timeline')
    store.actions.setWindow({ startTim: 1100, endTim: 1200 })
    nav.move(() => store.actions.setWindow({ startTim: 1100, endTim: 1500 })) // only the window: a click would replace the entry
    expect(nav.current).toBe('#view=timeline&win=100-500')
    nav.back()
    expect(store.getState().window).toEqual({ startTim: 1100, endTim: 1200 })
    nav.back()
    expect(store.getState().view).toBe('overview')
  })

  it('makes one entry of a move, however many writes it takes, and then records as before', async () => {
    const { store, nav } = await setup()
    nav.move(() => {
      store.actions.setView('statements')
      store.actions.selectStmt(1)
      store.actions.setWindow({ startTim: 1100, endTim: 1200 })
    })
    let steps = 0
    noteUserInput()
    store.actions.setWindow({ startTim: 1100, endTim: 1300 }) // a brush after the move replaces its entry
    while (nav.canBack) { nav.back(); steps++ }
    expect(steps).toBe(1)
    expect(store.getState().view).toBe('overview')
  })

  it('does not record a move that changes nothing, and runs the change without a document', async () => {
    const { store, nav } = await setup()
    nav.move(() => store.actions.setView('overview'))
    expect(nav.canBack).toBe(false)
    const bare = new NavHistory(createStore())
    let ran = false
    bare.move(() => { ran = true })
    expect(ran).toBe(true)
    expect(bare.current).toBe('')
  })

  it('gives one history per store', async () => {
    const { store } = await setup()
    expect(navHistoryOf(store)).toBe(navHistoryOf(store))
  })
})
