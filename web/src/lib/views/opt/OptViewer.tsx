import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { OptFold, OptText } from '../../data/opt'
import type { DumpIndex } from '../../data/optindex'
import type { LmOn } from '../../data/optindex'
import { dressLine, matchRanges, type Dressed, type GlossCtx, type Span } from '../../data/optdress'
import { gapText, type OptRow, type RowModel } from '../../data/optrows'
import { hasHit, hitsIn, type SearchResult } from '../../data/optsearch'
import { sqlSpans } from '../../data/optsql'
import { fmtInt } from '../../data/format'
import { scrollFromTop, scrollGeometry, topFromScroll } from '../../data/scrollmap'

/** Height of a row in pixels. */
export const ROW_H = 20
/** The first rendered row moves in steps of this many rows, so a scroll re-renders once per step. */
const STEP = 8
const OVER = 8
const MAX_TEXT = 4000
/** Id, Operation, Name, Rows, Bytes, Cost, Time: the columns every plan table has; the ones after them are the plan's extra columns. */
const STD_COLS = 7
/** The plan band's measures: a character of the mono face in px, what surrounds the band in the box (line numbers, margins, scroll bar), the characters of the
 * columns that never shrink (Id, Rows, Bytes, Cost, Time) and the least the operation and the name keep before the extra columns give way. */
const BAND_CHW = 7.2
const BAND_CHROME = 152
const BAND_FIXED = 4.5 + 3 * 7 + 10
const OP_MIN = 12
const NAME_MIN = 6

/** What the owner can ask of the viewer. */
export interface OptViewerApi {
  /** the line of the first and of the last visible row */
  view(): { top: number; bottom: number }
  /** scroll so that `line` is visible: in the middle (default), at the top, or with the least movement */
  reveal(line: number, how?: 'center' | 'top' | 'near'): void
  focus(): void
  visible(line: number): boolean
}

export interface PlanLink { href?: string; busy?: boolean; note?: string; onOpen?(): void }

interface Props {
  ix: DumpIndex
  text: OptText
  rows: RowModel
  mode: 'fmt' | 'raw'
  gloss: GlossCtx
  sel: number
  lm: LmOn
  bookmarks: ReadonlyMap<number, string>
  search: SearchResult
  hitCur: number
  planText: boolean
  planLink: PlanLink
  /** the line to start at */
  initialTop?: number
  onRow(row: OptRow, line: number): void
  onFold(row: OptRow, fold: OptFold): void
  onPlan(view: 'plan' | 'text'): void
  onDiff(sqlLine: number, row: OptRow): void
  onView(top: number, bottom: number): void
}

/** The spans of a line with the search's marks laid over them. */
function marked(spans: readonly Span[], ranges: readonly [number, number, boolean][]): ReactNode[] {
  const out: ReactNode[] = []
  let pos = 0
  let key = 0
  for (const sp of spans) {
    const a = pos
    const b = pos + sp.text.length
    const inner: ReactNode[] = []
    let p = a
    for (const [ra, rb, cur] of ranges) {
      if (rb <= p || ra >= b) continue
      const s0 = Math.max(ra, p)
      const e0 = Math.min(rb, b)
      if (s0 > p) inner.push(sp.text.slice(p - a, s0 - a))
      inner.push(<mark key={`m${s0}`} className={cur ? 'cur' : undefined}>{sp.text.slice(s0 - a, e0 - a)}</mark>)
      p = e0
    }
    if (p < b) inner.push(sp.text.slice(p - a))
    out.push(sp.cls ? <span key={key++} className={sp.cls} data-t={sp.t || undefined}>{inner}</span> : <span key={key++} className="opt-s">{inner}</span>)
    pos = b
  }
  return out
}

const plain = (s: string, ranges: readonly [number, number, boolean][]) => marked([{ text: s, cls: '' }], ranges)

function planVars(widths: { op: number; name: number }): CSSProperties {
  return { '--opw': widths.op, '--nmw': widths.name } as CSSProperties
}

/** The width in characters of an extra plan column (Pstart, TQ, …): its title or its widest cell. */
const xw = (n: number): CSSProperties => ({ '--xw': n } as CSSProperties)

export const OptViewer = memo(forwardRef<OptViewerApi, Props>(function OptViewer(p, ref) {
  const { ix, text, rows, mode, gloss, sel, lm, bookmarks, search, hitCur, planText, planLink } = p
  const d = ix.dump
  const box = useRef<HTMLDivElement>(null)
  // `first..last` are the rows rendered; `off` is the layer's distance from the top of the content in px, `shift` how far the first rendered row
  // is above the top edge of the view (only a scroll map, see below, needs it)
  const [win, setWin] = useState({ first: 0, last: 80, shift: 0 })
  const [height, setHeight] = useState(0)
  const [width, setWidth] = useState(0)
  const frame = useRef(0)
  const anchor = useRef(p.initialTop ?? d.viewFrom)
  // The scroll bar covers at most MAX_SCROLL_H px (a browser cannot scroll an element tens of millions of px high); a taller dump maps the scroll position
  // to the first visible row, as the Lines viewer does (data/scrollmap.ts). `topRef` is the first visible row (fractional); `expected` the scrollTop we set
  // ourselves, whose scroll event must not re-map the row we placed.
  const topRef = useRef(0)
  const expected = useRef(-1)
  const seen = useRef({ top: 0, bottom: 0 })
  const cb = useRef(p)
  cb.current = p
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const dressed = useRef(new Map<number, Dressed>())
  useMemo(() => { dressed.current = new Map() }, [ix, gloss])

  const measure = useCallback(() => {
    frame.current = 0
    const el = box.current
    const rm = rowsRef.current
    if (!el || rm.count === 0) return
    const ch = el.clientHeight
    const g = scrollGeometry(rm.count, ch, ROW_H)
    const capped = g.scrollH < rm.count * ROW_H
    const top = Math.abs(el.scrollTop - expected.current) < 1 ? Math.min(topRef.current, g.maxTop) : capped ? topFromScroll(g, el.scrollTop) : el.scrollTop / ROW_H
    topRef.current = top
    const first0 = Math.min(rm.count - 1, Math.floor(top + 1e-6))
    const lastVis = Math.min(rm.count - 1, Math.max(first0, Math.ceil(top + ch / ROW_H - 1e-6) - 1))
    const first = Math.max(0, Math.floor(first0 / STEP) * STEP - OVER)
    const last = Math.min(rm.count, first + Math.ceil(ch / ROW_H) + STEP + 2 * OVER)
    const shift = capped ? top - first : 0
    setWin((w) => (w.first === first && w.last === last && w.shift === shift ? w : { first, last, shift }))
    const topLine = rm.at(first0).line
    const bottom = rm.at(lastVis).line
    if (topLine !== seen.current.top || bottom !== seen.current.bottom) {
      seen.current = { top: topLine, bottom }
      anchor.current = topLine
      cb.current.onView(topLine, bottom)
    }
  }, [])
  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(measure) }, [measure])

  // the size of the box
  useEffect(() => {
    const el = box.current!
    const ro = new ResizeObserver(() => { setHeight(el.clientHeight); setWidth(el.clientWidth); schedule() })
    ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0 }
  }, [schedule])

  /** Put row `top` (fractional) at the top edge of the view. */
  const place = useCallback((top: number) => {
    const el = box.current
    const rm = rowsRef.current
    if (!el) return
    const g = scrollGeometry(rm.count, el.clientHeight, ROW_H)
    const t = Math.min(g.maxTop, Math.max(0, top))
    topRef.current = t
    el.scrollTop = g.scrollH < rm.count * ROW_H ? scrollFromTop(g, t) : t * ROW_H
    expected.current = el.scrollTop
  }, [])

  // new rows (a fold opened, Raw, the plan as text): the first visible line stays where it is
  const lastRows = useRef<RowModel | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (lastRows.current !== rows) {
      const first = lastRows.current === null
      lastRows.current = rows
      const line = anchor.current
      place(first && !p.initialTop ? 0 : rows.rowOf(line))
    }
    measure()
  }, [rows, height, measure, place, p.initialTop])

  useImperativeHandle(ref, () => ({
    view: () => ({ ...seen.current }),
    focus: () => box.current?.focus({ preventScroll: true }),
    visible: (line) => {
      const el = box.current
      if (!el) return false
      const r = rowsRef.current.rowOf(line)
      const t = topRef.current
      return r >= t - 0.05 && r + 1 <= t + el.clientHeight / ROW_H + 0.05 // one pixel of slack
    },
    reveal: (line, how = 'center') => {
      const el = box.current
      if (!el) return
      const r = rowsRef.current.rowOf(line)
      const t = topRef.current
      const rowsIn = el.clientHeight / ROW_H
      if (how === 'top') place(Math.max(0, r - 1))
      else if (how === 'near') { if (r < t) place(r); else if (r + 1 > t + rowsIn) place(r + 1 - rowsIn) }
      else if (r < t || r + 1 > t + rowsIn) place(Math.max(0, r - rowsIn / 2 + 1))
      measure()
    },
  }), [measure, place])

  // the widest line, for a horizontal scroll bar in Raw
  const maxLen = useMemo(() => {
    if (mode !== 'raw') return 0
    let m = 0
    for (let i = text.from; i <= text.to; i++) m = Math.max(m, Math.min(MAX_TEXT, text.get(i)?.length ?? 0))
    return m
  }, [mode, text])

  // the glossary card
  const [card, setCard] = useState<{ term: string; text: string; x: number; y: number } | null>(null)
  const cardKey = useRef<Element | null>(null)
  const onOver = (e: MouseEvent) => {
    const g = (e.target as Element).closest?.('.opt-gl[data-t]') ?? null
    if (g === cardKey.current) return
    cardKey.current = g
    if (!g) { setCard(null); return }
    const t = gloss.gloss.get((g as HTMLElement).dataset.t ?? '')
    if (!t) { setCard(null); return }
    const r = g.getBoundingClientRect()
    setCard({ term: t.term, text: t.text, x: Math.min(r.left, window.innerWidth - 460), y: r.bottom + 4 })
  }

  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element).closest?.('.lv-row') as HTMLElement | null
    if (!el) return
    const r = rowsRef.current.at(Number(el.dataset.r))
    if (!r) return
    const fb = (e.target as Element).closest('[data-fold]')
    if (fb || r.t === 'fold') { p.onFold(r, r.t === 'fold' ? r.fold : ix.foldById.get((fb as HTMLElement).dataset.fold ?? '') as OptFold); return }
    const pl = (e.target as Element).closest('[data-plan]') as HTMLElement | null
    if (pl) { p.onPlan(pl.dataset.plan === 'text' ? 'text' : 'plan'); return }
    if ((e.target as Element).closest('[data-open]')) { planLink.onOpen?.(); return }
    const df = (e.target as Element).closest('[data-diff]') as HTMLElement | null
    if (df) { p.onDiff(Number(df.dataset.diff), r); return }
    p.onRow(r, r.line)
  }

  const dress = (ln: number, s: string) => {
    let x = dressed.current.get(ln)
    if (!x) { x = dressLine(ix, gloss, ln, s); dressed.current.set(ln, x) }
    return x
  }
  const hits = search.hits
  const hitsOf = (a: number, b: number) => (search.re ? hitsIn(hits, a, b) : 0)
  const ranges = (s: string, ln: number) => (search.re && hasHit(hits, ln) ? matchRanges(search.re, s, ln === hitCur) : [])

  const planWidths = useMemo(() => {
    const pl = d.plan
    if (!pl) return { op: 9, name: 4 }
    return { op: Math.max(9, ...pl.rows.map((o) => o.depth * 2 + o.op.length)), name: Math.max(4, ...pl.rows.map((o) => o.name.length)) }
  }, [d.plan])

  // the columns after Time (Pstart, Pstop; TQ, IN-OUT, PQ Distrib), with the header's own titles and the width of the widest cell. They are drawn when
  // the band is wide enough to keep a little of the operation and the name beside them (those two give way first, with an ellipsis); in a narrower
  // one the Text view of the plan has them.
  const allExtra = useMemo(() => {
    const pl = d.plan
    if (!pl) return []
    return pl.cols.slice(STD_COLS).map((title, k) => ({ title, w: Math.max(title.length, ...pl.rows.map((o) => o.extra?.[k]?.length ?? 0)) }))
  }, [d.plan])
  const extraW = allExtra.reduce((n, c) => n + c.w + 2, 0)
  const room = (width - BAND_CHROME) / BAND_CHW - (BAND_FIXED + OP_MIN + NAME_MIN)
  const extraCols = extraW > 0 && room >= extraW ? allExtra : []
  const extraHidden = allExtra.length > 0 && extraCols.length === 0
  const planSwitch = (view: 'plan' | 'text') => (
    <>
      <span className="opt-seg" role="group" aria-label="The plan as">
        <button type="button" data-plan="plan" aria-pressed={view === 'plan'} title="The plan table as a plan">Plan</button>
        <button type="button" data-plan="text" aria-pressed={view === 'text'} title="The trace's own text">Text</button>
      </span>
      {planLink.href
        ? <a className="opt-act opt-act-link" href={planLink.href} target="_blank" rel="noopener" title="Open the plan, estimates only, in the plan visualizer (the plan travels in the link's fragment)" onClick={planLink.onOpen ? (e) => { e.preventDefault(); planLink.onOpen?.() } : undefined}>Open in plan viz ↗</a>
        : <span className="opt-act opt-act-off" title={planLink.note ?? 'preparing the link'}>{planLink.note ?? 'Open in plan viz ↗'}</span>}
    </>
  )

  const renderRow = (r: OptRow, idx: number): ReactNode => {
    const ln = r.line
    const cls = ['lv-row']
    const lmk = ix.lmAt.get(ln)
    const sqlCont = r.t === 'sql' && r.k > 0
    if (lmk && lm[lmk.kind] && r.t !== 'fold' && r.t !== 'gap' && !sqlCont) cls.push('opt-lm', 'opt-lm-' + lmk.tone)
    if (ln === sel && !sqlCont && r.t !== 'gap') cls.push('lv-sel')
    else if (r.t === 'gap' && sel >= r.line && sel <= r.to) cls.push('lv-sel')
    const note = bookmarks.get(ln)
    if (note !== undefined && !sqlCont) cls.push(note ? 'lv-note' : 'lv-bm')
    let num: ReactNode = String(ln)
    let fh: ReactNode = null
    let tx: ReactNode = null
    const foldBtn = (f: OptFold | null, open: boolean) => f && (
      <button type="button" className="lv-fold" data-fold={f.id} title={`${open ? 'Close' : 'Open'}: ${f.label}, lines ${fmtInt(f.from)}-${fmtInt(f.to)}  (z)`} aria-label={open ? 'Close the fold' : 'Open the fold'} aria-expanded={open}>{open ? '▾' : '▸'}</button>
    )
    switch (r.t) {
      case 'raw': {
        const s = text.get(ln) ?? ''
        const t = s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s
        tx = plain(t, ranges(t, ln))
        break
      }
      case 'gap':
        cls.push('opt-gaprow')
        tx = <span className="opt-gap" title={`${r.n === 1 ? 'This line is' : 'These lines are'} in the file, not in the report`}>{gapText(r.line, r.to)}</span>
        break
      case 'fold': {
        const f = r.fold
        cls.push('opt-fold', f.kind === 'same-run' ? 'opt-fold-run' : '')
        const s = text.get(ln) ?? ''
        const h = hitsOf(f.from, f.to)
        fh = foldBtn(f, false)
        const first = ix.sqlAt.has(ln) && s.length > 90 ? s.slice(0, 90) + ' …' : s
        tx = <>{plain(first, ranges(first, ln))}<span className="opt-fold-sum"><b>{fmtInt(f.lines)}</b> {f.lines === 1 ? 'line' : 'lines'} · {f.label}{h ? <> · <i>{fmtInt(h)} {h === 1 ? 'hit' : 'hits'}</i></> : null}</span></>
        break
      }
      case 'head': {
        cls.push(r.major ? 'opt-h1' : 'opt-h2')
        fh = foldBtn(r.fold, true)
        const span = r.to - r.from + 1
        const planHead = !!d.plan && planText && r.from === d.plan.from
        tx = <><span title={`${span === 3 ? 'A banner' : 'A heading'}: lines ${r.from}-${r.to}`}>{plain(r.text, ranges(r.text, ln))}</span>{planHead && planSwitch('text')}</>
        break
      }
      case 'sql': {
        cls.push('opt-sql')
        if (r.k === 0) cls.push('opt-sql-first')
        if (r.k === r.n - 1) cls.push('opt-sql-last')
        fh = foldBtn(r.fold, true)
        tx = marked(sqlSpans(r.text), ranges(r.text, ln))
        break
      }
      case 'planhead':
        cls.push('opt-h1', 'opt-planhead')
        tx = <>Plan table<small title={extraHidden ? `${allExtra.map((c) => c.title).join(', ')} ${allExtra.length === 1 ? 'is' : 'are'} in the Text view at this width` : undefined}>lines {fmtInt(r.plan.from)}-{fmtInt(r.plan.to)}, the table, its query blocks and predicates{extraHidden && <> · {allExtra.map((c) => c.title).join(', ')} are in the Text view at this width</>}</small>{planSwitch('plan')}</>
        break
      case 'plancols':
        num = ''
        tx = (
          <span className="opt-tbl opt-tbl-head opt-tbl-first" style={planVars(planWidths)}>
            <span className="opt-pc opt-pc-id">Id</span><span className="opt-pc opt-pc-op">Operation</span><span className="opt-pc opt-pc-name">Name</span>
            <span className="opt-pc opt-pc-n">Rows</span><span className="opt-pc opt-pc-n">Bytes</span><span className="opt-pc opt-pc-n">Cost</span><span className="opt-pc opt-pc-time">Time</span>
            {extraCols.map((c, k) => <span key={k} className="opt-pc opt-pc-x" style={xw(c.w)}>{c.title}</span>)}
          </span>
        )
        break
      case 'planop': {
        const o = r.op
        const hit = hasHit(hits, ln)
        tx = (
          <span className={'opt-tbl' + (r.last ? ' opt-tbl-last' : '') + (hit ? ' opt-hit' : '')} style={planVars(planWidths)}>
            <span className="opt-pc opt-pc-id">{o.id}</span><span className="opt-pc opt-pc-op" style={{ '--dep': o.depth } as CSSProperties}>{o.op}</span>
            <span className="opt-pc opt-pc-name">{o.name}</span><span className="opt-pc opt-pc-n">{o.rows}</span><span className="opt-pc opt-pc-n">{o.bytes}</span>
            <span className="opt-pc opt-pc-n">{o.cost}</span><span className="opt-pc opt-pc-time">{o.time}</span>
            {extraCols.map((c, k) => <span key={k} className="opt-pc opt-pc-x" style={xw(c.w)}>{o.extra?.[k] ?? ''}</span>)}
          </span>
        )
        break
      }
      case 'planpred': {
        const hit = hasHit(hits, ln)
        const pm = /^(access|filter|qb)(.*)$/.exec(r.pred.text)
        tx = (
          <span className={'opt-tbl' + (r.last ? ' opt-tbl-last' : '') + (hit ? ' opt-hit' : '')} style={planVars(planWidths)}>
            <span className="opt-pc opt-pc-id" /><span className="opt-pc opt-pc-pred" style={{ '--dep': r.op.depth } as CSSProperties}>{pm ? <><b>{pm[1]}</b>{pm[2]}</> : r.pred.text}</span>
          </span>
        )
        break
      }
      case 'line': {
        const s = text.get(ln) ?? ''
        const dl = dress(ln, s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s)
        if (dl.cls) cls.push(dl.cls)
        fh = foldBtn(r.fold, true)
        const flat = dl.spans.map((x) => x.text).join('')
        tx = <>{marked(dl.spans, ranges(flat, ln))}{dl.act && (dl.act.prev
          ? <button type="button" className="opt-act" data-diff={dl.act.line} title={`The statement on the next line, pretty-printed, against the previous version (line ${dl.act.prev})`}>diff with line {fmtInt(dl.act.prev)}</button>
          : <span className="opt-act opt-act-off">first version in this dump</span>)}</>
        break
      }
    }
    return <div key={idx} className={cls.filter(Boolean).join(' ')} data-r={idx}><span className="lv-ln">{num}</span><span className="lv-fh">{fh}</span><span className="lv-tx">{tx}</span></div>
  }

  const out: ReactNode[] = []
  const end = Math.min(rows.count, win.last)
  const geo = scrollGeometry(rows.count, height, ROW_H)
  const capped = geo.scrollH < rows.count * ROW_H
  for (let k = Math.min(win.first, Math.max(0, rows.count - 1)); k < end; k++) out.push(renderRow(rows.at(k), k))

  return (
    <>
      <div ref={box} className={'opt-lv' + (mode === 'fmt' ? ' opt-fmt' : '')} tabIndex={0} role="region" aria-label={mode === 'fmt' ? 'The dump, formatted' : 'The dump, raw'} onScroll={schedule}>
        <div className="opt-lv-inner" style={{ blockSize: capped ? geo.scrollH : rows.count * ROW_H, inlineSize: mode === 'raw' ? `calc(${maxLen}ch + 14ch)` : undefined }}>
          {capped
            ? (
              <div className="opt-lv-stick" style={{ blockSize: height }}>
                <div className="opt-lv-layer opt-lv-mapped" style={{ transform: `translateY(${-win.shift * ROW_H}px)` }} onClick={onClick} onMouseOver={onOver} onMouseLeave={() => { cardKey.current = null; setCard(null) }}>
                  {out}
                </div>
              </div>
            )
            : (
              <div className="opt-lv-layer" style={{ transform: `translateY(${win.first * ROW_H}px)` }} onClick={onClick} onMouseOver={onOver} onMouseLeave={() => { cardKey.current = null; setCard(null) }}>
                {out}
              </div>
            )}
        </div>
      </div>
      {card && <div className="lv-card opt-card" style={{ '--x': `${card.x}px`, '--y': `${card.y}px` } as CSSProperties}><b>{card.term}</b>{card.text}</div>}
    </>
  )
}))
