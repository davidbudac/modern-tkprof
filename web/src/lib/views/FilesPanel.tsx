import { useMemo, useRef, type CSSProperties, type MouseEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import type { FileEntry } from '../data/types'
import { fmtBytes, fmtCompact, fmtDur, fmtPct, fmtWall } from '../data/format'
import { clickFile, fileCount, fileTree, invert, isSelected, selectedCount } from '../data/fileset'
import { shareTotals, useFileShares, type FileShare } from '../data/fileshares'
import { filesPanelOpen } from '../state/store'
import { useStore, useActions } from '../state/session'
import { PaneToggle } from '../components/PaneToggle'
import { ResizeHandle } from '../components/ResizeHandle'

/** "3 of 7 files" (or "7 files" with every file selected). */
export function filesLabel(doc: TraceDoc, files: ReadonlySet<number> | null): string {
  const n = fileCount(doc)
  return files ? `${selectedCount(doc, files)} of ${n} files` : `${n} file${n === 1 ? '' : 's'}`
}

/**
 * The input files of a trace set, one row each, to choose which traces every view shows. Click a name: only that file; ⌘/Ctrl-click
 * toggles it; Shift-click selects the range from the last click. PX slave files are indented under their coordinator's file.
 * Renders nothing for a single-file document.
 */
export function FilesPanel({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const files = useStore((s) => s.files)
  const shares = useFileShares(doc)
  const tree = useMemo(() => fileTree(doc), [doc])
  const order = useMemo(() => tree.map((n) => n.idx), [tree])
  const ctxCount = useMemo(() => {
    const out = new Array<number>(fileCount(doc)).fill(0)
    for (const c of doc.contexts) { const f = c.fileIdx ?? 0; if (f < out.length) out[f]++ }
    return out
  }, [doc])
  const chainSize = useMemo(() => {
    const m = new Map<number, number>()
    for (const f of doc.file.files ?? []) m.set(f.chain, (m.get(f.chain) ?? 0) + 1)
    return m
  }, [doc])
  const anchor = useRef<number | null>(null)
  const totals = useMemo(() => shareTotals(doc, shares), [doc, shares])
  const maxResp = useMemo(() => shares.reduce((a, s) => Math.max(a, s ? s.responseUs : 0), 0), [shares])
  const n = fileCount(doc)
  const list = doc.file.files ?? []

  const pick = (idx: number, e: MouseEvent, how: 'name' | 'box') => {
    const mods = { toggle: e.metaKey || e.ctrlKey || how === 'box', range: e.shiftKey }
    actions.setFiles(clickFile(doc, files, order, idx, anchor.current, mods))
    anchor.current = idx
  }

  return (
    <aside className="files-panel" aria-label="Input files">
      <div className="files-head">
        <div className="t"><h2>Files</h2><span className="dim" aria-live="polite">{filesLabel(doc, files)}</span></div>
        <div className="opts">
          <button onClick={() => actions.setFiles(null)} disabled={files === null}>All</button>
          <button onClick={() => actions.setFiles(new Set())} disabled={files !== null && files.size === 0}>None</button>
          <button onClick={() => actions.setFiles(invert(doc, files))}>Invert</button>
        </div>
        <p className="xs dim">click: only this file · ⌘/Ctrl-click: toggle · Shift-click: range</p>
      </div>
      <ul className="files-list">
        {tree.map((node) => {
          const f = list[node.idx]
          if (!f) return null
          const on = isSelected(files, node.idx)
          const sh = shares[node.idx]
          return (
            <li key={node.idx} className={'file' + (on ? ' on' : '')} style={{ '--depth': node.depth } as CSSProperties}>
              <input type="checkbox" checked={on} readOnly aria-label={`show ${f.name}`} onClick={(e) => pick(node.idx, e, 'box')} />
              <div className="fbody">
                <button className="name mono" onClick={(e) => pick(node.idx, e, 'name')} title={`${f.path}\nclick: only this file`}>
                  {node.depth > 0 && <span className="dim">↳ </span>}{f.name}
                </button>
                <div className="meta dim">{fileMeta(doc, f, ctxCount[node.idx])}</div>
                <div className="chips">
                  {f.px && <span className="chip-q" title={node.parent !== null ? `PX slave of ${list[node.parent]?.name}` : 'PX slave trace with no coordinator in the set'}>PX{node.parent === null ? ' ?' : ''}</span>}
                  {(chainSize.get(f.chain) ?? 1) > 1 && <span className="chip-q" title={chainTitle(f, list)}>Chain {chainPos(f, list)}</span>}
                  {f.followed && <span className="chip-q" title="not named by the user: found by following TRACE CONTINUES IN / CONTINUED FROM">Followed</span>}
                  {(chainSize.get(f.chain) ?? 1) === 1 && f.continuedFrom?.length ? <span className="chip-q" title={`continues ${f.continuedFrom.join(', ')}, which is not in the set`}>Continued</span> : null}
                </div>
                <Share sh={sh} totals={totals} maxResp={maxResp} px={f.px && node.parent !== null} />
              </div>
            </li>
          )
        })}
      </ul>
      {n > 1 && files !== null && files.size === 0 && <p className="callout files-none">No file selected: the views are empty.</p>}
    </aside>
  )
}

function fileMeta(doc: TraceDoc, f: FileEntry, contexts: number): string {
  const parts = [fmtBytes(f.size), `${fmtCompact(f.lines)} lines`]
  parts.push(`${contexts} context${contexts === 1 ? '' : 's'}`)
  if (f.processPid) parts.push(`pid ${f.processPid}`)
  if (f.instance) parts.push(f.instance)
  const span = f.firstWallUs
    ? `${fmtWall(f.firstWallUs, doc.tzOffsetMin)} → ${fmtWall(f.lastWallUs, doc.tzOffsetMin)}`
    : f.firstTim > 0 ? `+${fmtDur(f.firstTim - doc.span.firstTim)} → +${fmtDur(f.lastTim - doc.span.firstTim)}` : ''
  return [...parts, span].filter(Boolean).join(' · ')
}

/** "2/3": the file's place among the files of its chain. */
function chainPos(f: FileEntry, list: readonly FileEntry[]): string {
  const same = list.filter((x) => x.chain === f.chain)
  return `${same.indexOf(f) + 1}/${same.length}`
}

function chainTitle(f: FileEntry, list: readonly FileEntry[]): string {
  return `part ${chainPos(f, list)} of a TRACE CONTINUES IN chain: ${list.filter((x) => x.chain === f.chain).map((x) => x.name).join(' → ')}`
}

/** The file's response time (its own rows) against the set's, and its non-idle waits against the files' sum. */
function Share({ sh, totals, maxResp, px }: { sh: FileShare | null | undefined; totals: { responseUs: number; waitUs: number }; maxResp: number; px: boolean }) {
  if (sh === undefined) return <div className="share dim">…</div>
  if (sh === null) return null
  const title = `response time ${fmtDur(sh.responseUs)} of ${fmtDur(totals.responseUs)} (the set: sum over its sessions)${px ? '; PX slave: runs in parallel with its coordinator, whose response time covers it' : ''} · non-idle waits ${fmtDur(sh.waitUs)}`
  return (
    <div className="share" title={title}>
      <span className="bar"><i style={{ inlineSize: `${maxResp ? (100 * sh.responseUs) / maxResp : 0}%` }} /></span>
      <span className="tabular">{fmtPct(sh.responseUs, totals.responseUs, 0)} time</span>
      <span className="tabular dim">{fmtPct(sh.waitUs, totals.waitUs, 0)} waits</span>
    </div>
  )
}

/**
 * The Files panel as a left pane of a `.body` grid: the panel, its resize handle and the collapse tab. The shell puts it first
 * in `.body`, adds `has-files` to `.shell` while `filesPanelOpen(state)` holds and sets `--files-w` on `.body` for a dragged width. Nothing for a single-file document.
 */
export function FilesPane({ doc, onWidth }: { doc: TraceDoc; /** the pane was dragged to this width (null = back to the default) */ onWidth: (px: number | null) => void }) {
  const actions = useActions()
  const open = useStore((s) => filesPanelOpen(s))
  if (!doc.multiFile) return null
  return (
    <>
      {open && <FilesPanel doc={doc} />}
      {open && <ResizeHandle anchor="start" className="resizer-files" label="Resize files panel" min={220} maxFrac={0.4} onChange={onWidth} />}
      <PaneToggle side="start" open={open} onToggle={() => actions.setFilesOpen(!open)} label="files panel" className="files-toggle" />
    </>
  )
}

/** Top-bar entry: opens / closes the Files panel; with a subset selected it says "3 of 7 files" and clears the selection. */
export function FilesToggle({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const open = useStore((s) => filesPanelOpen(s))
  const files = useStore((s) => s.files)
  if (!doc.multiFile) return null
  return (
    <span className="chip files-chip">
      <button className={'quiet' + (open ? ' on' : '')} aria-expanded={open} onClick={() => actions.setFilesOpen(!open)} title={`${open ? 'Hide' : 'Show'} the files panel`}>▤ {filesLabel(doc, files)}</button>
      {files && <button onClick={() => actions.setFiles(null)} aria-label="Select all files" title="show all files">×</button>}
    </span>
  )
}
