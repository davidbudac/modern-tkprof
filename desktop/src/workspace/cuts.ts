// The cuts folder (`<app cache dir>/cuts`): where "Open as new tab" of the Cut view writes the new trace files. The folder is
// the app's own: every cut gets a name of its own (an open tab reads its lines from its file, so a file is never replaced),
// and on start the files that no tab references and that are older than a week are deleted (docs/DESKTOP.md § Cuts).
import { safeFileName, writeCached, type FileData } from '../files'
import { inTauri, openKV } from '../platform'

/** The folder of the app's cache directory the cuts go to. */
export const CUTS_DIR = 'cuts'
/** Cut files older than this that no tab references are deleted on start. */
export const CUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const two = (n: number) => String(n).padStart(2, '0')

/** `yyyymmdd-hhmmss` of a date, local time. */
export const cutStamp = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`

/** A stem without the `-cut-<stamp>[-n]` of an earlier cut (a cut of a cut is named after the trace, not the cut). */
const baseStem = (stem: string) => stem.replace(/-cut-\d{8}-\d{6}(-\d+)?$/, '') || 'trace'

/**
 * The cache name of a new cut of `stem`: `<stem>-cut-<yyyymmdd-hhmmss>.trc`, with `-2`, `-3`, … when that name is `taken`
 * (two cuts in one second). Unique, so a new cut never replaces the file an open tab reads its lines from.
 */
export async function cutFileName(stem: string, at: Date, taken: (name: string) => boolean | Promise<boolean>): Promise<string> {
  const base = safeFileName(`${baseStem(stem)}-cut-${cutStamp(at)}`)
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.trc` : `${base}-${n}.trc`
    if (!(await taken(name))) return name
  }
}

/** Names being written right now (a second cut in the same second must not pick the same name before the first exists). */
const writing = new Set<string>()

/** Writes a new cut of `stem` to the cuts folder under a name of its own (written whole, then renamed into place); its path. */
export async function writeCut(stem: string, data: FileData, at = new Date()): Promise<string> {
  const { appCacheDir, join } = await import('@tauri-apps/api/path')
  const { exists } = await import('@tauri-apps/plugin-fs')
  const folder = await join(await appCacheDir(), CUTS_DIR)
  const name = await cutFileName(stem, at, async (n) => writing.has(n) || (await exists(await join(folder, n)).catch(() => false)))
  writing.add(name)
  try {
    return await writeCached(CUTS_DIR, name, data)
  } finally {
    writing.delete(name)
  }
}

/** A file of the cuts folder: its name and when it was last written (ms since the epoch; null: unknown). */
export interface CutEntry { name: string; mtime: number | null }

/**
 * The files of the cuts folder to delete: those older than `maxAge` that no tab references (by name: `referenced` are the
 * names of the folder's files that a tab of the workspace or a recent entry opens). A file whose age is unknown stays;
 * a `.part` left by a write that did not finish goes by the same rule.
 */
export function cutsToDelete(entries: readonly CutEntry[], referenced: ReadonlySet<string>, now: number, maxAge = CUT_MAX_AGE_MS): string[] {
  return entries.filter((e) => !referenced.has(e.name) && e.mtime !== null && now - e.mtime > maxAge).map((e) => e.name)
}

/** The names of the files directly inside `folder` among `paths` (a path of another folder is not a cut). */
export function namesIn(folder: string, paths: Iterable<string>): Set<string> {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = norm(folder)
  const out = new Set<string>()
  for (const p of paths) {
    const n = norm(p)
    const at = n.lastIndexOf('/')
    if (at >= 0 && n.slice(0, at) === f) out.add(n.slice(at + 1))
  }
  return out
}

type SavedTab = { set?: { paths?: string[] } }

/**
 * The retention of the cuts folder, run once on start after the tabs are restored: deletes the cuts that no tab of
 * `workspace.json` (open tabs and recent entries) nor `open` (the tabs of this window) references and that are older than
 * a week. The app only; the number of files deleted.
 */
export async function pruneCuts(open: Iterable<string> = [], now = Date.now()): Promise<number> {
  if (!inTauri) return 0
  const { appCacheDir, join } = await import('@tauri-apps/api/path')
  const fs = await import('@tauri-apps/plugin-fs')
  const folder = await join(await appCacheDir(), CUTS_DIR)
  if (!(await fs.exists(folder))) return 0
  const kv = await openKV('workspace.json')
  const saved = [...((await kv.get<SavedTab[]>('open')) ?? []), ...((await kv.get<SavedTab[]>('recent')) ?? [])]
  const referenced = namesIn(folder, [...open, ...saved.flatMap((t) => t?.set?.paths ?? [])])
  const entries: CutEntry[] = []
  for (const e of await fs.readDir(folder)) {
    if (!e.isFile) continue
    const st = await fs.stat(await join(folder, e.name)).catch(() => null)
    entries.push({ name: e.name, mtime: st?.mtime ? st.mtime.getTime() : null })
  }
  let n = 0
  for (const name of cutsToDelete(entries, referenced, now)) {
    try {
      await fs.remove(await join(folder, name))
      n++
    } catch (e) {
      console.error(`cuts: cannot delete ${name}:`, e)
    }
  }
  return n
}
