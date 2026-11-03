import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

/**
 * Motion helpers of both clients, adapted from transitions.dev; the tokens, keyframes and primitive classes are in
 * styles/motion.css. Everything here does nothing with reduced motion (the end state shows at once).
 */

/** Durations in ms, the same as the --motion-* tokens of motion.css. */
export const MOTION_MS = { quick: 150, fast: 250, slow: 400, emphasis: 500, stagger: 70 } as const
/** Exit durations in ms: --motion-quick and --motion-fast in motion.css. */
export const EXIT_MS = { quick: MOTION_MS.quick, fast: MOTION_MS.fast } as const
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)' // --motion-ease
const PAGE_PX = 8 // --motion-page
const PAGE_BLUR_PX = 3
const BLUR_PX = 2 // --motion-blur

export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Keeps the last non-null `value` mounted for `ms` after it turns null, so an exit animation can play:
 * `shown` is what to render, `closing` is true while it plays out. A new value during the exit shows
 * at once and cancels the timer. With reduced motion there is no delay.
 */
export function useExit<T>(value: T | null | undefined, ms: number): { shown: T | null; closing: boolean } {
  const last = useRef<T | null>(null)
  const [, drop] = useReducer((n: number) => n + 1, 0)
  const live = value != null
  useEffect(() => {
    if (value != null) last.current = value
  })
  useEffect(() => {
    if (live || last.current === null) return
    if (prefersReducedMotion()) {
      last.current = null
      return
    }
    const t = setTimeout(() => {
      last.current = null
      drop()
    }, ms)
    return () => clearTimeout(t)
  }, [live, ms])
  if (value != null) return { shown: value, closing: false }
  const closing = last.current !== null && !prefersReducedMotion()
  return { shown: closing ? last.current : null, closing }
}

/** How many characters `next` shares with `prev` at its start and at its end; a shared run is not counted twice. */
export function sharedEnds(prev: string, next: string): { start: number; end: number } {
  let start = 0
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++
  let end = 0
  while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++
  return { start, end }
}

/**
 * Which characters of `next` differ from `prev`: position by position when both are as long (the digits of a counter, so a
 * digit that stayed stays still), else all but the start and the end they share.
 */
export function changedChars(prev: string, next: string): boolean[] {
  const chars = next.split('')
  if (prev.length === next.length) return chars.map((c, i) => c !== prev[i])
  const { start, end } = sharedEnds(prev, next)
  return chars.map((_, i) => i >= start && i < next.length - end)
}

/** The text a swap leaves (`from`, null when none runs) and a counter of the swaps, for the keys that restart the animations. */
function useSwap(text: string, ms: number): { from: string | null; n: number } {
  const last = useRef(text)
  const [swap, setSwap] = useState<{ from: string | null; n: number }>({ from: null, n: 0 })
  useLayoutEffect(() => {
    if (last.current === text) return
    const from = last.current
    last.current = text
    if (prefersReducedMotion()) return
    setSwap((s) => ({ from, n: s.n + 1 }))
    const t = window.setTimeout(() => setSwap((s) => ({ from: null, n: s.n })), ms + 40)
    return () => window.clearTimeout(t)
  }, [text, ms])
  return swap
}

/** While a swap runs, eases `box`'s width from the old text's to the new one's (the CSS transition is on the box); after it, the width is the content's again. */
function useWidthTween(box: RefObject<HTMLElement | null>, from: RefObject<HTMLElement | null>, to: RefObject<HTMLElement | null>, swap: number) {
  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const o = from.current
    const n = to.current
    if (swap < 0 || !o || !n) {
      b.style.removeProperty('inline-size')
      return
    }
    const w0 = o.getBoundingClientRect().width
    const w1 = n.getBoundingClientRect().width
    b.style.inlineSize = `${w0}px`
    void b.offsetWidth // the start width is laid out before the end one is set, so the transition runs
    b.style.inlineSize = `${w1}px`
  }, [box, from, to, swap])
}

/**
 * A value that changes in place because the data behind it changed (transitions.dev "text swap soft"): the old text blurs out
 * while the new one blurs in, in the same spot, and the width eases between them. `align="end"` for a right-aligned column.
 */
export function SoftText({ text, align, className }: { text: string; align?: 'end'; className?: string }) {
  const { from, n } = useSwap(text, MOTION_MS.fast)
  const box = useRef<HTMLSpanElement>(null)
  const old = useRef<HTMLSpanElement>(null)
  const cur = useRef<HTMLSpanElement>(null)
  useWidthTween(box, old, cur, from === null ? -1 : n)
  const cls = 'soft' + (align === 'end' ? ' end' : '') + (from !== null ? ' swapping' : '') + (className ? ` ${className}` : '')
  return (
    <span ref={box} className={cls}>
      {from === null ? <span>{text}</span> : <>
        <span key={`o${n}`} ref={old} className="soft-old" aria-hidden="true">{from}</span>
        <span key={`n${n}`} ref={cur} className="soft-new">{text}</span>
      </>}
    </span>
  )
}

/**
 * A label that changes to one sharing its start or end ("Copy line" → "Copied", transitions.dev "text morph"): the shared
 * letters stay put, only the part that differs cross-blurs while its width eases.
 */
export function MorphText({ text }: { text: string }) {
  const { from, n } = useSwap(text, MOTION_MS.fast)
  const box = useRef<HTMLSpanElement>(null)
  const old = useRef<HTMLSpanElement>(null)
  const cur = useRef<HTMLSpanElement>(null)
  useWidthTween(box, old, cur, from === null ? -1 : n)
  if (from === null) return <>{text}</>
  const { start, end } = sharedEnds(from, text)
  return <>
    {text.slice(0, start)}
    <span key={n} ref={box} className="morph">
      <span ref={old} className="morph-old" aria-hidden="true">{from.slice(start, from.length - end)}</span>
      <span ref={cur} className="morph-new">{text.slice(start, text.length - end)}</span>
    </span>
    {text.slice(text.length - end)}
  </>
}

/**
 * A number that updates (transitions.dev "number pop-in"): the characters that changed rise in with a blur and a slight
 * overshoot, a little later each (up to two steps); the ones that stayed do not move.
 */
export function PopText({ text, className }: { text: string; className?: string }) {
  const { from, n } = useSwap(text, MOTION_MS.emphasis + 2 * MOTION_MS.stagger)
  const cls = className ? `pop-text ${className}` : 'pop-text'
  if (from === null) return <span className={cls}>{text}</span>
  const changed = changedChars(from, text)
  let k = 0
  return (
    <span key={n} className={cls}>
      {text.split('').map((c, i) => changed[i]
        ? <span key={i} className="ch" style={{ '--i': Math.min(k++, 2) } as CSSProperties}>{c}</span>
        : <span key={i}>{c}</span>)}
    </span>
  )
}

/** Two glyphs in one slot (transitions.dev "icon swap"): `show` picks the one in view, the other shrinks and blurs out. */
export function IconSwap({ show, icons }: { show: 0 | 1; icons: [ReactNode, ReactNode] }) {
  return (
    <span className="icon-swap" aria-hidden="true">
      <span data-off={show !== 0 || undefined}>{icons[0]}</span>
      <span data-off={show !== 1 || undefined}>{icons[1]}</span>
    </span>
  )
}

/** A status line while something is on its way ("Loading trace lines…", transitions.dev "shimmer text"). */
export function Shimmer({ children }: { children: string }) {
  return <span className="shimmer" data-text={children}>{children}</span>
}

const playing = new WeakMap<Element, Animation>()

/** Runs a Web Animation on `el`, cancelling the one this module runs there, so a quick succession never queues up. */
function play(el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return
  playing.get(el)?.cancel()
  playing.set(el, el.animate(frames, options))
}

/**
 * A pane whose content was replaced by the next item of a list (the enter half of transitions.dev "page side-by-side", run
 * vertically): it slides in from the side the item came from (`dir` -1: the item is above the last one, 1: below, 0: in place)
 * and cross-blurs. The old content leaves at once, so nothing has to stay mounted; a new call cuts the running one short.
 */
export function enterFrom(el: Element | null | undefined, dir: number) {
  play(el, [
    { opacity: 0, translate: `0 ${Math.sign(dir) * PAGE_PX}px`, filter: `blur(${PAGE_BLUR_PX}px)` },
    { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
  ], { duration: MOTION_MS.fast, easing: EASE })
}

/** New content where stale content stood (the reveal of transitions.dev "skeleton loader and reveal"): it sharpens from a blur. */
export function reveal(el: Element | null | undefined) {
  play(el, [{ opacity: 0.6, filter: `blur(${BLUR_PX}px)` }, { opacity: 1, filter: 'blur(0px)' }], { duration: MOTION_MS.slow, easing: 'ease-in-out' })
}

/** Plays `reveal` on `ref` each time `pending` turns false (the engine's answer replaces the stale content). */
export function useReveal(ref: RefObject<Element | null>, pending: boolean) {
  const was = useRef(pending)
  useLayoutEffect(() => {
    if (was.current && !pending) reveal(ref.current)
    was.current = pending
  }, [pending, ref])
}

const PILL_HOSTS = 'span.seg, .tabs'
const PILL_ON = ':scope > button[aria-pressed="true"], :scope > .tab[aria-current="page"]'
const PILL_PROPS = ['--pill-x', '--pill-y', '--pill-w', '--pill-h'] as const

/** Puts `host`'s pill on its one pressed button (the first time without sliding), or takes it away when there is not exactly one. */
function placePill(host: HTMLElement) {
  const on = host.querySelectorAll<HTMLElement>(PILL_ON)
  const btn = on.length === 1 && host.offsetWidth > 0 ? on[0] : null
  if (!btn) {
    if (host.dataset.pill !== undefined) {
      delete host.dataset.pill
      for (const p of PILL_PROPS) host.style.removeProperty(p)
    }
    return
  }
  // offsets: the layout box, not the painted one, so a host inside a popover that is still scaling in measures right
  const geo = [btn.offsetLeft, btn.offsetTop, btn.offsetWidth, btn.offsetHeight]
  PILL_PROPS.forEach((p, i) => host.style.setProperty(p, `${geo[i]}px`))
  if (host.dataset.pill === undefined) {
    host.dataset.pill = 'snap' // in place before it can slide: no transition until the next frame
    requestAnimationFrame(() => { if (host.dataset.pill === 'snap') host.dataset.pill = 'on' })
  }
}

/**
 * Sliding pills (transitions.dev "tabs sliding") for every segmented control (`span.seg`) and tab bar (`.tabs`) under `root`:
 * one pill per host, under its pressed button (`aria-pressed`) or current tab (`aria-current="page"`), sliding to the next one.
 * Hosts are found as they come and go, so call sites need nothing; a mutation observer and a resize observer re-place the
 * pills after a render or a resize. Returns the uninstall.
 */
export function installSlidingPills(root: HTMLElement = document.body): () => void {
  let frame = 0
  const sized = new Set<HTMLElement>()
  const ro = new ResizeObserver(() => schedule())
  const run = () => {
    frame = 0
    for (const h of sized) if (!h.isConnected) { ro.unobserve(h); sized.delete(h) }
    for (const h of root.querySelectorAll<HTMLElement>(PILL_HOSTS)) {
      if (!sized.has(h)) { sized.add(h); ro.observe(h) }
      placePill(h)
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(run) }
  const holds = (n: Node) => n instanceof Element && (n.matches(PILL_HOSTS) || n.querySelector(PILL_HOSTS) !== null)
  const inHost = (n: Node) => !!(n instanceof Element ? n : n.parentElement)?.closest(PILL_HOSTS)
  // cheap tests first: a row added to a long list is looked into, the list itself is not
  const mo = new MutationObserver((records) => {
    if (frame) return
    for (const r of records) {
      const hit = inHost(r.target)
        || (r.type === 'childList' && ([...r.addedNodes].some(holds) || [...r.removedNodes].some(holds)))
        || (r.type === 'attributes' && (r.attributeName === 'class' || r.attributeName === 'hidden') && holds(r.target)) // shown or hidden
      if (hit) { schedule(); return }
    }
  })
  // not `style` or `data-pill`: those are this function's own writes
  mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-current', 'class', 'hidden', 'disabled'] })
  window.addEventListener('resize', schedule)
  void document.fonts?.ready.then(schedule)
  schedule()
  return () => {
    mo.disconnect()
    ro.disconnect()
    window.removeEventListener('resize', schedule)
    cancelAnimationFrame(frame)
  }
}
