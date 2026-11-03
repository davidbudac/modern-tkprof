import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import type { Plan, PlanLine } from '../data/types'
import { fmtDur, fmtInt, fmtPct } from '../data/format'
import { flowLayout, flowPath, nodeSubline, opText, rowFlow, TONE_LABELS, type FlowNode, type FlowScale } from '../data/rowflow'
import { LineRef } from '../components/LineRef'
import { useStoreApi } from '../state/session'
import { usePopover } from '../components/usePopover'
import type { PopAnchor } from '../components/popoverPlace'
import '../styles/rowflow.css'

const OPEN_MS = 120, CLOSE_MS = 220

/** The width of an element, followed. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/**
 * One STAT dump as a Sankey (layout: `data/rowflow.ts`): leaves left, the root right, then the client. Band width = the
 * rows a child hands its parent (A-Rows), the dashed ghost = the optimizer's estimate, node fill = self time. Hover (or
 * focus) a node for every measure of its line and a link to its STAT line; click it to highlight its path to the root and
 * its subtree (click again or Esc clears). `focus` (a plan advisor's node link) selects a node.
 */
export function RowFlow({ doc, plan, lines, scale, onScale, focus }: {
  doc: TraceDoc; plan: Plan; lines: readonly PlanLine[]; scale: FlowScale; onScale(s: FlowScale): void
  focus?: { id: number; seq: number } | null
}) {
  const flow = useMemo(() => rowFlow(lines), [lines])
  const [scrollRef, width] = useWidth<HTMLDivElement>()
  const layout = useMemo(() => (width > 0 && flow.root ? flowLayout(flow, { width, scale }) : null), [flow, width, scale])
  const [sel, setSel] = useState<FlowNode | null>(null)
  const [pop, setPop] = useState<{ node: FlowNode; anchor: PopAnchor } | null>(null)
  const fig = useRef<HTMLDivElement>(null)
  const timers = useRef({ open: 0, close: 0 })
  const suppress = useRef<FlowNode | null>(null)
  useEffect(() => { setSel(null); setPop(null) }, [flow])
  useEffect(() => () => { window.clearTimeout(timers.current.open); window.clearTimeout(timers.current.close) }, [])
  useEffect(() => {
    if (!focus) return
    const n = flow.nodes.find((x) => x.line.id === focus.id && x.index >= 0)
    if (!n) return
    setSel(n)
    fig.current?.querySelector(`[data-node="${n.index}"]`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [focus, flow])
  // Esc clears the highlight: after an open popover and an open line viewer (the shell's Esc chain closes that), before
  // the rest of the chain (the details pane, the time window)
  const store = useStoreApi()
  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !store.getState().lineViewer) { e.stopPropagation(); setSel(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sel, store])

  const lit = useMemo(() => (sel ? flowPath(sel) : null), [sel])
  const boxOf = useMemo(() => new Map(layout?.nodes.map((b) => [b.node, b]) ?? []), [layout])
  const anchorOf = (node: FlowNode, clientY?: number): PopAnchor | null => {
    const b = boxOf.get(node), r = fig.current?.getBoundingClientRect()
    if (!b || !r) return null
    const x = r.left + b.x + b.w + 8
    const y = clientY ?? r.top + b.y
    return { x, y, rect: { left: x, top: y - 4, bottom: y + 8 } }
  }
  const later = (which: 'open' | 'close', f: () => void, ms: number) => {
    window.clearTimeout(timers.current[which])
    timers.current[which] = window.setTimeout(f, ms)
  }
  const enter = (node: FlowNode, e: ReactPointerEvent) => {
    window.clearTimeout(timers.current.close)
    if (suppress.current === node || pop?.node === node) return
    const y = e.clientY
    later('open', () => { const a = anchorOf(node, y); if (a) setPop({ node, anchor: a }) }, pop ? 0 : OPEN_MS)
  }
  const leave = (node: FlowNode) => {
    window.clearTimeout(timers.current.open)
    if (suppress.current === node) suppress.current = null
    later('close', () => setPop(null), CLOSE_MS)
  }
  const press = (node: FlowNode) => { suppress.current = node; window.clearTimeout(timers.current.open); setPop(null) }
  const toggle = (node: FlowNode) => setSel((s) => (s === node ? null : node))
  const hover = (node: FlowNode) => ({
    onPointerEnter: (e: ReactPointerEvent) => enter(node, e),
    onPointerLeave: () => leave(node),
    onPointerDown: () => press(node),
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); toggle(node) },
  })

  const root = flow.root
  const dim = (n: FlowNode) => (lit && !lit.has(n) ? ' dim' : '')
  return (
    <div className={'rf' + (sel ? ' has-sel' : '')}>
      <div className="rf-legend small" role="group" aria-label="Row flow legend">
        <span className="rf-key"><i className="rf-key-band" aria-hidden="true" />band = actual rows (A-Rows)</span>
        <span className="rf-key"><i className="rf-key-est" aria-hidden="true" />dashed = estimate (E-Rows)</span>
        <span className="rf-key rf-tones">node = self time:
          {TONE_LABELS.map((t, i) => <span key={t} className="rf-key"><i className={`rf-sw rf-t${i}`} aria-hidden="true" />{t}</span>)}
        </span>
        <span className="seg" role="group" aria-label="Band scale">
          <button aria-pressed={scale === 'sqrt'} onClick={() => onScale('sqrt')} title="band width ∝ √rows: a 1-row lookup stays readable next to a 10 M-row scan">√ rows</button>
          <button aria-pressed={scale === 'linear'} onClick={() => onScale('linear')} title="band width ∝ rows">linear</button>
        </span>
      </div>
      <div className="rf-scroll" ref={scrollRef}>
        {!root ? <p className="callout">No plan lines in this dump.</p> : layout && (
          <div className="rf-fig" ref={fig} style={{ inlineSize: layout.width, blockSize: layout.height }} onClick={() => setSel(null)}>
            <svg className="rf-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img"
              aria-label={`Row flow of ${flow.nodes.length} row sources, ${fmtInt(root.rows)} row${root.rows === 1 ? '' : 's'} to the client, ${fmtDur(flow.totalUs)} in the root`}>
              <g>
                {layout.links.map((l, i) => (
                  <path key={i} d={l.path} className={'rf-band' + (l.width < 3 ? ' thin' : '') + dim(l.from)} {...hover(l.from)} />
                ))}
              </g>
              <g aria-hidden="true">
                {layout.links.map((l, i) => l.estPath && <path key={i} d={l.estPath} className={'rf-est' + (l.estClipped ? ' clipped' : '') + dim(l.from)} />)}
              </g>
              <g>
                {layout.nodes.map((b) => (
                  <g key={b.node.index} className={'rf-node' + dim(b.node) + (sel === b.node ? ' sel' : '')} {...hover(b.node)}>
                    <rect className="rf-hit" x={b.x - 5} y={b.y - 2} width={b.w + 10} height={b.h + 4} />
                    <rect className={`rf-bar rf-t${b.tone}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={2} />
                  </g>
                ))}
                {layout.client && <rect className="rf-client" x={layout.client.x} y={layout.client.y} width={layout.client.w} height={layout.client.h} rx={2} />}
              </g>
            </svg>
            <div className="rf-labels">
              {layout.links.map((l, i) => l.label && (
                <span key={i} className={'rf-band-label' + (l.label.inside ? ' in' : '') + dim(l.from)} style={{ insetInlineStart: l.label.x - l.label.w / 2, insetBlockStart: l.label.y - 7.5, inlineSize: l.label.w }}>{l.label.text}</span>
              ))}
              {layout.nodes.map((b) => {
                const n = b.node
                const op = n.index < 0 ? 'STATEMENT' : n.line.op.replace(/\s+/g, ' ').trim()
                const obj = n.line.object && !op.endsWith(' ' + n.line.object) ? n.line.object : ''
                return (
                  <button key={n.index} type="button" data-node={n.index} className={`rf-label ${b.label.align}` + dim(n) + (sel === n ? ' sel' : '')}
                    style={{ insetInlineStart: b.label.x, insetBlockStart: b.label.y, inlineSize: b.label.w, blockSize: b.label.h }}
                    aria-pressed={sel === n} aria-label={`${n.line.id} ${opText(n.line)}: ${fmtInt(n.rows)} rows, ${nodeSubline(n)}`}
                    {...hover(n)}
                    onFocus={(e) => {
                      // keyboard focus only (a click focuses too); after the scroll that focusing may cause, which closes a popover
                      if (!e.currentTarget.matches(':focus-visible')) return
                      window.clearTimeout(timers.current.close)
                      if (pop?.node !== n) later('open', () => { const a = anchorOf(n); if (a) setPop({ node: n, anchor: a }) }, OPEN_MS)
                    }}
                    onBlur={() => later('close', () => setPop(null), CLOSE_MS)}>
                    <span className="rf-head"><span className="rf-id">{n.line.id}</span> {op}{obj && <span className="rf-obj"> {obj}</span>}</span>
                    <span className="rf-sub">{nodeSubline(n)}</span>
                  </button>
                )
              })}
              {layout.client && (
                <span className="rf-label end rf-client-label" style={{ insetInlineStart: layout.client.label.x, insetBlockStart: layout.client.label.y, inlineSize: layout.client.label.w, blockSize: layout.client.label.h }}>
                  <span className="rf-head">client</span>
                  <span className="rf-sub">{layout.client.text}</span>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {sel && (
        <p className="rf-selbar small">
          <b>{sel.line.id} {sel.index < 0 ? 'STATEMENT' : opText(sel.line)}</b>: its path to the client and its subtree
          {sel.index >= 0 && <> · STAT at <LineRef line={plan.line + sel.index} file={doc.fileOfCursor(plan.cursor)} /></>}
          {' · '}<button type="button" className="link" onClick={() => setSel(null)}>clear</button> <span className="muted">(Esc)</span>
        </p>
      )}
      {flow.notes.length > 0 && (
        <div className="callout rf-notes">{flow.notes.map((n) => <p key={n}>{n}</p>)}</div>
      )}
      {pop && (
        <FlowPopover doc={doc} plan={plan} node={pop.node} totalUs={flow.selfSumUs} anchor={pop.anchor} onClose={() => setPop(null)}
          onEnter={() => window.clearTimeout(timers.current.close)} onLeave={() => later('close', () => setPop(null), CLOSE_MS)} />
      )}
    </div>
  )
}

/** Every measure of one plan line and the link to its STAT line. */
function FlowPopover({ doc, plan, node, totalUs, anchor, onClose, onEnter, onLeave }: {
  doc: TraceDoc; plan: Plan; node: FlowNode; totalUs: number; anchor: PopAnchor; onClose(): void; onEnter(): void; onLeave(): void
}) {
  const root = usePopover(anchor, onClose, [node, anchor])
  const l = node.line
  const kids = node.children.reduce((a, c) => a + c.line.timeUs, 0)
  const io = (v: number, self: number) => (node.children.length ? `${fmtInt(v)} · self ${fmtInt(self)}` : fmtInt(v))
  const facts: [string, string][] = [
    ['A-Rows', fmtInt(node.rows)],
    ['E-Rows', node.est < 0 ? 'none' : node.estRows !== node.est ? `${fmtInt(node.est)} × ${fmtInt(l.starts)} starts = ${fmtInt(node.estRows)}` : fmtInt(node.est)],
    ['Starts', fmtInt(l.starts)],
    ...(node.children.length ? [['Rows in', fmtInt(node.inRows)] as [string, string]] : []),
    ['Time', fmtDur(l.timeUs)],
    ['Self time', node.clamped ? `0 (reports ${fmtDur(l.timeUs)} < children ${fmtDur(kids)})` : `${fmtDur(node.selfUs)} · ${fmtPct(node.selfUs, totalUs, 0)} of the plan's time`],
    ['Buffer gets (cr)', io(l.cr, node.selfCr)],
    ['Physical reads (pr)', io(l.pr, node.selfPr)],
    ['Physical writes (pw)', io(l.pw, node.selfPw)],
    ['Cost', l.cost >= 0 ? fmtInt(l.cost) : '–'],
    ['Bytes (size)', l.size >= 0 ? fmtInt(l.size) : '–'],
    ['obj#', l.obj > 0 ? String(l.obj) : '–'],
  ]
  return createPortal(
    <div className="rf-pop" ref={root} role="dialog" aria-label={`Plan line ${l.id}`} onPointerEnter={onEnter} onPointerLeave={onLeave} onKeyDown={(e) => e.stopPropagation()}>
      <div className="rf-pop-h">
        <b className="mono">{l.id} {node.index < 0 ? 'STATEMENT' : opText(l)}</b>
        <span className="muted">depth {node.depth}{node.children.length ? ` · ${node.children.length} child${node.children.length === 1 ? '' : 'ren'}` : ''}</span>
      </div>
      <dl className="rf-pop-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p className="rf-pop-line small">
        {node.index >= 0 ? <>STAT at <LineRef line={plan.line + node.index} file={doc.fileOfCursor(plan.cursor)} /></> : 'not in the trace: the statement line (id 0) the top-level row sources hang off'}
      </p>
    </div>,
    document.body,
  )
}
