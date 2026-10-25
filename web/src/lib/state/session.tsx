import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { createClient, type ApiClient } from '../data/client'
import { createStore, type Actions, type State, type Store } from './store'
import type { PivotConfig, SavedPivot } from '../data/pivotconfig'

/** Saved Pivot configurations (the desktop shell's global library): an external store for `useSyncExternalStore`. */
export interface PivotLibrary {
  subscribe(l: () => void): () => void
  getSnapshot(): SavedPivot[]
  /** saves `config` under `name` (a saved one of that name is replaced) */
  save(name: string, config: PivotConfig): void
  /** shows the library (rename, delete, import/export) */
  manage?(): void
}

/** What one open trace needs: its store and the server it talks to (and, desktop, the Pivot library). The desktop shell provides one per tab. */
export interface Session { store: Store; client: ApiClient; library?: PivotLibrary }

export function createSession(client: ApiClient = createClient('')): Session {
  return { store: createStore(), client }
}

export const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error('no SessionProvider above this component')
  return s
}

/** The session's store: `getState()`/`setState()` for event handlers, `useStore` for rendering. */
export function useStoreApi(): Store { return useSession().store }
export function useActions(): Actions { return useSession().store.actions }
export function useClient(): ApiClient { return useSession().client }
export function useLibrary(): PivotLibrary | undefined { return useSession().library }

export function useStore<T>(selector: (s: State) => T): T {
  const { getState, subscribe } = useSession().store
  return useSyncExternalStore(subscribe, () => selector(getState()), () => selector(getState()))
}
