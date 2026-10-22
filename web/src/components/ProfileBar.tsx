import { useLayoutEffect, useRef, useState } from 'react'
import { fmtDur, fmtPct } from '../data/format'
import { lightFill, type Role } from './colors'

export interface Segment { role: Role; label: string; us: number; count?: number }

/** The hero: one 100%-wide stacked bar of where the time went, direct-labelled where it fits. */
export function ProfileBar({ segments, totalUs, compact, onSelect }: { segments: Segment[]; totalUs: number; compact?: boolean; onSelect?: (s: Segment) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState<boolean[]>([])
  const segs = segments.filter((s) => s.us > 0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const out: boolean[] = []
      el.querySelectorAll<HTMLElement>('.pbar-seg').forEach((seg) => {
        const lbl = seg.querySelector<HTMLElement>('.lbl')
        out.push(!!lbl && lbl.scrollWidth + 10 <= seg.clientWidth)
      })
      setFits(out)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [segments, totalUs])
  const total = Math.max(totalUs, segs.reduce((a, s) => a + s.us, 0))
  return (
    <div className={'pbar' + (compact ? ' compact' : '')}>
      <div className="pbar-track" ref={ref} role="img" aria-label={segs.map((s) => `${s.label} ${fmtPct(s.us, total)}`).join(', ')}>
        {segs.map((s, i) => (
          <div
            key={s.label}
            className={'pbar-seg' + (fits[i] ? ' fits' : '') + (lightFill(s.role) ? ' on-light' : '') + (s.role === 'unaccounted' ? ' unaccounted' : '')}
            style={{ flex: `${s.us} 1 0`, background: s.role === 'unaccounted' ? undefined : `var(--c-${s.role})`, animationDelay: `${i * 40}ms`, cursor: onSelect ? 'pointer' : undefined }}
            title={`${s.label}: ${fmtDur(s.us)} (${fmtPct(s.us, total)})${s.count ? `, ${s.count.toLocaleString()} waits` : ''}`}
            onClick={onSelect ? () => onSelect(s) : undefined}
          >
            {!compact && <span className="lbl">{s.label} {fmtPct(s.us, total, 0)}</span>}
          </div>
        ))}
      </div>
      <div className="pbar-legend">
        {segs.map((s) => (
          <span className="k" key={s.label}>
            <i className={'swatch' + (s.role === 'unaccounted' ? ' unaccounted' : '')} style={{ background: s.role === 'unaccounted' ? undefined : `var(--c-${s.role})` }} />
            {s.label}
            <span className="n">{fmtDur(s.us)} · {fmtPct(s.us, total)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
