import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { LINE_KINDS, type PageCache } from '../data/linecache'
import { clampTop, revealTop, scrollFromTop, scrollGeometry, topFromScroll } from '../data/scrollmap'
import { lineTone } from './colors'
import { highlightRuns, matchSpans } from '../data/lines'
import { elaOf, type LineDecode } from '../data/linefields'
import { fmtDur, fmtInt } from '../data/format'

/** Height of a row in pixels; the rows are laid out by this component, the scroll bar only maps to the first visible line (see data/scrollmap.ts). */
export const ROW_H = 20
/** The first rendered row moves in steps of `STEP` rows, so scrolling re-renders the rows once per 20 lines, not per pixel. */
const STEP = 20
const OVERSCAN = 20
/** Longest text rendered for one line (the rest is cut with a note). */
const MAX_TEXT = 10_000

const toneClass = LINE_KINDS.map((k) => `lv-tone-${lineTone[k] ?? 'ink'}`)
const K_CALL = LINE_KINDS.indexOf('call'), K_WAIT = LINE_KINDS.indexOf('wait')
/** How long the pointer rests on a line's text before its card opens. */
const CARD_DELAY = 350
const baseOf = (top: number) => Math.max(0, Math.floor(top / STEP) * STEP - OVERSCAN)

/** The search whose matches are highlighted inside the rows. */
export interface RowHighlight { q: string; regex: boolean; caseSensitive: boolean }

/** The lines a time window covers (1-based, inclusive): the rows in it get a band in the gutter, its first and last row a boundary. */
export interface LineWindow { from: number; to: number }

/** What the owner can ask of the viewer. */
export interface ViewerApi {
  /** first visible line, 1-based */
  topLine(): number
  /** lines that fit the view */
  visibleRows(): number
  /** scroll so that `line` is visible: in the middle (default) or with the least movement */
  reveal(line: number, how?: 'center' | 'nearest'): void
  focus(): void
}

interface Props {
  cache: PageCache
  /** line → 1 (a call of the selected statement), 2 (a wait), 3 (both) */
  marks: ReadonlyMap<number, number>
  bookmarks: ReadonlySet<number>
  /** line → the note of its bookmark (a gutter mark with the note as tooltip) */
  notes?: ReadonlyMap<number, string>
  selected: number
  wrap: boolean
  /** highlight the matches of this search inside the rows (keep the object stable: rows are memoised on it) */
  highlight?: RowHighlight | null
  /** the lines of the time window, marked in the gutter */
  range?: LineWindow | null
  /** draw the elapsed time of call and wait lines as a bar in the right gutter */
  heat?: boolean
  /** kind indexes (into `LINE_KINDS`) whose rows are dimmed; line counts and scrolling are unchanged */
  mutedKinds?: ReadonlySet<number>
  /** a cursor id: the rows of any other cursor (and rows without one) are dimmed; -1 or omitted for none (needs the ids of `annot=2`) */
  focusCursor?: number
  /** the hover card of a line (null: nothing to show); omit for no cards */
  card?(line: number, text: string, kind: number): LineDecode | null
  /** per-line actions on the selected row: copy the text, copy a permalink (omit `onLink` where there is no URL to link to) */
  onCopy?(line: number): void
  onLink?(line: number): void
  apiRef: MutableRefObject<ViewerApi | null>
  /** first visible line offset (0-based, fractional); the owner keeps it across mounts */
  topRef: MutableRefObject<number>
  onSelect(line: number): void
  onBookmark(line: number): void
  onError(message: string | null): void
}

/**
 * The raw lines of one file: a scroll container whose scroll bar stands for the whole file, a layer with a window of rows
 * (~100) that moves with `transform`, pages from the cache. No React state changes per line or per pixel scrolled.
 */
export function LineViewer({ cache, marks, bookmarks, notes, selected, wrap, highlight, range, heat, mutedKinds, focusCursor, card, onCopy, onLink, apiRef, topRef, onSelect, onBookmark, onError }: Props) {
  const sc = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  const [base, setBase] = useState(() => baseOf(topRef.current))
  const [, setTick] = useState(0)
  const baseRef = useRef(base)
  const expected = useRef(-1) // scrollTop we set ourselves: the scroll event it causes is not the user's
  const total = cache.total
  const geo = scrollGeometry(total, h, ROW_H)
  const geoRef = useRef(geo)
  geoRef.current = geo
  const rowsRef = useRef(0)
  rowsRef.current = h / ROW_H
  const [shown, setShown] = useState<CardAt | null>(null)
  const cardTimer = useRef(0)
  const cardLine = useRef(0) // the line the card is open or about to open for
  const pending = useRef<{ line: number; how: 'center' | 'nearest' } | null>(null) // a reveal asked for before the view had a size

  const place = useCallback(() => {
    if (layer.current) layer.current.style.transform = `translateY(${-(topRef.current - baseRef.current) * ROW_H}px)`
  }, [topRef])

  const hideCard = useCallback(() => {
    window.clearTimeout(cardTimer.current)
    cardLine.current = 0
    setShown(null)
  }, [])
  useEffect(() => () => window.clearTimeout(cardTimer.current), [])

  const ensurePages = useCallback(() => {
    const top = Math.floor(topRef.current)
    const p0 = cache.pageOf(Math.max(1, top + 1 - OVERSCAN))
    let p1 = cache.pageOf(top + Math.ceil(rowsRef.current) + OVERSCAN)
    if (cache.pageCount > 0) p1 = Math.min(p1, cache.pageCount - 1)
    const keep = new Set<number>()
    for (let p = p0 - 1; p <= p1 + 1; p++) keep.add(p)
    cache.keepOnly(keep)
    for (let p = p0; p <= p1; p++) {
      if (!cache.peek(p)) cache.load(p).then(() => onError(null), (e: unknown) => { if (!(e instanceof DOMException && e.name === 'AbortError')) onError(String(e)) })
    }
    cache.prefetch(p0)
    cache.prefetch(p1)
  }, [cache, topRef, onError])

  const moveTo = useCallback((top: number, fromBar = false) => {
    hideCard()
    topRef.current = cache.total > 0 ? clampTop(geoRef.current, top) : Math.max(0, top)
    const b = baseOf(topRef.current)
    if (b !== baseRef.current) setBase(b); else place()
    const el = sc.current
    if (el && !fromBar) {
      const target = scrollFromTop(geoRef.current, topRef.current)
      if (Math.abs(el.scrollTop - target) >= 0.5) { el.scrollTop = target; expected.current = el.scrollTop }
    }
    ensurePages()
  }, [cache, topRef, place, ensurePages, hideCard])

  // the committed base positions the layer before paint
  useLayoutEffect(() => { baseRef.current = base; place() }, [base, place])

  // a page arrived: repaint (the owner may also have learnt the total)
  useEffect(() => cache.subscribe(() => setTick((t) => t + 1)), [cache])

  // geometry changed (size, total): clamp and re-map
  useEffect(() => {
    const p = pending.current
    if (p && h > 0) { pending.current = null; moveTo(revealTop(topRef.current, p.line - 1, rowsRef.current, p.how)) } else moveTo(topRef.current)
  }, [total, h, moveTo, topRef])

  useEffect(() => {
    const el = sc.current!
    const ro = new ResizeObserver(() => setH(el.clientHeight))
    ro.observe(el)
    setH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // the wheel moves by lines: a native scroll of an 8 M px bar would be a different distance on every file size
  useEffect(() => {
    const el = sc.current!
    const onWheel = (e: WheelEvent) => {
      hideCard()
      if (e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * Math.max(1, rowsRef.current - 1) : e.deltaY / ROW_H
      moveTo(topRef.current + lines)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [moveTo, topRef, hideCard])

  const onScroll = () => {
    hideCard()
    const el = sc.current!
    if (Math.abs(el.scrollTop - expected.current) < 1) return
    moveTo(topFromScroll(geoRef.current, el.scrollTop), true)
  }

  useEffect(() => {
    apiRef.current = {
      topLine: () => Math.floor(topRef.current) + 1,
      visibleRows: () => Math.max(1, Math.floor(rowsRef.current)),
      reveal: (line, how = 'center') => {
        if (rowsRef.current === 0) { pending.current = { line, how }; topRef.current = Math.max(0, line - 1); return }
        moveTo(revealTop(topRef.current, line - 1, rowsRef.current, how))
      },
      focus: () => sc.current?.focus({ preventScroll: true }),
    }
    return () => { apiRef.current = null }
  }, [apiRef, moveTo, topRef])

  const lineOfEvent = (e: MouseEvent): { n: number; gutter: boolean } | null => {
    const t = e.target as HTMLElement
    const row = t.closest<HTMLElement>('[data-ln]')
    return row ? { n: Number(row.dataset.ln), gutter: !!t.closest('.lv-ln') } : null
  }
  const onClick = (e: MouseEvent) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (act) {
      const n = Number(act.closest<HTMLElement>('[data-ln]')?.dataset.ln)
      if (act.dataset.act === 'copy') onCopy?.(n); else onLink?.(n)
      return
    }
    const hit = lineOfEvent(e)
    if (hit && !(window.getSelection()?.toString() && !hit.gutter)) onSelect(hit.n)
  }
  const onContextMenu = (e: MouseEvent) => {
    const hit = lineOfEvent(e)
    if (hit?.gutter) { e.preventDefault(); onBookmark(hit.n) }
  }
  /** Rests on a line's text for `CARD_DELAY`: open its card (no listeners on the rows; this one handler reads `data-ln`). */
  const onPointerMove = (e: PointerEvent) => {
    if (!card || e.pointerType === 'touch') return
    const t = e.target as HTMLElement
    const row = t.closest<HTMLElement>('[data-ln]')
    const n = row && t.closest('.lv-tx') ? Number(row.dataset.ln) : 0
    if (n === cardLine.current) return
    hideCard()
    if (n === 0 || !row) return
    cardLine.current = n
    const x = e.clientX
    cardTimer.current = window.setTimeout(() => {
      const l = cache.line(n)
      const decode = l && l.kind >= 0 ? card(n, l.text, l.kind) : null
      if (!decode) return
      const r = row.getBoundingClientRect()
      setShown({ line: n, x, top: r.top, bottom: r.bottom, decode })
    }, CARD_DELAY)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    hideCard()
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const page = Math.max(1, Math.floor(rowsRef.current) - 1)
    let to: number
    switch (e.key) {
      case 'ArrowDown': to = selected + 1; break
      case 'ArrowUp': to = selected - 1; break
      case 'PageDown': to = selected + page; break
      case 'PageUp': to = selected - page; break
      case 'Home': to = 1; break
      case 'End': to = total; break
      case 'b': e.preventDefault(); onBookmark(selected); return
      default: return
    }
    e.preventDefault()
    to = Math.min(Math.max(1, total), Math.max(1, to))
    onSelect(to)
    apiRef.current?.reveal(to, 'nearest')
  }

  const count = Math.ceil(h / ROW_H) + 2 * OVERSCAN + STEP
  const end = total > 0 ? Math.min(base + count, total) : base
  const rows = []
  for (let i = base; i < end; i++) {
    const n = i + 1
    const l = cache.line(n)
    const win = range && n >= range.from && n <= range.to ? WIN_IN | (n === range.from ? WIN_START : 0) | (n === range.to ? WIN_END : 0) : 0
    const ela = heat && l && (l.kind === K_CALL || l.kind === K_WAIT) ? elaOf(l.text, LINE_KINDS[l.kind]) : -1
    rows.push(<Row key={n} n={n} text={l?.text} kind={l?.kind ?? -1} heat={ela} mk={marks.get(n) ?? 0} sel={n === selected} bm={bookmarks.has(n)} note={notes?.get(n)} hl={highlight ?? undefined} win={win} muted={!!l && !!mutedKinds?.has(l.kind)} dim={focusCursor !== undefined && focusCursor >= 0 && !!l && l.cursor !== focusCursor} acts={n === selected ? (onLink ? 2 : onCopy ? 1 : 0) : 0} />)
  }
  const digits = String(Math.max(total, 1000)).length
  return (
    <div className={'lv' + (wrap ? ' lv-wrap' : '')} ref={sc} tabIndex={0} role="list" aria-label="Trace lines" aria-rowcount={total}
      style={{ '--lv-row': `${ROW_H}px`, '--lv-ln': `${digits}ch` } as React.CSSProperties}
      onScroll={onScroll} onClick={onClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
      onPointerMove={card ? onPointerMove : undefined} onPointerLeave={card ? hideCard : undefined}>
      <div className="lv-inner" style={{ height: geo.scrollH }}>
        <div className="lv-view" style={{ height: h }}>
          <div className="lv-layer" ref={layer}>{rows}</div>
        </div>
      </div>
      {shown && createPortal(<LineCard at={shown} />, document.body)}
    </div>
  )
}

/** A row's place in the time window (flags): inside it, its first line, its last line. */
const WIN_IN = 1, WIN_START = 2, WIN_END = 4

const Row = memo(function Row({ n, text, kind, heat, mk, sel, bm, note, hl, win, muted, dim, acts }: {
  n: number; text: string | undefined; kind: number
  /** the elapsed µs of a call or wait line, -1 for none (no bar) */
  heat: number
  mk: number; sel: boolean; bm: boolean; note?: string; hl?: RowHighlight
  /** `WIN_*` flags */
  win: number
  /** dimmed by the owner's muted kinds */
  muted: boolean
  /** outside the focused cursor */
  dim: boolean
  /** the selected row's actions: 0 none, 1 copy, 2 copy and permalink */
  acts: number
}) {
  const cut = text !== undefined && text.length > MAX_TEXT
  const cls = 'lv-row ' + (kind >= 0 ? toneClass[kind] : 'lv-pending') + (mk ? ` lv-mk${mk}` : '') + (sel ? ' lv-sel' : '') + (bm ? ' lv-bm' : '') + (note ? ' lv-note' : '') + (muted ? ' lv-mute' : '') + (dim ? ' lv-dim' : '')
    + (win & WIN_IN ? ' lv-win' : '') + (win & WIN_START ? ' lv-win-start' : '') + (win & WIN_END ? ' lv-win-end' : '')
  return (
    <div className={cls} data-ln={n} role="listitem" aria-selected={sel || undefined}>
      <span className="lv-ln" title={note}>{n}</span>
      <span className="lv-tx">{text === undefined ? '' : cut ? text.slice(0, MAX_TEXT) + ` … (+${text.length - MAX_TEXT} characters)` : hl ? marked(text, hl) : text || ' '}</span>
      {/* a fixed-width gutter at the row's end in every row: the text of the selected row is never laid under its actions */}
      <span className="lv-gut">
        {acts > 0 && (
          <span className="lv-act" role="group" aria-label={`Line ${n}`}>
            <button type="button" data-act="copy" title="copy the line's text" aria-label={`Copy the text of line ${n}`}>Copy</button>
            {acts > 1 && <button type="button" data-act="link" title="copy a link that opens this line" aria-label={`Copy a link to line ${n}`}>Link</button>}
          </span>
        )}
        {heat > 0 && <i className="lv-heat" style={{ '--w': heatWidth(heat).toFixed(3) } as React.CSSProperties} title={fmtDur(heat)} />}
      </span>
    </div>
  )
})

/** The bar of an elapsed time as a fraction of the gutter: log scale, 1 µs nothing, 1 ms half, 1 s (and longer) full. */
export const heatWidth = (us: number) => Math.min(1, Math.max(0, Math.log10(us) / 6))

/** Where a card opens: the line's row (viewport coordinates) and the pointer's x. */
interface CardAt { line: number; x: number; top: number; bottom: number; decode: LineDecode }

/** The hover card of a line: one element, fixed under its row (above it when the viewport ends first), never focused. */
function LineCard({ at }: { at: CardAt }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const c = el.current!
    const gap = 4, edge = 8
    const w = c.offsetWidth, h = c.offsetHeight
    const below = at.bottom + gap
    const y = below + h > window.innerHeight - edge && at.top - gap - h >= edge ? at.top - gap - h : below
    c.style.setProperty('--x', `${Math.max(edge, Math.min(at.x, window.innerWidth - w - edge))}px`)
    c.style.setProperty('--y', `${y}px`)
  }, [at])
  const d = at.decode
  return (
    <div className="lv-card" ref={el} role="tooltip">
      <div className="lv-card-h">{d.title}<span>line {fmtInt(at.line)}</span></div>
      {d.fields.length > 0 && (
        <table>
          <tbody>
            {d.fields.map((f, i) => (<tr key={i} title={f.hint}><th scope="row">{f.label}</th><td>{f.value}</td></tr>))}
          </tbody>
        </table>
      )}
      {d.note && <p>{d.note}</p>}
    </div>
  )
}


/** The line's text with the matches of the search wrapped in <mark>. */
function marked(text: string, hl: RowHighlight) {
  const spans = matchSpans(text, hl.q, hl.regex, hl.caseSensitive)
  if (spans.length === 0) return text || ' '
  return highlightRuns(text, spans).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : r.text))
}
