import { describe, expect, it } from 'vitest'
import { annotationsFile, execKey, execNotes, parseAnnotationsFile, stmtNote, stmtRef } from '@lib'
import { createStore } from '@lib/state/store'
import { makeDoc } from '@lib/data/testdoc'
import type { AssistantMessage, Part } from './conversation'
import { citedHashes, citedTargets, noteText, saveNote, targetLabel, targetName } from './answerNote'

async function trace() {
  const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 1 }])
  Object.assign(doc.cursors[0], { statement: 0, line: 118, execs: 3 })
  Object.assign(doc.cursors[1], { statement: 1, line: 200, execs: 1 })
  const store = createStore()
  store.setLoaded({ doc, compare: null })
  return { doc, store }
}

const answer = (...parts: Part[]): AssistantMessage => ({ role: 'assistant', id: 'm1a', at: 1, provider: 'Fake lab', parts, state: 'done' })
const text = (t: string): Part => ({ kind: 'text', text: t })
const intent = (href: string): Part => ({ kind: 'intent', id: 'mcp_1', href, target: { view: 'overview' } })

describe('citedTargets', () => {
  it('names the statements, executions and windows an answer links to, once each, in the order they are written', async () => {
    const { doc } = await trace()
    const base = doc.span.firstTim
    const m = answer(
      text('[sql1](mtkprof:#view=statements&sql=sql1) and [its 2nd run](mtkprof:#view=statements&sql=sql0&exec=118:2), [the same](mtkprof:#sql=sql1) and [a window](mtkprof:#view=timeline&win=100-900).'),
      intent('mtkprof:#view=statements&sql=sql0'),
    )
    const targets = citedTargets(doc, citedHashes(m))
    expect(targets.map((t) => t.key)).toEqual(['s:1', 'e:0:118:2', 'w:100-900', 's:0'])
    expect(targets[1]).toMatchObject({ kind: 'execution', stmt: 0, cursorLine: 118, execNo: 2 })
    expect(targets[2]).toMatchObject({ kind: 'window', from: base + 100, to: base + 900 })
  })

  it('takes the most specific place of a link, and nothing from links that are no object of a note', async () => {
    const { doc } = await trace()
    const hashes = [
      '#view=statements&sql=sql0&exec=118:1&win=100-900', // an execution
      '#view=timeline&sql=sql1&win=100-900', // a statement
      '#view=waits&ev=db+file+sequential+read', '#view=lines&file=0&line=3', '#view=sessions&contexts=0', '#view=waits', '#',
      '#view=statements&sql=nope', '#view=statements&sql=sql0&exec=118:9', '#view=timeline&win=900-100', // not in this trace
    ]
    expect(citedTargets(doc, hashes).map((t) => t.key)).toEqual(['e:0:118:1', 's:1'])
    expect(citedTargets(doc, [])).toEqual([])
  })

  it('collects the links of text, code excluded, and the places it was asked to show', () => {
    const m = answer(text('See [a](mtkprof:#view=waits) and `[b](mtkprof:#view=sessions)`'), intent('mtkprof:#view=statements&sql=sql0'), intent('https://example.com/'), { kind: 'tool', id: 't', name: 'x', args: {} })
    expect(citedHashes(m)).toEqual(['#view=waits', '#view=statements&sql=sql0'])
  })
})

describe('noteText', () => {
  it('writes the links as their labels under a line that says the assistant wrote it', () => {
    const m = answer(
      text('The slowest is [`sql1`](mtkprof:#view=statements&sql=sql1), **80%** of the time.\n\nSee [the docs](https://docs.oracle.com/x).'),
      { kind: 'tool', id: 't', name: 'statements', args: {} },
      text('  Second part, [execution #2](mtkprof:#view=statements&sql=sql0&exec=118:2).  '),
    )
    expect(noteText(m)).toBe(
      'From the assistant (Fake lab):\n\nThe slowest is sql1, **80%** of the time.\n\nSee [the docs](https://docs.oracle.com/x).\n\nSecond part, execution #2.',
    )
  })
})

describe('saveNote', () => {
  it('puts the answer on the statement, as a note the statement view and the Notes view read', async () => {
    const { doc, store } = await trace()
    const [t] = citedTargets(doc, ['#view=statements&sql=sql1'])
    expect(saveNote(store, t, 'It is slow.')).toBe('added')
    const list = store.getState().annotations
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'statement', note: 'It is slow.', stmt: stmtRef(doc.statements[1]) })
    expect(stmtNote(list, stmtRef(doc.statements[1]))).toBe(list[0])
    expect(targetName(doc, t)).toBe('statement sql1')
    expect(targetLabel(doc, t)).toMatch(/^Statement sql1 · /)
    // what the file keeps reads back
    const file = parseAnnotationsFile(JSON.stringify(annotationsFile('id', 'x.trc', list, [])))
    expect(file.skipped).toBe(0)
    expect(file.annotations).toEqual(list)
  })

  it('puts it on an execution by the cursor line and the number, and on a window by its times', async () => {
    const { doc, store } = await trace()
    const [e, w] = citedTargets(doc, ['#view=statements&sql=sql0&exec=118:2', '#view=timeline&win=100-900'])
    saveNote(store, e, 'run two')
    saveNote(store, w, 'the batch')
    const list = store.getState().annotations
    expect(list[0]).toMatchObject({ kind: 'execution', stmt: stmtRef(doc.statements[0]), execNo: 2, cursorLine: 118, note: 'run two' })
    expect(execNotes(list, stmtRef(doc.statements[0])).get(execKey(118, 2))).toBe(list[0])
    expect(list[1]).toMatchObject({ kind: 'window', from: doc.span.firstTim + 100, to: doc.span.firstTim + 900, note: 'the batch' })
    expect(targetName(doc, e)).toBe('execution #2 of sql0')
    expect(targetLabel(doc, e)).toMatch(/^Execution #2 of sql0 · /)
    expect(targetLabel(doc, w)).toBe('Time window +100 µs → +900 µs')
    expect(parseAnnotationsFile(JSON.stringify(annotationsFile('id', 'x.trc', list, []))).skipped).toBe(0)
  })

  it('adds to the note a place has instead of a second one, and not twice', async () => {
    const { doc, store } = await trace()
    const [t] = citedTargets(doc, ['#view=statements&sql=sql0'])
    store.actions.addAnnotation({ id: 'mine', kind: 'statement', note: 'my own note', created: 1, updated: 1, stmt: stmtRef(doc.statements[0]) })
    expect(saveNote(store, t, 'From the assistant:\n\nanswer')).toBe('appended')
    expect(store.getState().annotations).toHaveLength(1)
    expect(store.getState().annotations[0].note).toBe('my own note\n\nFrom the assistant:\n\nanswer')
    expect(saveNote(store, t, 'From the assistant:\n\nanswer')).toBe('present')
    expect(store.getState().annotations[0].note).toBe('my own note\n\nFrom the assistant:\n\nanswer')
  })

  it('does not write a note without a trace', () => {
    expect(() => saveNote(createStore(), { kind: 'statement', key: 's:0', stmt: 0 }, 'x')).toThrow('no trace')
  })
})
