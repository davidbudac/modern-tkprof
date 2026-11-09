import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AUTH_LABEL, KINDS, formatHeaders, keyMoved, needsKey, newProviderId, parseHeaders, testProvider, validateProvider,
  type AssistProvider, type ProviderAuth, type ProviderKind, type TestResult,
} from '../assist/providers'
import { assistKeyForget, getJSON, send, useEngine, type Schemas } from '../engine'
import { inApp } from '../platform'
import type { Tab } from '../workspace/workspace'
import { useWorkspaceState } from '../workspace/WorkspaceProvider'
import { McpSection } from './McpSection'
import { BindPreview, Card, Row, SubHead, Switch } from './parts'
import { useSettings, type AssistBinds } from './settings'

type Backend = Schemas['BackendInfo']
type Status = { running: true } | (TestResult & { running?: false })

const BINDS: { id: AssistBinds; label: string; title: string }[] = [
  { id: 'mask', label: 'Mask', title: 'Each bind value as its type, length and a hash' },
  { id: 'keep', label: 'Keep', title: 'The bind values as traced' },
]

/** The longest a test may take (a codex turn takes about half a minute). */
const TEST_TIMEOUT_MS = 120_000

/** The trace a test runs on: the tab Settings was opened from, else the first open one. */
function testTab(tabs: Tab[], origin: { kind: string; key?: string } | undefined): Tab | undefined {
  const usable = (t: Tab) => !!t.sessionId && (t.state === 'ready' || t.state === 'live')
  const from = origin?.kind === 'tab' ? tabs.find((t) => t.key === origin.key) : undefined
  return from && usable(from) ? from : tabs.find(usable)
}

const where = (p: AssistProvider) => (KINDS[p.kind].http ? p.baseUrl : `the ${p.kind} CLI`) + (p.model ? ` · ${p.model}` : '')

function statusText(p: AssistProvider, s: Status): string {
  if (s.running) return needsKey(p) ? 'Testing… (a key prompt shows when no key is held)' : 'Testing…'
  if (s.ok) return `Passed in ${(s.ms / 1000).toFixed(1)} s${s.text ? `: “${s.text.length > 80 ? s.text.slice(0, 80) + '…' : s.text}”` : ''}`
  if (s.code === 'auth' && needsKey(p)) return `The provider refused the key, so it was forgotten: Test again to enter another one. (${s.message})`
  if (s.code === 'no_key') return 'No key was entered.'
  return s.message
}

/** Settings → Assistant: the privacy defaults, the model providers with Test, and the CLI agents found. */
export function AssistantSection() {
  const { settings, update } = useSettings()
  const { client, status } = useEngine()
  const { tabs, origin } = useWorkspaceState()
  const providers = settings.assistProviders
  const [form, setForm] = useState<{ prev?: AssistProvider } | null>(null)
  const [tests, setTests] = useState<Record<string, Status>>({})
  const [note, setNote] = useState<string | null>(null)
  const [backends, setBackends] = useState<Backend[] | null>(null)
  const [backendsError, setBackendsError] = useState<string | null>(null)
  const running = useRef(new Map<string, AbortController>())
  const tab = testTab(tabs, origin)

  const reload = useCallback(() => {
    if (!client) return
    setBackends(null)
    getJSON<Schemas['BackendList']>(client, '/engine/assist/backends').then(
      (l) => {
        setBackends(l.backends)
        setBackendsError(null)
      },
      (e) => setBackendsError(String(e)),
    )
  }, [client])
  useEffect(() => {
    if (status === 'ready') reload()
  }, [status, reload])
  useEffect(() => () => running.current.forEach((c) => c.abort()), [])

  const forgetKey = async (id: string) => {
    if (client) await send(client, 'DELETE', `/engine/assist/providers/${encodeURIComponent(id)}/key`).catch((e) => console.warn('forget key:', String(e)))
    if (inApp) await assistKeyForget(id).catch((e) => console.warn('forget key:', String(e)))
  }

  const test = async (p: AssistProvider) => {
    if (!client || !tab?.sessionId || running.current.has(p.id)) return
    const ctl = new AbortController()
    running.current.set(p.id, ctl)
    const timer = setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS)
    setTests((t) => ({ ...t, [p.id]: { running: true } }))
    const r = await testProvider(client, tab.sessionId, p, ctl.signal)
    clearTimeout(timer)
    running.current.delete(p.id)
    if (!r.ok && r.code === 'auth' && needsKey(p)) await forgetKey(p.id)
    setTests((t) => ({ ...t, [p.id]: r }))
  }

  const save = (next: AssistProvider, prev?: AssistProvider) => {
    if (prev && keyMoved(prev, next)) void forgetKey(prev.id)
    update({ assistProviders: prev ? providers.map((x) => (x.id === prev.id ? next : x)) : [...providers, next] })
    setTests(({ [next.id]: _, ...rest }) => rest)
    setForm(null)
  }
  const remove = (p: AssistProvider) => {
    running.current.get(p.id)?.abort()
    void forgetKey(p.id)
    update({ assistProviders: providers.filter((x) => x.id !== p.id) })
  }
  const experimental = (k: ProviderKind) => backends?.find((b) => b.kind === k)?.experimental
  const cli = backends?.filter((b) => b.command) ?? []

  return (
    <>
      <Card>
        <Row
          label="Bind values sent"
          desc="What the assistant's tools send of each bind value. Masked hashes are salted per conversation; SQL text, literals included, is sent as traced"
          extra={<BindPreview mode={settings.assistBinds} />}
        >
          <span className="seg" role="group" aria-label="Assistant bind values">
            {BINDS.map((b) => (
              <button key={b.id} aria-pressed={settings.assistBinds === b.id} title={b.title} onClick={() => update({ assistBinds: b.id })}>
                {b.label}
              </button>
            ))}
          </span>
        </Row>
        <Row
          label="Ask before moving the view"
          htmlFor="assist-ask"
          desc="When you ask the assistant to show something, it moves the views there and the chat offers Back. With this on, it offers a chip in the chat and the views stay until you click it"
        >
          <Switch id="assist-ask" checked={settings.assistAskBeforeMoving} onChange={(assistAskBeforeMoving) => update({ assistAskBeforeMoving })} />
        </Row>
        <div className="set-foot">
          Nothing about a trace is sent until you agree, once per trace and provider.{' '}
          {inApp
            ? 'An API key is asked for on first use; Remember in keychain keeps it in the OS keychain, where the app reads it itself. It never enters this page, a file or a backup.'
            : 'An API key is asked for on first use and kept in the engine’s memory until it stops (the dev browser has no keychain).'}
        </div>
      </Card>

      <SubHead title="Providers" desc="Model providers the assistant panel can talk to. Keys are not stored here; they are asked for on use">
        {!form && <button onClick={() => setForm({})}>Add provider…</button>}
      </SubHead>
      {(providers.length > 0 || form) && (
        <Card>
          {providers.map((p) => {
            const s = tests[p.id]
            return (
              <div key={p.id} className="set-row provider" aria-label={p.name}>
                <div className="set-text">
                  <span className="set-label">
                    {p.name}
                    <span className="badge">{KINDS[p.kind].label}</span>
                    {experimental(p.kind) && <span className="badge experimental">Experimental</span>}
                  </span>
                  <span className="set-desc"><span className="mono">{where(p)}</span> · {AUTH_LABEL[p.auth]}</span>
                </div>
                <div className="set-control">
                  <button disabled={!tab || s?.running} onClick={() => void test(p)}>Test</button>
                  {needsKey(p) && (
                    <button onClick={() => void forgetKey(p.id).then(() => setNote(`Forgot the key of ${p.name}: the next use asks for it again.`))}>
                      Forget key
                    </button>
                  )}
                  <button onClick={() => setForm({ prev: p })}>Edit</button>
                  <button className="quiet" onClick={() => remove(p)}>Remove</button>
                </div>
                {s && (
                  <p className={'set-extra small ' + (s.running ? 'muted' : s.ok ? 'ok-text' : 'warn-text')} role="status">
                    {statusText(p, s)}
                  </p>
                )}
              </div>
            )
          })}
          {form && <ProviderForm key={form.prev?.id ?? 'new'} prev={form.prev} onSave={save} onCancel={() => setForm(null)} />}
          {note && <div className="set-note muted" role="status">{note}</div>}
          {providers.length > 0 && (
            <div className="set-foot">
              {tab
                ? `Test sends one short message through a conversation on ${tab.title}: the provider sees the trace's file names and may call the analysis tools (bind values masked). A CLI test runs one turn of the CLI (Codex: about 70–90k input tokens).`
                : 'Open a trace to test a provider: the test runs one short conversation on it.'}
            </div>
          )}
        </Card>
      )}

      <SubHead title="CLI agents" desc="The claude and codex commands on the engine's PATH, with their own login. They run with mtkprof's tools only">
        <button onClick={reload} disabled={backends === null && !backendsError}>Refresh</button>
      </SubHead>
      <Card>
        {backendsError && <div className="set-note warn-text">{backendsError}</div>}
        <table className="cache-table cli-table" aria-label="CLI agents">
          <thead>
            <tr>
              <th>CLI</th>
              <th>Version</th>
              <th>Login</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {backends === null && !backendsError && (
              <tr>
                <td colSpan={4} className="muted">Checking…</td>
              </tr>
            )}
            {backends !== null && cli.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">Neither claude nor codex is on the engine's PATH</td>
              </tr>
            )}
            {cli.map((b) => (
              <tr key={b.kind}>
                <td>
                  <span className="cli-name"><span className={'cli-dot' + (b.error || !b.loggedIn ? ' off' : '')} aria-hidden />{b.command}</span>
                  {b.experimental && <span className="badge experimental">Experimental</span>}
                </td>
                <td className="mono small">{b.version ?? '–'}</td>
                <td className="small">
                  {b.error ? <span className="warn-text">{b.error}</span> : b.loggedIn ? `logged in${b.login ? ` · ${b.login}` : ''}` : <span className="warn-text">{b.login || 'not logged in'}</span>}
                </td>
                <td className="mono small">{b.path ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <McpSection binds={settings.assistBinds} />
    </>
  )
}

interface Draft {
  kind: ProviderKind
  name: string
  auth: ProviderAuth
  baseUrl: string
  model: string
  headers: string
}

const blank: Draft = { kind: 'openai', name: '', auth: 'bearer', baseUrl: '', model: '', headers: '' }

/** Add or edit a provider. There is no key field: the key is asked for when the provider is used. */
function ProviderForm({ prev, onSave, onCancel }: { prev?: AssistProvider; onSave(p: AssistProvider, prev?: AssistProvider): void; onCancel(): void }) {
  const [d, setD] = useState<Draft>(() =>
    prev ? { kind: prev.kind, name: prev.name, auth: prev.auth, baseUrl: prev.baseUrl ?? '', model: prev.model ?? '', headers: formatHeaders(prev.headers) } : blank,
  )
  const [problems, setProblems] = useState<string[]>([])
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const k = KINDS[d.kind]

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const h = k.http ? parseHeaders(d.headers) : { headers: {}, problems: [] }
    const id = prev?.id ?? newProviderId()
    const raw = { id, kind: d.kind, name: d.name.trim() || k.label, auth: d.auth, model: d.model, ...(k.http ? { baseUrl: d.baseUrl, headers: h.headers } : {}) }
    const { provider, problems: p } = validateProvider(raw)
    const errs = [...h.problems, ...p.map((x) => x.replace(/^provider: /, ''))]
    if (!provider || errs.length) return setProblems(errs)
    onSave(provider, prev)
  }

  return (
    <form className="assist-form" onSubmit={submit} autoComplete="off" aria-label={prev ? `Edit ${prev.name}` : 'Add a provider'}>
      <div className="field">
        <span className="label">Kind</span>
        <span className="seg" role="group" aria-label="Provider kind">
          {(Object.keys(KINDS) as ProviderKind[]).map((id) => (
            <button type="button" key={id} aria-pressed={d.kind === id} onClick={() => set({ kind: id, auth: KINDS[id].auth[0] })}>
              {KINDS[id].label}
            </button>
          ))}
        </span>
      </div>
      <div className="field">
        <label htmlFor="assist-name">Name</label>
        <input id="assist-name" type="text" value={d.name} placeholder={k.label} onChange={(e) => set({ name: e.target.value })} autoFocus />
      </div>
      {k.http && (
        <div className="field">
          <label htmlFor="assist-url">Base URL</label>
          <input id="assist-url" type="url" className="mono" value={d.baseUrl} placeholder="http://localhost:11434/v1" onChange={(e) => set({ baseUrl: e.target.value })} spellCheck={false} />
          <small className="muted">Up to the version; /chat/completions is appended.</small>
        </div>
      )}
      <div className="field">
        <label htmlFor="assist-model">Model</label>
        <input id="assist-model" type="text" className="mono" value={d.model} placeholder={k.http ? 'required' : "the CLI's default"} onChange={(e) => set({ model: e.target.value })} spellCheck={false} />
      </div>
      {k.auth.length > 1 && (
        <div className="field">
          <span className="label">{d.kind === 'codex' ? 'Sign-in' : 'Key'}</span>
          <span className="seg" role="group" aria-label="Authentication">
            {k.auth.map((a) => (
              <button type="button" key={a} aria-pressed={d.auth === a} onClick={() => set({ auth: a })}>
                {d.kind === 'codex' && a === 'bearer' ? 'OpenAI API key' : AUTH_LABEL[a]}
              </button>
            ))}
          </span>
          {d.auth === 'bearer' && <small className="muted">Asked for on first use{inApp ? '; it can be remembered in the keychain' : ''}.</small>}
        </div>
      )}
      {k.http && (
        <div className="field">
          <label htmlFor="assist-headers">Extra headers</label>
          <textarea id="assist-headers" className="mono" rows={2} value={d.headers} placeholder="X-Team: dba" onChange={(e) => set({ headers: e.target.value })} spellCheck={false} />
          <small className="muted">Name: value per line. No credentials here: the key is asked for in the key prompt.</small>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="small warn-text" role="alert">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <span className="actions">
        <button type="submit" className="primary">{prev ? 'Save' : 'Add'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  )
}
