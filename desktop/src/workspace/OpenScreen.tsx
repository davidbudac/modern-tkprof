import { useLayoutEffect, useRef, useState } from 'react'
import { useEngine } from '../engine'
import { isMac } from '@lib'
import { inTauri, pickPaths } from '../platform'
import { BindSeg } from '../settings/BindSeg'
import { useSettings } from '../settings/settings'
import { ago } from '../time'
import { useWorkspace, useWorkspaceState } from './WorkspaceProvider'
import { setSummary, setTooltip, titleOf } from './traceSet'
import { canCompare, defaultOpenOptions, openRequest, type OpenOptions } from './workspace'
import { CompareTabsButton } from './CompareTabs'
import { FolderIcon } from '../ui/FolderIcon'
import { FolderPicker } from './FolderPicker'

/**
 * The "+" tab: open files or folders (dialog, drop, path), the open options, the recent trace sets.
 * A folder lists its trace files to choose from first (`FolderPicker`).
 */
export function OpenScreen() {
  const { pick } = useWorkspaceState()
  return pick ? <FolderPicker key={pick.id} pick={pick} /> : <OpenChoices />
}

function OpenChoices() {
  const ws = useWorkspace()
  const { recent, tabs, openOptions } = useWorkspaceState()
  const { status } = useEngine()
  const { settings } = useSettings()
  // The options live in the workspace (a drop anywhere on this screen opens with them); each visit starts from the settings' defaults.
  useLayoutEffect(() => ws.setOpenOptions(defaultOpenOptions(settings)), [])
  const { binds, follow } = openOptions
  const salt = openOptions.salt ?? ''
  const set = (patch: Partial<OpenOptions>) => ws.setOpenOptions({ ...openOptions, ...patch })
  const [path, setPath] = useState('')
  const [dir, setDir] = useState('')
  const dirInput = useRef<HTMLInputElement>(null)
  const pathInput = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const ready = status === 'ready'
  const options = (): OpenOptions => openRequest(openOptions)

  const openPaths = (paths: string[] | null) => {
    if (!paths?.length) return
    void ws.openOrPick({ paths, options: options() })
  }
  const pick = (folder: boolean) => void pickPaths(folder).then(openPaths, (e) => console.error('open dialog:', e))
  const lines = (text: string) => text.split('\n').map((p) => p.trim()).filter(Boolean)
  const inDir = (name: string) => (dir.trim() ? `${dir.trim().replace(/[\\/]+$/, '')}/${name}` : name)

  // The dev browser has no dialogs and no paths: "Open files…" takes the names from a file input
  // (resolved against the folder field), "Open folder…" opens the folder typed in the field.
  const openFiles = () => (inTauri ? pick(false) : fileInput.current?.click())
  const openFolder = () => {
    if (inTauri) return pick(true)
    if (dir.trim()) openPaths([dir.trim()])
    else dirInput.current?.focus()
  }
  const onFiles = (files: FileList | null) => {
    const names = Array.from(files ?? [], (f) => inDir(f.name))
    if (fileInput.current) fileInput.current.value = ''
    if (!names.length) return
    if (dir.trim()) openPaths(names)
    else {
      setPath(names.join('\n'))
      pathInput.current?.focus()
    }
  }

  return (
    <div className="open-screen">
      <section className="open-main">
        <h1>Open a trace</h1>
        <p className="muted">
          Oracle 10046 trace files, or folders of them. Several files open as one trace set.{' '}
          <button className="link" onClick={() => ws.go({ kind: 'page', id: 'tracing' })}>How to make a trace</button>
        </p>
        <div className="drop-zone">
          <p className="actions">
            <button className="primary" disabled={!ready} onClick={openFiles}>Open files…</button>
            <button disabled={!ready} onClick={openFolder}>Open folder…</button>
            {!inTauri && <input ref={fileInput} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />}
            {ready ? <span className="muted small">or drop them anywhere on the window</span> : <span className="muted small">Waiting for the engine…</span>}
          </p>
          {!inTauri && (
            <div className="path-form">
              <label htmlFor="open-dir">Folder (dev browser mode: the engine reads it; also the base of the picked file names)</label>
              <input id="open-dir" ref={dirInput} type="text" className="mono" placeholder="/path/to/folder" value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
            </div>
          )}
          <form
            className="path-form"
            onSubmit={(e) => {
              e.preventDefault()
              openPaths(lines(path))
              setPath('')
            }}
          >
            <label htmlFor="open-path">{inTauri ? 'Or paths (one per line; a folder opens all its trace files)' : 'Paths (dev browser mode: one per line, files or folders)'}</label>
            <span className="row">
              <textarea id="open-path" ref={pathInput} className="mono" rows={2} placeholder="/path/to/trace.trc" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
              <button type="submit" disabled={!ready || !path.trim()}>Open</button>
            </span>
          </form>
          <details className="rollout open-opts">
            <summary><b>Options</b> · binds {binds === 'keep' ? 'kept' : binds === 'redact' ? 'redacted' : 'dropped'}{follow && ' · follow'}</summary>
            <div className="opt-row">
              <span className="muted small">Bind values</span>
              <BindSeg value={binds} onChange={(b) => set({ binds: b })} />
              {binds === 'redact' ? (
                <label className="small muted">
                  Salt <input type="text" value={salt} onChange={(e) => set({ salt: e.target.value })} placeholder="random per open" />
                </label>
              ) : (
                <span className="muted small faint">· redacting asks for a salt</span>
              )}
              <label className="check">
                <input type="checkbox" checked={!!follow} onChange={(e) => set({ follow: e.target.checked })} />
                Follow as it grows (live; one file)
              </label>
            </div>
          </details>
        </div>
        <p className="muted small key-tip">
          {isMac
            ? <>Keys: <kbd>⌘1</kbd>…<kbd>⌘9</kbd> views of a trace · <kbd>⌃1</kbd>…<kbd>⌃9</kbd> open traces · hold <kbd>⌘</kbd> or <kbd>⌃</kbd> to see which is which</>
            : <>Keys: <kbd>Ctrl+1</kbd>…<kbd>Ctrl+9</kbd> views of a trace · <kbd>Alt+1</kbd>…<kbd>Alt+9</kbd> open traces · hold <kbd>Ctrl</kbd> or <kbd>Alt</kbd> to see which is which</>}
        </p>
        {tabs.filter(canCompare).length >= 2 && (
          <section className="compare-card" aria-labelledby="compare-card-h">
            <div>
              <h2 id="compare-card-h">Compare two open traces</h2>
              <p className="muted small">A fixed snapshot of the whole traces: SQL, CPU, elapsed time, waits and plan changes (deltas are B minus A). Needs two ready, non-live tabs.</p>
            </div>
            <CompareTabsButton />
          </section>
        )}
      </section>
      <section className="recent" aria-labelledby="recent-h">
        <h2 id="recent-h">Recent</h2>
        {recent.length === 0 && <p className="muted small">Nothing yet.</p>}
        <ul>
          {recent.map((r, i) => (
            <li key={i}>
              <button className="recent-open" disabled={!ready} onClick={() => void ws.openOrPick(r.set)} title={setTooltip(r.set.paths)}>
                <b className="mono recent-title">{r.dirs?.length ? <FolderIcon className="folder-mark" /> : null}<span>{titleOf(r.set.paths)}</span></b>
                <span className="muted small mono">{setSummary(r.set.paths, r.files, r.dirs)}</span>
              </button>
              <span className="recent-ago muted small">{r.set.options.binds !== 'keep' && `binds ${r.set.options.binds} · `}{ago(r.at)}</span>
              <button className="recent-x quiet" onClick={() => ws.removeRecent(i)} aria-label={`Remove ${titleOf(r.set.paths)} from the recent list`}>×</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
