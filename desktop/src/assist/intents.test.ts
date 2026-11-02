import { describe, expect, it } from 'vitest'
import { createStore } from '@lib/state/store'
import { makeDoc } from '@lib/data/testdoc'
import type { Event } from '@lib/data/types'
import { hashOf } from '@lib'
import { navHistoryOf } from '../workspace/session/navHistory'
import type { IntentPart } from './conversation'
import { applyIntent, intentHash, receiveIntent } from './intents'

/** makeDoc's trace (statements sql0 and sql1, four contexts, three files) with cursor lines, executions and a wait event. */
async function trace() {
  const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
  Object.assign(doc, { slice: true })
  Object.assign(doc.cursors[0], { statement: 0, line: 118, execs: 3 })
  Object.assign(doc.cursors[1], { statement: 1, line: 200, execs: 1 })
  doc.events.push({ id: 0, name: 'db file sequential read', class: 'User I/O' } as Event)
  const store = createStore()
  store.setLoaded({ doc, compare: null })
  store.setState({ linesApi: true })
  return { doc, store, nav: navHistoryOf(store) }
}

const intent = (href: string, target: IntentPart['target'], outcome?: IntentPart['outcome']): IntentPart => ({ kind: 'intent', id: 'mcp_1', href, target, outcome })

// every kind of target the show tool sends, with the link the engine makes of it (engine/internal/assist/tools_show_test.go)
const kinds: [string, IntentPart, string][] = [
  ['view', intent('mtkprof:#view=waits', { view: 'waits' }), '#view=waits'],
  ['statement', intent('mtkprof:#view=statements&sql=sql1', { view: 'statements', sql_id: 'sql1' }), '#view=statements&sql=sql1'],
  ['execution', intent('mtkprof:#view=statements&sql=sql0&exec=118:2', { view: 'statements', sql_id: 'sql0', cursorLine: 118, execNo: 2 }), '#view=statements&sql=sql0&exec=118%3A2'],
  ['event', intent('mtkprof:#view=waits&ev=db+file+sequential+read', { view: 'waits', event: 'db file sequential read' }), '#view=waits&ev=db+file+sequential+read'],
  ['window', intent('mtkprof:#view=timeline&win=1200-2400', { view: 'timeline', from: 1200, to: 2400 }), '#view=timeline&win=1200-2400'],
  ['contexts', intent('mtkprof:#view=sessions&contexts=0,3', { view: 'sessions', contexts: [0, 3] }), '#view=sessions&contexts=0%2C3'],
  ['line', intent('mtkprof:#view=lines&file=1&line=42', { view: 'lines', file: 1, line: 42 }), '#view=lines&file=1&line=42'],
  ['pivot', intent('mtkprof:#view=pivot', { view: 'pivot', pivot: { fact: 'waits', by: ['event'], sort: 'ela' } }), '#view=pivot'],
]

describe('applyIntent', () => {
  for (const [kind, it_, canonical] of kinds)
    it(`${kind}: opens ${canonical}`, async () => {
      const { doc, store } = await trace()
      expect(intentHash(it_)).toBe(it_.href.replace('mtkprof:', ''))
      const r = applyIntent(store, it_)
      expect(r).toEqual({ state: 'applied', at: canonical })
      expect(hashOf(doc, store.getState())).toBe(canonical)
    })

  it('selects the statement and the execution of an execution intent', async () => {
    const { store } = await trace()
    applyIntent(store, kinds[2][1])
    expect(store.getState().view).toBe('statements')
    expect(store.getState().selection).toMatchObject({ stmt: 0, exec: { cursor: 0, execNo: 2 } })
  })

  it('sets the Pivot of a pivot intent: fact, dimensions, measure and the one statement or event', async () => {
    const { store } = await trace()
    applyIntent(store, intent('mtkprof:#view=pivot', { view: 'pivot', pivot: { fact: 'waits', by: ['event', 'stmt'], sort: 'max', sql_id: 'sql1', event: 'db file sequential read' } }))
    expect(store.getState().view).toBe('pivot')
    expect(store.getState().pivot).toMatchObject({ fact: 'waits', by: ['event', 'stmt'], stmt: 1, event: 0, notice: null })
    expect(store.getState().pivot.sort).toEqual({ calls: 'e', waits: 'max' })
    // a later intent without a filter clears the old one; a measure left out keeps the sort
    applyIntent(store, intent('mtkprof:#view=pivot', { view: 'pivot', pivot: { fact: 'calls', by: ['kind'] } }))
    expect(store.getState().pivot).toMatchObject({ fact: 'calls', by: ['kind'], stmt: null, event: null })
    expect(store.getState().pivot.sort).toEqual({ calls: 'e', waits: 'max' })
  })

  it('keeps the views in the history before it moves them, even when it changes only the window', async () => {
    const { doc, store, nav } = await trace()
    const base = doc.span.firstTim
    store.actions.setView('timeline')
    store.actions.setWindow({ startTim: 1100, endTim: 1200 })
    const before = hashOf(store.getState().doc!, store.getState())
    expect(nav.current).toBe(before)
    const r = applyIntent(store, intent('mtkprof:#view=timeline&win=1200-2400', { view: 'timeline', from: 1200, to: 2400 }))
    expect(r).toMatchObject({ state: 'applied' })
    expect(store.getState().window).toEqual({ startTim: base + 1200, endTim: base + 2400 })
    expect(nav.current).toBe((r as { at: string }).at)
    nav.back() // one step, not the entry before the window was brushed
    expect(store.getState().view).toBe('timeline')
    expect(store.getState().window).toEqual({ startTim: 1100, endTim: 1200 })
  })

  it('makes a first pick of a statement an entry of its own', async () => {
    const { store, nav } = await trace()
    store.actions.setView('statements')
    expect(store.getState().selection.stmt).toBeNull()
    applyIntent(store, kinds[1][1])
    expect(store.getState().selection.stmt).toBe(1)
    nav.back()
    expect(store.getState().view).toBe('statements')
    expect(store.getState().selection.stmt).toBeNull()
  })

  it('returns to the previous view, selection and window with Back, and forward moves again', async () => {
    const { doc, store, nav } = await trace()
    store.actions.setView('statements')
    store.actions.selectStmt(0)
    store.actions.setWindow({ startTim: 1100, endTim: 1300 })
    const before = { view: store.getState().view, selection: store.getState().selection, window: store.getState().window }
    applyIntent(store, kinds[4][1])
    expect(store.getState().view).toBe('timeline')
    expect(nav.canBack).toBe(true)
    nav.back()
    expect(store.getState()).toMatchObject(before)
    nav.forward()
    expect(store.getState().view).toBe('timeline')
    expect(store.getState().window).toEqual({ startTim: doc.span.firstTim + 1200, endTim: doc.span.firstTim + 2400 })
  })

  it('keeps the entry Back returns to after a Back that has not settled', async () => {
    const { store, nav } = await trace()
    store.actions.setView('waits')
    store.actions.setView('sessions')
    nav.back() // the views settle on `waits` without a user input after this
    applyIntent(store, kinds[1][1])
    expect(nav.canBack).toBe(true)
    nav.back()
    expect(store.getState().view).toBe('waits')
  })

  it('leaves the store and the history as they are for a target the trace does not have', async () => {
    const { store, nav } = await trace()
    store.actions.setView('waits')
    const before = store.getState()
    const entry = nav.current
    const canBack = nav.canBack
    const bad: [IntentPart, string[]][] = [
      [intent('mtkprof:#view=statements&sql=nope', { view: 'statements', sql_id: 'nope' }), ['sql']],
      [intent('mtkprof:#view=statements&sql=sql0&exec=118:9', { view: 'statements', sql_id: 'sql0', cursorLine: 118, execNo: 9 }), ['exec']],
      [intent('mtkprof:#view=waits&ev=no+such+wait', { view: 'waits', event: 'no such wait' }), ['ev']],
      [intent('mtkprof:#view=sessions&contexts=12', { view: 'sessions', contexts: [12] }), ['contexts']],
      [intent('mtkprof:#view=lines&file=7&line=1', { view: 'lines', file: 7, line: 1 }), ['file']],
      [intent('mtkprof:#view=pivot', { view: 'pivot', pivot: { fact: 'calls', by: ['nope'] } }), ['pivot']],
      [intent('mtkprof:#view=pivot', { view: 'pivot', pivot: { fact: 'calls', by: ['stmt'], sort: 'ela' } }), ['pivot']],
      [intent('mtkprof:#view=pivot', { view: 'pivot', pivot: { fact: 'waits', by: ['event'], sql_id: 'nope', event: 'no such wait' } }), ['sql', 'ev']],
      [intent('https://example.com/', { view: 'overview' }), []],
      [intent('javascript:alert(1)', { view: 'overview' }), []],
      [intent('', { view: 'overview' }), []],
    ]
    for (const [it_, keys] of bad) {
      expect(applyIntent(store, it_), it_.href).toEqual({ state: 'unresolved', keys })
      expect(store.getState(), it_.href).toBe(before)
      expect(nav.current).toBe(entry)
    }
    expect(nav.canBack).toBe(canBack)
  })

  it('does nothing without a document', () => {
    const store = createStore()
    expect(applyIntent(store, kinds[0][1])).toEqual({ state: 'unresolved', keys: [] })
  })
})

describe('receiveIntent', () => {
  it('moves the views at once, or only offers the move when asked to ask first', async () => {
    const { store, nav } = await trace()
    const before = store.getState()
    expect(receiveIntent(store, kinds[1][1], true)).toEqual({ state: 'pending' })
    expect(store.getState()).toBe(before)
    expect(nav.canBack).toBe(false)
    expect(receiveIntent(store, kinds[1][1], false)).toMatchObject({ state: 'applied' })
    expect(store.getState().selection.stmt).toBe(1)
  })

  it('does not offer a move to a place the trace does not have', async () => {
    const { store } = await trace()
    const before = store.getState()
    expect(receiveIntent(store, intent('mtkprof:#view=statements&sql=nope', { view: 'statements', sql_id: 'nope' }), true)).toEqual({ state: 'unresolved', keys: ['sql'] })
    expect(store.getState()).toBe(before)
  })
})
