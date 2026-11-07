import { memo, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LINE_KINDS, type CachedLine, type PageCache } from '../data/linecache'
import { foldAt, foldHiding, headAtRow, indexFolds, lineOfRow, rowOfLine, tableOf, visibleCount, withHeads, type Fold, type FoldIndex } from '../data/folds'
import { clampTop, revealTop, scrollFromTop, scrollGeometry, topFromScroll } from '../data/scrollmap'
import { lineTone, roleLabel } from './colors'
import { highlightRuns, matchSpans } from '../data/lines'
import { elaOf, splitZeros, type LineDecode } from '../data/linefields'
import { mergeHits, refRuns, type RefRun } from '../data/linerefs'
import { fmtDur, fmtInt } from '../data/format'
import { addRange, hasLine, toggleLine, type LineRange, type LineSet } from '../data/lineset'
import { isMac } from '../shell/platform'
import type { Inlay } from '../data/inlays'
import { barFrac, magnitudeOf, type LineTimes } from '../data/linetime'
import type { ReadableCell } from '../views/readableRows'
import type { BindCellRow, BindChip, CallParts, Seg } from '../data/readable'
import { PlanCells, PlanHeads } from './PlanCells'
import { planHidden } from '../data/planlayout'

/** Height of a row in pixels; the rows are laid out by this component, the scroll bar only maps to the first visible line (see data/scrollmap.ts). */
export const ROW_H = 20
/** The first rendered row moves in steps of `STEP` rows, so scrolling re-renders the rows once per 20 lines, not per pixel. */
const STEP = 20
const OVERSCAN = 20
/** Longest text rendered for one line (the rest is cut with a note). */
const MAX_TEXT = 10_000

const toneClass = LINE_KINDS.map((k) => `lv-tone-${lineTone[k] ?? 'ink'}`)
const K_CALL = LINE_KINDS.indexOf('call'), K_WAIT = LINE_KINDS.indexOf('wait'), K_STAT = LINE_KINDS.indexOf('stat'), K_BINDS = LINE_KINDS.indexOf('binds'), K_PARSING = LINE_KINDS.indexOf('parsing-in-cursor')
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
/** The key that adds a line to the selection with a click: ⌘ on macOS (Ctrl+click is the context menu there), else Ctrl. */
const pickKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey)

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
  /** the selected lines (sorted, apart ranges), highlighted; null/omitted for none. (`range` above is the time window.) */
  selLines?: LineSet | null
  /**
   * Shift+click on a row or Shift+Arrow/Page/Home/End extend a range from the anchor (the selected line, or the last ⌘/Ctrl-clicked one)
   * to that line, next to the lines picked before; ⌘+click (macOS) or Ctrl+click adds a line or takes it out (the selected line joins
   * the set on the first one); a plain click or unshifted move clears the set (null)
   */
  onLines?(lines: LineRange[] | null): void
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
  /** the lines whose Δ (the time from the timed line before) reaches the Δ threshold, µs by line: tinted, with the Δ in the tooltip; omit for none */
  deltaHits?: ReadonlyMap<number, number>
  /** handle lines of blocks that can be folded (the handle shows `▾`; a folded one always shows `▸`) */
  foldable?: ReadonlySet<number>
  /** a click on a fold handle: fold or unfold the block of this line */
  onFold?(line: number): void
  /**
   * the header for the first visible line, laid over the top of the rows (null: none, nothing is shown; the view never changes size); `key` says when `node` changed.
   * `lane`: the formatted view's sticky lane row (its own style, from the band column to the right edge; `--lane` the band's colour)
   */
  head?(topLine: number): { key: string; node: ReactNode; lane?: string } | null
  /** the readable mode: each line parsed into columns (kind, detail, time bar, Δ, clock) with its cursor's lane; keep it stable, a new one repaints the rows */
  readable?(line: number, l: CachedLine): ReadableCell
  /** readable mode: the highlighted statement (its id): the Statement cells of its lane's rows are tinted in its colour */
  hlStmt?: number
  /** readable mode: the line ranges laid out as tables, a head row above each (the plan dumps); sorted, apart; keep the array stable */
  tables?: readonly (readonly [number, number])[]
  /** readable mode: Δ, as the text of the time column (over the bar) */
  deltaCol?: boolean
  /** readable mode: the file's traced time (µs): the Duration track of a fold is a log share of it, as the rows' are (`ReadableCell.trackW`) */
  spanUs?: number
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
export function LineViewer({ cache, marks, bookmarks, notes, selected, wrap, highlight, range, inlays, selLines, onLines, onHover, gap, heat, times, mutedKinds, focusCursor, links, onRef, refTitle, head, card, folds, deltaHits, foldable, onFold, readable, hlStmt, tables, deltaCol, spanUs, onAct, top, side, onViewChange, apiRef, topRef, onSelect, onBookmark, onError }: Props) {
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
  const selRef = useRef(selected)
  selRef.current = selected
  const [shown, setShown] = useState<CardAt | null>(null)
  const cardTimer = useRef(0)
  const cardLine = useRef(0) // the line the card is open or about to open for
  const pending = useRef<{ line: number; how: 'center' | 'nearest' } | null>(null) // a reveal asked for before the view had a size

  // the pinned header: recomputed when the first visible line moves, the state changes only with the header's key
  const [pinned, setPinned] = useState<{ key: string; node: ReactNode; lane?: string } | null>(null)
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

  // the formatted clock shows its full stamp on the first row in view that has one (class `lv-ftop`, read by the CSS): set on the DOM
  // with the scroll, so that moving the view renders nothing. A row re-rendered with another className loses it: every render sets it again.
  const ftop = useRef<Element | null>(null)
  const markTop = useCallback(() => {
    let el: Element | null = null
    const kids = readableOn.current ? layer.current?.children : undefined
    if (kids) {
      for (let j = Math.max(0, Math.round(topRef.current) - baseRef.current), k = 0; j < kids.length && k < 8; j++, k++) {
        const c = kids[j].classList
        if (c.contains('lv-ck2')) { el = kids[j]; break } // a row that shows the changing digits only
        if (c.contains('lv-ck1')) break // a row that shows its whole stamp already
      }
    }
    if (ftop.current !== el) ftop.current?.classList.remove('lv-ftop')
    el?.classList.add('lv-ftop')
    ftop.current = el
  }, [topRef])
  useLayoutEffect(() => { markTop() })

  const place = useCallback(() => {
    if (layer.current) layer.current.style.transform = `translateY(${-(topRef.current - baseRef.current) * ROW_H}px)`
    markTop()
  }, [topRef, markTop])

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

  // the Shift span being extended: its anchor and moving end, the lines picked before it, and the set it last made (while `selLines`
  // is still that set, the next Shift move continues the span; anything else starts a new one)
  const span = useRef<{ anchor: number; moving: number; base: LineSet; made: LineSet | null }>({ anchor: 0, moving: 0, base: [], made: null })

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
    if (prevIndex.current !== index) {
      // the folds changed: in the formatted view the selected line stays where it is on the screen when it is in view (a fold toggled above it, Fold repeats switched), else the first visible line stays the first visible line
      const top = topRef.current, r0 = Math.floor(top), old = prevIndex.current
      const sel = selRef.current
      const selRow = sel > 0 && readableOn.current ? rowOfLine(sel, old) : -1 // (the raw view keeps its first visible line, as it did)
      if (selRow >= r0 && selRow + 1 <= top + rowsRef.current) topRef.current = Math.max(0, rowOfLine(sel, index) - (selRow - top))
      else topRef.current = rowOfLine(lineOfRow(r0, old), index) + (top - r0)
      prevIndex.current = index
    }
    const p = pending.current
    if (p && h > 0) { pending.current = null; moveTo(revealTop(topRef.current, rowOfLine(p.line, index), rowsRef.current, p.how)) } else moveTo(topRef.current, false, true)
  }, [vtotal, h, index, moveTo, topRef])

  const [sbw, setSbw] = useState(0) // the scroll bar's width: a row over the rows leaves it out, so its columns line up
  const probe = useRef<HTMLSpanElement>(null)
  const [phide, setPhide] = useState(0) // the plan table's columns the view is too narrow for (`planHidden`)
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

  // the plan table spans the Operation, Detail and Clock columns (inset 1 digit each side): how many of its columns fit is read from the column headers' widths
  useEffect(() => {
    if (!readable || chw <= 0) { setPhide(0); return }
    const box = sc.current?.closest('.lv-box')
    const cells = ['.lv-ch-kind', '.lv-ch-tx', '.lv-ch-clk'].map((q) => box?.querySelector<HTMLElement>(q))
    if (cells.some((c) => !c)) return
    const [k, t, c] = cells as HTMLElement[]
    const calc = () => setPhide(planHidden(k.offsetWidth + t.offsetWidth + c.offsetWidth - 2 * chw - 2, chw, k.offsetWidth - chw - 1))
    const ro = new ResizeObserver(calc)
    for (const el of cells as HTMLElement[]) ro.observe(el)
    calc()
    return () => ro.disconnect()
  }, [readable, chw])

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
    if (hit && e.shiftKey && onLines) { extendTo(hit.n); return }
    if (hit && pickKey(e) && onLines) { pick(hit.n); return }
    if (hit && !(window.getSelection()?.toString() && !hit.gutter)) {
      if (selLines) onLines?.(null)
      onSelect(hit.n)
    }
  }
  /** The Shift span going on: the one made last while the set is still its, else a new one from the selected line next to the set. */
  const spanNow = () => {
    const sp = span.current
    if (sp.made && sp.made === selLines) return sp
    return { anchor: selected, moving: selected, base: selLines ?? [], made: null }
  }
  /** Shift: the span runs from its anchor to `n`, next to the lines picked before it; the selection stays where it is. */
  const extendTo = (n: number) => {
    const sp = spanNow()
    const made = addRange(sp.base, sp.anchor, n)
    span.current = { ...sp, moving: n, made }
    onLines?.(made)
  }
  /** ⌘/Ctrl+click: `n` in or out of the set (the selected line joins it first); the line becomes the selected one and the next span's anchor. */
  const pick = (n: number) => {
    const set = selLines && selLines.length > 0 ? selLines : n === selected ? [] : [{ from: selected, to: selected }]
    const made = toggleLine(set, n)
    span.current = { anchor: n, moving: n, base: made, made: made.length > 0 ? made : null }
    onLines?.(made.length > 0 ? made : null)
    onSelect(n)
  }
  /** Shift or ⌘/Ctrl+mouse down must not extend the browser's text selection (it would select across rows). */
  const onMouseDown = (e: MouseEvent) => {
    if ((e.shiftKey || pickKey(e)) && onLines && !(e.target as HTMLElement).closest('[data-act]')) e.preventDefault()
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
    const ext = e.shiftKey && !!onLines // Shift moves the span's end that is not the anchor
    const row = rowOfLine(ext ? spanNow().moving : selected, x) // moves step by visual row: a fold is one step
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
      if (selLines) onLines?.(null)
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
      rows.push(<PlanHeadRow key={`h${th.from}`} lane={rd?.lane ?? null} from={th.from} foldable={!!foldable?.has(th.from)} hide={phide} />)
      continue
    }
    const n = lineOfRow(i, index)
    const f0 = foldAt(n, index)
    const fold = f0 && !f0.quiet ? f0 : undefined // a quiet fold's handle line reads as itself
    const filt = f0?.filter && f0.quiet ? f0.to - f0.from : 0 // the Δ filter hides the lines below this one
    const l = cache.line(n)
    const win = range && n >= range.from && n <= range.to ? WIN_IN | (n === range.from ? WIN_START : 0) | (n === range.to ? WIN_END : 0) : 0
    const rd = readable && l && l.kind >= 0 ? readable(n, l) : undefined
    // formatted: the handle of a plan or a BINDS table sits in its head row's Operation cell (the plan's in the head row above it); a BINDS block drawn as chips has none
    const tbFirst = !!rd?.plan && tableOf(n, index)?.from === n
    const binds = readable && l?.kind === K_BINDS && !!rd?.bindHead && !f0?.inline
    const hereFold = binds && !!foldable?.has(n)
    // quiet folds above this row: a dotted gap mark in its number cell, a hairline over a CURSOR row (the `=====` rule folded away)
    const hid = readable && n > 1 ? foldHiding(n - 1, index) : undefined
    const gapAbove = !!hid?.quiet && !hid.filter
    const ela = !heat || readable ? -2 : l && (l.kind === K_CALL || l.kind === K_WAIT) ? elaOf(l.text, LINE_KINDS[l.kind]) : -1
    const inRange = hasLine(selLines, n)
    const t = times && l && !readable ? times.at(n, l.text, l.kind) : undefined
    const clk = times?.clock && !readable ? t?.clock ?? '' : null, dlt = times?.delta && !readable ? t?.delta ?? '' : null
    const tb = rd?.plan ? tableOf(n, index) : undefined
    rows.push(<Row key={n} n={n} rd={rd} hlStmt={hlStmt} dcol={!!deltaCol} span={spanUs ?? 0} phide={phide} tb={tb ? (n === tb.to ? 2 : 1) : 0} inline={!!f0?.inline} gapAbove={gapAbove} ruleTop={gapAbove && l?.kind === K_PARSING} opFold={hereFold} foldLabel={fold?.label} foldUs={fold?.us} clk={clk} clkT={t?.clockTitle} dlt={dlt} dltT={t?.deltaTitle} anchor={!!t?.anchor} text={l?.text} kind={l?.kind ?? -1} ids={inlays ? l : undefined} inlays={inlays} gap={gap?.(n) ?? 0} inRange={inRange} heat={ela} mk={marks.get(n) ?? 0} sel={n === selected} bm={bookmarks.has(n)} note={notes?.get(n)} hl={highlight ?? undefined} win={win} muted={!!l && !!mutedKinds?.has(l.kind)} dim={focusCursor !== undefined && focusCursor >= 0 && !!l && l.cursor !== focusCursor} refs={!!links} fold={fold?.summary ?? null} foldable={!!foldable?.has(n) && !tbFirst && !binds && !f0?.inline} dh={deltaHits?.get(n)} filt={filt} />)
  }
  const digits = String(Math.max(total, 1000)).length
  const hover = card || refTitle || onHover
  return (
    <div className="lv-box" style={{ '--lv-row': `${ROW_H}px`, '--lv-ln': `${digits}ch`, '--lv-sbw': `${sbw}px`, '--lv-chw': chw > 0 ? `${chw}px` : undefined } as React.CSSProperties}>
      <div className="lv-box-col">
      {top}
      <div className="lv-stack">
      {/* over the top rows, not above them: the scroll container keeps its height whether there is a header or not */}
      {head && pinned && !(readable && planTop) && (pinned.lane !== undefined
        ? (
          <div className="lv-slane lv-rd" role="note" aria-label="Statement at the top of the view" style={{ '--lane': pinned.lane } as React.CSSProperties}>
            {deltaCol && <span className="lv-bar lv-slane-sp" />}
            <span className="lv-ln lv-slane-sp" />
            <div className="lv-slane-body">{pinned.node}</div>
          </div>
        )
        : <div className="lv-head" role="note" aria-label="Statement at the top of the view">{pinned.node}</div>)}
      <div className={'lv' + (readable ? ' lv-rd-on' : wrap ? ' lv-wrap' : '') + (heat && !readable ? ' lv-heat-on' : '')} ref={sc} tabIndex={0} role="list" aria-label="Trace lines" aria-rowcount={vtotal}
        style={{ '--lv-row': `${ROW_H}px`, '--lv-ln': `${digits}ch` } as React.CSSProperties}
        onScroll={onScroll} onClick={onClick} onMouseDown={onLines ? onMouseDown : undefined} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
        onPointerMove={hover ? onPointerMove : undefined} onPointerLeave={hover ? onPointerLeave : undefined}>
        <div className="lv-inner" style={{ height: geo.scrollH }}>
          <div className="lv-view" style={{ height: h }}>
            {readable && planTop && <PlanHeadRow lane={null} overlay hide={phide} />}
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

const Row = memo(function Row({ n, rd, hlStmt, dcol, span, phide, tb, inline, gapAbove, ruleTop, opFold, foldLabel, foldUs, clk, clkT, dlt, dltT, anchor, text, kind, ids, inlays, gap, inRange, heat, mk, sel, bm, note, hl, win, muted, dim, refs, fold, foldable, dh, filt }: {
  n: number; text: string | undefined; kind: number
  /** the readable row of the line (readable mode), undefined for the trace as written */
  rd?: ReadableCell
  /** readable mode: the highlighted statement */
  hlStmt?: number
  /** readable mode: the Δ column is shown */
  dcol?: boolean
  /** readable mode: the file's traced time, for the track of a fold */
  span: number
  /** readable mode: the plan table's columns that do not fit (`planHidden`) */
  phide?: number
  /** readable mode: a row of a table (a plan dump under its head row): 1, its last row 2; 0 for none */
  tb?: number
  /** readable mode: a BINDS header whose binds are drawn as chips on it (its lines are folded under it) */
  inline?: boolean
  /** readable mode: quiet folds hide the lines above this row (a gap mark in its number cell); `ruleTop`: it is a CURSOR row and the hidden line is its `=====` rule (a hairline) */
  gapAbove?: boolean; ruleTop?: boolean
  /** readable mode: this BINDS row's fold handle sits in its Operation cell (`▾ BINDS`) */
  opFold?: boolean
  /** a fold of repeats: its label and bar (readable mode) */
  foldLabel?: string; foldUs?: number
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
  /** the line's Δ in µs when it reaches the Δ threshold (the row is tinted), undefined otherwise */
  dh?: number
  /** the Δ filter hides this many lines below the row (0: none) */
  filt?: number
}) {
  const cut = text !== undefined && text.length > MAX_TEXT
  const cls = 'lv-row ' + (kind >= 0 ? toneClass[kind] : 'lv-pending') + (mk ? ` lv-mk${mk}` : '') + (sel ? ' lv-sel' : '') + (bm ? ' lv-bm' : '') + (note ? ' lv-note' : '') + (muted ? ' lv-mute' : '') + (dim ? ' lv-dim' : '') + (inRange ? ' lv-range' : '')
    + (win & WIN_IN ? ' lv-win' : '') + (win & WIN_START ? ' lv-win-start' : '') + (win & WIN_END ? ' lv-win-end' : '')
    + (dh !== undefined ? ' lv-dhit' : '') + (filt ? ' lv-filt' : '')
  const handle = (
    <span className="lv-fh">
      {fold !== null
        ? <button type="button" className="lv-fold" data-act="fold" aria-expanded={false} aria-label={`Unfold line ${n}: ${fold}`} title={`unfold: ${fold} (z)`}>▸</button>
        : foldable && <button type="button" className="lv-fold" data-act="fold" aria-expanded={true} aria-label={`Fold the block at line ${n}`} title="fold this block (z)">▾</button>}
    </span>
  )
  if (rd) return <ReadableRow n={n} rd={rd} span={span} hlane={hlStmt !== undefined && !!rd.lane && rd.lane.stmt >= 0 && rd.lane.stmt === hlStmt} dcol={!!dcol} phide={phide ?? 0} tb={tb ?? 0} inline={!!inline} gapAbove={!!gapAbove} ruleTop={!!ruleTop} opFold={!!opFold} cls={cls} sel={sel} note={note} gap={gap} handle={handle} fold={fold} foldLabel={foldLabel} foldUs={foldUs} hit={!!hl && text !== undefined && matchSpans(text, hl.q, hl.regex, hl.caseSensitive).length > 0} />
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

/** The track of a Duration cell: the fraction of it the time fills (log scale), what colours it, and whether a call's CPU part is the solid end. */
interface Track { w: number; cpu?: number; cls: string; call: boolean }

/** The call phases that have a colour of their own (`--c-phase-*`); any other call is `other`. */
const PHASES = new Set(['parse', 'exec', 'fetch', 'close'])

/**
 * The time a line took in its own column: the number right-aligned, the unit in a slot of its own after it, so the numbers line up down the
 * view whatever their unit (`146 µs`, `1.35 ms`, `2.448 s`), its weight following its size (µs light, ms medium, s heavy); then a track
 * (log of the share of the file's traced time, 0.01 % to 100 %: a tick at 1 %, the hot-spot share, in the middle, faint ones at 0.1 % and 10 %)
 * filled in the wait's class colour, or in the call's slate with its CPU part the solid end. Empty for a line without a time.
 */
function DurCell({ us, track, title }: { us?: number; track?: Track; title?: string }) {
  if (us === undefined) return <span className="lv-dur" />
  const s = fmtDur(us), i = s.lastIndexOf(' ')
  return (
    <span className="lv-dur" title={title ?? `${fmtInt(us)} µs`}>
      <span className={`lv-dnum mag-${magnitudeOf(us)}${us === 0 ? ' zero' : ''}`}><b>{s.slice(0, i)}</b><small>{s.slice(i + 1)}</small></span>
      <span className={`lv-trk lv-trk-${track?.cls ?? 'other'}`} aria-hidden="true">
        {track && track.w > 0 && <i className={'lv-fill' + (track.call ? ' soft' : '')} style={{ '--f': track.w.toFixed(4) } as React.CSSProperties} />}
        {track?.call && track.cpu !== undefined && track.cpu > 0 && <i className="lv-fill" style={{ '--f': track.cpu.toFixed(4) } as React.CSSProperties} />}
      </span>
    </span>
  )
}

/** One piece of a readable row's detail (an empty quantity is left out: the detail reads as one run of text). A reference is a link that opens its statement (the viewer's `onRef`). */
const segNode = (s: Seg, i: number) => (typeof s === 'string' ? s
  : 'q' in s ? (s.n === '' ? null : <span key={i} className={`rd-q rd-q-${s.q}`} title={s.title}><b>{s.n}</b> <small>{s.unit}</small></span>)
    : s.ref ? <a key={i} className={`rd-${s.c} lv-ref lv-ref-${s.ref.slice(0, s.ref.indexOf(':'))}`} data-act="ref" data-ref={s.ref} title={s.title}>{s.t}</a>
      : <span key={i} className={`rd-${s.c}`} title={s.title}>{s.t}</span>)

/**
 * A call's Detail in groups (`CallParts`), each in a slot of its own so they line up down consecutive calls: the `exec N` tag (a slot of its own
 * on a call row with groups: only the first row of an execution has the tag), the rows (number right-aligned, then its unit), the gets in one quiet
 * box (`query` · `current` · `disk`, a fixed width per number), the CPU. The notes (hard parse, cached) follow as the line's `parts`.
 */
function CallDetail({ call, execNo }: { call: CallParts; execNo?: number }) {
  const g = call.gets
  const rows = call.rows
  return (
    <span className="rd-call">
      <span className="rd-slot rd-slot-exec">{execNo !== undefined && <span className="rd-exec" title={`execution ${execNo} of this cursor: this is its first row`}>exec {execNo}</span>}</span>
      <span className="rd-slot rd-slot-rows">{rows && <span className="rd-q rd-q-rows" title={rows.title}><b>{rows.n}</b><small>{rows.unit}</small></span>}</span>
      {g && (
        <span className="rd-gets" title={g.title}>
          <span><i>query</i><b className={g.zero[0] ? 'z' : undefined}>{g.query}</b></span>
          <span><i>current</i><b className={g.zero[1] ? 'z' : undefined}>{g.current}</b></span>
          <span><i>disk</i><b className={g.zero[2] ? 'z' : undefined}>{g.disk}</b></span>
        </span>
      )}
      {call.cpu && <span className="rd-cpu" title={call.cpu.title}><i>cpu</i> <b>{call.cpu.n}</b> <small>{call.cpu.unit}</small></span>}
    </span>
  )
}

/**
 * Δ as the text of a readable row's time column. From the pin it is the time from there; else the unexplained gap before the line: dim, its weight
 * by size, amber when it is worth a look.
 */
const DeltaText = ({ rd }: { rd: ReadableCell }) => (
  <span className={'lv-rdlt' + (rd.fromPin ? ' pin' : ' gap') + (rd.delta.startsWith('−') ? ' neg' : '') + (rd.deltaEmph ? ' emph' : '') + (rd.deltaUs !== undefined ? ` mag-${magnitudeOf(rd.deltaUs)}` : '')}>
    {rd.pinned ? <><DeltaIcon filled /> = 0</> : rd.delta}
  </span>
)

/** The pin's mark: a Δ, filled on the pinned line. */
const DeltaIcon = ({ filled }: { filled: boolean }) => (
  <svg className="lv-dicon" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2 9 8.8H1z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
)

/**
 * A line in readable mode (`hlane`: a row of the highlighted statement's lane): the time column (Δ as text; none with Δ off), the number (with the pin), the cursor's
 * lane, the fold handle, the duration (the number and its bar), what the line is, its detail and the clock. Every column but the detail has a width of its own, so they line up down the view; the detail is
 * cut where it does not fit. A plan line is a row of its plan's table: its cells in the detail, the time columns empty.
 */
function ReadableRow({ n, rd, span, hlane, dcol, phide, tb, inline, gapAbove, ruleTop, opFold, cls, sel, note, gap, handle, fold, foldLabel, foldUs, hit }: {
  n: number; rd: ReadableCell; span: number; hlane: boolean; dcol: boolean; phide: number; tb: number; inline: boolean; gapAbove: boolean; ruleTop: boolean; opFold: boolean; cls: string; sel: boolean; note?: string; gap: number; handle: ReactNode
  fold: string | null; foldLabel?: string; foldUs?: number; hit: boolean
}) {
  const dur = fold !== null ? foldUs : rd.dur
  const lane = rd.lane
  const plan = fold === null ? rd.plan : undefined
  // the duration's track: a fold's total in `other`; a wait in its class colour; a call in its phase's slate, its CPU part the solid end
  const phase = rd.label.toLowerCase()
  const track: Track | undefined = fold !== null ? (foldUs !== undefined ? { w: barFrac(foldUs, span), cls: 'other', call: false } : undefined)
    : rd.bar && rd.trackW !== undefined ? (rd.bar.role === 'cpu' ? { w: rd.trackW, cpu: rd.trackCpuW, cls: `ph-${PHASES.has(phase) ? phase : 'other'}`, call: true } : { w: rd.trackW, cls: rd.bar.role, call: false })
      : undefined
  const durTitle = fold !== null || dur === undefined ? undefined : `${fmtInt(dur)} µs${rd.bar?.cpu ? ` · CPU ${fmtDur(rd.bar.cpu)}` : ''}${rd.hot ? ' · a hot spot: 1 % of the traced time or more' : ''}`
  const short = !!rd.clockShort && !rd.clockFull // the clock shows its changing digits (the first row in view and the selected one: the whole stamp)
  // a row of a table: a plan's STAT line (under its head row), a bind of a BINDS block, the head of a BINDS block (its binds not drawn as chips)
  const tbl = fold !== null ? null : plan && tb ? 'plan' : rd.bindRow ? 'bindrow' : rd.bindHead && !inline ? 'bindhead' : null
  return (
    <div className={cls + ' lv-rd' + (rd.hot ? ' lv-hot' : '') + (hlane ? ' lv-hlane' : '') + (rd.clock ? (short ? ' lv-ck2' : ' lv-ck1') : '') + (hit ? ' lv-hit' : '') + (rd.pinned ? ' lv-pinned' : '') + (gapAbove ? ' lv-gapa' : '') + (ruleTop ? ' lv-rulet' : '') + (rd.execFirst && fold === null ? ' lv-exec1' : '')
      + (fold === null && rd.br ? ` lv-br-${rd.br}` : '') + (fold === null && rd.brIndent ? ' lv-br-ind' : '')} data-ln={n} role="listitem" aria-selected={sel || undefined} style={lane ? laneVars(lane) : undefined}>
      {/* first: the time column, Δ as text (`dcol` off: no column); the line's own time is the Duration cell's */}
      {dcol && (
        <span className="lv-bar" title={[rd.deltaTitle, fold].filter(Boolean).join('\n') || undefined}>
          <DeltaText rd={rd} />
        </span>
      )}
      <span className="lv-ln" title={note}>
        {dcol && (
          <button type="button" className="lv-pin" data-act="pin" aria-pressed={rd.pinned} aria-label={rd.pinned ? `Unpin line ${n}` : `Pin line ${n}: Δ is measured from it`} title={rd.pinned ? 'unpin (a)' : 'pin this line: Δ is measured from it (a)'}>
            <DeltaIcon filled={rd.pinned} />
          </button>
        )}
        {n}{gap > 0 && <i className="lv-gap" title={`gap ${fmtDur(gap)} before this line`} />}
        {gapAbove && !ruleTop && <i className="lv-gapmark" aria-hidden="true" />}
      </span>
      {/* a band: the sql_id and the SQL are the sticky lane row's (the cell's tooltip names the cursor) */}
      <span className={'lv-lane' + (lane ? '' : ' lv-lane-none')} title={lane?.title || undefined} />
      {handle}
      <DurCell us={dur} track={track} title={durTitle} />
      {tbl ? (
        // the rows of a plan's or BINDS table: one band from the Operation column to the right edge (the clock included); PLAN / BINDS is said once, in its head row
        <TableBand head={tbl === 'bindhead'} last={tb === 2 || (tbl === 'bindrow' && !!rd.bindRow?.last)}
          handle={<>{opFold && <button type="button" className="lv-fold lv-fold-op" data-act="fold" aria-expanded={true} aria-label={`Fold the block at line ${n}`} title="fold this block (z)">▾</button>}{tbl === 'bindhead' ? rd.label : ''}</>}>
          {tbl === 'plan' && plan && <PlanCells r={plan} hide={phide} />}
          {tbl === 'bindrow' && rd.bindRow && <>
            <span className="pc pc-tag" />
            <BindCells b={rd.bindRow} />
            {rd.bindRow.last && <button type="button" className="lv-asrun" data-act="asrun" title="the statement as it ran: these values in place of its placeholders (side panel, As run)">SQL with values →</button>}
          </>}
          {tbl === 'bindhead' && <>
            <span className="pc pc-tag">{rd.execNo !== undefined && <span className="rd-exec" title={`execution ${rd.execNo} of this cursor: this is its first row`}>exec {rd.execNo}</span>}</span>
            <BindHeads />
          </>}
        </TableBand>
      ) : (
        <>
          <span className={`lv-kd lv-tone-${fold !== null ? 'dim' : rd.tone || 'none'}${fold === null && rd.op ? ` lv-op-${rd.op}` : ''}`}>
            {fold !== null ? foldLabel ?? '' : plan && tb ? '' : rd.label}
          </span>
          {plan ? <span className="lv-tx lv-plan"><PlanCells r={plan} /></span> : (
            <span className="lv-tx" style={fold === null && (rd.indent || rd.keyW) ? ({ '--ind': rd.indent || undefined, '--kw': rd.keyW ? `${rd.keyW}ch` : undefined } as React.CSSProperties) : undefined}>
              {fold === null && rd.call && (rd.call.rows || rd.call.gets || rd.call.cpu) ? <CallDetail call={rd.call} execNo={rd.execNo} />
                : fold === null && rd.execNo !== undefined && <span className="rd-exec" title={`execution ${rd.execNo} of this cursor: this is its first row`}>exec {rd.execNo}</span>}
              {fold === null && inline && rd.chips ? <>{rd.chips.map((c, i) => <BindChipNode key={i} c={c} />)}</> : null}
              {fold === null && rd.asRun && <button type="button" className="lv-asrun" data-act="asrun" title="the statement as it ran: these values in place of its placeholders (side panel, As run)">SQL with values →</button>}
              {fold === null && rd.dot && !rd.micro && <i className={'rd-dot' + (rd.dot === 'idle' ? ' ring' : '')} style={{ '--dot': `var(--c-${rd.dot})` } as React.CSSProperties} title={roleLabel[rd.dot]} />}
              {fold !== null ? <span className="rd-fold">{fold}</span> : rd.micro ? <MicroDetail rd={rd} /> : rd.parts.map(segNode)}
              {fold === null && rd.waited && <span className={'rd-share' + (rd.waited.crit ? ' crit' : '')} title={`${fmtInt(rd.waited.us)} µs of the call's e= were not CPU (e − c): it waited`}>· {fmtDur(rd.waited.us)} waiting ({rd.waited.pct} %)</span>}
            </span>
          )}
          <span className={'lv-rclk' + (short ? '' : ' ck-full')} title={rd.clockTitle}>{short ? <><span className="ck-s">{rd.clockShort}</span><span className="ck-f">{rd.clock}{rd.micros}</span></> : rd.clock + rd.micros}</span>
        </>
      )}
    </div>
  )
}

/**
 * The band of a plan's or BINDS block's table: from the Operation column to the right edge on a sunken ground, a 1 px frame (`head`: its first row, `last`: its last), the
 * handle cell (▾ PLAN, ▾ BINDS) first, then the cells. The handle cell is as wide as Operation less the band's inset, so the cells start where Detail does.
 */
function TableBand({ head, last, handle, children }: { head?: boolean; last?: boolean; handle?: ReactNode; children: ReactNode }) {
  return (
    <span className={'lv-tbl' + (head ? ' lv-tbl-first lv-tbl-head' : '') + (last ? ' lv-tbl-last' : '')}>
      <span className="tc-handle">{handle}</span>
      {children}
    </span>
  )
}

/** A lane's CSS variables: the band's colour (none: transparent), the label's (the statement's) and the depth. */
const laneVars = (lane: NonNullable<ReadableCell['lane']>) => ({ '--lane': lane.color ?? 'transparent', '--lane-ink': lane.ink || undefined, '--dep': lane.depth } as React.CSSProperties)

/** A bind as a chip on the BINDS row: `:B1 = 8706` and its type dimmed. */
function BindChipNode({ c }: { c: BindChip }) {
  return <span className="rd-bchip" title={c.title}><span className="bname">{c.name}</span> = <b className={'bval' + (c.none ? ' none' : '')}>{c.value}</b>{c.type && <small>{c.type}</small>}</span>
}

/**
 * A wait of a run of the same event: the event and object once (faint, a ditto, when the row above is of the run too), then the fields that vary in
 * right-aligned columns (`file 12 | block 171160 | 8 blocks`), so they line up down the run.
 */
function MicroDetail({ rd }: { rd: ReadableCell }) {
  const m = rd.micro!
  return (
    <>
      <span className={'rd-pre' + (rd.ditto ? ' ditto' : '')}>
        {rd.dot && <i className={'rd-dot' + (rd.dot === 'idle' ? ' ring' : '')} style={{ '--dot': `var(--c-${rd.dot})` } as React.CSSProperties} title={roleLabel[rd.dot]} />}
        {rd.parts.map((s, i) => (typeof s !== 'string' && !('q' in s) && (s.c === 'ev' || s.c === 'evobj') ? segNode(s, i) : null))}
      </span>
      <span className="rd-mc rd-mc-file"><i>file</i> <b>{m.file}</b></span>
      <span className="rd-mc rd-mc-block"><i>block</i> <b>{m.block}</b></span>
      <span className="rd-mc rd-mc-blocks"><b>{fmtInt(m.blocks)}</b> <i>{m.blocks === 1 ? 'block' : 'blocks'}</i></span>
    </>
  )
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
 * The head row of a plan's table, in the readable row's columns: the table band with PLAN (and the fold handle) in its first cell, the plan's column names after it. In
 * the layout (a row of its own above the plan's first line) or laid over the top row (`overlay`) while the plan's lines fill the top.
 */
const PlanHeadRow = memo(function PlanHeadRow({ lane, overlay, from, foldable, hide }: { lane: ReadableCell['lane']; overlay?: boolean; from?: number; foldable?: boolean; hide: number }) {
  return (
    <div className={'lv-row lv-rd' + (overlay ? ' lv-plan-head' : '')} role="presentation" aria-hidden={overlay || undefined}>
      <span className="lv-bar" />
      <span className="lv-ln" />
      <span className={'lv-lane' + (lane ? '' : ' lv-lane-none')} style={lane ? laneVars(lane) : undefined} />
      <span className="lv-fh" />
      <DurCell />
      <TableBand head handle={<>{foldable && from !== undefined && <button type="button" className="lv-fold lv-fold-op" data-act="fold" data-ln={from} aria-expanded={true} aria-label={`Fold the plan at line ${from}`} title="fold this plan (z)">▾</button>}PLAN</>}>
        <PlanHeads hide={hide} />
      </TableBand>
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
