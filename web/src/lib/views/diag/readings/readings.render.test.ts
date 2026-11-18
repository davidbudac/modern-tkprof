import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { memoryDiagSource, type DiagFile, type DiagSource } from '../../../data/diag'
import { readingUiOf } from '../../../data/diagheap'
import { HAS_READINGS_FIXTURE, loadReadingFixtures, type ReadingFixture } from '../../../data/diagreadingsfixture'
import { initHeapUi, HeapReadingView, type HeapUi } from './heap'
import { initSummaryUi, PgaDetailView, PgaSummaryView } from './pga'
import { readingView } from './index'

const file: DiagFile = { name: 'd.trc', lines: 1000, release: '', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [], outlineTotal: 0 }
const sourceWith = (text: boolean): DiagSource => memoryDiagSource(file, {}, text ? ['x'] : null)

function draw(View: typeof HeapReadingView, f: ReadingFixture, source: DiagSource = sourceWith(true)): string {
  return renderToStaticMarkup(createElement(View, { node: f.node, reading: f.reading, source, goLine: () => {}, selectNode: () => {} }))
}
/** A source whose kept state for the heap node is set before the first draw (the tab and the selected row as a click would have left them). */
function heapSource(f: ReadingFixture, patch: Partial<HeapUi>, text = true): DiagSource {
  const s = sourceWith(text)
  readingUiOf(s).set(f.node.id, { ...initHeapUi(), ...patch })
  return s
}
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length

describe.skipIf(!HAS_READINGS_FIXTURE)('the heap reading, from the engine\'s answer for the pga heap of diag_heap_sub', () => {
  const fx = loadReadingFixtures()
  const f = fx.heapPga
  const h = draw(HeapReadingView, f)

  it('is registered for the kind heap, and the PGA readings for theirs', () => {
    expect(readingView('heap')).toBe(HeapReadingView)
    expect(readingView('pga-summary')).toBe(PgaSummaryView)
    expect(readingView('pga-detail')).toBe(PgaDetailView)
  })

  it('has the header line: name, descriptor, depth, extents, chunks and the lines as links to the text', () => {
    expect(h).toContain('>pga heap</h3>')
    expect(h).toContain('0x7fde9a405220')
    expect(h).toContain('depth 0')
    expect(h).toContain('103 extents')
    expect(h).toContain('321 chunks')
    expect(h).toMatch(/lines <button[^>]*>32<\/button>–<button[^>]*>933<\/button>/)
  })

  it('has the check block in the kept tone, one line per check with the printed line as a link', () => {
    expect(h).toContain('class="rd-chk ok"')
    expect(h).toContain("Chunks sum to <b>4,707,160</b> bytes: matches the dump&#x27;s Total heap size.")
    expect(h).toContain("Free-list chunks sum to <b>49,560</b> bytes: matches the dump&#x27;s Total free space.")
    expect(h).toContain("Permanent chunks sum to <b>392,464</b> bytes: matches the dump&#x27;s Permanent space.")
    for (const line of ['679', '716', '921']) expect(h).toMatch(new RegExp(`<button type="button" class="rd-lnk"[^>]*>${line}</button>`))
    expect(h).not.toContain('rd-chk bad')
    expect(h).not.toContain('rd-flags')
  })

  it('has the heap tree: the heap itself marked, its siblings, its children, not the whole run, bytes right-aligned', () => {
    expect(h).toContain('aria-label="Heap tree"')
    expect(h).toMatch(/class="rd-tn on"[^>]*aria-current="true"[^>]*><span class="rd-tn-name">pga heap<\/span><span class="rd-tn-n">4,707,160<\/span>/)
    expect(h).toMatch(/class="rd-tn"[^>]*><span class="rd-tn-name">koh-kghu call<\/span><span class="rd-tn-n">3,546,640<\/span>/)
    expect(h).toContain('top call heap')
    expect(count(h, /<button[^>]*class="rd-tn/g)).toBeLessThan(f.reading.run ? (f.reading.run as unknown[]).length + 1 : 99)
  })

  it('has the three tabs with their counts, and by comment first: sortable, with the types, the share and a bar', () => {
    expect(h).toMatch(/aria-pressed="true">By comment<span class="n">58<\/span>/)
    expect(h).toMatch(/aria-pressed="false">By type<span class="n">4<\/span>/)
    expect(h).toMatch(/aria-pressed="false">Sub-heaps<span class="n">14<\/span>/)
    expect(h).toContain('aria-sort="descending"')
    expect(h).toContain('>koh-kghu call</td>')
    expect(h).toContain('freeable +1')
    expect(h).toContain('<td class="num">3,555,464</td><td class="num">75.5%</td>')
    expect(h).toContain('class="rd-bar"')
    expect(h).toContain('Click a row to see its chunks in the text.')
    expect(h).toContain('<tfoot>')
  })

  it('has the free lists as a histogram of buckets with their sizes, the permanent chunks line', () => {
    expect(h).toContain('class="rd-hist"')
    expect(h).toMatch(/<title>bucket 0, from 56 bytes: 2 chunks, 112 bytes<\/title>/)
    expect(h).toContain('24 buckets, 10 chunks, 49,560 bytes in')
    expect(h).toContain("the dump&#x27;s Total free space says 49,560")
    expect(h).toContain('Permanent chunks')
    expect(h).toContain('392,464 bytes')
  })

  it('shows the row the user chose with the stepper over its chunk lines: "1 / 160 · line 46", previous, next, In text, and the marks the text will carry', () => {
    const lines = fx.heapPga.lines!.lines
    const s = heapSource(f, { sel: { key: 'c:koh-kghu call', label: 'koh-kghu call', comment: 'koh-kghu call', lines, total: lines.length, more: 0, next: 0, i: 0, loading: false, error: null } })
    const d = draw(HeapReadingView, f, s)
    expect(d).toContain('<b>160</b> chunk lines of')
    expect(d).toContain('1 / 160 · line 46')
    expect(d).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous chunk"|<button[^>]*aria-label="Previous chunk"[^>]*disabled=""/)
    expect(d).toContain('aria-label="Next chunk"')
    expect(d).toContain('>In text</button>')
    expect(d).toMatch(/class="rd-sel on"[^>]*data-row="koh-kghu call"/)
  })

  it('says a failed load of the chunk lines, and that it is loading', () => {
    const base = { key: 'c:x', label: 'x', comment: 'x', lines: [] as number[], total: 0, more: 0, next: 0, i: 0 }
    expect(draw(HeapReadingView, f, heapSource(f, { sel: { ...base, loading: true, error: null } }))).toContain('Loading the chunk lines of')
    expect(draw(HeapReadingView, f, heapSource(f, { sel: { ...base, loading: false, error: 'boom' } }))).toMatch(/role="alert">Could not read the chunk lines of .*boom/)
  })

  it('keeps its tab: the type table lists the types with their bytes and share; a missing selection shows no chunk bar', () => {
    const d = draw(HeapReadingView, f, heapSource(f, { tab: 'type' }))
    expect(d).toMatch(/aria-pressed="true">By type/)
    expect(d).toContain('<td class="mono"><span class="rd-tw none"></span>freeable</td>')
    expect(d).toContain('4,000,648')
    expect(d).not.toContain('rd-chunkbar')
  })

  it('lists the sub-heaps with their descriptor, size, bytes held here, extents and share; a click opens the sub-heap\'s own dump; and the largest sub-heaps block', () => {
    const d = draw(HeapReadingView, f, heapSource(f, { tab: 'subs' }))
    expect(d).toMatch(/aria-pressed="true">Sub-heaps/)
    expect(d).toContain('0x7fde992411e8')
    expect(d).toContain('<td class="num" title="3.4 MB">3,552,984</td><td class="num">3,551,744</td>')
    expect(d).toMatch(/class="rd-sel"[^>]*title="Open the reading of the sub-heap&#x27;s own dump/)
    expect(d).toContain('5 largest sub-heaps')
    expect(d).toContain('its dump</button>')
    expect(d).toContain('Open the reading')
  })

  it('does not offer the chunks of a row where the source has no text (the standalone report), and its line numbers are plain', () => {
    const d = draw(HeapReadingView, f, sourceWith(false))
    expect(d).toContain('The chunk lines are not in this report.')
    expect(d).not.toContain('rd-sel')
    expect(d).toContain('class="rd-lnk off"')
    expect(d).not.toContain('<button type="button" class="rd-lnk" title="Show line')
  })
})

describe.skipIf(!HAS_READINGS_FIXTURE)('the heap reading of a sub-heap and of a heap whose totals cannot be checked', () => {
  const fx = loadReadingFixtures()

  it('names the parent heap as a link and shows the heap tree down to its parents: parent, siblings, itself', () => {
    const d = draw(HeapReadingView, fx.heapKoh)
    expect(d).toContain('depth 1')
    expect(d).toMatch(/in <button type="button" class="rd-lnk rd-ui"[^>]*>pga heap<\/button>/)
    expect(d).toMatch(/class="rd-tn anc"[^>]*style="--d:0"[^>]*><span class="rd-tn-name">pga heap/)
    expect(d).toMatch(/class="rd-tn on"[^>]*style="--d:1"/)
  })

  it('shows a PDB-filtered heap neutral: each check says why it was not made, and a quiet note says what limits the numbers', () => {
    const d = draw(HeapReadingView, fx.heapPdb)
    expect(d).toContain('class="rd-chk none"')
    expect(d).toContain('Chunks against Total heap size: not checked: the dump was taken inside a PDB')
    expect(d).toContain('Free-list chunks against Total free space: not checked, for the same reason.')
    expect(d).not.toContain('rd-chk ok')
    expect(d).not.toContain('rd-chk bad')
    expect(d).toContain('class="rd-flags"')
    expect(d).toContain('taken inside PDB 3')
  })

  it('shows a differing check in the problem tone with the difference', () => {
    const r = JSON.parse(JSON.stringify(fx.heapPga.reading)) as { checks: { state: string; printed: number; diff: number; computed: number }[] }
    r.checks[1] = { ...r.checks[1], state: 'differ', printed: 50000, computed: 49560, diff: -440 }
    const d = draw(HeapReadingView, { ...fx.heapPga, reading: r as never })
    expect(d).toContain('class="rd-chk bad"')
    expect(d).toContain("the dump&#x27;s Total free space says 50,000, a difference of -440")
  })
})

describe.skipIf(!HAS_READINGS_FIXTURE)('the PGA summary, from the engine\'s answer for diag_pga_summary', () => {
  const f = loadReadingFixtures().pgaSummary
  const h = draw(PgaSummaryView, f)

  it('says the figures are rounded and has no check: nothing green or red', () => {
    expect(h).toContain('The figures of this dump are rounded')
    expect(h).not.toContain('rd-chk')
  })

  it('has the top uses of the process: share, size as printed, chunks, comment, category, heap, and the line', () => {
    expect(h).toContain('Top uses of this process')
    expect(h).toContain('<td class="num">32%</td>')
    expect(h).toContain('<span title="3,511,296 bytes">3429 KB</span>')
    expect(h).toContain('217 <span class="rd-dim">chunks</span>')
    expect(h).toContain('pl/sql vc2')
    expect(h).toContain('PL/SQL')
    expect(h).toMatch(/<button type="button" class="rd-lnk"[^>]*>35<\/button>/)
  })

  it('has the private heap summary by depth', () => {
    expect(h).toContain('Private heap summary')
    expect(h).toContain('Summary of subheaps at depth 1')
    expect(h).toContain('Summary of subheaps at depth 2')
    expect(h).toContain('557 KB free')
    expect(h).toContain('384 KB in empty extents')
  })

  it('has the memory per Oracle process, the top ones first, with the total allocated and sums', () => {
    expect(h).toContain('Memory per Oracle process')
    expect(h).toMatch(/aria-pressed="true">Top<span class="n">10<\/span>/)
    expect(h).toMatch(/aria-pressed="false">All<span class="n">74<\/span>/)
    expect(h).toContain('Total allocated')
    expect(h).toContain('644 MB')
    expect(h).toContain('>MMON</td>')
    expect(h).toContain('aria-label="Show the session detail of process 2361"')
    expect(h).toContain('10 processes')
  })

  it('has the estimated uses for all processes with how many snapshots they come from, and the swap lines', () => {
    expect(h).toContain('Estimated uses for all processes')
    expect(h).toContain('from 10 snapshots out of 74 processes')
    expect(h).toContain('unsnapshotted')
    expect(h).toContain('Swap information')
    expect(h).toContain('Swap (Avail / Total)')
    expect(h).toContain('4092.21M /  4096.00M')
  })

  it('shows all the processes, sorted, and the session detail of a process that was opened', () => {
    const s = sourceWith(true)
    readingUiOf(s).set(f.node.id, { ...initSummaryUi(), ptab: 'all', sort: { col: 'ospid', dir: 1 }, open: ['231'] })
    const d = draw(PgaSummaryView, f, s)
    expect(count(d, /<td class="num mono">/g)).toBe(74)
    expect(d).toContain('aria-sort="ascending"')
    expect(d).toContain('oracle@ol9-19-dg1.localdomain (MMON)')
    expect(d).toContain('0/SYS')
    expect(d).toContain('<span class="rd-mono">19.28589</span>')
  })
})

describe.skipIf(!HAS_READINGS_FIXTURE)('the PGA detail, from the engine\'s answer for diag_pga_detail', () => {
  const f = loadReadingFixtures().pgaDetail
  const h = draw(PgaDetailView, f)

  it('names the process, says the rows are exact bytes and what they add up to', () => {
    expect(h).toMatch(/PGA memory detail for pid <span class="rd-mono">6<\/span>, OS pid <span class="rd-mono">14085<\/span>/)
    expect(h).toContain('<b class="rd-strong">10,959,840</b> bytes in 1,627 chunks')
    expect(h).toContain('474 rows')
  })

  it('has the rows with exact bytes (largest first), bars and links to their lines, the first 300 of them with a way to show more', () => {
    expect(h).toContain('<td class="num">3,512,312</td>')
    expect(h).toContain('pl/sql vc2')
    expect(h).toContain('class="rd-bar"')
    expect(count(h, /<tr><td class="num">[\d,]+<\/td><td class="bc">/g)).toBe(300 + 1) // the rows and the footer
    expect(h).toContain('Show 174 more')
    expect(h).toContain('300 of 474 rows shown')
    expect(h).toContain('aria-sort="descending"')
  })
})
