import { kindGroups } from '../data/callkinds'
import { resolveVar } from './colors'

/** Tile edge in CSS px. A 45° line across a T×T tile repeats every T/√2 ≈ 4.24px, matching the CSS brushes. */
const T = 6

/**
 * Canvas pattern for call-phase group `g` (index into `kindGroups`): the phase shade with its brush drawn on
 * top, the canvas twin of `--b-phase-*` over `--c-phase-*`. Returns a plain color for the solid brush.
 * Resolves the tokens on each call, so callers cache per render (theme switches re-resolve).
 */
export function phasePattern(g: number): string | { image: HTMLCanvasElement; repeat: 'repeat'; scaleX: number; scaleY: number } {
  const k = kindGroups[g]
  const fill = resolveVar(k.token)
  if (k.brush === 'solid') return fill
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1))
  const c = document.createElement('canvas')
  c.width = c.height = T * dpr
  const x = c.getContext('2d')
  if (!x) return fill
  x.scale(dpr, dpr)
  x.fillStyle = fill
  x.fillRect(0, 0, T, T)
  x.strokeStyle = resolveVar(`${k.token}-ink`)
  x.lineWidth = 1.5
  x.lineCap = 'square'
  const fwd = () => { // `/`, with the corner pieces so the tile wraps seamlessly
    x.beginPath()
    x.moveTo(0, T); x.lineTo(T, 0)
    x.moveTo(-1, 1); x.lineTo(1, -1)
    x.moveTo(T - 1, T + 1); x.lineTo(T + 1, T - 1)
    x.stroke()
  }
  const back = () => {
    x.beginPath()
    x.moveTo(0, 0); x.lineTo(T, T)
    x.moveTo(T - 1, -1); x.lineTo(T + 1, 1)
    x.moveTo(-1, T - 1); x.lineTo(1, T + 1)
    x.stroke()
  }
  if (k.brush === 'fwd') fwd()
  else if (k.brush === 'back') back()
  else if (k.brush === 'cross') { x.lineWidth = 1.2; fwd(); back() }
  else { x.fillStyle = x.strokeStyle; x.fillRect(T / 2, 0, 1.5, T) } // vert
  return { image: c, repeat: 'repeat', scaleX: 1 / dpr, scaleY: 1 / dpr }
}
