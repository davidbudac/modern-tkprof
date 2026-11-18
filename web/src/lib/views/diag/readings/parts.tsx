// What the dump reader's readings share: a line number that links into the text, a sortable column header, a thin bar, the reading's kept state as a hook, and the
// free-list histogram.
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DiagSource } from '../../../data/diag'
import { fmtInt } from '../../../data/format'
import { copyText } from '../../../data/clipboard'
import { processOfSession } from '../../../data/diagstack'
import { TraceMark } from '../../../components/DumpMark'
import { histLayout, readingUiOf, type Sort } from '../../../data/diagheap'
import type { HeapBucket } from '../../../data/diagreadings'
import '../../../styles/diagreading.css'

/** The reading's kept state for a node (its tab, sorts, open rows, selected row): kept per source, so it is there again when the node is shown again. */
export function useReadingUi<T extends object>(source: DiagSource, node: string, init: () => T): [T, (p: Partial<T>) => void] {
  const ui = readingUiOf(source)
  useSyncExternalStore(ui.subscribe, ui.getVersion, ui.getVersion)
  const v = ui.get(node, init)
  const patch = useCallback((p: Partial<T>) => ui.set(node, { ...ui.get(node, init), ...p }), [ui, node, init])
  return [v, patch]
}

/** A line of the file as a link into the text; where the source has no text (the standalone report) it is the number only. */
export function LineLink({ line, text, source, goLine, title }: { line: number; text?: ReactNode; source: DiagSource; goLine(line: number): void; title?: string }) {
  const label = text ?? fmtInt(line)
  if (!source.text) return <span className="rd-lnk off" title={`Line ${fmtInt(line)}; the text is not in this report`}>{label}</span>
  return <button type="button" className="rd-lnk" title={title ?? `Show line ${fmtInt(line)} in the text`} onClick={() => goLine(line)}>{label}</button>
}

/** A column header that sorts: `num` right-aligns it. */
export function SortTh({ label, col, sort, onSort, num, className, title }: { label: ReactNode; col: string; sort: Sort; onSort(col: string): void; num?: boolean; className?: string; title?: string }) {
  const on = sort.col === col
  return (
    <th className={`rd-sortable${num ? ' num' : ''}${className ? ` ${className}` : ''}`} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} title={title}>
      <button type="button" onClick={() => onSort(col)}>{label}<span className="sx" aria-hidden="true">{on ? (sort.dir === 1 ? '▲' : '▼') : ''}</span></button>
    </th>
  )
}

/** A thin bar: `frac` of the cell's width (0 to 1). */
export function Bar({ frac }: { frac: number }) {
  return <span className="rd-bar" aria-hidden="true"><i style={{ inlineSize: `${Math.max(0, Math.min(1, frac)) * 100}%` }} /></span>
}

/** The free lists (or one block of the reserved lists) as a histogram: bytes per bucket, the chunk count under each bar, the bucket's size as the label. */
export function BucketHist({ buckets, what }: { buckets: readonly HeapBucket[]; what: string }) {
  if (buckets.length === 0) return null
  const h = histLayout(buckets)
  return (
    <svg className="rd-hist" viewBox={`0 0 ${h.width} ${h.height + 25}`} width={h.width} role="img" aria-label={`${what}: ${buckets.length} buckets, bytes per bucket`}>
      {h.bars.map((b) => (
        <g key={b.b.n}>
          <title>{`bucket ${b.b.n}, from ${fmtInt(b.b.size)} bytes: ${fmtInt(b.b.chunks)} chunk${b.b.chunks === 1 ? '' : 's'}, ${fmtInt(b.b.bytes)} bytes`}</title>
          <rect x={b.x + Math.min(3, h.bw / 5)} y={h.height - b.h} width={Math.max(1, h.bw - 2 * Math.min(3, h.bw / 5))} height={b.h || 0.75} className={b.b.bytes ? 'hb' : 'hb0'} />
          {b.count && <text x={b.x + h.bw / 2} y={h.height + 10} className="ht" textAnchor="middle">{b.b.chunks}</text>}
          {b.label && <text x={b.x + h.bw / 2} y={h.height + 21} className="hs" textAnchor="middle">{b.label}</text>}
        </g>
      ))}
    </svg>
  )
}

/** A line of text that may be very long and wraps after each `<-` (the stack as one line), in a block that selects as one piece, with the Copy button's feedback. */
export function CopyBlock({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
  const [done, setDone] = useState<'' | 'ok' | 'fail'>('')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const parts = text.split('<-')
  return (
    <>
      <div className="rd-oneline"><code className="rd-mono" aria-label={label}>{parts.map((p, i) => <Fragment key={i}>{i > 0 && <>{'<-'}<wbr /></>}{p}</Fragment>)}</code></div>
      <div className="rd-actions">
        <button type="button" className="quiet rd-copy" disabled={!text}
          onClick={() => { void copyText(text).then((ok) => { setDone(ok ? 'ok' : 'fail'); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setDone(''), 1600) }) }}>
          {done === 'ok' ? 'Copied' : done === 'fail' ? 'Could not copy' : 'Copy'}
        </button>
        {children}
      </div>
    </>
  )
}

/**
 * A session the dump names (`sid.serial`) as a link to the reading of its process where that process is in this file (found by `processOfSession`, which asks
 * once), else its text; beside it the "10046" link to a SQL trace that holds the session (desktop).
 */
export function SessionLink({ source, self, session, selectNode, label }: { source: DiagSource; self: string; session: string; selectNode(id: string): void; label?: ReactNode }) {
  const [node, setNode] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setNode(null)
    void processOfSession(source, session).then((n) => { if (live) setNode(n) })
    return () => { live = false }
  }, [source, session])
  const text = label ?? session
  return (
    <span className="rd-sess">
      {node && node !== self
        ? <button type="button" className="rd-lnk rd-sessbtn" title={`Show the reading of the process that holds session ${session}`} onClick={() => selectNode(node)}>{text}</button>
        : <span className="rd-mono rd-strong">{text}</span>}
      <TraceMark by={{ session }} />
    </span>
  )
}
