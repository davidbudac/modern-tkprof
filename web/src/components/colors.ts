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
