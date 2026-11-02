import { useState, type ReactNode } from 'react'
import { useClient, type TraceDoc } from '@lib'
import { responseError } from '../../engine'
import { openCached, safeFileName, saveAs } from '../../files'
import { traceStem, useCurrentTab } from './useTab'

type Format = 'text' | 'json' | 'csv' | 'html'

const FORMATS: { id: Format; label: string; ext: string; type: string; what: ReactNode }[] = [
  { id: 'text', label: 'Text report', ext: 'txt', type: 'text/plain', what: <>what <code>mtkprof report -aggregate</code> prints: tkprof-style statements, waits, findings</> },
  { id: 'json', label: 'JSON document', ext: 'json', type: 'application/json', what: <>the document <code>mtkprof json</code> writes (no fact tables)</> },
  { id: 'csv', label: 'CSV (zip)', ext: 'csv.zip', type: 'application/zip', what: <>the files <code>mtkprof export</code> writes: statements, calls, waits, binds, … in one zip</> },
  { id: 'html', label: 'Standalone HTML', ext: 'html', type: 'text/html', what: <>the single-file report (the UI with the document inlined), to send to someone</> },
]

const SORTS = ['elapsed', 'self', 'cpu', 'execs', 'disk', 'query', 'rows', 'line'] as const

interface TextOptions {
  sort: (typeof SORTS)[number]
  top: number
  execs: number
  binds: number
  sys: boolean
  width: number
}

const DEFAULTS: TextOptions = { sort: 'elapsed', top: 0, execs: 20, binds: 5, sys: true, width: 120 }

/** `filename="…"` of a Content-Disposition header. */
function dispositionName(h: string | null): string | null {
  const m = h && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(h)
  return m ? decodeURIComponent(m[1]) : null
}

/** Reports: the CLI's outputs of this session (GET api/report), saved to a file or opened. */
export function ReportsView({ doc }: { doc: TraceDoc }) {
  const client = useClient()
  const tab = useCurrentTab()
  const [opts, setOpts] = useState<TextOptions>(DEFAULTS)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (p: Partial<TextOptions>) => setOpts((o) => ({ ...o, ...p }))

  const fetchReport = async (f: Format) => {
    const q = new URLSearchParams({ format: f })
    if (f === 'text') {
      q.set('sort', opts.sort)
      q.set('top', String(opts.top))
      q.set('execs', String(opts.execs))
      q.set('binds', String(opts.binds))
      q.set('sys', opts.sys ? '1' : '0')
      q.set('width', String(opts.width))
    }
    const r = await client.fetch(`/api/report?${q}`)
    if (!r.ok) throw await responseError(r, 'report')
    if (!r.body) throw new Error('report: empty answer')
    const fmt = FORMATS.find((x) => x.id === f)!
    const name = safeFileName(dispositionName(r.headers.get('content-disposition')) ?? `${traceStem(doc, tab)}.${fmt.ext}`)
    return { body: r.body, name, fmt }
  }

  const go = (f: Format, open: boolean) => {
    setBusy(f + (open ? ':open' : ''))
    setMsg(null)
    void (async () => {
      const { body, name, fmt } = await fetchReport(f)
      if (open) {
        const where = await openCached('reports', name, body, fmt.type)
        return `Opened ${where}`
      }
      const path = await saveAs(name, body, [{ name: fmt.label, extensions: [fmt.ext.split('.').pop()!] }], `Save the ${fmt.label.toLowerCase()}`)
      return path ? `Saved ${path}` : null
    })()
      .then(
        (text) => text && setMsg({ ok: true, text }),
        (e: unknown) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setBusy(null))
  }

  const num = (k: 'top' | 'execs' | 'binds' | 'width', min: number, label: string, title: string) => (
    <label className="pv-ctl" title={title}>
      {label}
      <input type="number" className="num" min={min} value={opts[k]} onChange={(e) => set({ [k]: Math.max(min, Math.round(Number(e.target.value) || 0)) })} />
    </label>
  )

  return (
    <section className="section reports">
      <header>
        <h2>Reports</h2>
        <span className="hint">the outputs of the mtkprof CLI for this trace, produced by the engine</span>
      </header>
      <ul className="report-list">
        {FORMATS.map((f) => (
          <li key={f.id}>
            <div>
              <b>{f.label}</b> <span className="muted small">.{f.ext}</span>
              <p className="small muted">{f.what}</p>
            </div>
            <span className="actions">
              <button onClick={() => go(f.id, false)} disabled={busy !== null}>
                {busy === f.id ? 'Saving…' : 'Save…'}
              </button>
              {f.id === 'html' && (
                <button onClick={() => go(f.id, true)} disabled={busy !== null} title="writes it to the app cache folder and opens it in the browser">
                  {busy === 'html:open' ? 'Opening…' : 'Open standalone HTML'}
                </button>
              )}
            </span>
            {f.id === 'text' && (
              <details className="rollout report-opts">
                <summary>
                  <b>Options</b> · sort {opts.sort} · top {opts.top} · {opts.execs < 0 ? 'all' : opts.execs} executions · {opts.binds} bind sets · width {opts.width} · SYS {opts.sys ? 'on' : 'off'}
                </summary>
                <div className="report-opts-body">
                <label className="pv-ctl">
                  Sort
                  <select value={opts.sort} onChange={(e) => set({ sort: e.target.value as TextOptions['sort'] })}>
                    {SORTS.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                {num('top', 0, 'Top', 'only the top N statements (0 = all)')}
                {num('execs', -1, 'Executions', 'executions listed per statement (0 = none, -1 = all); an aggregate session leaves them out')}
                {num('binds', 0, 'Bind sets', 'bind sets printed per statement (0 = none)')}
                {num('width', 0, 'Width', 'report width (below 80 = 120)')}
                <label className="check">
                  <input type="checkbox" checked={opts.sys} onChange={(e) => set({ sys: e.target.checked })} /> recursive SYS statements
                </label>
                <button className="quiet" onClick={() => setOpts(DEFAULTS)}>
                  Defaults
                </button>
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
      {msg && (
        <p className={msg.ok ? 'small muted' : 'callout report-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </section>
  )
}
