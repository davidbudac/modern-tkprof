// Which side panes a view gets: the wait-event inspector only where events are the subject, the Files panel open or folded by view.
// The user's own open/close of the Files panel wins for that view until the tab is closed (kept in memory per store, not in `workspace.json`).
import type { Store, View } from '../state/store'

/** The views that show the wait-event inspector; its selection stays in the store, so the pane is back on return. */
export const showsInspector = (view: View): boolean => view === 'waits' || view === 'timeline'

/** Views that start with the Files panel folded to its edge tab (the filter row's "▤ N files" chip opens it anywhere). */
const FOLDED_VIEWS: ReadonlySet<View> = new Set<View>(['statements', 'waits', 'pivot', 'annotations', 'reports'])

/** Whether the Files panel is open in `view` before the user has said otherwise. */
export const filesDefaultOpen = (view: View): boolean => !FOLDED_VIEWS.has(view)

/** A tab's manual open/close of the Files panel, per view. */
export class FilesChoices {
  private choices = new Map<View, boolean>()

  /** What the panel should be in `view`: the user's choice there, else the view's default. */
  wanted(view: View): boolean {
    return this.choices.get(view) ?? filesDefaultOpen(view)
  }

  /** Remembers the user's choice for `view`. */
  record(view: View, open: boolean): void {
    this.choices.set(view, open)
  }

  has(view: View): boolean {
    return this.choices.has(view)
  }
}

const byStore = new WeakMap<Store, FilesChoices>()

/**
 * The store's choices, created on first use and kept as long as the store lives (a tab's views come and go with the visible tab).
 * A Files state restored from `workspace.json` (`restored`, not null) stands for the view the tab starts on.
 */
export function filesChoicesOf(store: Store, view: View, restored: boolean | null): FilesChoices {
  let c = byStore.get(store)
  if (!c) {
    byStore.set(store, (c = new FilesChoices()))
    if (restored !== null) c.record(view, restored)
  }
  return c
}
