import { roleOfClass, roleOrder, type Role } from '../components/colors'
import type { Minimap } from './types'

export interface MinimapSeries { role: Role; values: Float64Array }

/**
 * Reduces the buckets to `width` columns of stacked series, bottom to top: CPU, then the wait classes
 * folded into color roles in `roleOrder`. A value is the share of the column's time (0..1) the series
 * accounts for, so stacks sum to at most 1. `idle` false leaves the Idle class out.
 */
export function reduceMinimap(mm: Minimap, width: number, idle = true): MinimapSeries[] {
  const n = mm.cpu.length
  const w = Math.max(0, Math.floor(width))
  if (n === 0 || w === 0 || !(mm.bucketUs > 0)) return []
  const byRole = new Map<Role, number[][]>()
  const add = (role: Role, buckets: number[]) => { const l = byRole.get(role); if (l) l.push(buckets); else byRole.set(role, [buckets]) }
  add('cpu', mm.cpu)
  for (const [cls, buckets] of Object.entries(mm.waits)) {
    if (!idle && cls === 'Idle') continue
    add(roleOfClass(cls, false), buckets)
  }
  const out: MinimapSeries[] = []
  for (const role of roleOrder) {
    const lists = byRole.get(role)
    if (!lists) continue
    const values = new Float64Array(w)
    for (let x = 0; x < w; x++) {
      // the buckets this column covers; at least one, so a wide strip repeats a bucket across columns
      const lo = Math.floor((x * n) / w)
      const hi = Math.max(lo + 1, Math.ceil(((x + 1) * n) / w))
      let sum = 0
      for (const b of lists) for (let i = lo; i < hi && i < b.length; i++) sum += b[i]
      values[x] = Math.min(1, sum / ((hi - lo) * mm.bucketUs))
    }
    out.push({ role, values })
  }
  return out
}

/** Column fraction (0..1 across the strip) ↔ µs from the first timestamp; the buckets cover `n * bucketUs`. */
export function minimapSpanUs(mm: Minimap): number { return mm.cpu.length * mm.bucketUs }
