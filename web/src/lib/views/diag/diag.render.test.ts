import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { DiagFile, DiagNode } from '../../data/diag'
import { DiagOutlineStore } from '../../data/diagoutline'
import { memoryDiagSource } from '../../data/diag'
import { DiagOutline, heapIndent } from './DiagOutline'
import { DiagGuide, md } from './DiagGuide'
import { DiagFacts } from './DiagFacts'
import { readingView, registerReading, registeredReadings, unregisterReading } from './readings'

const node = (id: string, from: number, to: number, kids = false, extra: Partial<DiagNode> = {}): DiagNode => ({ id, kind: 'title', title: id, from, to, lines: to - from + 1, hasChildren: kids, ...extra })
const file = (extra: Partial<DiagFile> = {}): DiagFile => ({ name: 'e.trc', lines: 36651, release: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [{ kind: 'diagdump', first: 32, last: 36651 }], unplaced: 0, outline: [], outlineTotal: 0, ...extra })
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('the outline', () => {
  const top = [node('a', 1, 100, true, { title: 'Diagnostic dump (level 2)', sub: 'Starting a non-incident diagnostic dump' }), node('b', 101, 200, false, { title: 'Dump', cut: true })]
  const store = new DiagOutlineStore(memoryDiagSource({ ...file(), outline: top, outlineTotal: 5 }, { a: [node('a1', 1, 50, false, { title: 'Call Stack Trace' })] }, ['x']))
  const draw = (sel: string | null, hits: number[] | null = null) => html(createElement(DiagOutline, { rows: store.rows(), selected: sel, path: new Set<string>(), hits, digest: false, onSelect: () => {}, onToggle: () => {}, onMore: () => {} }))

  it('draws the nodes with their titles, line counts and second lines, a tag for a dump without an end line, and a tree role', () => {
    const h = draw(null)
    expect(h).toContain('role="tree"')
    expect(h).toContain('Diagnostic dump (level 2)')
    expect(h).toContain('Starting a non-incident diagnostic dump')
    expect(h).toContain('>100<')
    expect(h).toContain('no end line')
    expect(h).toContain('aria-level="1"')
  })

  it('draws "N of M shown · load more" where the top level is not all there', () => {
    expect(draw(null)).toContain('2 of 5 shown · load more')
  })

  it('marks the selected node and shows hits inside nodes', () => {
    const h = draw('a', [5, 6, 150])
    expect(h).toMatch(/opt-ol-row on[^"]*"[^>]*aria-selected="true"/)
    expect(h).toContain('title="2 search hits"')
    expect(h).toContain('title="1 search hit"')
  })

  it('indents the heap dumps of the top level by their depth, so the sub-heaps read as children of their heap; a nested heap keeps the level of its place', () => {
    const heaps = [node('h0', 1, 10, false, { kind: 'heap', title: 'Heap dump: pga heap', depth: 0 }), node('h1', 11, 20, false, { kind: 'heap', title: 'Heap dump: koh-kghu call', depth: 1 }), node('h2', 21, 30, false, { kind: 'heap', title: 'Heap dump: deep', depth: 2 })]
    const s = new DiagOutlineStore(memoryDiagSource({ ...file(), outline: heaps, outlineTotal: 3 }, {}, ['x']))
    const h = html(createElement(DiagOutline, { rows: s.rows(), selected: null, path: new Set<string>(), hits: null, digest: false, onSelect: () => {}, onToggle: () => {}, onMore: () => {} }))
    expect(h).toMatch(/style="--d:0"[^>]*aria-level="1"[^>]*data-node="h0"/)
    expect(h).toMatch(/style="--d:1"[^>]*aria-level="2"[^>]*data-node="h1"/)
    expect(h).toMatch(/style="--d:2"[^>]*aria-level="3"[^>]*data-node="h2"/)
    expect(heapIndent(heaps[1], 0)).toBe(1)
    expect(heapIndent(heaps[1], 1)).toBe(0)
    expect(heapIndent(node('t', 1, 2), 0)).toBe(0)
    expect(heapIndent(node('x', 1, 2, false, { kind: 'heap', depth: 99 }), 0)).toBe(6)
  })

  it('draws the children of an open node one level down', async () => {
    await store.openNode('a')
    const h = draw('a1')
    expect(h).toContain('Call Stack Trace')
    expect(h).toContain('aria-level="2"')
    expect(h).toContain('aria-expanded="true"')
  })
})

describe('the guide', () => {
  const draw = (n: DiagNode | null, o: { selected?: boolean; hits?: number | null; q?: string; digest?: boolean } = {}) =>
    html(createElement(DiagGuide, { node: n, selected: o.selected ?? true, hits: o.hits ?? null, q: o.q ?? '', digest: o.digest ?? false, onGo: () => {} }))
  afterEach(() => unregisterReading('callstack'))

  it('says what is selected, its lines, kind, children and reading, with the sourced text and its source', () => {
    const h = draw(node('t', 50, 187, false, { kind: 'title', title: 'Call Stack Trace' }))
    expect(h).toContain('Selected')
    expect(h).toContain('Call Stack Trace')
    expect(h).toContain('138')
    expect(h).toContain('none for this kind of section')
    expect(h).toContain('docs/trace-format-diag.md')
    expect(h).toContain('A diagnostic dump: error stack, call stack, process state')
  })

  it('is silent for a kind it has no text for, and asks for a selection when there is none', () => {
    expect(draw(node('b', 1, 5, false, { kind: 'banner', title: 'X' }))).toContain('No guide text for this kind of section')
    expect(draw(null)).toContain('Select a part in the outline')
  })

  it('says the node is only the one at the top of the text when nothing is selected', () => {
    expect(draw(node('t', 1, 5), { selected: false })).toContain('At the top of the text')
  })

  it('lists the reading of a node, and whether this version can show it', () => {
    const n = node('h', 32, 923, true, { kind: 'heap', title: 'Heap dump: pga heap', name: 'pga heap', depth: 0, size: 4707160, reading: 'callstack' })
    expect(draw(n)).toContain('this version has no view for it')
    registerReading('callstack', () => null)
    expect(draw(n)).toContain('(centre, Reading)')
    expect(draw(n)).toContain('pga heap')
    expect(draw(n)).toContain('4.5 MB')
  })

  it('shows the search hits inside the node while a search is on', () => {
    expect(draw(node('t', 1, 5), { hits: 12, q: 'ksedst' })).toContain('12 for')
    expect(draw(node('t', 1, 5), { hits: 12, q: '' })).not.toContain('Hits')
  })

  it('shows the line number as plain text where there is no text to go to (the standalone report)', () => {
    expect(draw(node('t', 50, 60), { digest: true })).not.toContain('Go to line')
    expect(draw(node('t', 50, 60))).toContain('Go to line 50')
  })

  it('renders backticks as code and double stars as bold', () => {
    expect(html(createElement('p', null, ...md('a `b` and **c**')))).toBe('<p>a <code>b</code> and <b>c</b></p>')
  })
})

describe('the facts bar', () => {
  const draw = (f: DiagFile, onOpen?: () => void) => html(createElement(DiagFacts, { file: f, onOpenAs10046: onOpen }))

  it('names the file, what it holds, the release and version, and the lines', () => {
    const h = draw(file())
    expect(h).toContain('e.trc')
    expect(h).toContain('1 diagnostic dump')
    expect(h).toContain('Oracle Database 19c Enterprise Edition Release 19.0.0.0.0')
    expect(h).toContain('19.27.0.0.0')
    expect(h).toContain('36,651')
    expect(h).not.toContain('opt-warn')
  })

  it('warns that another version is read with the 19c rules and counts the lines outside any known part', () => {
    const h = draw(file({ version: '23.6.0.0.0', tested: false, unplaced: 1234 }))
    expect(h).toContain('read with the 19c rules; this file is 23.6.0.0.0')
    expect(h).toContain('1,234 lines outside any known part')
  })

  it('shows the incident facts of an incident file', () => {
    const h = draw(file({ incident: { dumpFile: '/u01/x/incdir_199651/cdb1_ora_11593_i199651.trc', id: '199651', problem: 'ORA 6544 [pevm_peruws_callback-1]', continuedFrom: '/u01/x/trace/cdb1_ora_11593_mtk_diag_exp10.trc' } }))
    expect(h).toContain('199651')
    expect(h).toContain('ORA 6544 [pevm_peruws_callback-1]')
    expect(h).toContain('cdb1_ora_11593_mtk_diag_exp10.trc')
  })

  it('says how many lines are 10046 records, and offers the SQL trace when the shell can open it', () => {
    const h = draw(file({ records10046: 99 }))
    expect(h).toContain('<b>99</b> lines of 10046 records; open it as a SQL trace for them')
    expect(h).not.toContain('Open as SQL trace')
    expect(draw(file({ records10046: 99 }), () => {})).toContain('Open as SQL trace')
    expect(draw(file({ records10046: 1 }))).toContain('<b>1</b> line of 10046 records')
  })
})

describe('the registry of readings', () => {
  it('has the heap and the PGA readings, registers a component by kind and forgets it', () => {
    expect(registeredReadings().sort()).toEqual(['heap', 'pga-detail', 'pga-summary'])
    const C = () => null
    registerReading('callstack', C)
    expect(readingView('callstack')).toBe(C)
    expect(readingView('hang')).toBeUndefined()
    unregisterReading('callstack')
    expect(readingView('callstack')).toBeUndefined()
  })
})
