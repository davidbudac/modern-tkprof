// Import names: the trace has obj#, file# and user ids, not names. The dialog hands out the names script of the trace (one
// read-only PL/SQL block, `mtkprof refscript -paste`), takes what it printed as pasted text (or a saved file), and sends it to
// the engine session, which merges it into the trace's reference bundle and applies it (data/refimport.ts). Nothing here
// connects to the database. The shell mounts `RefImportHost` (store `refImport`); views link to it with `ImportNames`.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { sourceOf } from '../data/source'
import { copyText } from '../data/clipboard'
import { previewPaste, RefError, PASTE_END, PASTE_HEADER, type RefCounts, type RefImporter, type RefPasted, type RefScriptInfo, type RefStatus } from '../data/refimport'
import { fileHost } from '../shell/files'
import { useActions, useStore } from '../state/session'
import { usePersisted } from '../state/persist'
import '../styles/refimport.css'

// ---- support -------------------------------------------------------------------

const probes = new WeakMap<RefImporter, Promise<boolean>>()

/** Whether the server behind `refs` takes pasted names (an engine session; `mtkprof serve` answers 404). Asked once per importer. */
function probe(refs: RefImporter): Promise<boolean> {
  let p = probes.get(refs)
  if (!p) {
    p = refs.status().then(() => true, (e: unknown) => !(e instanceof RefError && e.status === 404))
    probes.set(refs, p)
  }
  return p
}

/** 'yes' once the server is known to take pasted names, 'no' for a document without one or one without the routes. */
export function useRefSupport(refs: RefImporter | null): 'yes' | 'no' | 'unknown' {
  const [v, setV] = useState<'yes' | 'no' | 'unknown'>(refs ? 'unknown' : 'no')
  useEffect(() => {
    if (!refs) { setV('no'); return }
    let live = true
    void probe(refs).then((ok) => { if (live) setV(ok ? 'yes' : 'no') })
    return () => { live = false }
  }, [refs])
  return v
}

/** How to name objects without the dialog: the CLI's script and `-ref`. */
export const CLI_NAMES_HINT = 'mtkprof refscript -paste trace.trc -o names.sql, run it, save what it prints as names.txt, then -ref names.txt'

/**
 * A link that opens the Import names dialog, where the document's server takes pasted names; elsewhere (the standalone HTML,
 * `mtkprof serve`) the CLI's way, as text. `children`: the link's text.
 */
export function ImportNames({ doc, children = 'Import names…' }: { doc: TraceDoc; children?: string }) {
  const actions = useActions()
  const compare = useStore((s) => s.compare)
  const support = useRefSupport(compare ? null : sourceOf(doc).refs)
  if (support === 'unknown') return null
  if (support === 'no') {
    return <span className="rfi-cli">CLI: <code>mtkprof refscript -paste</code>, run it, then <code>-ref</code> its saved output</span>
  }
  return <button type="button" className="link rfi-open" onClick={actions.openRefImport}>{children}</button>
}

/** The shell's Import names dialog, open while the store's `refImport` is set; it follows the document across the reload an import causes. */
export function RefImportHost() {
  const open = useStore((s) => s.refImport)
  const doc = useStore((s) => s.doc)
  const compare = useStore((s) => s.compare)
  const actions = useActions()
  const refs = doc && !compare ? sourceOf(doc).refs : null
  // each document has its source (a new one after the reload): the card talks to whichever is current
  const latest = useRef(refs)
  if (refs) latest.current = refs
  const importer = useMemo<RefImporter>(() => ({
    status: (signal) => latest.current!.status(signal),
    script: (plans, signal) => latest.current!.script(plans, signal),
    paste: (text) => latest.current!.paste(text),
  }), [])
  if (!latest.current) return null
  return <RefImportDialog open={open} importer={importer} onClose={actions.closeRefImport} />
}

// ---- dialog --------------------------------------------------------------------

/** The Import names dialog over `importer` (an engine session's ref routes). Open while `open` is set. */
export function RefImportDialog({ open, importer, onClose, subject }: {
  open: boolean
  importer: RefImporter
  onClose: () => void
  /** what the names are for, under the title (Connections: the trace's file names) */
  subject?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      className="rfi-dialog"
      aria-labelledby="rfi-title"
      onClose={() => open && onClose()}
      // the shell's Esc chain (window, details pane, line viewer) must not act on the key that closes this dialog
      onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation() }}
    >
      {open && <RefImportCard importer={importer} onClose={onClose} subject={subject} />}
    </dialog>
  )
}

type Run =
  | { phase: 'sending' }
  | { phase: 'applying'; pasted: RefPasted }
  | { phase: 'done'; pasted: RefPasted }
  | { phase: 'failed'; error: string; pasted?: RefPasted }

type Msg = { kind: 'ok' | 'error'; text: string }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** What a paste holds, kept per importer while the app runs: closing the dialog does not lose it. */
const drafts = new WeakMap<RefImporter, string>()

const POLL_MS = 250
const POLL_MAX_MS = 120_000

function RefImportCard({ importer, onClose, subject }: { importer: RefImporter; onClose: () => void; subject?: string }) {
  const [status, setStatus] = useState<RefStatus | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [plans, setPlans] = usePersisted('mtkprof.refimport.plans', false)
  const [script, setScript] = useState<RefScriptInfo | null>(null)
  const [scriptErr, setScriptErr] = useState<string | null>(null)
  const [text, setText] = useState(() => drafts.get(importer) ?? '')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const mounted = useRef(true)
  // set on every mount: StrictMode mounts, unmounts and mounts again
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    const ctl = new AbortController()
    importer.status(ctl.signal).then(setStatus, (e: unknown) => {
      if (ctl.signal.aborted) return
      if (e instanceof RefError && e.status === 404) setUnsupported(true)
      else setStatusErr(errText(e))
    })
    return () => ctl.abort()
  }, [importer])

  useEffect(() => {
    if (unsupported) return
    const ctl = new AbortController()
    setScriptErr(null)
    importer.script(plans, ctl.signal).then(setScript, (e: unknown) => { if (!ctl.signal.aborted) setScriptErr(errText(e)) })
    return () => ctl.abort()
  }, [importer, plans, unsupported])

  const preview = useMemo(() => previewPaste(text), [text])
  const isScript = /mtkprof names script|dbms_output\.put_line/.test(text)
  const found = preview.objects + preview.files + preview.users + preview.plans
  const busy = run?.phase === 'sending' || run?.phase === 'applying'
  const canApply = !busy && text.trim() !== '' && !isScript && (found > 0 || preview.tables)

  const edit = (v: string) => {
    drafts.set(importer, v)
    setText(v)
    if (run?.phase === 'done' || run?.phase === 'failed') setRun(null)
  }

  const copy = () => {
    if (!script) return
    void copyText(script.script).then((ok) => setMsg(ok ? { kind: 'ok', text: 'Script copied' } : { kind: 'error', text: 'Could not copy to the clipboard' }))
  }
  const save = () => {
    if (!script) return
    fileHost().save(script.name, script.script, 'Save the names script').then(
      (ok) => ok && setMsg({ kind: 'ok', text: `Saved ${script.name}` }),
      (e: unknown) => setMsg({ kind: 'error', text: errText(e) }),
    )
  }
  const openFile = () => {
    fileHost().open(['txt', 'log', 'lst', 'out', 'csv'], 'The saved output of the names script').then(
      (f) => { if (f) edit(f.text) },
      (e: unknown) => setMsg({ kind: 'error', text: errText(e) }),
    )
  }

  /** Asks for the session's ref status until the job `id` has ended. */
  const follow = async (pasted: RefPasted) => {
    const until = Date.now() + POLL_MAX_MS
    while (mounted.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      let st: RefStatus
      try { st = await importer.status() } catch (e) { if (mounted.current) setRun({ phase: 'failed', error: errText(e), pasted }); return }
      if (!mounted.current) return
      if (st.job?.id !== pasted.job.id || st.job.state === 'running') continue
      setStatus(st)
      setRun(st.job.state === 'done' ? { phase: 'done', pasted } : { phase: 'failed', error: st.job.message || st.job.state, pasted })
      return
    }
    if (mounted.current) setRun({ phase: 'failed', error: 'The engine is still applying the names; they show when it is done.', pasted })
  }
  const apply = () => {
    if (!canApply) return
    setRun({ phase: 'sending' })
    setMsg(null)
    importer.paste(text).then(
      (pasted) => { if (!mounted.current) return; setRun({ phase: 'applying', pasted }); void follow(pasted) },
      (e: unknown) => { if (mounted.current) setRun({ phase: 'failed', error: errText(e) }) },
    )
  }

  const wanted = status?.wanted ?? script?.wanted
  const lines = script ? script.script.split('\n').length - 1 : 0
  return (
    <section className="rfi-card">
      <header className="rfi-head">
        <h2 id="rfi-title">Import object names</h2>
        <button type="button" className="rfi-x" aria-label="Close" onClick={onClose}>×</button>
      </header>
      {subject && <p className="rfi-subject mono small">{subject}</p>}
      <p className="muted small">
        A trace names objects, files and users by number. Run this script where the database is and paste what it prints:
        owners, object names, partitions, types, tablespaces and file names then show everywhere. Nothing here connects to the database.
      </p>

      {unsupported ? (
        <p className="rfi-unsupported small">
          This server does not take pasted names (a trace opened with <code>mtkprof serve</code>). From the command line:{' '}
          <code>{CLI_NAMES_HINT}</code>.
        </p>
      ) : (
        <>
          {wanted && <Coverage wanted={wanted} named={status?.named} plans={plans || (status?.named.plans ?? 0) > 0} />}
          {statusErr && <p className="rfi-error small" role="alert">{statusErr}</p>}

          <ol className="rfi-steps">
            <li>
              <h3>Run this script</h3>
              <p className="muted small">
                Read-only: SELECTs and DBMS_XPLAN only. SQL*Plus or SQLcl: <code>@{script?.name ?? 'names.sql'}</code>, or paste it at
                the <code>SQL&gt;</code> prompt. SQL Developer: Run Script (F5). A user with SELECT_CATALOG_ROLE gets every name; any
                other user the objects it can see (the output says so). For a PDB trace connect to the PDB.
              </p>
              <div className="rfi-row">
                <button type="button" className="rfi-primary" disabled={!script} onClick={copy}>Copy script</button>
                <button type="button" disabled={!script} onClick={save}>Save {script?.name ?? 'script'}…</button>
                <label className="rfi-check" title="DBMS_XPLAN plans with their predicates: a much longer output">
                  <input type="checkbox" checked={plans} onChange={(e) => setPlans(e.target.checked)} />
                  Execution plans too{wanted && wanted.plans > 0 ? ` (${wanted.plans} sql_id${wanted.plans === 1 ? '' : 's'})` : ''}
                </label>
                <span className={msg?.kind === 'error' ? 'rfi-error small' : 'muted small'} role="status">{msg?.text}</span>
              </div>
              {scriptErr && <p className="rfi-error small" role="alert">{scriptErr}</p>}
              {script && (
                <details className="rfi-script">
                  <summary className="small">Show the script ({lines} lines)</summary>
                  <pre tabIndex={0}>{script.script}</pre>
                </details>
              )}
            </li>
            <li>
              <h3>Paste its output</h3>
              <textarea
                className="rfi-paste"
                rows={7}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={text}
                aria-label="The output of the names script"
                placeholder={`${PASTE_HEADER}\nobj,108609,108609,"MTK","MTK_CUST","","TABLE"\nfile,12,"/u01/oradata/users01.dbf","USERS","DATAFILE",12\n…\n${PASTE_END}`}
                onChange={(e) => edit(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply() } }}
              />
              <PasteNote text={text} preview={preview} isScript={isScript} />
              <div className="rfi-row">
                <button type="button" onClick={openFile}>Open saved output…</button>
                <span className="rfi-spacer" />
                <button type="button" className="rfi-primary" disabled={!canApply} onClick={apply}>
                  {run?.phase === 'sending' || run?.phase === 'applying' ? 'Applying…' : 'Apply names'}
                </button>
              </div>
            </li>
          </ol>
          <Result run={run} status={status} onClose={onClose} />
        </>
      )}
    </section>
  )
}

const KINDS: { key: keyof RefCounts; label: string }[] = [
  { key: 'objects', label: 'Objects' },
  { key: 'files', label: 'Datafiles' },
  { key: 'users', label: 'Users' },
  { key: 'plans', label: 'Plans' },
]

/** Per kind: how many of what the trace refers to have a name (a sql_id: a plan). */
function Coverage({ wanted, named, plans }: { wanted: RefCounts; named?: RefCounts; plans: boolean }) {
  const kinds = KINDS.filter((k) => wanted[k.key] > 0 && (k.key !== 'plans' || plans))
  if (kinds.length === 0) return <p className="muted small">This trace refers to no object, file or user by number.</p>
  return (
    <dl className="rfi-cov" aria-label="Named so far">
      {kinds.map((k) => {
        const n = named?.[k.key] ?? 0, of = wanted[k.key]
        return (
          <div key={k.key} className={n >= of ? 'rfi-full' : n > 0 ? 'rfi-part' : ''}>
            <dt>{k.label}</dt>
            <dd><b>{named ? n : '–'}</b> of {of}</dd>
            <span className="rfi-bar" aria-hidden="true"><i style={{ inlineSize: `${of ? Math.min(100, (100 * n) / of) : 0}%` }} /></span>
          </div>
        )
      })}
    </dl>
  )
}

function plural(n: number, one: string, many = one + 's') { return `${n} ${n === 1 ? one : many}` }

function countsText(c: { objects: number; files: number; users: number; plans: number }): string {
  const parts = [
    c.objects && plural(c.objects, 'object'),
    c.files && plural(c.files, 'datafile'),
    c.users && plural(c.users, 'user'),
    c.plans && plural(c.plans, 'plan'),
  ].filter(Boolean)
  return parts.join(' · ')
}

/** What the pasted text holds, as the user pastes it. */
function PasteNote({ text, preview, isScript }: { text: string; preview: ReturnType<typeof previewPaste>; isScript: boolean }) {
  if (text.trim() === '') return <p className="muted small rfi-note">Paste everything it printed, from <code>{PASTE_HEADER}</code> to <code>{PASTE_END}</code>; other lines are ignored.</p>
  if (isScript) return <p className="rfi-warn small rfi-note">That is the script itself: run it and paste what it prints.</p>
  const found = countsText(preview)
  if (!found) {
    if (preview.tables) return <p className="muted small rfi-note">No script lines: the text is read as tables under their header rows (OBJECT_ID, OWNER, OBJECT_NAME …).</p>
    return <p className="rfi-warn small rfi-note">Nothing to import: no line starts with <code>obj,</code> <code>file,</code> <code>user,</code> or <code>plan,</code>.{preview.notes.length > 0 ? ` The script said: ${preview.notes.join('; ')}` : ''}</p>
  }
  return (
    <p className="small rfi-note">
      Found {found}{preview.notes.length > 0 && <span className="muted"> · {plural(preview.notes.length, 'note')}</span>}
      {preview.header && !preview.end && <span className="rfi-warn"> · no <code>{PASTE_END}</code> line: the output looks cut off; what is here can still be applied</span>}
    </p>
  )
}

/** The import's progress and outcome, with the script's notes. */
function Result({ run, status, onClose }: { run: Run | null; status: RefStatus | null; onClose: () => void }) {
  if (!run) return null
  const pasted = 'pasted' in run ? run.pasted : undefined
  return (
    <div className={`rfi-result small${run.phase === 'failed' ? ' rfi-failed' : ''}`} role="status" aria-live="polite">
      {run.phase === 'sending' && <p>Sending…</p>}
      {run.phase === 'applying' && <p>Read {countsText(run.pasted.read) || 'nothing'}; applying…</p>}
      {run.phase === 'done' && (
        <div className="rfi-done">
          <p>
            <b>Applied.</b> Read {countsText(run.pasted.read)}
            {status && <>; named now: {countsText(status.named) || 'nothing of this trace'}</>}. The views show the names; they are kept for this trace.
          </p>
          <button type="button" className="rfi-primary" onClick={onClose}>Done</button>
        </div>
      )}
      {run.phase === 'failed' && <p className="rfi-error">{run.error}</p>}
      {pasted && !pasted.complete && run.phase !== 'failed' && <p className="rfi-warn">The paste had no <code>{PASTE_END}</code> line: run the script again and copy all of it for the rest.</p>}
      {pasted && pasted.notes.length > 0 && (
        <details className="rfi-notes" open={pasted.notes.length <= 4}>
          <summary>The script said ({pasted.notes.length})</summary>
          <ul>{pasted.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
