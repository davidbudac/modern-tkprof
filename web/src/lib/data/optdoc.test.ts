import { describe, expect, it } from 'vitest'
import { dumpOfLine, isOptDoc, lineLabel, optFacts, startView, viewFits } from './optdoc'
import { makeDoc, makeOptDoc, optFileOf } from './testdoc'
import { createStore } from '../state/store'
import type { Marker } from './types'

const file = optFileOf(3) // dumps at lines 10-29, 30-49, 50-69

describe('which views a document can have', () => {
  it('lets a 10053 document have the 10053 view and the tools, a 10046 one everything but the 10053 view', async () => {
    const opt = await makeOptDoc({ file })
    const plain = await makeDoc([])
    expect(isOptDoc(opt)).toBe(true)
    expect(isOptDoc(plain)).toBe(false)
    for (const v of ['opt', 'annotations', 'reports']) expect(viewFits(opt, v), v).toBe(true)
    for (const v of ['overview', 'statements', 'lines', 'compare', 'cut', 'blocks']) expect(viewFits(opt, v), v).toBe(false)
    for (const v of ['overview', 'statements', 'lines', 'annotations', 'cut']) expect(viewFits(plain, v), v).toBe(true)
    expect(viewFits(plain, 'opt')).toBe(false)
    expect(startView(opt)).toBe('opt')
    expect(startView(plain)).toBe('overview')
  })
})

describe('the remembered view', () => {
  it('opens a 10053 tab on the 10053 view and a 10046 tab on the Overview, whatever the store held before', async () => {
    const store = createStore()
    const opt = await makeOptDoc({ file })
    const plain = await makeDoc([])
    store.setLoaded({ doc: plain, compare: null })
    store.actions.setView('waits')
    store.setLoaded({ doc: opt, compare: null }) // the same store holds another document: nothing of the old view carries over
    expect(store.getState().view).toBe('opt')
    store.setLoaded({ doc: plain, compare: null })
    expect(store.getState().view).toBe('overview')
  })

  it('ignores a view the document cannot have, so 10053 is never the view of a 10046 tab nor Waits that of a 10053 tab', async () => {
    const store = createStore()
    store.setLoaded({ doc: await makeDoc([]), compare: null })
    store.actions.setView('opt')
    expect(store.getState().view).toBe('overview')
    store.actions.setView('waits')
    expect(store.getState().view).toBe('waits')
    const s2 = createStore()
    s2.setLoaded({ doc: await makeOptDoc({ file }), compare: null })
    s2.actions.setView('waits')
    expect(s2.getState().view).toBe('opt')
    s2.actions.setView('annotations')
    expect(s2.getState().view).toBe('annotations')
  })

  it('swapDoc (a newer document of the same trace) keeps a fitting view and replaces one that does not fit', async () => {
    const store = createStore()
    const opt = await makeOptDoc({ file })
    store.setLoaded({ doc: opt, compare: null })
    store.actions.openOpt(2)
    store.swapDoc({ doc: await makeOptDoc({ file }), compare: null })
    expect(store.getState().view).toBe('opt')
    expect(store.getState().optDump).toBe(2)
    store.swapDoc({ doc: await makeOptDoc({ file: optFileOf(1) }), compare: null }) // fewer dumps: the open one is clamped
    expect(store.getState().optDump).toBe(0)
    store.swapDoc({ doc: await makeDoc([]), compare: null })
    expect(store.getState().view).toBe('overview')
  })

  it('openOpt switches to the view and makes a new request each time', async () => {
    const store = createStore()
    store.setLoaded({ doc: await makeOptDoc({ file }), compare: null })
    store.actions.openOpt(1, 40)
    expect(store.getState().optGo).toEqual({ dump: 1, line: 40, seq: 1 })
    store.actions.openOpt(1, 40)
    expect(store.getState().optGo).toEqual({ dump: 1, line: 40, seq: 2 })
    store.actions.openOpt(0)
    expect(store.getState().optGo).toEqual({ dump: 0, seq: 3 })
    store.actions.setOptDump(2)
    expect(store.getState().optDump).toBe(2)
  })
})

describe('lines of the file among the dumps', () => {
  it('finds the dump of a line and labels a bookmark with it', () => {
    expect(dumpOfLine(file, 10)).toBe(0)
    expect(dumpOfLine(file, 49)).toBe(1)
    expect(dumpOfLine(file, 9)).toBeNull()
    expect(dumpOfLine(file, 70)).toBeNull()
    expect(lineLabel(file, 55)).toBe('dump 3 · sqlid2')
    expect(lineLabel(file, 3)).toBe('')
  })
})

describe('the masthead facts of a 10053 file', () => {
  const mk = (text: string): Marker => ({ line: 1, kind: 0, text, time: '', hasTime: false })
  it('takes the release and version, and the session and pluggable database from the markers', async () => {
    const doc = await makeOptDoc({ file })
    Object.assign(doc, { markers: [mk('*** 2026-11-11T12:12:59.670506+00:00 (PDB1(3))'), mk('*** SESSION ID:(237.40646) 2026-11-11T12:12:59.670521+00:00'), mk('*** MODULE NAME:(x)')] })
    expect(optFacts(doc)).toEqual({ release: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0', version: '19.27.0.0.0', session: '237.40646', pdb: 'PDB1 (container 3)' })
  })
  it('reads the pluggable database from the marker text the parser gives (PDB1(3)) as well', async () => {
    const doc = await makeOptDoc({ file })
    Object.assign(doc, { markers: [mk('PDB1(3)')] })
    expect(optFacts(doc).pdb).toBe('PDB1 (container 3)')
  })
  it('is empty of session and pdb without markers', async () => {
    const f = optFacts(await makeOptDoc({ file }))
    expect([f.session, f.pdb]).toEqual(['', ''])
  })
})
