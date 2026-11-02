import { libraryFile, mergeLibrary, newAnnotationId, parseLibraryFile, type PivotConfig, type PivotLibrary, type SavedPivot } from '@lib'
import { openKV } from '../platform'
import { pickTextFile, saveAs } from '../files'

/**
 * The global library of saved Pivot configurations (not per trace), in `library.json` under the
 * key `pivots`. One instance for the app; each session tab gets a `PivotLibrary` view of it (the
 * Pivot view's "Saved" menu) through `libraryFor`.
 */
const FILE = 'library.json'
const KEY = 'pivots'

class Library {
  private list: SavedPivot[] = []
  private listeners = new Set<() => void>()
  private loaded: Promise<void> | null = null

  load(): Promise<void> {
    this.loaded ??= openKV(FILE)
      .then((kv) => kv.get<SavedPivot[]>(KEY))
      .then((v) => {
        // what was saved before the load finished stays
        if (Array.isArray(v)) this.set(mergeLibrary(v, this.list), false)
      })
      .catch((e) => console.error('library:', e))
    return this.loaded
  }

  getSnapshot = () => this.list
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    void this.load()
    return () => void this.listeners.delete(l)
  }

  private set(list: SavedPivot[], persist = true) {
    this.list = list
    for (const l of this.listeners) l()
    if (persist) void openKV(FILE).then((kv) => kv.set(KEY, list)).catch((e) => console.error('library:', e))
  }

  /** Saves `config` under `name`; a saved one of that name is replaced (keeping its id). */
  save = (name: string, config: PivotConfig) => {
    const now = Date.now()
    const old = this.list.find((p) => p.name === name)
    const p: SavedPivot = old ? { ...old, config, updated: now } : { id: newAnnotationId(), name, config, created: now, updated: now }
    this.set(mergeLibrary(this.list.filter((x) => x !== old), [p]))
  }

  rename(id: string, name: string) {
    this.set(mergeLibrary(this.list.map((p) => (p.id === id ? { ...p, name, updated: Date.now() } : p)), []))
  }

  remove(id: string) {
    this.set(this.list.filter((p) => p.id !== id))
  }

  /** The saved pivots once the store is read (a backup export must not miss any). */
  async all(): Promise<SavedPivot[]> {
    await this.load()
    return this.list
  }

  /** Replaces the list (the combined backup import has merged already). */
  async replaceAll(list: SavedPivot[]) {
    await this.load()
    this.set(list)
  }

  /** `{version: 1, pivots}` as JSON. */
  exportText(): string {
    return JSON.stringify(libraryFile(this.list), null, 2) + '\n'
  }

  /** Merges a library file (by id, newer wins); how many came in and how many were skipped. */
  async importText(text: string): Promise<{ added: number; skipped: number }> {
    await this.load()
    const { pivots, skipped } = parseLibraryFile(text)
    this.set(mergeLibrary(this.list, pivots))
    return { added: pivots.length, skipped }
  }
}

export const library = new Library()

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }]

/** The `PivotLibrary` a session gets: the app's library with its management (rename, delete, export, import), which the Pivot's Saved menu shows. */
export function libraryFor(): PivotLibrary {
  return {
    subscribe: library.subscribe,
    getSnapshot: library.getSnapshot,
    save: library.save,
    rename: (id, name) => library.rename(id, name),
    remove: (id) => library.remove(id),
    exportAll: async () => {
      const n = library.getSnapshot().length
      const to = await saveAs('mtkprof-library.json', library.exportText(), JSON_FILTER, 'Export the library')
      return to ? `Exported ${n} saved pivot${n === 1 ? '' : 's'}.` : null
    },
    importFile: async () => {
      const f = await pickTextFile(JSON_FILTER, 'Import a library')
      if (!f) return null
      const r = await library.importText(f.text)
      return `Imported ${r.added} from ${f.name} (same id: the newer one kept)${r.skipped ? `; ${r.skipped} entries not understood` : ''}.`
    },
  }
}
