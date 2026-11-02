import { describe, expect, it } from 'vitest'
import { createStore } from '@lib/state/store'
import { makeDoc } from '@lib/data/testdoc'
import type { Event } from '@lib/data/types'
import { hashOf } from '@lib'
import { chipOf, linkOf, openChip, unresolvedText } from './links'

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
  return { doc, store }
}

describe('linkOf', () => {
  it('knows mtkprof: and https: links and nothing else', () => {
    expect(linkOf('mtkprof:#view=statements&sql=abc')).toEqual({ kind: 'mtkprof', hash: '#view=statements&sql=abc' })
    expect(linkOf(' MTKPROF:view=waits ')).toEqual({ kind: 'mtkprof', hash: '#view=waits' })
    expect(linkOf('https://docs.oracle.com/x?y=1')).toEqual({ kind: 'https', href: 'https://docs.oracle.com/x?y=1' })
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'http://example.com', 'data:text/html,x', '/relative', '//host/x', 'file:///etc/hosts', 'vbscript:x', 'https:', ''])
      expect(linkOf(bad), bad).toBeNull()
  })
})

describe('chips round-trip through urlstate', () => {
  // every kind of link the system prompt names, in the form the assistant writes it, and the hash the store then stands for
  const cases: [string, string, string][] = [
    ['view', 'mtkprof:#view=waits', '#view=waits'],
    ['sql', 'mtkprof:#view=statements&sql=sql1', '#view=statements&sql=sql1'],
    ['sql', 'mtkprof:#sql=@1', '#view=statements&sql=sql1'],
    ['exec', 'mtkprof:#view=statements&sql=sql0&exec=118:2', '#view=statements&sql=sql0&exec=118%3A2'],
    ['event', 'mtkprof:#view=waits&ev=db+file+sequential+read', '#view=waits&ev=db+file+sequential+read'],
    ['window', 'mtkprof:#view=timeline&win=1200-2400', '#view=timeline&win=1200-2400'],
    ['contexts', 'mtkprof:#view=sessions&contexts=0,3', '#view=sessions&contexts=0%2C3'],
    ['line', 'mtkprof:#view=lines&file=1&line=42', '#view=lines&file=1&line=42'],
  ]
  for (const [kind, href, canonical] of cases)
    it(`${kind}: ${href}`, async () => {
      const { doc, store } = await trace()
      const link = linkOf(href)
      expect(link?.kind).toBe('mtkprof')
      const hash = (link as { hash: string }).hash
      expect(chipOf(doc, hash)).toEqual({ hash, kind, unresolved: [] })
      expect(openChip(store, hash)).toBe(true)
      const after = hashOf(doc, store.getState())
      expect(after).toBe(canonical)
      // and the canonical form is a link to the same place
      expect(chipOf(doc, after).unresolved).toEqual([])
    })

  it('selects the statement and the execution of an exec chip', async () => {
    const { doc, store } = await trace()
    openChip(store, '#view=statements&sql=sql0&exec=118:3')
    expect(store.getState().view).toBe('statements')
    expect(store.getState().selection).toMatchObject({ stmt: 0, exec: { cursor: 0, execNo: 3 } })
    expect(doc.statements[0].sqlId).toBe('sql0')
  })

  it('leaves the store as it is for a target the trace does not have', async () => {
    const { doc, store } = await trace()
    openChip(store, '#view=waits')
    const before = store.getState()
    for (const hash of ['#view=statements&sql=nope', '#sql=sql0&exec=118:9', '#view=waits&ev=no+such+wait', '#contexts=12', '#view=lines&file=7&line=1', '#view=nowhere']) {
      const chip = chipOf(doc, hash)
      expect(chip.unresolved.length, hash).toBeGreaterThan(0)
      expect(openChip(store, hash), hash).toBe(false)
      expect(store.getState()).toBe(before)
    }
    expect(unresolvedText(chipOf(doc, '#sql=nope&exec=1:1').unresolved)).toBe('Not in this trace: statement, execution')
  })
})
