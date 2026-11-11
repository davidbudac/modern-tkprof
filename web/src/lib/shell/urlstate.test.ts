import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store'
import { makeDoc, makeOptDoc, optFileOf } from '../data/testdoc'
import type { Event } from '../data/types'
import { apply, hashOf, unresolved } from './urlstate'

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
    apply(store, doc, '#files=0&contexts=0,3')
    expect([...store.getState().contexts!]).toEqual([0])
  })
})

/** makeDoc's trace with statement 0's cursor opened at line 118 (three executions) and one wait event. */
async function linkDoc() {
  const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
  Object.assign(doc, { slice: true })
  Object.assign(doc.cursors[0], { statement: 0, line: 118, execs: 3 })
  Object.assign(doc.cursors[1], { statement: 1, line: 200, execs: 1 })
  doc.events.push({ id: 0, name: 'db file sequential read', class: 'User I/O' } as Event)
  const store = createStore()
  store.setLoaded({ doc, compare: null })
  store.setState({ linesApi: true })
  return { doc, store }
}

describe('URL hash: the mtkprof: link grammar (exec=, contexts=)', () => {
  it('round trips every key of a link', async () => {
    const { doc, store } = await linkDoc()
    const links = [
      '#view=statements&sql=sql0',
      '#view=statements&sql=sql0&exec=118%3A3',
      '#view=waits&ev=db+file+sequential+read&win=1200-2400',
      '#view=sessions&contexts=0%2C3',
      '#view=lines&file=1&line=42',
      '#sql=%401&ev=db+file+sequential+read',
    ]
    for (const h of links) {
      apply(store, doc, h)
      expect(unresolved(doc, h), h).toEqual([])
      expect(hashOf(doc, store.getState()), h).toBe(h.startsWith('#sql=') ? '#view=statements&sql=sql1&ev=db+file+sequential+read' : h)
    }
  })

  it('drops the I/O map zoom: it lay inside the window the link replaces', async () => {
    const { doc, store } = await linkDoc()
    store.actions.zoomIO({ range: { startTim: 10, endTim: 20 }, blocks: {} })
    apply(store, doc, '#view=blocks&win=0-500')
    expect(store.getState().view).toBe('blocks')
    expect(store.getState().ioZoom).toEqual([])
  })

  it('reads the form the assistant writes: commas, colons and + unescaped', async () => {
    const { doc, store } = await linkDoc()
    apply(store, doc, '#view=statements&sql=sql0&exec=118:2&contexts=1,3&win=0-500')
    const s = store.getState()
    expect(s.selection).toEqual({ stmt: 0, event: null, call: null, exec: { cursor: 0, execNo: 2 } })
    expect([...s.contexts!]).toEqual([1, 3])
    expect(s.window).toEqual({ startTim: doc.span.firstTim, endTim: doc.span.firstTim + 500 })
  })

  it('drops an execution of another statement or beyond the cursor, and contexts the trace lacks', async () => {
    const { doc, store } = await linkDoc()
    for (const h of ['#sql=sql0&exec=200:1', '#sql=sql0&exec=118:4', '#sql=sql0&exec=118:0', '#exec=118:1']) {
      apply(store, doc, h)
      expect(store.getState().selection.exec, h).toBeNull()
      expect(unresolved(doc, h), h).toContain('exec')
    }
    apply(store, doc, '#contexts=1,9')
    expect([...store.getState().contexts!]).toEqual([1])
    apply(store, doc, '#contexts=9')
    expect(store.getState().contexts).toBeNull()
    apply(store, doc, '#view=waits') // no contexts in the hash: all of them
    expect(store.getState().contexts).toBeNull()
  })

  it('names what does not resolve', async () => {
    const { doc } = await linkDoc()
    expect(unresolved(doc, '#view=nope&sql=zzz&ev=no+such+event&win=5-1&contexts=7&files=9&file=5&line=0')).toEqual(
      ['view', 'sql', 'ev', 'win', 'contexts', 'files', 'file', 'line'])
    expect(unresolved(doc, '#sql=@2')).toEqual(['sql'])
    expect(unresolved(doc, '#sql=@1x')).toEqual(['sql'])
    expect(unresolved(doc, '#view=lines&line=101')).toEqual(['line']) // qc.trc has 100 lines
    expect(unresolved(doc, '#view=overview&foo=bar')).toEqual([])
  })

  it('leaves exec out of the hash once another statement is selected', async () => {
    const { doc, store } = await linkDoc()
    apply(store, doc, '#sql=sql0&exec=118:1')
    store.actions.pickStmt(1)
    expect(hashOf(doc, store.getState())).toBe('#view=statements&sql=sql1')
  })
})

describe('URL hash: the 10053 view', () => {
  const file = optFileOf(3)

  it('is the only view of a 10053 document: any other view in a link opens it, the dump is part of the hash', async () => {
    const doc = await makeOptDoc({ file })
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    expect(hashOf(doc, store.getState())).toBe('#view=opt')
    store.actions.openOpt(2, 55)
    store.actions.setOptDump(2)
    expect(hashOf(doc, store.getState())).toBe('#view=opt&dump=2')

    const other = createStore()
    other.setLoaded({ doc, compare: null })
    apply(other, doc, '#view=opt&dump=1')
    expect(other.getState().view).toBe('opt')
    expect(other.getState().optDump).toBe(1)
    expect(other.getState().optGo).toMatchObject({ dump: 1 })
    apply(other, doc, '#view=waits&sql=abc')
    expect(other.getState().view).toBe('opt')
    apply(other, doc, '') // Back to a hash without a dump: the first
    expect(other.getState().optDump).toBe(0)
    apply(other, doc, '#view=opt&dump=9') // no such dump
    expect(other.getState().optDump).toBe(0)
  })

  it('does not let an ordinary document have the 10053 view', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    apply(store, doc, '#view=opt&dump=1')
    expect(store.getState().view).toBe('overview')
    expect(hashOf(doc, store.getState())).toBe('')
  })

  it('names the keys a document does not have', async () => {
    const opt = await makeOptDoc({ file })
    const plain = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
    expect(unresolved(opt, '#view=opt&dump=1')).toEqual([])
    expect(unresolved(opt, '#view=opt&dump=3')).toEqual(['dump'])
    expect(unresolved(opt, '#view=waits')).toEqual(['view'])
    expect(unresolved(plain, '#view=opt')).toEqual(['view'])
  })
})
