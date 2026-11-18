// The heap reading (kind `heap`): where the memory of one heap dump is, checked against the totals the dump prints. The mock-up is
// docs/mockups/diag-reader/shots/heap-a-light.png: the header line, the check, the heap tree, the tables (by comment, by type, sub-heaps) with a stepper over the
// chunk lines of the selected row, the free lists.
import { Fragment, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { DiagSource } from '../../../data/diag'
import { fmtBytes, fmtInt } from '../../../data/format'
import {
  checkText, checkTone, commentKey, commentRows, flagNotes, heapTree, loadMoreChunks, readingUiOf, selectRow, selLine, shareText, sortRows, stepKind, stepperText, stepTo, subRows, toggleSort,
  typeKey, typeRows, typesText, type ChunkSel, type CommentRow, type ReadingUi, type SelHost, type Sort, type SubRow, type TypeRow,
} from '../../../data/diagheap'
import { normalizeHeap, type HeapReading as HeapData } from '../../../data/diagreadings'
import { ChevronDownIcon, ChevronUpIcon } from '../../../components/icons'
import { Bar, BucketHist, LineLink, SortTh, useReadingUi } from './parts'
import { registerReading, type ReadingProps } from './registry'

type Tab = 'comment' | 'type' | 'subs'

/** What a heap reading keeps while another node or tab is shown. */
export interface HeapUi {
  tab: Tab
  sorts: { comment: Sort; type: Sort; subs: Sort }
  /** the types whose variants are shown */
  open: string[]
  /** the selected row of a table and the chunk lines loaded for it */
  sel: ChunkSel | null
}

export const initHeapUi = (): HeapUi => ({
  tab: 'comment',
  sorts: { comment: { col: 'bytes', dir: -1 }, type: { col: 'bytes', dir: -1 }, subs: { col: 'held', dir: -1 } },
  open: [],
  sel: null,
})

/** The selected row's state in the kept store; every change goes through here, so the lines marked in the text follow it whether or not the component is shown. */
function hostOf(ui: ReadingUi, node: string): SelHost {
  return {
    sel: () => ui.get(node, initHeapUi).sel,
    set: (s) => { ui.set(node, { ...ui.get(node, initHeapUi), sel: s }); ui.setMarks(node, s?.lines ?? null) },
  }
}

const bytesText = (n: number) => fmtInt(n)

export function HeapReadingView({ node, reading, source, goLine, selectNode }: ReadingProps) {
  const h = useMemo(() => normalizeHeap(reading), [reading])
  const [st, patch] = useReadingUi<HeapUi>(source, node.id, initHeapUi)
  const ui = readingUiOf(source)
  const host = useMemo(() => hostOf(ui, node.id), [ui, node.id])
  const live = !!source.text
  const link = (line: number, text?: string) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const sel = st.sel

  const tone = checkTone(h.checks)
  const notes = flagNotes(h, fmtInt)
  const parent = h.parentNode ? h.run.find((r) => r.node === h.parentNode) : undefined
  const tabs: [Tab, string, number][] = [['comment', 'By comment', h.comments], ['type', 'By type', h.byType.length], ['subs', 'Sub-heaps', h.subheapsTotal]]
  const choose = (spec: { key: string; label: string; comment?: string; type?: string }) => { if (live) void selectRow(source, node.id, host, spec) }
  const sortOf = (tab: Tab) => (col: string) => patch({ sorts: { ...st.sorts, [tab]: toggleSort(st.sorts[tab], col, col === 'comment' || col === 'type' || col === 'name' ? 1 : -1) } })

  return (
    <div className="rd" data-reading="heap">
      <header className="rd-head">
        <h3 className="rd-title rd-mono">{h.name}</h3>
        <span className="rd-meta">
          desc <span className="rd-mono">{h.desc}</span>
          {h.depth !== undefined && <> · depth {h.depth}</>}
          {h.pdb !== undefined && <> · pdb {h.pdb}</>}
          {parent ? <> · in <button type="button" className="rd-lnk rd-ui" onClick={() => selectNode(parent.node)} title={`Show the reading of ${parent.name}`}>{parent.name}</button></> : h.parent ? <> · parent <span className="rd-mono">{h.parent}</span></> : null}
          {' '}· {fmtInt(h.extents)} {h.extents === 1 ? 'extent' : 'extents'} · {fmtInt(h.chunks)} {h.chunks === 1 ? 'chunk' : 'chunks'} · lines {link(h.from)}–{link(h.to, fmtInt(h.to))}
        </span>
      </header>

      {h.checks.length > 0 && (
        <div className={`rd-chk ${tone}`} role="group" aria-label="The check against the dump's own totals">
          {h.checks.map((c, i) => {
            const same = c.state === 'none' && !!c.reason && h.checks[i - 1]?.state === 'none' && h.checks[i - 1].reason === c.reason
            const t = checkText(c, fmtInt, same)
            return (
              <div key={c.name} className={t.state}>
                {t.head}{t.sum !== undefined && <> <b>{fmtInt(t.sum)}</b></>}{t.tail}
                {t.line ? link(t.line) : null}
              </div>
            )
          })}
        </div>
      )}
      {notes.length > 0 && <ul className="rd-flags" aria-label="What changes how the numbers are read">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}

      {h.run.length > 1 && <HeapTree h={h} select={selectNode} />}

      <section className="rd-sec">
        <div className="rd-seg-row">
          <div className="rd-seg" role="group" aria-label="Table">
            {tabs.map(([t, label, n]) => <button key={t} type="button" aria-pressed={st.tab === t} onClick={() => patch({ tab: t })}>{label}<span className="n">{fmtInt(n)}</span></button>)}
          </div>
          <span className="rd-dim">{st.tab === 'subs' ? (h.subheapsTotal > 0 ? 'Click a row to open the sub-heap’s own dump.' : '') : live ? 'Click a row to see its chunks in the text.' : 'The chunk lines are not in this report.'}</span>
        </div>
        {st.tab !== 'subs' && sel && <ChunkBar sel={sel} node={node.id} source={source} host={host} goLine={goLine} />}
        {st.tab === 'comment' && <CommentTable h={h} sort={st.sorts.comment} onSort={sortOf('comment')} sel={sel} choose={choose} live={live} />}
        {st.tab === 'type' && <TypeTable h={h} sort={st.sorts.type} onSort={sortOf('type')} sel={sel} choose={choose} live={live} open={st.open} setOpen={(open) => patch({ open })} />}
        {st.tab === 'subs' && <SubTable h={h} sort={st.sorts.subs} onSort={sortOf('subs')} select={selectNode} link={link} />}
      </section>

      <FreeLists h={h} link={link} />
      <Others h={h} link={link} />
    </div>
  )
}

// ---- the heap tree ----------------------------------------------------------------------------------------------------------------------------

function HeapTree({ h, select }: { h: HeapData; select(id: string): void }) {
  const rows = useMemo(() => heapTree(h.run, h.node), [h.run, h.node])
  const box = useRef<HTMLUListElement>(null)
  // the selected heap stays in view: the list scrolls inside its own box, never the reading
  useEffect(() => {
    const b = box.current
    const on = b?.querySelector<HTMLElement>('.rd-tn.on')
    if (b && on) b.scrollTop = Math.max(0, on.offsetTop - (b.clientHeight - on.offsetHeight) / 2)
  }, [h.node, rows])
  if (rows.length === 0) return null
  return (
    <section className="rd-sec">
      <div className="rd-k">Heap tree <span className="rd-dim">(this heap with its parents, siblings and sub-heaps, of the {fmtInt(h.run.length)}{h.runMore ? ` of ${fmtInt(h.run.length + h.runMore)}` : ''} heaps of the dump run; bytes are each heap&apos;s own size)</span></div>
      <ul className="rd-tree" ref={box} aria-label="Heap tree">
        {rows.map((r) => (
          <li key={r.run.node}>
            <button type="button" className={`rd-tn${r.role === 'self' ? ' on' : r.role === 'ancestor' ? ' anc' : ''}`} style={{ '--d': r.depth } as CSSProperties} aria-current={r.role === 'self' ? 'true' : undefined}
              title={`${r.run.name} · ${r.run.desc} · lines ${fmtInt(r.run.from)}-${fmtInt(r.run.to)}${r.role === 'self' ? '' : ' (click to show its reading)'}`}
              onClick={() => { if (r.role !== 'self') select(r.run.node) }}>
              <span className="rd-tn-name">{r.run.name}</span>
              <span className="rd-tn-n">{r.run.size > 0 ? fmtInt(r.run.size) : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---- the stepper over a selected row's chunk lines --------------------------------------------------------------------------------------------

function ChunkBar({ sel, node, source, host, goLine }: { sel: ChunkSel; node: string; source: DiagSource; host: SelHost; goLine(line: number): void }) {
  const line = selLine(sel)
  const step = (dir: 1 | -1) => {
    const k = stepKind(sel, dir)
    if (k === 'step') host.set(stepTo(sel, dir))
    else if (k === 'load') void loadMoreChunks(source, node, host, true)
  }
  return (
    <div className="rd-chunkbar" role="group" aria-label="The chunks of the selected row">
      {sel.error ? (
        <span className="rd-lab rd-err" role="alert">Could not read the chunk lines of <span className="rd-mono">{sel.label || '(no comment)'}</span>: {sel.error}</span>
      ) : sel.loading && sel.lines.length === 0 ? (
        <span className="rd-lab rd-dim">Loading the chunk lines of <span className="rd-mono">{sel.label || '(no comment)'}</span>…</span>
      ) : (
        <span className="rd-lab"><b>{fmtInt(sel.total)}</b> chunk {sel.total === 1 ? 'line' : 'lines'} of <span className="rd-mono">{sel.label || '(no comment)'}</span></span>
      )}
      <span className="rd-grow" />
      {sel.lines.length > 0 && <span className="rd-pos" title={sel.more > 0 ? `${fmtInt(sel.lines.length)} of ${fmtInt(sel.total)} chunk lines loaded; the next ones come when the stepper gets there` : undefined}>{stepperText(sel, fmtInt)}</span>}
      <button type="button" className="quiet icon-btn" disabled={stepKind(sel, -1) === 'none'} onClick={() => step(-1)} title="Previous chunk" aria-label="Previous chunk"><ChevronUpIcon /></button>
      <button type="button" className="quiet icon-btn" disabled={stepKind(sel, 1) === 'none' || (sel.loading && sel.lines.length > 0)} onClick={() => step(1)} title="Next chunk" aria-label="Next chunk"><ChevronDownIcon /></button>
      <button type="button" className="quiet" disabled={!line} onClick={() => goLine(line)} title="Show the chunk in the text, with the chunks of this row marked in the gutter and the line map">In text</button>
      <button type="button" className="quiet" onClick={() => host.set(null)} title="Clear the selection">Clear</button>
    </div>
  )
}

// ---- the tables ---------------------------------------------------------------------------------------------------------------------------------

const rowKeys = (act: () => void) => (e: KeyboardEvent<HTMLElement>) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act() } }

interface TableProps { h: HeapData; sel: ChunkSel | null; choose(spec: { key: string; label: string; comment?: string; type?: string }): void; live: boolean }

function CommentTable({ h, sort, onSort, sel, choose, live }: TableProps & { sort: Sort; onSort(col: string): void }) {
  const rows = useMemo(() => sortRows(commentRows(h), sort, {
    comment: (r: CommentRow) => r.comment, chunks: (r) => r.chunks, bytes: (r) => r.bytes, share: (r) => r.bytes, type: (r) => r.types[0]?.type,
  }), [h, sort])
  const max = Math.max(1e-9, ...rows.map((r) => r.share))
  const oth = h.otherComments
  return (
    <div className="rd-tblwrap">
      <table className="rd-tbl rd-heap">
        <thead>
          <tr>
            <SortTh label="Comment" col="comment" sort={sort} onSort={onSort} />
            <SortTh label="Type" col="type" sort={sort} onSort={onSort} className="ty" />
            <SortTh label="Chunks" col="chunks" sort={sort} onSort={onSort} num />
            <SortTh label="Bytes" col="bytes" sort={sort} onSort={onSort} num />
            <SortTh label="Share" col="share" sort={sort} onSort={onSort} num />
            <th className="bc" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ty = typesText(r.types)
            const on = sel?.key === commentKey(r.comment)
            const act = () => choose({ key: commentKey(r.comment), label: r.comment, comment: r.comment })
            return (
              <tr key={r.key} className={live ? `rd-sel${on ? ' on' : ''}` : undefined} tabIndex={live ? 0 : undefined} aria-selected={live ? on : undefined} data-row={r.key}
                onClick={live ? act : undefined} onKeyDown={live ? rowKeys(act) : undefined} title={r.suffixes ? `${fmtInt(r.suffixes)} different "^" suffixes are grouped under this comment` : undefined}>
                <td className="mono wrap">
                  {r.comment ? r.comment : <span className="rd-dim">(no comment)</span>}
                  {r.suffixes ? <span className="rd-dim"> · {fmtInt(r.suffixes)} names</span> : null}
                </td>
                <td className="dim nw ty mono" title={ty.title}>{ty.text}</td>
                <td className="num">{fmtInt(r.chunks)}</td>
                <td className="num">{bytesText(r.bytes)}</td>
                <td className="num">{shareText(r.share)}</td>
                <td className="bc"><Bar frac={r.share / max} /></td>
              </tr>
            )
          })}
          {oth && oth.count > 0 && (
            <tr className="rd-other">
              <td title="The comments after the largest ones, summed">{fmtInt(oth.count)} other {oth.count === 1 ? 'comment' : 'comments'}</td>
              <td className="ty" />
              <td className="num">{fmtInt(oth.chunks)}</td>
              <td className="num">{bytesText(oth.bytes)}</td>
              <td className="num">{shareText(h.bytes > 0 ? oth.bytes / h.bytes : 0)}</td>
              <td className="bc" />
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>{fmtInt(h.comments)} {h.comments === 1 ? 'comment' : 'comments'}{oth && oth.count > 0 ? `, ${fmtInt(h.byComment.length)} listed` : ''}</td>
            <td className="ty" />
            <td className="num">{fmtInt(h.chunks)}</td>
            <td className="num">{bytesText(h.bytes)}</td>
            <td className="num">{h.bytes > 0 ? '100%' : ''}</td>
            <td className="bc" />
          </tr>
        </tfoot>
      </table>
      {h.byComment.length === 0 && <p className="rd-note">This heap has no chunks in the dump.</p>}
    </div>
  )
}

function TypeTable({ h, sort, onSort, sel, choose, live, open, setOpen }: TableProps & { sort: Sort; onSort(col: string): void; open: string[]; setOpen(open: string[]): void }) {
  const rows = useMemo(() => sortRows(typeRows(h), sort, { type: (r: TypeRow) => r.type, chunks: (r) => r.chunks, bytes: (r) => r.bytes, share: (r) => r.bytes }), [h, sort])
  const max = Math.max(1e-9, ...rows.map((r) => r.share))
  const toggle = (t: string) => setOpen(open.includes(t) ? open.filter((x) => x !== t) : [...open, t])
  return (
    <div className="rd-tblwrap">
      <table className="rd-tbl rd-heap">
        <thead>
          <tr>
            <SortTh label="Type" col="type" sort={sort} onSort={onSort} />
            <SortTh label="Chunks" col="chunks" sort={sort} onSort={onSort} num />
            <SortTh label="Bytes" col="bytes" sort={sort} onSort={onSort} num />
            <SortTh label="Share" col="share" sort={sort} onSort={onSort} num />
            <th className="bc" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = sel?.key === typeKey(r.type)
            const act = () => choose({ key: typeKey(r.type), label: r.type, type: r.type })
            const isOpen = open.includes(r.type)
            return (
              <Fragment key={r.key}>
                <tr className={live ? `rd-sel${on ? ' on' : ''}` : undefined} tabIndex={live ? 0 : undefined} aria-selected={live ? on : undefined} onClick={live ? act : undefined} onKeyDown={live ? rowKeys(act) : undefined}>
                  <td className="mono">
                    {r.variants
                      ? <button type="button" className="rd-tw" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the ${r.variants.length} printed types of ${r.type}`} title={`${r.variants.length} printed types (${r.variants[0].type}, …)`} onClick={(e) => { e.stopPropagation(); toggle(r.type) }}>{isOpen ? '▾' : '▸'}</button>
                      : <span className="rd-tw none" />}
                    {r.type}
                    {r.variants ? <span className="rd-dim"> · {fmtInt(r.variants.length)} variants</span> : null}
                  </td>
                  <td className="num">{fmtInt(r.chunks)}</td>
                  <td className="num">{bytesText(r.bytes)}</td>
                  <td className="num">{shareText(r.share)}</td>
                  <td className="bc"><Bar frac={r.share / max} /></td>
                </tr>
                {isOpen && r.variants?.map((v) => {
                  const von = sel?.key === typeKey(v.type)
                  const vact = () => choose({ key: typeKey(v.type), label: v.type, type: v.type })
                  return (
                    <tr key={v.type} className={`rd-variant${live ? ` rd-sel${von ? ' on' : ''}` : ''}`} tabIndex={live ? 0 : undefined} aria-selected={live ? von : undefined} onClick={live ? vact : undefined} onKeyDown={live ? rowKeys(vact) : undefined}>
                      <td className="mono">{v.type}</td>
                      <td className="num">{fmtInt(v.chunks)}</td>
                      <td className="num">{bytesText(v.bytes)}</td>
                      <td className="num">{shareText(v.share)}</td>
                      <td className="bc"><Bar frac={v.share / max} /></td>
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>{fmtInt(h.byType.length)} {h.byType.length === 1 ? 'type' : 'types'}</td>
            <td className="num">{fmtInt(h.chunks)}</td>
            <td className="num">{bytesText(h.bytes)}</td>
            <td className="num">{h.bytes > 0 ? '100%' : ''}</td>
            <td className="bc" />
          </tr>
        </tfoot>
      </table>
      {h.byType.length === 0 && <p className="rd-note">This heap has no chunks in the dump.</p>}
    </div>
  )
}

function SubTable({ h, sort, onSort, select, link }: { h: HeapData; sort: Sort; onSort(col: string): void; select(id: string): void; link(line: number, text?: string): ReactNode }) {
  const rows = useMemo(() => sortRows(subRows(h), sort, { name: (r: SubRow) => r.name, size: (r) => r.size, held: (r) => r.held, chunks: (r) => r.chunks, extents: (r) => r.extents, share: (r) => r.held }), [h, sort])
  const max = Math.max(1e-9, ...rows.map((r) => r.share))
  const oth = h.otherSubheaps
  return (
    <>
      {rows.length === 0 && !oth ? <p className="rd-note">This heap has no sub-heaps in the dump.</p> : (
        <div className="rd-tblwrap">
          <table className="rd-tbl rd-subs">
            <thead>
              <tr>
                <SortTh label="Sub-heap" col="name" sort={sort} onSort={onSort} />
                <SortTh label="Size" col="size" sort={sort} onSort={onSort} num title="The sub-heap's own size: sz= of the ds line under its descriptor chunk" />
                <SortTh label="Held here" col="held" sort={sort} onSort={onSort} num title="Bytes of this heap's chunks that belong to the sub-heap (ds=)" />
                <SortTh label="Chunks" col="chunks" sort={sort} onSort={onSort} num className="opt-col" />
                <SortTh label="Extents" col="extents" sort={sort} onSort={onSort} num className="opt-col" />
                <SortTh label="Share" col="share" sort={sort} onSort={onSort} num />
                <th className="bc" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const act = () => { if (r.node) select(r.node) }
                return (
                  <tr key={r.key} className={r.node ? 'rd-sel' : undefined} tabIndex={r.node ? 0 : undefined} onClick={r.node ? act : undefined} onKeyDown={r.node ? rowKeys(act) : undefined}
                    title={r.node ? `Open the reading of the sub-heap's own dump (${fmtInt(r.chunks)} chunks here, ds line ${fmtInt(r.line)})` : `The sub-heap's own dump is not in this file (${fmtInt(r.chunks)} chunks here, ds line ${fmtInt(r.line)})`}>
                    <td className="mono wrap">{r.name || <span className="rd-dim">(no name)</span>} <span className="rd-dim">{r.desc}</span></td>
                    <td className="num" title={r.size !== undefined ? fmtBytes(r.size) : undefined}>{r.size !== undefined ? fmtInt(r.size) : <span className="rd-dim">–</span>}</td>
                    <td className="num">{fmtInt(r.held)}</td>
                    <td className="num opt-col">{fmtInt(r.chunks)}</td>
                    <td className="num opt-col">{r.extents !== undefined ? fmtInt(r.extents) : <span className="rd-dim">–</span>}</td>
                    <td className="num">{shareText(r.share)}</td>
                    <td className="bc"><Bar frac={r.share / max} /></td>
                  </tr>
                )
              })}
              {oth && oth.count > 0 && (
                <tr className="rd-other">
                  <td>{fmtInt(oth.count)} other {oth.count === 1 ? 'sub-heap' : 'sub-heaps'}</td>
                  <td className="num" />
                  <td className="num">{fmtInt(oth.bytes)}</td>
                  <td className="num opt-col">{fmtInt(oth.chunks)}</td>
                  <td className="num opt-col" />
                  <td className="num">{shareText(h.bytes > 0 ? oth.bytes / h.bytes : 0)}</td>
                  <td className="bc" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && <p className="rd-note">Size is the <span className="rd-mono">sz=</span> of the <span className="rd-mono">ds</span> line under the sub-heap&apos;s descriptor chunk; held here are the bytes of this heap&apos;s chunks that carry its <span className="rd-mono">ds=</span>. {h.subheapsTotal > rows.length ? `${fmtInt(rows.length)} of ${fmtInt(h.subheapsTotal)} sub-heaps are listed.` : ''}</p>}
      {h.largest.length > 0 && (
        <div className="rd-blk">
          <div className="rd-k">{fmtInt(h.largest.length)} largest sub-heaps <span className="rd-dim">(the dump&apos;s own list; its size= is a little more than the sub-heap&apos;s total)</span></div>
          <table className="rd-tbl rd-narrow">
            <thead><tr><th>Sub-heap</th><th className="num">Size as printed</th><th className="num">Line</th><th /></tr></thead>
            <tbody>
              {h.largest.map((l) => (
                <tr key={l.desc}>
                  <td className="mono wrap">{l.name || <span className="rd-dim">(no name)</span>} <span className="rd-dim">{l.desc}</span></td>
                  <td className="num">{fmtInt(l.size)}</td>
                  <td className="num">{link(l.line)}</td>
                  <td className="nw">{l.node ? <button type="button" className="rd-lnk rd-ui" onClick={() => select(l.node!)} title="Show the reading of the sub-heap's own dump">its dump</button> : <span className="rd-dim" title="The sub-heap's own dump is not in this file">not in file</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ---- the free lists and the other parts -------------------------------------------------------------------------------------------------------

function FreeLists({ h, link }: { h: HeapData; link(line: number, text?: string): ReactNode }) {
  const f = h.freeLists
  if (!f.present || f.buckets.length === 0) return null
  const res = f.reserved ?? []
  return (
    <section className="rd-sec">
      <div className="rd-k">Free lists{f.bytes > 0 ? <span className="rd-dim"> (bar: bytes per bucket; number: chunks; the bucket&apos;s size below)</span> : null}</div>
      {f.bytes > 0 && <BucketHist buckets={f.buckets} what="Free lists" />}
      <p className="rd-note">
        {fmtInt(f.buckets.length)} buckets{f.bytes > 0 ? '' : ', all empty'}, {fmtInt(f.chunks)} {f.chunks === 1 ? 'chunk' : 'chunks'}, {fmtInt(f.bytes)} bytes in {f.line ? link(f.line, 'the free lists') : 'the free lists'}
        {f.printed !== undefined ? `; the dump's Total free space says ${fmtInt(f.printed)}` : ''}.
      </p>
      {res.map((r) => (
        <div className="rd-blk" key={r.line}>
          <div className="rd-k"><span className="rd-mono">{r.title}</span> {link(r.line)}</div>
          <BucketHist buckets={r.buckets} what={r.title} />
          <p className="rd-note">{fmtInt(r.buckets.length)} non-empty {r.buckets.length === 1 ? 'bucket' : 'buckets'}, {fmtInt(r.chunks)} {r.chunks === 1 ? 'chunk' : 'chunks'}, {fmtInt(r.bytes)} bytes{r.printed !== undefined ? `; the dump says ${fmtInt(r.printed)}` : ''}.</p>
        </div>
      ))}
    </section>
  )
}

function Others({ h, link }: { h: HeapData; link(line: number, text?: string): ReactNode }) {
  if (!h.permanent && !h.unpinned) return null
  const p = h.permanent
  const u = h.unpinned
  return (
    <section className="rd-sec">
      <div className="rd-k">Other parts of the dump</div>
      <dl className="rd-kv">
        {p && (<><dt>Permanent chunks</dt><dd>{fmtInt(p.chunks)} {p.chunks === 1 ? 'chunk' : 'chunks'}, {fmtInt(p.bytes)} bytes, listed again from line {link(p.line)}{p.printed !== undefined ? <span className="rd-dim"> · the dump&apos;s Permanent space says {fmtInt(p.printed)}</span> : null}</dd></>)}
        {u && (<><dt>Unpinned space</dt><dd>{fmtInt(u.bytes)} bytes, <span className="rd-mono">rcr={fmtInt(u.rcr)} trn={fmtInt(u.trn)}</span> {link(u.line)}</dd></>)}
      </dl>
    </section>
  )
}

registerReading('heap', HeapReadingView)
