import { useEffect, useMemo, useRef, useState } from 'react'
import './brief.css'
import { useClient, useStore, useStoreApi } from '@lib'
import { copyText } from '@lib/data/clipboard'
import { safeFileName, saveAs } from '../../files'
import { briefNotes, briefRequest, fetchBrief, fmtTokens, newSalt, type Brief, type BriefBinds } from './brief'
import { traceStem, useCurrentTab } from './useTab'

const BINDS: { id: BriefBinds; title: string }[] = [
  { id: 'mask', title: 'Each value as its type, length and a salted hash: equal values stay recognisable' },
  { id: 'keep', title: 'The values as traced' },
  { id: 'none', title: 'Leave the binds out' },
]

/** The case text of each tab, kept while the app runs: closing the dialog does not lose what was typed. */
const cases = new WeakMap<object, string>()

/** `value` once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** The brief of the open trace for an LLM: a modal card with the case, what goes in, a preview with its token estimate, Copy and Save. Open while `open` is set. */
export function BriefDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      className="brief-dialog"
      aria-labelledby="brief-title"
      onClose={() => open && onClose()}
      // the shell's Esc handler (window time, inspector, line viewer) must not act on the key that closes this dialog
      onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation() }}
    >
      {open && <BriefCard onClose={onClose} />}
    </dialog>
  )
}

type Preview = { brief: Brief | null; busy: boolean; error: string }
type Msg = { kind: 'copied' | 'saved' | 'error'; text: string }

function BriefCard({ onClose }: { onClose: () => void }) {
  const store = useStoreApi()
  const client = useClient()
  const tab = useCurrentTab()
  const doc = useStore((s) => s.doc)
  const noteCount = useStore((s) => briefNotes(s).length)
  const [caseText, setCaseText] = useState(() => cases.get(store) ?? '')
  const [notes, setNotes] = useState(true)
  const [plans, setPlans] = useState(true)
  const [binds, setBinds] = useState<BriefBinds>('mask')
  const salt = useMemo(newSalt, [])
  const settled = useDebounced(caseText, 300)
  const [preview, setPreview] = useState<Preview>({ brief: null, busy: true, error: '' })
  const [msg, setMsg] = useState<Msg | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    setPreview((p) => ({ ...p, busy: true, error: '' }))
    setMsg(null)
    fetchBrief(client, briefRequest(store.getState(), { caseText: settled, notes, plans, binds, salt }), ctl.signal).then(
      (brief) => setPreview({ brief, busy: false, error: '' }),
      (e: unknown) => { if (!ctl.signal.aborted) setPreview({ brief: null, busy: false, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => ctl.abort()
  }, [client, store, settled, notes, plans, binds, salt])

  const { brief } = preview
  // what Copy and Save hand out is what the preview shows: not while it is being refreshed or the case text is not in it yet
  const ready = brief !== null && !preview.busy && caseText === settled
  const tokens = brief ? `≈ ${fmtTokens(brief.tokens)} tokens` : ''
  const failed = (e: unknown) => setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) })

  const copy = () => {
    if (!brief || !ready) return
    void copyText(brief.markdown).then((ok) => setMsg(ok ? { kind: 'copied', text: `Copied · ${tokens}` } : { kind: 'error', text: 'Could not copy to the clipboard' }))
  }
  const save = () => {
    if (!brief || !ready) return
    const name = `${safeFileName(doc ? traceStem(doc, tab) : 'trace')}-brief.md`
    saveAs(name, brief.markdown, [{ name: 'Markdown', extensions: ['md'] }], 'Save the brief').then((path) => path && setMsg({ kind: 'saved', text: `Saved ${path} · ${tokens}` }), failed)
  }

  const opened = tab?.set.options.binds
  return (
    <section className="brief-card">
      <h2 id="brief-title">Copy brief</h2>
      <p className="muted small">What mtkprof sees in this trace, as Markdown for an LLM: the statements that make up the response time, their waits, plans and findings, and your notes. Facts only; nothing is sent anywhere.</p>
      <label className="brief-case">
        What is the problem?
        <textarea
          autoFocus
          rows={3}
          value={caseText}
          placeholder="What you see, what you already tried, what you want to know"
          onChange={(e) => { cases.set(store, e.target.value); setCaseText(e.target.value) }}
        />
      </label>
      <div className="brief-options">
        <label className="check" title="Your notes on statements, executions, time windows and bookmarked lines, next to what they annotate">
          <input type="checkbox" checked={notes} disabled={noteCount === 0} onChange={(e) => setNotes(e.target.checked)} />
          Notes{noteCount === 0 ? ' (none yet)' : ` (${noteCount})`}
        </label>
        <label className="check" title="The execution plan of each listed statement">
          <input type="checkbox" checked={plans} onChange={(e) => setPlans(e.target.checked)} />
          Plans
        </label>
        <span className="brief-binds">
          Bind values
          <span className="seg" role="group" aria-label="Bind values">
            {BINDS.map((b) => (
              <button key={b.id} aria-pressed={binds === b.id} title={b.title} onClick={() => setBinds(b.id)}>{b.id}</button>
            ))}
          </span>
        </span>
      </div>
      <p className="muted small">
        SQL text goes in as traced, literals included.
        {opened && opened !== 'keep' && <> This trace was opened with its bind values {opened === 'none' ? 'dropped' : 'redacted'}, so <b>keep</b> shows no more than that.</>}
      </p>
      <div className="brief-preview-head">
        <b>Preview</b>
        <span className="muted small" aria-live="polite">{preview.busy ? 'rendering…' : tokens}</span>
      </div>
      {preview.error
        ? <p className="callout report-error" role="alert">{preview.error}</p>
        : <pre className="brief-preview" tabIndex={0} aria-label="Brief preview" aria-busy={!ready}>{brief?.markdown ?? ''}</pre>}
      <div className="brief-actions">
        <span className={'small ' + (msg?.kind === 'error' ? 'report-error' : 'muted')} role="status">{msg?.text}</span>
        <button className="primary" disabled={!ready} onClick={copy}>{msg?.kind === 'copied' ? 'Copied' : 'Copy'}</button>
        <button disabled={!ready} onClick={save}>Save .md</button>
        <button onClick={onClose}>Close</button>
      </div>
    </section>
  )
}
