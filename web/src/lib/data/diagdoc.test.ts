import { describe, expect, it } from 'vitest'
import { describeFile, releaseOf, sectionCounts, sectionNoun } from './diagdoc'
import { isDumpDoc, isReaderDoc, startView, viewFits } from './optdoc'
import { makeDiagDoc, makeDoc, makeOptDoc, optFileOf } from './testdoc'
import { createStore } from '../state/store'
import { apply, hashOf } from '../shell/urlstate'
import type { DiagFile } from './diag'

const file: DiagFile = { name: 'd.trc', lines: 100, release: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [], outlineTotal: 0 }

describe('what a diag file says it holds', () => {
  const sec = (kind: string) => ({ kind, first: 1, last: 2 })
  it('counts the sections by kind in order of appearance and words them as the Go note does', () => {
    expect(sectionCounts([sec('heap'), sec('procstate'), sec('heap')])).toEqual([{ kind: 'heap', n: 2 }, { kind: 'procstate', n: 1 }])
    expect(describeFile({ sections: [] })).toBe('no diagnostic dump recognised')
    expect(describeFile({ sections: [sec('diagdump')] })).toBe('1 diagnostic dump')
    expect(describeFile({ sections: [sec('heap'), sec('heap'), sec('heap')] })).toBe('3 heap dumps')
    expect(describeFile({ sections: [sec('hang'), sec('hang'), sec('procstate'), sec('sysstate')] })).toBe('2 hang analyses, 1 process state and 1 system state')
    expect(sectionNoun('pga-summary', 2)).toBe('PGA memory summaries')
    expect(sectionNoun('unknown-kind', 1)).toBe('diagnostic dump')
  })

  it('drops the edition suffix of the release', () => {
    expect(releaseOf(file)).toBe('Oracle Database 19c Enterprise Edition Release 19.0.0.0.0')
  })
})

describe('which views a diag document can have', () => {
  it('lets it have the dump view and the tools, and a 10046 or 10053 document neither the dump view nor the other\'s', async () => {
    const dump = await makeDiagDoc({ file })
    const opt = await makeOptDoc({ file: optFileOf(1) })
    const plain = await makeDoc([])
    expect(isDumpDoc(dump)).toBe(true)
    expect(isDumpDoc(plain)).toBe(false)
    expect(isReaderDoc(dump) && isReaderDoc(opt) && !isReaderDoc(plain)).toBe(true)
    for (const v of ['dump', 'annotations', 'reports']) expect(viewFits(dump, v), v).toBe(true)
    for (const v of ['opt', 'overview', 'statements', 'lines', 'compare', 'cut']) expect(viewFits(dump, v), v).toBe(false)
    expect(viewFits(opt, 'dump')).toBe(false)
    expect(viewFits(plain, 'dump')).toBe(false)
    expect(startView(dump)).toBe('dump')
  })

  it('opens a diag tab on the dump view whatever the store held, and never remembers a 10046 view for it', async () => {
    const store = createStore()
    store.setLoaded({ doc: await makeDoc([]), compare: null })
    store.actions.setView('waits')
    store.setLoaded({ doc: await makeDiagDoc({ file }), compare: null })
    expect(store.getState().view).toBe('dump')
    store.actions.setView('waits')
    expect(store.getState().view).toBe('dump')
    store.setLoaded({ doc: await makeDoc([]), compare: null })
    expect(store.getState().view).toBe('overview')
    store.actions.setView('dump')
    expect(store.getState().view).toBe('overview')
  })

  it('takes a request to show a node and a line, each with a new seq', async () => {
    const store = createStore()
    store.setLoaded({ doc: await makeDiagDoc({ file }), compare: null })
    store.actions.openDump({ node: 'n1', line: 42 })
    expect(store.getState().dumpGo).toEqual({ node: 'n1', line: 42, seq: 1 })
    store.actions.openDump({ line: 7 })
    expect(store.getState().dumpGo).toEqual({ line: 7, seq: 2 })
    expect(store.getState().view).toBe('dump')
  })

  it('puts #view=dump in the URL and opens on it, unknown to 10046 documents', async () => {
    const store = createStore()
    const dump = await makeDiagDoc({ file })
    store.setLoaded({ doc: dump, compare: null })
    expect(hashOf(dump, store.getState())).toBe('#view=dump')
    apply(store, dump, '')
    expect(store.getState().view).toBe('dump')
    const plain = await makeDoc([])
    store.setLoaded({ doc: plain, compare: null })
    apply(store, plain, '#view=dump')
    expect(store.getState().view).toBe('overview')
  })
})
