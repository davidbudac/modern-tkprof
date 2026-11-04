import { memo, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LINE_KINDS, type CachedLine, type PageCache } from '../data/linecache'
import { foldAt, headAtRow, indexFolds, lineOfRow, rowOfLine, tableOf, visibleCount, withHeads, type Fold, type FoldIndex } from '../data/folds'
import { clampTop, revealTop, scrollFromTop, scrollGeometry, topFromScroll } from '../data/scrollmap'
import { lineTone } from './colors'
import { highlightRuns, matchSpans } from '../data/lines'
import { elaOf, splitZeros, type LineDecode } from '../data/linefields'
import { mergeHits, refRuns, type RefRun } from '../data/linerefs'
import { fmtDur, fmtInt } from '../data/format'
import type { Inlay } from '../data/inlays'
import type { LineTimes } from '../data/linetime'
import type { ReadableCell } from '../views/readableRows'
import type { BindCellRow, Seg } from '../data/readable'
import { PlanCells, PlanHeads } from './PlanCells'

/** Height of a row in pixels; the rows are laid out by this component, the scroll bar only maps to the first visible line (see data/scrollmap.ts). */
export const ROW_H = 20
/** The first rendered row moves in steps of `STEP` rows, so scrolling re-renders the rows once per 20 lines, not per pixel. */
const STEP = 20
const OVERSCAN = 20
/** Longest text rendered for one line (the rest is cut with a note). */
const MAX_TEXT = 10_000

const toneClass = LINE_KINDS.map((k) => `lv-tone-${lineTone[k] ?? 'ink'}`)
const K_CALL = LINE_KINDS.indexOf('call'), K_WAIT = LINE_KINDS.indexOf('wait'), K_STAT = LINE_KINDS.indexOf('stat')
/** How long the pointer rests on a line's text before its card opens. */
const CARD_DELAY = 350
const NO_FOLDS: readonly Fold[] = []
const NO_TABLES: readonly (readonly [number, number])[] = []
const baseOf = (top: number) => Math.max(0, Math.floor(top / STEP) * STEP - OVERSCAN)

/** The search whose matches are highlighted inside the rows. */
export interface RowHighlight { q: string; regex: boolean; caseSensitive: boolean }

/** The lines a time window covers (1-based, inclusive): the rows in it get a band in the gutter, its first and last row a boundary. */
export interface LineWindow { from: number; to: number }

/** The click on a reference: the modifier keys, the pointer (viewport coordinates) and the box of the clicked link (a popup anchors at it). */
export interface RefMods { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; x: number; y: number; anchor?: DOMRect }

export type { Inlay }

/** What the owner can ask of the viewer. */
export interface ViewerApi {
  /** the line in the first visible row, 1-based */
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
  /** dim annotations inside the row text (`Inlay.at` = index in the text after which the hint is inserted; 0 inserts before, text.length appends); omit for none. Keep the function stable: rows are memoised on it, and a new one repaints them */
  inlays?(line: number, text: string, kind: number, ids: CachedLine | undefined): Inlay[]
  /** the selected range of lines (inclusive, from <= to), highlighted; null/omitted for none. (`range` above is the time window.) */
  selRange?: { from: number; to: number } | null
  /** Shift+click on a row or Shift+Arrow/Page/Home/End extend a range from the anchor (the selected line when no range) to that line; a plain click or unshifted move clears it (null) */
  onRange?(range: { from: number; to: number } | null): void
  /** the line under the pointer over the text (null on leave), at most once per animation frame */
  onHover?(line: number | null): void
  /** the idle gap before a line in µs (0/undefined none): a tick in the gutter with the duration as its title */
  gap?(line: number): number | undefined
  /** draw the elapsed time of call and wait lines as a bar in the right gutter */
  heat?: boolean
  /** the clock and delta columns of the gutter (keep it stable: a new one repaints the rows); omit for neither */
  times?: LineTimes
  /** kind indexes (into `LINE_KINDS`) whose rows are dimmed; line counts and scrolling are unchanged */
  mutedKinds?: ReadonlySet<number>
  /** a cursor id: the rows of any other cursor (and rows without one) are dimmed; -1 or omitted for none (needs the ids of `annot=2`) */
  focusCursor?: number
  /** the hover card of a line (null: nothing to show); omit for no cards */
  card?(line: number, text: string, kind: number): LineDecode | null
  /** underline the references in the rows (cursor numbers, sql_ids, obj#, plan hashes); a click on one calls `onRef` and does not select the row */
  links?: boolean
  /** a click on a reference: its line, kind (`cursor`, `sqlid`, `obj`, `plh`), value, the line's cached ids and the modifier keys */
  onRef?(line: number, kind: string, value: string, ids: CachedLine | undefined, mods: RefMods): void
  /** the tooltip of a reference, asked once when the pointer first rests on it (undefined: none) */
  refTitle?(kind: string, value: string, ids: CachedLine | undefined): string | undefined
  /** the folded ranges (sorted, apart; keep the array stable between changes): lines `from+1..to` are not laid out, `from` shows the summary. Omit for none */
  folds?: readonly Fold[]
  /** handle lines of blocks that can be folded (the handle shows `▾`; a folded one always shows `▸`) */
  foldable?: ReadonlySet<number>
  /** a click on a fold handle: fold or unfold the block of this line */
  onFold?(line: number): void
  /** the header for the first visible line, laid over the top of the rows (null: none, nothing is shown; the view never changes size); `key` says when `node` changed */
  head?(topLine: number): { key: string; node: ReactNode } | null
  /** the readable mode: each line parsed into columns (kind, detail, time bar, Δ, clock) with its cursor's lane; keep it stable, a new one repaints the rows */
  readable?(line: number, l: CachedLine): ReadableCell
  /** readable mode: the line ranges laid out as tables, a head row above each (the plan dumps); sorted, apart; keep the array stable */
  tables?: readonly (readonly [number, number])[]
  /** readable mode: the Δ column (after the kind, before the detail) */
  deltaCol?: boolean
  /** a click on a row's own control in readable mode: `pin` (the line number's pin), `asrun` (a BINDS row's SQL with its values), `lane` (a lane's sql_id) */
  onAct?(line: number, act: 'pin' | 'asrun' | 'lane', el: HTMLElement): void
  /** a row over the scroll container, as wide as its rows (the formatted view's column headers): `--lv-sbw` is the scroll bar's width */
  top?: ReactNode
  /** something beside the scroll container, the full height of the viewer (the density strip) */
  side?: ReactNode
  /** the first visible line (1-based) and the lines that fit (in lines, folds counted), after every move and resize (at most once per animation frame) */
  onViewChange?(top: number, rows: number): void
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
export function LineViewer({ cache, marks, bookmarks, notes, selected, wrap, highlight, range, inlays, selRange, onRange, onHover, gap, heat, times, mutedKinds, focusCursor, links, onRef, refTitle, head, card, folds, foldable, onFold, readable, tables, deltaCol, onAct, top, side, onViewChange, apiRef, topRef, onSelect, onBookmark, onError }: Props) {
  const sc = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  const [base, setBase] = useState(() => baseOf(topRef.current))
  const [, setTick] = useState(0)
  const baseRef = useRef(base)
  const expected = useRef(-1) // scrollTop we set ourselves: the scroll event it causes is not the user's
  const total = cache.total
  // `topRef`, the scroll bar and the rows count visual rows: the lines of the folds are not laid out
  // the folds and, in readable mode, a head row for each table
  const index = useMemo(() => indexFolds(withHeads(folds ?? NO_FOLDS, readable ? tables ?? NO_TABLES : NO_TABLES)), [folds, tables, readable])
  const indexRef = useRef<FoldIndex>(index)
  indexRef.current = index
  const prevIndex = useRef(index)
  const vtotal = visibleCount(total, index)
  const geo = scrollGeometry(vtotal, h, ROW_H)
  const geoRef = useRef(geo)
  geoRef.current = geo
  const rowsRef = useRef(0)
  rowsRef.current = h / ROW_H
  const [shown, setShown] = useState<CardAt | null>(null)
  const cardTimer = useRef(0)
  const cardLine = useRef(0) // the line the card is open or about to open for
  const pending = useRef<{ line: number; how: 'center' | 'nearest' } | null>(null) // a reveal asked for before the view had a size

  // the pinned header: recomputed when the first visible line moves, the state changes only with the header's key
  const [pinned, setPinned] = useState<{ key: string; node: ReactNode } | null>(null)
  const headRef = useRef(head)
  headRef.current = head
  // readable mode: the plan table's column headers over the top row while the top row is a plan line (its own head scrolled away)
  const [planTop, setPlanTop] = useState(false)
  const readableOn = useRef(false)
  readableOn.current = !!readable
  const refreshHead = useCallback((force = false) => {
    const r0 = Math.floor(topRef.current), x = indexRef.current
    const top = lineOfRow(r0, x)
    const r = headRef.current?.(top) ?? null
    setPinned((prev) => (!force && (prev?.key ?? null) === (r?.key ?? null) ? prev : r))
    setPlanTop(readableOn.current && (tableOf(top, x) ? !headAtRow(r0, x) : cache.line(top)?.kind === K_STAT))
  }, [topRef, cache])

  // the visible range for the owner, coalesced to one call per animation frame
  const viewCb = useRef(onViewChange)
  viewCb.current = onViewChange
  const viewFrame = useRef(0)
  const notifyView = useCallback(() => {
    if (viewFrame.current || !viewCb.current) return
    viewFrame.current = requestAnimationFrame(() => {
      viewFrame.current = 0
      const x = indexRef.current, r0 = Math.floor(topRef.current), rows = rowsRef.current
      // the rows the view covers, as lines: hidden lines in between count
      const span = x.folds.length === 0 ? rows : lineOfRow(Math.floor(r0 + rows), x) - lineOfRow(r0, x) + (r0 + rows - Math.floor(r0 + rows))
      viewCb.current?.(lineOfRow(r0, x), span)
    })
  }, [topRef])
  useEffect(() => () => { cancelAnimationFrame(viewFrame.current); viewFrame.current = 0 }, []) // (StrictMode re-runs the effects: the id must not stay set)

  const place = useCallback(() => {
    if (layer.current) layer.current.style.transform = `translateY(${-(topRef.current - baseRef.current) * ROW_H}px)`
  }, [topRef])

  const hideCard = useCallback(() => {
    window.clearTimeout(cardTimer.current)
    cardLine.current = 0
    setShown(null)
  }, [])
  useEffect(() => () => window.clearTimeout(cardTimer.current), [])

  // the line under the pointer for the owner: the wanted line is kept per move, the call is coalesced to one per animation frame
  const hoverCb = useRef(onHover)
  hoverCb.current = onHover
  const hoverWant = useRef<number | null>(null) // the line under the pointer now
  const hoverSent = useRef<number | null>(null) // the line the owner was told last
  const hoverFrame = useRef(0)
  const setHover = useCallback((n: number | null) => {
    if (hoverWant.current === n) return
    hoverWant.current = n
    if (hoverFrame.current) return
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0
      if (hoverSent.current === hoverWant.current) return
      hoverSent.current = hoverWant.current
      hoverCb.current?.(hoverSent.current)
    })
  }, [])
  useEffect(() => () => { cancelAnimationFrame(hoverFrame.current); hoverFrame.current = 0 }, [])

  // the anchor of the range selection (only meaningful while `selRange` has it as an end)
  const anchor = useRef(0)

  const ensurePages = useCallback(() => {
    const x = indexRef.current, r0 = Math.floor(topRef.current)
    const p0 = cache.pageOf(Math.max(1, lineOfRow(r0, x) - OVERSCAN))
    let p1 = cache.pageOf(lineOfRow(r0 + Math.ceil(rowsRef.current), x) - 1 + OVERSCAN)
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

  /** `keepHead`: a move the view's size caused (the header is not recomputed for it). */
  const moveTo = useCallback((top: number, fromBar = false, keepHead = false) => {
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
    if (!keepHead) refreshHead()
    notifyView()
  }, [cache, topRef, place, ensurePages, hideCard, refreshHead, notifyView])

  // the committed base positions the layer before paint
  useLayoutEffect(() => { baseRef.current = base; place() }, [base, place])

  // a page arrived: repaint (the owner may also have learnt the total)
  useEffect(() => cache.subscribe(() => { setTick((t) => t + 1); refreshHead() }), [cache, refreshHead])
  // the owner's header function changed (its closures): rebuild the node
  useEffect(() => refreshHead(true), [head, refreshHead])
  useEffect(() => refreshHead(), [readable, refreshHead]) // (the plan's column headers)

  // geometry changed (size, total): clamp and re-map
  useEffect(() => {
    if (prevIndex.current !== index) { // the folds changed: the first visible line stays the first visible line
      const top = topRef.current, r0 = Math.floor(top)
      topRef.current = rowOfLine(lineOfRow(r0, prevIndex.current), index) + (top - r0)
      prevIndex.current = index
    }
    const p = pending.current
    if (p && h > 0) { pending.current = null; moveTo(revealTop(topRef.current, rowOfLine(p.line, index), rowsRef.current, p.how)) } else moveTo(topRef.current, false, true)
  }, [vtotal, h, index, moveTo, topRef])

  const [sbw, setSbw] = useState(0) // the scroll bar's width: a row over the rows leaves it out, so its columns line up
  const probe = useRef<HTMLSpanElement>(null)
  const [chw, setChw] = useState(0) // the width of a digit in the rows' font: the formatted columns' default widths are in digits
  useEffect(() => {
    const el = sc.current!
    const measure = () => {
      setH(el.clientHeight); setSbw(el.offsetWidth - el.clientWidth)
      const w = probe.current?.getBoundingClientRect().width ?? 0
      if (w > 0) setChw(w / 10)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
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
      topLine: () => lineOfRow(Math.floor(topRef.current), indexRef.current),
      visibleRows: () => Math.max(1, Math.floor(rowsRef.current)),
      reveal: (line, how = 'center') => {
        const row = rowOfLine(line, indexRef.current)
        if (rowsRef.current === 0) { pending.current = { line, how }; topRef.current = Math.max(0, row); return }
        moveTo(revealTop(topRef.current, row, rowsRef.current, how))
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
      if (act.dataset.act === 'ref') {
        const ref = act.dataset.ref ?? '', i = ref.indexOf(':')
        if (i > 0) onRef?.(n, ref.slice(0, i), ref.slice(i + 1), cache.line(n), { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, x: e.clientX, y: e.clientY, anchor: act.getBoundingClientRect() })
      } else if (act.dataset.act === 'fold') onFold?.(n)
      else if (act.dataset.act === 'pin' || act.dataset.act === 'asrun' || act.dataset.act === 'lane') onAct?.(n, act.dataset.act, act)
      return
    }
    const hit = lineOfEvent(e)
    if (hit && e.shiftKey && onRange) { extendTo(hit.n); return }
    if (hit && !(window.getSelection()?.toString() && !hit.gutter)) {
      if (selRange) onRange?.(null)
      onSelect(hit.n)
    }
  }
  /** The anchor of the range and the end that moves: with a range, the anchor kept from its start (it must still be an end of the range), else the selected line. */
  const rangeEnds = (): { a: number; cur: number } => {
    if (selRange && (anchor.current === selRange.from || anchor.current === selRange.to)) return { a: anchor.current, cur: anchor.current === selRange.from ? selRange.to : selRange.from }
    return { a: selected, cur: selected }
  }
  /** Shift: the range runs from the anchor to `n`; the selection stays where it is. */
  const extendTo = (n: number) => {
    const { a } = rangeEnds()
    anchor.current = a
    onRange?.({ from: Math.min(a, n), to: Math.max(a, n) })
  }
  /** Shift+mouse down must not extend the browser's text selection (it would select across rows). */
  const onMouseDown = (e: MouseEvent) => {
    if (e.shiftKey && onRange && !(e.target as HTMLElement).closest('[data-act]')) e.preventDefault()
  }
  const onContextMenu = (e: MouseEvent) => {
    const hit = lineOfEvent(e)
    if (hit?.gutter) { e.preventDefault(); onBookmark(hit.n) }
  }
  /** Rests on a line's text for `CARD_DELAY`: open its card (no listeners on the rows; this one handler reads `data-ln`). */
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    const t = e.target as HTMLElement
    if (onHover) {
      const r = t.closest<HTMLElement>('[data-ln]')
      setHover(r && t.closest('.lv-tx') ? Number(r.dataset.ln) : null)
    }
    const link = t.closest<HTMLElement>('.lv-ref')
    if (link) {
      // a reference has a tooltip of its own, not the card; it is set once, on the first move over it
      hideCard()
      if (link.dataset.tip === undefined) {
        link.dataset.tip = ''
        const ref = link.dataset.ref ?? '', i = ref.indexOf(':')
        const n = Number(link.closest<HTMLElement>('[data-ln]')?.dataset.ln)
        const tip = i > 0 ? refTitle?.(ref.slice(0, i), ref.slice(i + 1), cache.line(n)) : undefined
        if (tip) link.title = tip
      }
      return
    }
    if (!card) return
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
  const onPointerLeave = () => { hideCard(); if (onHover) setHover(null) }
  const onKeyDown = (e: KeyboardEvent) => {
    hideCard()
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const page = Math.max(1, Math.floor(rowsRef.current) - 1)
    const x = indexRef.current
    const ext = e.shiftKey && !!onRange // Shift extends the range from the end that is not the anchor
    const row = rowOfLine(ext ? rangeEnds().cur : selected, x) // moves step by visual row: a fold is one step
    let to: number
    switch (e.key) {
      case 'ArrowDown': to = row + 1; break
      case 'ArrowUp': to = row - 1; break
      case 'PageDown': to = row + page; break
      case 'PageUp': to = row - page; break
      case 'Home': to = 0; break
      case 'End': to = vtotal - 1; break
      case 'b': e.preventDefault(); onBookmark(selected); return
      default: return
    }
    e.preventDefault()
    to = Math.min(Math.max(0, vtotal - 1), Math.max(0, to))
    if (to < row && to > 0 && headAtRow(to, x)) to-- // a table's head row is not a line: up from its first line goes above it
    to = lineOfRow(to, x)
    to = Math.min(Math.max(1, total), Math.max(1, to))
    if (ext) extendTo(to)
    else {
      if (selRange) onRange?.(null)
      onSelect(to)
    }
    apiRef.current?.reveal(to, 'nearest')
  }

  const count = Math.ceil(h / ROW_H) + 2 * OVERSCAN + STEP
  const end = total > 0 ? Math.min(base + count, vtotal) : base
  const rows = []
  for (let i = base; i < end; i++) {
    const th = readable ? headAtRow(i, index) : undefined
    if (th) {
      const l = cache.line(th.from)
      const rd = l && l.kind >= 0 ? readable!(th.from, l) : undefined
      rows.push(<PlanHeadRow key={`h${th.from}`} lane={rd?.lane ?? null} tone={rd?.tone ?? ''} dcol={!!deltaCol} />)
      continue
    }
    const n = lineOfRow(i, index)
    const f0 = foldAt(n, index)
    const fold = f0 && !f0.quiet ? f0 : undefined // a quiet fold's handle line reads as itself
    const l = cache.line(n)
    const win = range && n >= range.from && n <= range.to ? WIN_IN | (n === range.from ? WIN_START : 0) | (n === range.to ? WIN_END : 0) : 0
    const rd = readable && l && l.kind >= 0 ? readable(n, l) : undefined
    const ela = !heat || readable ? -2 : l && (l.kind === K_CALL || l.kind === K_WAIT) ? elaOf(l.text, LINE_KINDS[l.kind]) : -1
    const inRange = !!selRange && n >= selRange.from && n <= selRange.to
    const t = times && l && !readable ? times.at(n, l.text, l.kind) : undefined
    const clk = times?.clock && !readable ? t?.clock ?? '' : null, dlt = times?.delta && !readable ? t?.delta ?? '' : null
    const tb = rd?.plan ? tableOf(n, index) : undefined
    rows.push(<Row key={n} n={n} rd={rd} dcol={!!deltaCol} tb={tb ? (n === tb.to ? 2 : 1) : 0} foldLabel={fold?.label} foldW={fold?.w} foldUs={fold?.us} clk={clk} clkT={t?.clockTitle} dlt={dlt} dltT={t?.deltaTitle} anchor={!!t?.anchor} text={l?.text} kind={l?.kind ?? -1} ids={inlays ? l : undefined} inlays={inlays} gap={gap?.(n) ?? 0} inRange={inRange} heat={ela} mk={marks.get(n) ?? 0} sel={n === selected} bm={bookmarks.has(n)} note={notes?.get(n)} hl={highlight ?? undefined} win={win} muted={!!l && !!mutedKinds?.has(l.kind)} dim={focusCursor !== undefined && focusCursor >= 0 && !!l && l.cursor !== focusCursor} refs={!!links} fold={fold?.summary ?? null} foldable={!!foldable?.has(n)} />)
  }
  const digits = String(Math.max(total, 1000)).length
  const hover = card || refTitle || onHover
  return (
    <div className="lv-box" style={{ '--lv-row': `${ROW_H}px`, '--lv-ln': `${digits}ch`, '--lv-sbw': `${sbw}px`, '--lv-chw': chw > 0 ? `${chw}px` : undefined } as React.CSSProperties}>
      <div className="lv-box-col">
      {top}
      <div className="lv-stack">
      {/* over the top rows, not above them: the scroll container keeps its height whether there is a header or not */}
      {head && pinned && !(readable && planTop) && <div className="lv-head" role="note" aria-label="Statement at the top of the view">{pinned.node}</div>}
      <div className={'lv' + (readable ? ' lv-rd-on' : wrap ? ' lv-wrap' : '') + (heat && !readable ? ' lv-heat-on' : '')} ref={sc} tabIndex={0} role="list" aria-label="Trace lines" aria-rowcount={vtotal}
        style={{ '--lv-row': `${ROW_H}px`, '--lv-ln': `${digits}ch` } as React.CSSProperties}
        onScroll={onScroll} onClick={onClick} onMouseDown={onRange ? onMouseDown : undefined} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
        onPointerMove={hover ? onPointerMove : undefined} onPointerLeave={hover ? onPointerLeave : undefined}>
        <div className="lv-inner" style={{ height: geo.scrollH }}>
          <div className="lv-view" style={{ height: h }}>
            {readable && planTop && <PlanHeadRow lane={null} tone="commit" dcol={!!deltaCol} overlay />}
            <div className="lv-layer" ref={layer}>{rows}</div>
          </div>
        </div>
        <span className="lv-probe" ref={probe} aria-hidden="true">0000000000</span>
        {shown && createPortal(<LineCard at={shown} />, document.body)}
      </div>
      </div>
      </div>
      {side}
    </div>
  )
}

/** A row's place in the time window (flags): inside it, its first line, its last line. */
const WIN_IN = 1, WIN_START = 2, WIN_END = 4

const Row = memo(function Row({ n, rd, dcol, tb, foldLabel, foldW, foldUs, clk, clkT, dlt, dltT, anchor, text, kind, ids, inlays, gap, inRange, heat, mk, sel, bm, note, hl, win, muted, dim, refs, fold, foldable }: {
  n: number; text: string | undefined; kind: number
  /** the readable row of the line (readable mode), undefined for the trace as written */
  rd?: ReadableCell
  /** readable mode: the Δ column is shown */
  dcol?: boolean
  /** readable mode: a row of a table (a plan dump under its head row): 1, its last row 2; 0 for none */
  tb?: number
  /** a fold of repeats: its label and bar (readable mode) */
  foldLabel?: string; foldW?: number; foldUs?: number
  /** the clock cell: null for no column, '' for an empty cell; `clkT` its title */
  clk: string | null; clkT?: string
  /** the delta cell: null for no column, '' for an empty cell; `dltT` its title */
  dlt: string | null; dltT?: string
  /** the line the deltas are measured from (its delta cell shows a dot) */
  anchor: boolean
  /** the line's cached ids, given to `inlays` (undefined when there is no `inlays`) */
  ids: CachedLine | undefined
  /** the owner's hints function (a new function repaints the rows) */
  inlays?: Props['inlays']
  /** the idle gap before the line in µs, 0 for none */
  gap: number
  /** inside the selected range */
  inRange: boolean
  /** the elapsed µs of a call or wait line, -1 for none (an empty slot), -2 for no heat slot at all */
  heat: number
  mk: number; sel: boolean; bm: boolean; note?: string; hl?: RowHighlight
  /** `WIN_*` flags */
  win: number
  /** dimmed by the owner's muted kinds */
  muted: boolean
  /** outside the focused cursor */
  dim: boolean
  /** render the references of the text as links (`data-act="ref"`) */
  refs: boolean
  /** the summary of the fold this line is the handle of (the lines below it are hidden), null for none */
  fold: string | null
  /** the line starts a block that can be folded */
  foldable: boolean
}) {
  const cut = text !== undefined && text.length > MAX_TEXT
  const cls = 'lv-row ' + (kind >= 0 ? toneClass[kind] : 'lv-pending') + (mk ? ` lv-mk${mk}` : '') + (sel ? ' lv-sel' : '') + (bm ? ' lv-bm' : '') + (note ? ' lv-note' : '') + (muted ? ' lv-mute' : '') + (dim ? ' lv-dim' : '') + (inRange ? ' lv-range' : '')
    + (win & WIN_IN ? ' lv-win' : '') + (win & WIN_START ? ' lv-win-start' : '') + (win & WIN_END ? ' lv-win-end' : '')
  const handle = (
    <span className="lv-fh">
      {fold !== null
        ? <button type="button" className="lv-fold" data-act="fold" aria-expanded={false} aria-label={`Unfold line ${n}: ${fold}`} title={`unfold: ${fold} (z)`}>▸</button>
        : foldable && <button type="button" className="lv-fold" data-act="fold" aria-expanded={true} aria-label={`Fold the block at line ${n}`} title="fold this block (z)">▾</button>}
    </span>
  )
  if (rd) return <ReadableRow n={n} rd={rd} dcol={!!dcol} tb={tb ?? 0} cls={cls} sel={sel} note={note} gap={gap} handle={handle} fold={fold} foldLabel={foldLabel} foldW={foldW} foldUs={foldUs} hit={!!hl && text !== undefined && matchSpans(text, hl.q, hl.regex, hl.caseSensitive).length > 0} />
  return (
    <div className={cls} data-ln={n} role="listitem" aria-selected={sel || undefined}>
      <span className="lv-ln" title={note}>
        {clk !== null || dlt !== null ? <span className="lv-n">{n}</span> : n}{gap > 0 && <i className="lv-gap" title={`gap ${fmtDur(gap)} before this line`} />}
        {clk !== null && <span className="lv-clk" title={clkT}>{clk}</span>}
        {dlt !== null && <span className={'lv-dlt' + (anchor ? ' lv-dlt-anchor' : '') + (dlt.startsWith('−') ? ' lv-dlt-neg' : '')} title={dltT}>{anchor ? '●' : dlt}</span>}
        {/* the elapsed time as a bar right of the number, where the eye already is (a slot in every row while heat is on) */}
        {heat > -2 && <span className="lv-heat-slot">{heat > 0 && <i className="lv-heat" style={{ '--w': heatWidth(heat).toFixed(3) } as React.CSSProperties} title={fmtDur(heat)} />}</span>}
      </span>
      {/* a slot of its own in every row, so the text does not shift between rows with and without a handle */}
      {handle}
      <span className="lv-tx">{text === undefined ? '' : cut ? text.slice(0, MAX_TEXT) + ` … (+${text.length - MAX_TEXT} characters)` : hl || refs || inlays ? marked(text, kind, hl, refs, inlays?.(n, text, kind, ids)) : text || ' '}{fold !== null && <span className="lv-fold-sum">{fold}</span>}</span>
    </div>
  )
})

/**
 * The time a line took in its own column: the number right-aligned, the unit in a slot of its own after it, so the numbers line
 * up down the view whatever their unit (`146 µs`, `1.35 ms`, `2.448 s`); empty for a line without one.
 */
function DurCell({ us }: { us?: number }) {
  if (us === undefined) return <span className="lv-dur" />
  const s = fmtDur(us), i = s.lastIndexOf(' ')
  return <span className="lv-dur" title={`${fmtInt(us)} µs`}><b>{s.slice(0, i)}</b><small>{s.slice(i + 1)}</small></span>
}

/** One piece of a readable row's detail (an empty quantity is left out: the detail reads as one run of text). */
const segNode = (s: Seg, i: number) => (typeof s === 'string' ? s
  : 'q' in s ? (s.n === '' ? null : <span key={i} className={`rd-q rd-q-${s.q}`} title={s.title}><b>{s.n}</b> <small>{s.unit}</small></span>)
    : <span key={i} className={`rd-${s.c}`} title={s.title}>{s.t}</span>)

/** The Δ cell of a readable row (`dcol` off: none). */
const DeltaCell = ({ rd }: { rd?: ReadableCell }) => (
  <span className={'lv-rdlt' + (rd?.delta.startsWith('−') ? ' neg' : '')} title={rd?.deltaTitle}>{rd ? (rd.pinned ? 'pinned' : rd.delta) : ''}</span>
)

/**
 * A line in readable mode: its duration, the number (with the pin), the cursor's lane, the fold handle, the time bar, what the line
 * is, Δ, its detail and the clock. Every column but the detail has a width of its own, so they line up down the view; the detail is
 * cut where it does not fit. A plan line is a row of its plan's table: its cells in the detail, the time columns empty.
 */
function ReadableRow({ n, rd, dcol, tb, cls, sel, note, gap, handle, fold, foldLabel, foldW, foldUs, hit }: {
  n: number; rd: ReadableCell; dcol: boolean; tb: number; cls: string; sel: boolean; note?: string; gap: number; handle: ReactNode
  fold: string | null; foldLabel?: string; foldW?: number; foldUs?: number; hit: boolean
}) {
  const dur = fold !== null ? foldUs : rd.dur
  const lane = rd.lane
  const w = fold !== null && foldW !== undefined ? foldW : rd.barW
  const plan = fold === null ? rd.plan : undefined
  const barTitle = fold !== null ? fold : rd.bar ? `${fmtDur(rd.bar.us)}${rd.bar.cpu ? ` · CPU ${fmtDur(rd.bar.cpu)}` : ''}${rd.hot ? ' · a hot spot: 1 % of the traced time or more' : ''}` : undefined
  return (
    <div className={cls + ' lv-rd' + (rd.hot ? ' lv-hot' : '') + (hit ? ' lv-hit' : '') + (rd.pinned ? ' lv-pinned' : '') + tableCls(rd, plan ? tb : 0, fold === null)} data-ln={n} role="listitem" aria-selected={sel || undefined}>
      <DurCell us={dur} />
      <span className="lv-ln" title={note}>
        <button type="button" className="lv-pin" data-act="pin" aria-pressed={rd.pinned} aria-label={rd.pinned ? `Unpin line ${n}` : `Pin line ${n}: Δ is measured from it`} title={rd.pinned ? 'unpin (a)' : 'pin this line: Δ is measured from it (a)'}>
          <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true"><path d="M2 0h5v1.2L6.2 2v3l1.8 1.5V7.5H5v3.5L4.5 11 4 10.99V7.5H1V6.5L2.8 5V2L2 1.2z" fill="currentColor" /></svg>
        </button>
        {n}{gap > 0 && <i className="lv-gap" title={`gap ${fmtDur(gap)} before this line`} />}
      </span>
      <span className={'lv-lane' + (lane ? '' : ' lv-lane-none')} style={lane ? ({ '--lane': lane.color, '--dep': lane.depth } as React.CSSProperties) : undefined} title={lane?.title}>
        {lane?.label !== undefined ? <a className="lv-lane-id" data-act="lane">{lane.label}</a> : lane?.sub ? <span className="lv-lane-sub">{lane.sub}</span> : null}
      </span>
      {handle}
      <span className="lv-bar" title={barTitle}>
        {w !== undefined && w > 0 && <i className={`lv-bar-${fold === null && rd.bar ? rd.bar.role : 'other'}`} style={{ '--w': w.toFixed(4) } as React.CSSProperties} />}
        {fold === null && rd.cpuW !== undefined && rd.cpuW > 0 && <b style={{ '--w': rd.cpuW.toFixed(4) } as React.CSSProperties} />}
      </span>
      {/* the rows of a plan's table: PLAN is said once, in its head row */}
      <span className={`lv-kd lv-tone-${fold !== null ? 'dim' : rd.tone || 'none'}`}>{fold !== null ? foldLabel ?? '' : (plan && tb) || rd.bindRow ? '' : rd.label}</span>
      {dcol && <DeltaCell rd={rd} />}
      {plan ? <span className="lv-tx lv-plan"><PlanCells r={plan} /></span>
        : fold === null && rd.bindRow ? <span className="lv-tx lv-plan"><BindCells b={rd.bindRow} /></span>
        : fold === null && rd.bindHead ? (
          <span className="lv-tx lv-plan">
            <BindHeads />
            <button type="button" className="lv-asrun" data-act="asrun" title="the statement as it ran: these values in place of its placeholders (side panel, As run)">SQL with values →</button>
          </span>
        ) : (
        <span className="lv-tx" style={rd.indent && fold === null ? ({ '--ind': rd.indent } as React.CSSProperties) : undefined}>
          {fold === null && rd.asRun && <button type="button" className="lv-asrun" data-act="asrun" title="the statement as it ran: these values in place of its placeholders (side panel, As run)">SQL with values →</button>}
          {fold !== null ? <span className="rd-fold">{fold}</span> : rd.parts.map(segNode)}
        </span>
      )}
      <span className="lv-rclk" title={rd.clockTitle}>{rd.clock}{rd.micros && <small>{rd.micros}</small>}</span>
    </div>
  )
}

/** The table classes of a readable row: a plan's row (`tb` 1, its last 2), the head or a row of a BINDS block's table. */
function tableCls(rd: ReadableCell, tb: number, plain: boolean): string {
  if (tb) return ' lv-tb' + (tb === 2 ? ' lv-tb-end' : '')
  if (!plain) return ''
  if (rd.bindHead) return ' lv-tb lv-tb-head'
  if (rd.bindRow) return ' lv-tb' + (rd.bindRow.last ? ' lv-tb-end' : '')
  return ''
}

/** A bind as a row of its BINDS block's table: the placeholder, the value (as the trace has it, cut ones marked) and the type. */
function BindCells({ b }: { b: BindCellRow }) {
  return (
    <>
      <span className="pc pc-bname" title={b.title}>{b.name}</span>
      <span className={'pc pc-bval' + (b.none ? ' none' : '')} title={b.title}>{b.value}</span>
      <span className="pc pc-btype" title={b.title}>{b.type}</span>
    </>
  )
}
const BindHeads = () => (
  <>
    <span className="pc pc-bname">Variable</span>
    <span className="pc pc-bval">Value</span>
    <span className="pc pc-btype">Type</span>
  </>
)

/**
 * The head row of a plan's table, in the readable row's columns: PLAN in the kind column, the plan's column names in the detail. In
 * the layout (a row of its own above the plan's first line) or laid over the top row (`overlay`) while the plan's lines fill the top.
 */
const PlanHeadRow = memo(function PlanHeadRow({ lane, tone, dcol, overlay }: { lane: ReadableCell['lane']; tone: string; dcol: boolean; overlay?: boolean }) {
  return (
    <div className={'lv-row lv-rd lv-tb lv-tb-head' + (overlay ? ' lv-plan-head' : '')} role="presentation" aria-hidden={overlay || undefined}>
      <DurCell />
      <span className="lv-ln" />
      <span className={'lv-lane' + (lane ? '' : ' lv-lane-none')} style={lane ? ({ '--lane': lane.color, '--dep': lane.depth } as React.CSSProperties) : undefined} />
      <span className="lv-fh" />
      <span className="lv-bar" />
      <span className={`lv-kd lv-tone-${tone || 'none'}`}>PLAN</span>
      {dcol && <DeltaCell />}
      <span className="lv-tx lv-plan"><PlanHeads /></span>
      <span className="lv-rclk" />
    </div>
  )
})

/** The bar of an elapsed time as a fraction of its slot: log scale, 1 µs nothing, 1 ms half, 1 s (and longer) full. */
export const heatWidth = (us: number) => Math.min(1, Math.max(0, Math.log10(us) / 6))

/** A value longer than this takes both columns of the hover card. */
const CARD_WIDE = 22

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
  // two columns of label and value; a long value takes the whole width; the zero fields are named on one line below
  const { shown, zeros } = splitZeros(d.fields)
  return (
    <div className="lv-card" ref={el} role="tooltip">
      <div className="lv-card-h">{d.title}<span>line {fmtInt(at.line)}</span></div>
      {shown.length > 0 && (
        <dl className="lv-card-grid">
          {shown.map((f, i) => (
            <div key={i} title={f.hint} className={f.value.length > CARD_WIDE ? 'wide' : undefined}><dt>{f.label}</dt><dd>{f.value}</dd></div>
          ))}
        </dl>
      )}
      {zeros.length > 0 && <p className="lv-card-zero">zero: {zeros.join(', ')}</p>}
      {d.note && <p>{d.note}</p>}
    </div>
  )
}


/** One run of the text: plain, a search hit, a reference link (a hit inside a link stays inside it). */
function runNode(r: RefRun, i: number) {
  const inner = r.hit ? <mark>{r.text}</mark> : r.text
  return r.ref
    ? <a key={`${i}${r.ref.kind}${r.ref.value}`} className={`lv-ref lv-ref-${r.ref.kind}`} data-act="ref" data-ref={`${r.ref.kind}:${r.ref.value}`}>{inner}</a>
    : r.hit ? <mark key={i}>{r.text}</mark> : r.text
}

const inlayNode = (h: Inlay, i: number) => <span key={`i${i}`} className={`lv-inlay lv-inlay-${h.kind}`} aria-hidden="true">{h.text}</span>

/** A readable value standing in for the raw number `raw` (its tooltip); inside a reference it stays a link. */
function valueNode(h: Inlay, raw: string, r: RefRun, i: number) {
  const v = <span key={`v${i}`} className={`lv-val lv-val-${h.kind}`} title={raw}>{h.text}</span>
  return r.ref ? <a key={`v${i}${r.ref.kind}${r.ref.value}`} className={`lv-ref lv-ref-${r.ref.kind}`} data-act="ref" data-ref={`${r.ref.kind}:${r.ref.value}`}>{v}</a> : v
}

/**
 * The line's text with the matches of the search wrapped in <mark> and, with `refs`, its references as links (hits inside a link stay inside it);
 * `ins` (hints, any order) are inserted at their offsets, and the ones with a `from` replace the raw text `[from, at)`: a run is split where a hint falls inside it.
 */
function marked(text: string, kind: number, hl: RowHighlight | undefined, refs: boolean, ins?: Inlay[]) {
  const spans = hl ? matchSpans(text, hl.q, hl.regex, hl.caseSensitive) : []
  if (!ins || ins.length === 0) {
    if (!refs) {
      if (spans.length === 0) return text || ' '
      return highlightRuns(text, spans).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : r.text))
    }
    const runs = mergeHits(refRuns(text, LINE_KINDS[kind]), spans)
    if (runs.length === 0) return ' '
    if (runs.length === 1 && !runs[0].ref && !runs[0].hit) return text
    return runs.map(runNode)
  }
  const runs: RefRun[] = refs ? mergeHits(refRuns(text, LINE_KINDS[kind]), spans) : spans.length ? highlightRuns(text, spans) : [{ text }]
  const clamp = (n: number) => Math.min(text.length, Math.max(0, n))
  const sorted = ins.map((h) => {
    const at = clamp(h.at)
    return { h, at, from: h.from === undefined ? at : Math.min(at, clamp(h.from)), swap: h.from !== undefined }
  }).sort((a, b) => a.from - b.from || a.at - b.at)
  const out: ReactNode[] = []
  let h = 0, at = 0, skip = 0 // next hint, offset of the current run's start, end of the raw text replaced so far
  let k = 0
  for (const r of runs) {
    const end = at + r.text.length
    let pos = at
    for (;;) {
      for (; h < sorted.length && sorted[h].from <= pos && sorted[h].from < end; h++) {
        const s = sorted[h]
        if (s.swap) { out.push(valueNode(s.h, text.slice(s.from, s.at), r, h)); skip = Math.max(skip, s.at) } else out.push(inlayNode(s.h, h))
      }
      if (pos >= end) break
      const next = Math.min(end, h < sorted.length ? sorted[h].from : end)
      if (pos < skip) { pos = Math.min(next, skip); continue }
      out.push(runNode(pos === at && next === end ? r : { ...r, text: r.text.slice(pos - at, next - at) }, k++))
      pos = next
    }
    if (r.text === '') out.push(runNode(r, k++))
    at = end
  }
  for (; h < sorted.length; h++) out.push(inlayNode(sorted[h].h, h)) // at the end of the text
  if (text === '') out.push(' ')
  return out
}
