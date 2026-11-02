import { useStoreApi } from '@lib'
import { useWorkspaceState } from '../WorkspaceProvider'
import type { Tab } from '../workspace'

/** The tab whose session the calling view renders (inside its SessionProvider). */
export function useCurrentTab(): Tab | undefined {
  const store = useStoreApi()
  const { tabs } = useWorkspaceState()
  return tabs.find((t) => t.session?.store === store)
}

/** A file name stem for exports of a trace: its first input without directory and `.trc`. */
export function traceStem(doc: { file: { traceFile?: string; path: string } }, tab?: Tab): string {
  const p = doc.file.traceFile || doc.file.path || tab?.title || 'trace'
  return (p.split(/[\\/]/).pop() || 'trace').replace(/\.trc$/i, '')
}
