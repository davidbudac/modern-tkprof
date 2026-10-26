// A time window as lines of the input files: which files it touches and which of their lines it covers.
import type { ApiClient } from './client'
import type { TraceDoc } from './doc'
import { isSelected } from './fileset'
import { lineAt } from './lines'
import type { FileEntry, ID } from './types'
import type { TimeWindow } from '../state/store'

/** A range of lines of one input file, 1-based and inclusive. */
export interface LineRange { from: number; to: number }

/** The file's time range overlaps the window (a file without timed records never does). */
export const fileInWindow = (f: Pick<FileEntry, 'firstTim' | 'lastTim'>, win: TimeWindow): boolean => f.lastTim > 0 && f.firstTim <= win.endTim && f.lastTim >= win.startTim

/**
 * The input files to look at for the window: the ones in the file selection (`files`, null = all) whose time range overlaps it, in
 * file order; with `stmt` the files holding one of its cursors come first. A single-file trace is `[0]`.
 */
export function windowFiles(doc: TraceDoc, win: TimeWindow, files: ReadonlySet<number> | null, stmt?: ID | null): number[] {
  const list = doc.file.files
  if (!list || list.length <= 1) return [0]
  const out: number[] = []
  list.forEach((f, i) => { if (isSelected(files, i) && fileInWindow(f, win)) out.push(i) })
  const cursors = stmt == null ? undefined : doc.statements[stmt]?.cursors
  if (!cursors?.length) return out
  const holding = new Set(cursors.map((c) => doc.fileOfCursor(c)))
  return [...out.filter((i) => holding.has(i)), ...out.filter((i) => !holding.has(i))]
}

/** The first line of `file` at or after the window's start (a record is written when its call ends, so lines run in `tim` order). */
export function windowStartLine(client: ApiClient, file: number, win: TimeWindow, signal?: AbortSignal): Promise<number> {
  return lineAt(client, file, Math.ceil(win.startTim), signal)
}

/** What the range needs of a file: its line count and time range (a trace without a file list is one file with the trace's own). */
function fileInfo(doc: TraceDoc, file: number): Pick<FileEntry, 'lines' | 'firstTim' | 'lastTim'> | null {
  const f = doc.file.files?.[file]
  if (f) return f
  return file === 0 && !doc.file.files?.length ? { lines: doc.diag.lines, firstTim: doc.span.firstTim, lastTim: doc.span.lastTim } : null
}

/**
 * The lines of `file` whose records the window covers: from the window start's line to the line before the first record past the
 * window's end (the file's last line when the window runs past its last record). Null when the window does not overlap the file or
 * holds none of its records.
 */
export async function windowLineRange(client: ApiClient, doc: TraceDoc, file: number, win: TimeWindow, signal?: AbortSignal): Promise<LineRange | null> {
  const f = fileInfo(doc, file)
  if (!f || f.lines <= 0 || !fileInWindow(f, win)) return null
  const from = await windowStartLine(client, file, win, signal)
  const to = win.endTim >= f.lastTim ? f.lines : (await lineAt(client, file, Math.floor(win.endTim) + 1, signal)) - 1
  return to < from ? null : { from, to }
}
