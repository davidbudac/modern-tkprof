import type { Tab } from './workspace'

/** Numeric statement IDs are valid only for the exact source content snapshot. */
export function comparisonSource(snapshot: Tab, side: 'a' | 'b', tabs: Tab[]): Tab {
  const comparison = snapshot.comparison
  const source = comparison && tabs.find((t) => t.key === comparison[side])
  if (!source?.session || source.state !== 'ready') throw new Error('The original source tab is closed or reopening. Reopen the trace and create a new comparison to inspect this statement.')
  const identity = side === 'a' ? comparison!.identityA : comparison!.identityB
  if (!identity || source.identity !== identity) throw new Error('The source trace changed since this snapshot. Create a new comparison to inspect its statements.')
  return source
}
