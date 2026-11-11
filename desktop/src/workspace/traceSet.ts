/**
 * Pure helpers for trace sets (several files, or a folder the engine expands into its `*.trc`
 * files): the tab title, which requested paths are folders, the tooltip, the recent-list line.
 */
import type { FileInfo } from '../engine'

export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** The folder a path is in (no trailing slash; the root and a drive root keep theirs); '' for a bare name. */
export function dirOf(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (i < 0) return ''
  const d = t.slice(0, i)
  return d === '' || /^[a-z]:$/i.test(d) ? t.slice(0, i + 1) : d
}

/** `name` for one path (file or folder), `name (+N)` for a set: the first path's name and the others counted. */
export function titleOf(paths: string[]): string {
  if (paths.length === 0) return 'trace'
  return paths.length === 1 ? baseName(paths[0]) : `${baseName(paths[0])} (+${paths.length - 1})`
}

/** Slashes unified, no trailing slash; case folded for a Windows path (drive letter or UNC). */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^([a-z]:|\/\/)/i.test(s) ? s.toLowerCase() : s
}

/** The requested paths the engine expanded: those with a reported file below them (a folder). */
export function dirsOf(paths: string[], files: Pick<FileInfo, 'path'>[]): string[] {
  const below = files.map((f) => norm(f.path))
  return paths.filter((p) => {
    const d = norm(p) + '/'
    return below.some((f) => f.startsWith(d))
  })
}

/**
 * The requested paths that the session holds: those with a reported file of that path. The engine can leave a file out of a set (a 10053 file among
 * 10046 files, all but the first of a set of 10053 files), and then the tab's title, made from the request, counts files that are not in it.
 * Null when the request holds a folder (its files are not the request's paths), or when no requested path is found among the files, which is the
 * case where the engine reports another spelling of the path (so nothing can be said).
 */
export function heldPaths(paths: string[], files: Pick<FileInfo, 'path'>[]): string[] | null {
  if (files.length === 0 || dirsOf(paths, files).length > 0) return null
  const have = new Set(files.map((f) => norm(f.path)))
  const held = paths.filter((p) => have.has(norm(p)))
  return held.length > 0 ? held : null
}

const LISTED = 8

/**
 * The tab's tooltip: the requested paths, and when the engine reports more files than were given
 * (a folder expanded, `TRACE CONTINUES IN FILE` followed) how many it opened and which.
 */
export function setTooltip(paths: string[], files: Pick<FileInfo, 'name'>[] = []): string {
  const lines = [...paths]
  if (files.length > paths.length) {
    const names = files.slice(0, LISTED).map((f) => f.name)
    lines.push('', `${files.length} files: ${names.join(', ')}${files.length > LISTED ? ', …' : ''}`)
  }
  return lines.join('\n')
}

/**
 * The recent list's second line: the file count with the folder it is in for a single path, `N files in <folder>`
 * when that path is a folder (`dirs`), the count alone for a set; the path while the count is unknown.
 */
export function setSummary(paths: string[], files?: number, dirs: string[] = []): string {
  if (paths.length === 1 && !files) return paths[0]
  if (!files) return `${paths.length} paths`
  const n = `${files} file${files === 1 ? '' : 's'}`
  if (paths.length !== 1) return n
  return dirs.length ? `${n} in ${paths[0]}` : `${n} · ${dirOf(paths[0])}`
}
