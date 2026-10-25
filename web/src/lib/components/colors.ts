/** Data colors by role. Charts read them from the CSS tokens so light/dark stay in sync. */
export type Role = 'cpu' | 'userio' | 'sysio' | 'commit' | 'concurrency' | 'network' | 'other' | 'idle' | 'unaccounted'

export const roleLabel: Record<Role, string> = {
  cpu: 'CPU', userio: 'User I/O', sysio: 'System I/O', commit: 'Commit', concurrency: 'Concurrency',
  network: 'Network', other: 'Other waits', idle: 'Idle', unaccounted: 'Unaccounted',
}

export const roleOrder: Role[] = ['cpu', 'userio', 'sysio', 'commit', 'concurrency', 'network', 'other', 'idle', 'unaccounted']

/** Wait class → color role. Classes without a slot fold into "other" (categorical ceiling). */
export function roleOfClass(cls: string, idle: boolean): Role {
  if (idle) return 'idle'
  switch (cls) {
    case 'User I/O': return 'userio'
    case 'System I/O': return 'sysio'
    case 'Commit': return 'commit'
    case 'Concurrency': return 'concurrency'
    case 'Network': return 'network'
    case 'Idle': return 'idle'
    default: return 'other'
  }
}

let probe: HTMLElement | null = null

/** Resolves a CSS color token (which may be a light-dark() expression) to an rgb() string canvas can use. */
export function resolveVar(name: string): string {
  if (!probe) {
    probe = document.createElement('span')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    document.body.appendChild(probe)
  }
  probe.style.color = `var(${name})`
  return getComputedStyle(probe).color
}

export function cssColor(role: Role): string { return resolveVar(`--c-${role}`) }

export function chromeColors() {
  return { ink: resolveVar('--ink'), ink2: resolveVar('--ink-2'), ink3: resolveVar('--ink-3'), grid: resolveVar('--c-grid'), axis: resolveVar('--c-axis'), surface: resolveVar('--surface-raised'), hairline: resolveVar('--hairline') }
}

/** Whether a role's fill is light enough to need dark text on it. */
export function lightFill(role: Role): boolean {
  return role === 'commit' || role === 'idle' || role === 'unaccounted' || role === 'concurrency' || role === 'sysio'
}

let pixel: CanvasRenderingContext2D | null = null

/** Any CSS color → [r, g, b] (via a 1px canvas, so oklch() and friends work too). */
function rgbOf(color: string): [number, number, number] {
  pixel ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!pixel) return [128, 128, 128]
  pixel.clearRect(0, 0, 1, 1)
  pixel.fillStyle = color
  pixel.fillRect(0, 0, 1, 1)
  const d = pixel.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2]]
}

/** The k-th shade of a role's color: k = 0 is the role color, higher k steps towards the surface (several events of one class). */
export function roleShade(role: Role, k: number): string {
  const base = cssColor(role)
  if (k === 0) return base
  const t = Math.min(0.6, 0.2 * k)
  const a = rgbOf(base), s = rgbOf(resolveVar('--surface-raised'))
  return `rgb(${a.map((v, i) => Math.round(v + (s[i] - v) * t)).join(', ')})`
}
