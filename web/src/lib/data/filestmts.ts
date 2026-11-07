// The statements' numbers inside one input file. The Trace pane works on one file at a time, and a statement that ran in several files of a trace set (a chain,
// a PX group) has more time in the set than in the file on screen: the picker's time and share, the overview track and the sticky lane row all say the file's.
import { useMemo } from 'react'
import type { TraceDoc } from './doc'
import { contextsOfFiles, fileCount } from './fileset'
import { sourceOf, useSourceQuery } from './source'
import type { Scope } from '../state/store'
import type { FileStmtStats } from './stmtpick'

/**
 * Elapsed time and executions of every statement (by id) over the calls of input file `file`. A trace of one file is the document's own table; a set asks the
 * source for the statistics of the file's contexts (the engine's `api/statements`, or the fact columns) and shows the whole set's numbers until they arrive.
 */
export function useFileStmts(doc: TraceDoc, file: number): readonly FileStmtStats[] {
  const source = sourceOf(doc)
  const multi = fileCount(doc) > 1
  const scope = useMemo<Scope | null>(() => (multi ? { window: null, files: new Set([file]), contexts: contextsOfFiles(doc, new Set([file])), includeIdle: true } : null), [doc, file, multi])
  const q = useSourceQuery(source, `filestmts:${file}`, (signal) => (scope && source.ready ? source.statements(scope, signal) : null), 'filestmts')
  return q.data ?? doc.stats.statements
}
