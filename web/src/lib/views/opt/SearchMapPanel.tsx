import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { pathOf, type DumpIndex } from '../../data/optindex'
import { buildSearchMap, runIdOf, runLabel, runRows, type SmOrder, type SearchMap } from '../../data/searchmap'
import { PAD_T, layoutMap, orderAt, type SmLayout } from '../../data/searchmaplayout'
import { fmtInt } from '../../data/format'
import { CloseIcon } from '../../components/icons'
import '../../styles/searchmap.css'

const PLOT_H = 150
const AXIS_W = 52
const tick = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })

export interface SearchMapPanelProps {
  ix: DumpIndex
  /** the line the view follows: the run that holds it is the one shown, until another is picked */
  focus: number
  /** the panel's height in px (dragged); null is the CSS default */
  height: number | null
  onHeight(px: number | null): void
  onClose(): void
  /** go to a line of the dump (a join order's) */
  onLine(line: number): void
  /** go to a node of the outline (a run) */
  onNode(id: string): void
}

/** What the plot draws: the paths of a layout. Memoised on the layout, so a pointer moving over it redraws only the overlay. */
const Plot = memo(function Plot({ l, label }: { l: SmLayout; label: string }) {
  return (
    <svg className="sm-plot" width={l.plotW} height={l.svgH} role="img" aria-label={label}>
      {l.band && <rect className="sm-band" x={l.band.x} y={PAD_T} width={l.band.w} height={l.plotH} />}
      {l.grid.map((g) => <line key={g.v} className="sm-grid" x1={0} x2={l.plotW} y1={g.y} y2={g.y} />)}
      <line className="sm-axis" x1={0} x2={l.plotW} y1={PAD_T + l.plotH} y2={PAD_T + l.plotH} />
      {l.xTicks.map((t) => <text key={t.x} className="sm-xt" x={t.x} y={PAD_T + l.plotH + 12} textAnchor="middle">{t.label}</text>)}
      <path className="sm-lad sm-ab" d={l.ladderAb} />
      <path className="sm-dash" d={l.dash} />
      <path className="sm-lad sm-ok" d={l.ladderOk} />
      <path className="sm-lad sm-win" d={l.ladderWin} />
      {l.dotR > 0 && <>
        <path className="sm-dot sm-ab" d={l.dotsAb} strokeWidth={l.dotR * 2} />
        <path className="sm-dot sm-ok" d={l.dotsOk} strokeWidth={l.dotR * 2} />
        <path className="sm-dot sm-win" d={l.dotsWin} strokeWidth={l.dotR * 2} />
      </>}
      <path className="sm-end sm-ok" d={l.endsOk} strokeWidth={Math.max(3, l.dotR * 2 + 1.5)} />
      <path className="sm-end sm-win" d={l.endsWin} strokeWidth={Math.max(4, l.dotR * 2 + 3)} />
      <path className="sm-x" d={l.crosses} />
      <path className="sm-best" d={l.best} />
      {l.strip.map((s) => <path key={s.slot} className={`sm-sq sm-c${s.slot}`} d={s.d} />)}
    </svg>
  )
})

/** The cost axis, kept at the left while the plot scrolls. */
const YAxis = memo(function YAxis({ l }: { l: SmLayout }) {
  return (
    <svg className="sm-yaxis" width={AXIS_W} height={l.svgH} aria-hidden="true">
      {l.grid.map((g) => <text key={g.v} className="sm-yt" x={AXIS_W - 6} y={g.y + 3.5} textAnchor="end">{tick.format(g.v)}</text>)}
      <text className="sm-yl" x={AXIS_W - 6} y={PAD_T - 3} textAnchor="end">cost</text>
      <text className="sm-yl" x={AXIS_W - 6} y={PAD_T + l.plotH + 12} textAnchor="end">order</text>
      <text className="sm-yl" x={AXIS_W - 6} y={l.stripTop + 8} textAnchor="end">tables</text>
    </svg>
  )
})

/** What the pointer is over: the tooltip of one order. */
function OrderTip({ o, at }: { o: SmOrder; at: { x: number; y: number } }) {
  const style = { insetInlineStart: Math.min(at.x + 14, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 330), insetBlockStart: Math.max(8, at.y - 12) }
  const state = o.isBest ? 'the winner' : o.done ? 'completed' : 'aborted'
  return (
    <div className="sm-tip" style={style} role="tooltip">
      <b>Join order {fmtInt(o.n)}</b> <span>· {state}</span>
      <ol>
        {o.tables.map((t, p) => {
          const pt = o.points.find((x) => x.pos === p)
          const here = !o.done && p === o.abortAt
          return (
            <li key={p} title={t}>
              <i className={`sm-sw sm-c${o.slot[p]}`} />
              <span className="n">{p + 1}</span>
              <span className="t">{o.labels[p]}</span>
              <span className={'c' + (pt ? '' : ' none')}>{pt ? pt.text : here ? 'aborted here' : 'not printed'}</span>
            </li>
          )
        })}
      </ol>
      {o.done
        ? <p>Completed at cost <b>{o.cost}</b>.</p>
        : <p>Join order aborted: cost &gt; best plan cost. The trace prints no cost at the abort.{o.abort === 'no-step' ? ' No join step was printed for this order.' : ''}</p>}
      {!o.done && o.bestText && <p>Best complete plan so far: <b>{o.bestText}</b></p>}
      <p className="go">Click to go to line {fmtInt(o.line)}</p>
    </div>
  )
}

/** The map of one run's search for a join order, with the table of the dump's runs under it. */
export function SearchMapPanel({ ix, focus, height, onHeight, onClose, onLine, onNode }: SearchMapPanelProps) {
  const rows = useMemo(() => runRows(ix.dump.runs, ix.root), [ix])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  // the run: the one holding the line the view follows; the last one when the line is in none; a pick holds until the line enters another run
  const holding = runIdOf(pathOf(ix, focus))
  const lastRun = useRef('')
  const followed = holding || lastRun.current || rows.find((r) => r.orders > 0)?.id || rows[0]?.id || ''
  useEffect(() => { if (holding) lastRun.current = holding }, [holding])
  const [pick, setPick] = useState<{ id: string; at: string } | null>(null)
  const runId = pick && pick.at === followed && byId.has(pick.id) ? pick.id : followed
  const choose = (id: string) => setPick({ id, at: followed })

  const [sIdx, setSIdx] = useState<{ run: string; idx: number } | null>(null)
  const node = ix.byId.get(runId) ?? null
  const map: SearchMap | null = useMemo(() => (node ? buildSearchMap(node, sIdx && sIdx.run === runId ? sIdx.idx : undefined) : null), [node, runId, sIdx])
  const row = byId.get(runId)

  // the room: the plot scrolls sideways when the orders do not fit
  const scroller = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(720)
  const has = !!map && map.orders.length > 0
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setAvail(Math.max(200, el.clientWidth)))
    ro.observe(el)
    setAvail(Math.max(200, el.clientWidth))
    return () => ro.disconnect()
  }, [has])
  const layout = useMemo(() => (map ? layoutMap(map, { avail, plotH: PLOT_H }) : null), [map, avail])

  // the order under the pointer or the keyboard
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  useEffect(() => setHover(null), [map])
  const box = useRef<HTMLDivElement>(null)
  const at = (e: { clientX: number }): number => (layout && box.current ? orderAt(e.clientX - box.current.getBoundingClientRect().left, layout.colW, map!.orders.length) : -1)
  const onMove = (e: PointerEvent<HTMLDivElement>) => { const i = at(e); setHover((h) => (i < 0 ? null : h && h.i === i && Math.abs(h.x - e.clientX) < 6 && Math.abs(h.y - e.clientY) < 6 ? h : { i, x: e.clientX, y: e.clientY })) }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!layout || !map || map.orders.length === 0) return
    const n = map.orders.length
    const cur = hover ? hover.i : -1
    let to = -2
    if (e.key === 'ArrowRight') to = Math.min(n - 1, cur + 1)
    else if (e.key === 'ArrowLeft') to = Math.max(0, cur < 0 ? 0 : cur - 1)
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = n - 1
    else if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); onLine(map.orders[cur].line); return }
    else if (e.key === 'Escape' && hover) { e.stopPropagation(); setHover(null); return }
    else return
    e.preventDefault()
    const r = box.current!.getBoundingClientRect()
    setHover({ i: to, x: r.left + (to + 0.5) * layout.colW, y: r.top + PAD_T + 20 })
    const sc = scroller.current
    if (sc) { const x = (to + 0.5) * layout.colW; if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 20) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2) }
  }

  // the panel's height: dragged from its top edge
  const root = useRef<HTMLElement>(null)
  const [drag, setDrag] = useState(false)
  const setFrom = (clientY: number) => {
    const host = root.current?.parentElement
    if (!host) return
    const b = host.getBoundingClientRect()
    onHeight(Math.round(Math.min(b.height * 0.75, Math.max(180, b.bottom - clientY))))
  }
  const bump = (d: number) => { const b = root.current?.getBoundingClientRect(); if (b) setFrom(b.top - d) }

  const nOrders = map?.orders.length ?? 0
  const winner = map && map.winner >= 0 ? map.orders[map.winner] : null
  const hov = hover && map ? map.orders[hover.i] : null

  return (
    <section className="opt-map" aria-label="Search map" ref={root} style={height ? { blockSize: height } : undefined}>
      <div className={'opt-map-grip' + (drag ? ' drag' : '')} role="separator" aria-orientation="horizontal" aria-label="Resize the search map" tabIndex={0} title="Drag to resize; double-click for the default height"
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); e.preventDefault() }}
        onPointerMove={(e) => { if (drag) setFrom(e.clientY) }} onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)} onLostPointerCapture={() => setDrag(false)}
        onDoubleClick={() => onHeight(null)}
        onKeyDown={(e) => { if (e.key === 'ArrowUp') { e.preventDefault(); bump(16) } else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-16) } }} />
      <header className="opt-map-head">
        <h2>Search map</h2>
        <select className="opt-map-pick" aria-label="Costing run" value={runId} onChange={(e) => choose(e.target.value)} title="The costing run to draw. It follows the run that holds the selected line, until you pick another.">
          {rows.map((r) => <option key={r.id} value={r.id}>{runLabel(r.run)} · {fmtInt(r.orders)} {r.orders === 1 ? 'order' : 'orders'}</option>)}
        </select>
        {map && map.searches > 1 && (
          <select className="opt-map-pick" aria-label="Join search of the run" value={map.search} onChange={(e) => setSIdx({ run: runId, idx: Number(e.target.value) })}
            title="This run costed more than one search (an or-expansion costs a branch each); each has its own join order numbers.">
            {Array.from({ length: map.searches }, (_, i) => <option key={i} value={i}>Join search {i + 1} of {map.searches}</option>)}
          </select>
        )}
        {row && <button type="button" className="quiet" onClick={() => onNode(row.id)} title="Show the run in the text">Go to the run</button>}
        <span className="opt-map-legend" aria-label="Tables">
          {map?.legend.map((g) => <span key={g.slot} title={`${g.table}, the same colour in every order`}><i className={`sm-sw sm-c${g.slot}`} />{g.label}</span>)}
        </span>
        <button type="button" className="quiet icon-btn" onClick={onClose} title="Close the search map  (m)" aria-label="Close the search map"><CloseIcon /></button>
      </header>

      <div className="opt-map-body">
        {map && layout && nOrders > 0 ? (
          <>
            <div className="opt-map-chart">
              <YAxis l={layout} />
              <div className="opt-map-scroll" ref={scroller}>
                <div className="opt-map-plot" ref={box} style={{ inlineSize: layout.plotW, blockSize: layout.svgH }} tabIndex={0} role="group"
                  aria-label={`The ${fmtInt(nOrders)} join orders of the run, in the order tried. Left and right arrows move between them, Enter goes to the line.`}
                  onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={(e) => { const i = at(e); if (i >= 0) onLine(map.orders[i].line) }} onKeyDown={onKey} onBlur={() => setHover(null)}>
                  <Plot l={layout} label={`Search map of ${runLabel(row!.run)}: ${fmtInt(nOrders)} join orders`} />
                  {hover && <div className="sm-hl" style={{ insetInlineStart: hover.i * layout.colW, inlineSize: layout.colW, blockSize: PAD_T + layout.plotH + 2 }} />}
                  {hover && <div className="sm-hl sm-hl-strip" style={{ insetInlineStart: hover.i * layout.colW, inlineSize: layout.colW, insetBlockStart: layout.stripTop - 1, blockSize: layout.stripH + 2 }} />}
                </div>
              </div>
            </div>
            <p className="opt-map-read" aria-live="polite">
              {winner
                ? <>Winner: join order <b>{fmtInt(winner.n)}</b> ({winner.labels.join(', ')}). Its last best-so-far cost is <b>{winner.cost}</b>{row?.finalCost ? <>; the run's final cost is <b>{row.finalCost}</b></> : null}.</>
                : <>The run names no best join order.</>}
              {layout.colW <= 4 ? ' The orders are narrow, so the dots are left out; hover a column for its costs.' : ''}
            </p>
            <p className="opt-map-key">
              <span><i className="sm-g sm-g-dot" />cost printed after a step</span>
              <span><i className="sm-g sm-g-end" />end of a completed order</span>
              <span><i className="sm-g sm-g-x" />order aborted, cost &gt; best plan cost (the trace prints no number, so the mark sits above the line)</span>
              <span><i className="sm-g sm-g-best" />best complete plan so far</span>
            </p>
          </>
        ) : (
          <p className="opt-map-empty">{map ? 'This run printed no join orders.' : 'No costing run in this dump.'}</p>
        )}
        <p className="opt-map-note">The map plots the costs the trace prints and computes none of its own.</p>

        <table className="opt-map-runs" aria-label="The costing runs of the dump">
          <thead>
            <tr><th>Query block</th><th className="r">Run</th><th className="r">Join orders</th><th className="r">Aborted</th><th className="r">Final cost</th><th>Note</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.id === runId ? 'on' : undefined} aria-current={r.id === runId ? 'true' : undefined} onClick={() => choose(r.id)}>
                <td><button type="button" className="link" onClick={(e) => { e.stopPropagation(); choose(r.id) }} title="Draw this run">{r.run.qb} (#{r.run.qbn})</button></td>
                <td className="r">{r.run.n} of {r.run.of}</td>
                <td className="r">{fmtInt(r.orders)}</td>
                <td className="r">{fmtInt(r.aborted)}</td>
                <td className="r">{r.finalCost || ''}</td>
                <td className="note">
                  {r.run.sameAs > 0 && <span>same as run {r.run.sameAs}</span>}
                  {r.run.final && <span className="final" title="Costed after the final query: the run that gave the plan">gave the plan</span>}
                  {r.bestJo > 0 && <span>best order {r.bestJo}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hov && hover && <OrderTip o={hov} at={hover} />}
    </section>
  )
}
