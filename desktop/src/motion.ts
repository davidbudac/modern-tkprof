import { useEffect, useReducer, useRef } from 'react'

/** Exit durations in ms: --motion-quick and --motion-fast in motion.css. */
export const EXIT_MS = { quick: 150, fast: 250 } as const

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

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
