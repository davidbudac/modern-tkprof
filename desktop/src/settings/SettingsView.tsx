import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtBytes } from '@lib'
import { BACKUP_FILE_NAME, describeMerge, mergeBackup, parseBackup, serializeBackup } from '../backup'
import { useConnections } from '../connections'
import { pickTextFile, saveAs } from '../files'
import { library } from '../library/library'
import { getJSON, send, useEngine, type CacheList, type CacheWipe } from '../engine'
import { appInfo, appVersion, inTauri, openReleasesPage, pickFolder, type AppInfo } from '../platform'
import { BrandIcon } from '../branding/BrandIcon'
import { dirOf, titleOf } from '../workspace/traceSet'
import { useWorkspace, useWorkspaceState } from '../workspace/WorkspaceProvider'
import { openKV } from '../platform'
import { ago, fmtUptime } from '../time'
import { AssistantSection } from './AssistantSection'
import { BindSeg } from './BindSeg'
import { engineOptionsOf, sameEngineOptions, useSettings, type Theme } from './settings'
import { TrashIcon } from '../ui/icons'

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

const APP_PROTOCOL = 1

/** The cap is set in whole GiB: `20 GB`, not fmtBytes' `20.00 GB`. */
const fmtCap = (n: number) => (n > 0 && n % 2 ** 30 === 0 ? `${n / 2 ** 30} GB` : fmtBytes(n))

/** Settings, in the order of use: opening traces, appearance, the assistant, the engine (its settings, then its facts), the index cache, backup, about. */
export function SettingsView() {
  const { settings, update } = useSettings()
  const engine = useEngine()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [app, setApp] = useState('…')
  useEffect(() => {
    appInfo().then(setInfo, () => {})
  }, [engine.addr])
  useEffect(() => {
    appVersion().then(setApp, () => setApp('?'))
  }, [])
  const wanted = engineOptionsOf(settings)
  const pending = !sameEngineOptions(wanted, engine.options ?? {})

  return (
    <div className="page settings">
      <SettingsIndex />
      <div className="settings-body">
      <h1>Settings</h1>

      <section id="settings-opening" aria-labelledby="settings-opening-h">
        <h2 id="settings-opening-h">Opening traces</h2>
        <div className="field">
          <span className="label">Default bind values</span>
          <span className="row">
            <BindSeg value={settings.binds} onChange={(binds) => update({ binds })} />
            {settings.binds === 'redact' && (
              <input type="text" value={settings.salt} placeholder="salt (random per open when empty)" onChange={(e) => update({ salt: e.target.value })} aria-label="Redaction salt" />
            )}
          </span>
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.startEmpty} onChange={(e) => update({ startEmpty: e.target.checked })} />
          Start empty, without re-opening the last session's traces
        </label>
      </section>

      <section id="settings-appearance" aria-labelledby="settings-appearance-h">
        <h2 id="settings-appearance-h">Appearance</h2>
        <div className="field">
          <span className="label">Theme</span>
          <span className="seg" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} aria-pressed={settings.theme === t.id} onClick={() => update({ theme: t.id })}>
                {t.label}
              </button>
            ))}
          </span>
        </div>
      </section>

      <section id="settings-assistant" aria-labelledby="settings-assistant-h">
        <h2 id="settings-assistant-h">Assistant</h2>
        <AssistantSection />
      </section>

      <section id="settings-engine" aria-labelledby="settings-engine-h">
        <h2 id="settings-engine-h">Engine</h2>
        <p className="muted small">Cache location, cap and plan URL apply on restart.</p>
        <div className="field">
          <label htmlFor="cache-dir">Cache location</label>
          <span className="row">
            <input
              id="cache-dir"
              type="text"
              className="mono"
              value={settings.cacheDir ?? ''}
              placeholder={info?.defaultCacheDir ?? 'default'}
              onChange={(e) => update({ cacheDir: e.target.value.trim() || null })}
              spellCheck={false}
            />
            {inTauri && (
              <button
                onClick={() =>
                  void pickFolder('Index cache location').then((d) => d && update({ cacheDir: d }))
                }
              >
                Change…
              </button>
            )}
            <button disabled={!settings.cacheDir} onClick={() => update({ cacheDir: null })}>
              Default
            </button>
          </span>
          {info && <small className="muted mono">In use: {info.cacheDir}</small>}
        </div>
        <div className="field">
          <label htmlFor="cache-cap">Cap (GiB)</label>
          <span className="row">
            <input
              id="cache-cap"
              type="number"
              min={1}
              step={1}
              className="num"
              value={settings.cacheCapGB ?? ''}
              placeholder={engine.health ? String(Math.round(engine.health.cache.cap / 2 ** 30)) : ''}
              onChange={(e) => {
                const n = Number(e.target.value)
                update({ cacheCapGB: e.target.value === '' || !(n > 0) ? null : Math.round(n) })
              }}
            />
            <span className="muted small">Least recently used entries go first. Empty uses the engine's default</span>
          </span>
        </div>
        <div className="field">
          <label htmlFor="planviz">Plan visualizer URL</label>
          <input
            id="planviz"
            type="url"
            className="mono"
            value={settings.planVizUrl}
            placeholder="the engine's default"
            onChange={(e) => update({ planVizUrl: e.target.value })}
            spellCheck={false}
          />
        </div>
        <p className="row">
          <button className={pending ? 'primary' : undefined} disabled={engine.status === 'starting'} onClick={() => void engine.restart(wanted)}>
            Restart engine
          </button>
          {pending && <span className="small warn-text">Restart the engine to apply the changes. Open traces re-open from the cache.</span>}
        </p>
        <dl className="kv engine-facts" data-status={engine.status}>
          <dt>Version</dt>
          <dd className="mono">{engine.version ?? '–'} · protocol {engine.protocol ?? '–'} <span className="muted">(app speaks {APP_PROTOCOL})</span></dd>
          <dt>Binary</dt>
          <dd className="mono small">{info?.enginePath ?? '–'}</dd>
          <dt>Listening</dt>
          <dd className="mono small">{engine.addr ?? '–'}</dd>
          <dt>Status</dt>
          <dd className="engine-status">
            <span className="dot" aria-hidden />
            {engine.status}
            {engine.restarts > 0 && ` · ${engine.restarts} automatic restart${engine.restarts === 1 ? '' : 's'}`}
          </dd>
          <dt>Uptime</dt>
          <dd className="mono">{engine.health ? fmtUptime(engine.health.uptime) : '–'}</dd>
        </dl>
      </section>

      <section id="settings-cache" aria-labelledby="settings-cache-h">
        <h2 id="settings-cache-h">Index cache</h2>
        <CacheEntries />
      </section>

      <section id="settings-backup" aria-labelledby="settings-backup-h">
        <h2 id="settings-backup-h">Backup</h2>
        <BackupSection />
      </section>

      <section id="settings-about" aria-labelledby="settings-about-h">
        <details className="rollout about">
        <summary><h2 id="settings-about-h">About</h2><span className="muted small">mtkprof {app}</span></summary>
        <div className="about-brand"><BrandIcon className="brand-icon-about" motion="once" /><b>mtkprof</b></div>
        <p className="muted">Oracle SQL trace analyzer: the desktop app around the mtkprof engine.</p>
        <dl className="kv">
          <dt>App version</dt>
          <dd className="mono">{app}</dd>
          {info && (
            <>
              <dt>Settings and workspace</dt>
              <dd className="mono small">{info.dataDir}</dd>
              <dt>Logs</dt>
              <dd className="mono small">{info.logDir}</dd>
            </>
          )}
        </dl>
        <p className="row">
          <button onClick={() => void openReleasesPage()}>Releases page</button>
          <span className="muted small">New versions are published there; the app does not update itself.</span>
        </p>
        <p className="muted small">Licensed under the Apache License 2.0. © 2026 David Budac.</p>
        </details>
      </section>
      </div>
    </div>
  )
}

const SECTIONS = [
  { id: 'settings-opening', label: 'Opening traces' },
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-assistant', label: 'Assistant' },
  { id: 'settings-engine', label: 'Engine' },
  { id: 'settings-cache', label: 'Index cache' },
  { id: 'settings-backup', label: 'Backup' },
  { id: 'settings-about', label: 'About' },
]

/** How far below the scroller's top a section's heading may sit and still count as the one being read. */
const READ_LINE = 96

/** The nearest ancestor that scrolls (the frame's main area). */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/** The section index beside the page on wide windows (hidden by CSS otherwise); it marks the section being read. */
function SettingsIndex() {
  const ref = useRef<HTMLElement>(null)
  const [current, setCurrent] = useState(SECTIONS[0].id)
  /** a clicked entry stays marked while its scroll runs (and when the page ends before its section reaches the top), until the user scrolls */
  const pinned = useRef(false)
  useEffect(() => {
    const scroller = scrollerOf(ref.current)
    if (!scroller) return
    const unpin = () => { pinned.current = false }
    const spy = () => {
      if (pinned.current) return
      const top = scroller.getBoundingClientRect().top
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      let at = SECTIONS[0].id
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top - top <= READ_LINE) at = s.id
      }
      setCurrent(atEnd && scroller.scrollTop > 0 ? SECTIONS[SECTIONS.length - 1].id : at)
    }
    spy()
    scroller.addEventListener('scroll', spy, { passive: true })
    const user = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const t of user) scroller.addEventListener(t, unpin, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', spy)
      for (const t of user) scroller.removeEventListener(t, unpin)
    }
  }, [])
  const go = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    // About is a rollout: open it, as the engine menu does, so the section can reach the top
    const d = el.querySelector('details')
    if (d) d.open = true
    pinned.current = true
    setCurrent(id)
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  return (
    <nav ref={ref} className="settings-index" aria-label="Settings sections">
      {SECTIONS.map((s) => (
        <a key={s.id} href={`#${s.id}`} aria-current={current === s.id ? 'true' : undefined} onClick={(e) => { e.preventDefault(); go(s.id) }}>
          {s.label}
        </a>
      ))}
    </nav>
  )
}

const BACKUP_FILTER = [{ name: 'JSON', extensions: ['json'] }]

/** Portable backup plus explicitly selected investigation metadata. */
function BackupSection() {
  const cx = useConnections()
  const { settings, update } = useSettings()
  const { tabs } = useWorkspaceState()
  const ws = useWorkspace()
  const [references, setReferences] = useState<{ paths: string[] }[]>([])
  useEffect(() => { void openKV('investigation-backup.json').then(async (kv) => setReferences((await kv.get<{ paths: string[] }[]>('references')) ?? [])) }, [])
  const [include, setInclude] = useState({ annotations: false, settings: false, workspace: false })
  const running = useRef(false)
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = (f: () => Promise<string | null>) => {
    if (running.current) return
    running.current = true
    setWorking(true)
    void f().then(
      (text) => text && setMsg({ ok: true, text }),
      (e: unknown) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
    ).finally(() => { running.current = false; setWorking(false) })
  }
  const exportAll = async () => {
    const lib = await library.all()
    const conns = cx.entries.map(({ source: _, ...c }) => c)
    const archived = include.workspace ? (await (await openKV('investigation-backup.json')).get<{ paths: string[] }[]>('references')) ?? [] : []
    const investigation = Object.values(include).some(Boolean) ? {
      ...(include.annotations ? { annotations: await ws.exportInvestigationAnnotations() } : {}),
      ...(include.settings ? { settings: { theme: settings.theme, binds: settings.binds, startEmpty: settings.startEmpty } } : {}),
      ...(include.workspace ? { workspace: [...archived, ...tabs.filter((t) => t.origin === 'paths').map((t) => ({ paths: t.set.paths }))] } : {}),
    } : undefined
    const to = await saveAs(BACKUP_FILE_NAME, serializeBackup(conns, lib, investigation), BACKUP_FILTER, 'Export backup')
    return to ? `Exported ${conns.length} connection${conns.length === 1 ? '' : 's'} and ${lib.length} saved pivot${lib.length === 1 ? '' : 's'}.` : null
  }
  const importAll = async () => {
    const f = await pickTextFile(BACKUP_FILTER, 'Import connections and library')
    if (!f) return null
    const b = parseBackup(f.text)
    if (b.fatal) throw new Error(`Import of ${f.name} failed: ${b.fatal}`)
    const m = mergeBackup(cx.local, await library.all(), b)
    cx.replaceLocal(m.connections)
    await library.replaceAll(m.library)
    const i = b.investigation
    if (include.annotations && i?.annotations) await ws.importInvestigationAnnotations(i.annotations)
    if (include.settings && i?.settings) update(i.settings)
    if (include.workspace && i?.workspace) {
      const kv = await openKV('investigation-backup.json')
      const existing = (await kv.get<{ paths: string[] }[]>('references')) ?? []
      const unique = new Map([...existing, ...i.workspace].map((r) => [JSON.stringify(r.paths), r]))
      const refs = [...unique.values()]
      await kv.set('references', refs)
      setReferences(refs)
    }
    return describeMerge(m.counts, b) + (i ? ' Optional metadata imported only for checked categories. Workspace references are retained without opening traces.' : '')
  }
  return (
    <>
      <p className="muted small">
        A JSON file with the connection definitions and the saved Pivot configurations. Passwords and passphrases stay out; they are
        asked for on use. Importing merges by id: a connection is replaced, a saved pivot only when the imported one is newer.
      </p>
      <div className="checks" role="group" aria-label="Optional investigation metadata">
        <span className="label">Also export and import</span>
        <label className="check"><input type="checkbox" checked={include.annotations} onChange={(e) => setInclude({ ...include, annotations: e.target.checked })} />Notes and bookmarks (merge newer entries)</label>
        <label className="check"><input type="checkbox" checked={include.settings} onChange={(e) => setInclude({ ...include, settings: e.target.checked })} />Appearance and opening defaults</label>
        <label className="check"><input type="checkbox" checked={include.workspace} onChange={(e) => setInclude({ ...include, workspace: e.target.checked })} />Workspace path references (open manually after import)</label>
      </div>
      <p className="muted small">
        Notes and paths may contain sensitive information. Never included: raw traces, credentials, redaction salts, engine paths and URLs.
      </p>
      {references.length > 0 && <div>
        <h3>Imported workspace references</h3>
        <p className="muted small">Paths refer to the original computer. Open a reference explicitly using current bind defaults; missing files will report an error.</p>
        <ul>{references.map((ref) => <li key={JSON.stringify(ref.paths)}>
          <span className="mono small">{ref.paths.join(', ')}</span>{' '}
          <button onClick={() => ws.open({ paths: ref.paths, options: { binds: settings.binds, salt: settings.salt || undefined } })}>Open reference</button>
        </li>)}</ul>
      </div>}
      <span className="actions">
        <button disabled={working} onClick={() => run(exportAll)}>Export backup…</button>
        <button disabled={working} onClick={() => run(importAll)}>Import…</button>
        {msg && (
          <span className={msg.ok ? 'muted small' : 'warn-text small'} role="status">
            {msg.text}
          </span>
        )}
      </span>
    </>
  )
}

/** `GET /engine/cache` with Remove per entry and Wipe; open entries are kept. Its usage line, Refresh and Wipe sit in the Index cache section. */
function CacheEntries() {
  const { client, status } = useEngine()
  const [list, setList] = useState<CacheList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  const reload = useCallback(() => {
    if (!client) return
    getJSON<CacheList>(client, '/engine/cache').then(
      (l) => {
        setList(l)
        setError(null)
      },
      (e) => setError(String(e)),
    )
  }, [client])
  useEffect(() => {
    if (status === 'ready') reload()
  }, [status, reload])

  const remove = async (identity: string) => {
    if (!client) return
    try {
      await send(client, 'DELETE', `/engine/cache/${encodeURIComponent(identity)}`)
      setNote(null)
    } catch (e) {
      setNote(String(e))
    }
    reload()
  }
  const wipe = async () => {
    setConfirm(false)
    if (!client) return
    try {
      const w = await send<CacheWipe>(client, 'DELETE', '/engine/cache')
      setNote(`Removed ${w.removed.length} entr${w.removed.length === 1 ? 'y' : 'ies'} (${fmtBytes(w.bytes)})${w.skipped.length ? `; kept ${w.skipped.length} that an open trace uses` : ''}.`)
    } catch (e) {
      setNote(String(e))
    }
    reload()
  }

  return (
    <div className="cache-entries">
      <p className="row">
        <span className="usage-text">
          {list ? `${fmtBytes(list.bytes)} of ${fmtCap(list.cap)} in ${list.entries} entr${list.entries === 1 ? 'y' : 'ies'}` : 'Usage…'}
        </span>
        {list && list.cap > 0 && (
          <span className="usage-bar" role="img" aria-label={`${Math.round((100 * list.bytes) / list.cap)} % of the cap`}>
            <i style={{ inlineSize: `${Math.min(100, (100 * list.bytes) / list.cap)}%` }} />
          </span>
        )}
        <span className="spacer" />
        <button onClick={reload}>Refresh</button>
        {confirm ? (
          <>
            <button className="danger" onClick={() => void wipe()}>Wipe all entries</button>
            <button onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : (
          <button className="danger" onClick={() => setConfirm(true)} disabled={!list?.entries}>Wipe cache…</button>
        )}
      </p>
      {error && <p className="small warn-text">{error}</p>}
      {note && <p className="small muted">{note}</p>}
      {list && list.items.length > 0 && (
        <details className="rollout">
          <summary>{list.entries} entr{list.entries === 1 ? 'y' : 'ies'}</summary>
        <table className="cache-table">
          <thead>
            <tr>
              <th>Trace</th>
              <th className="num">Size</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...list.items]
              .sort((a, b) => Date.parse(b.lastUsed) - Date.parse(a.lastUsed))
              .map((it) => (
                <tr key={it.identity}>
                  <td>
                    <span className="cache-paths" title={it.paths.join('\n')}>
                      <span className="mono small">{it.paths.length ? titleOf(it.paths) : it.identity.slice(0, 16)}</span>
                      {it.paths.length > 0 && dirOf(it.paths[0]) && <small className="muted mono">{dirOf(it.paths[0])}</small>}
                    </span>
                    {it.open && <span className="badge info">open</span>}
                  </td>
                  <td className="num mono">{fmtBytes(it.bytes)}</td>
                  <td className="small" title={when(it.lastUsed)}>{ago(it.lastUsed) || it.lastUsed}</td>
                  <td>
                    <button className="quiet icon-btn" disabled={it.open} aria-label={`Remove ${it.paths.length ? titleOf(it.paths) : it.identity.slice(0, 16)} from the cache`}
                      title={it.open ? 'an open trace uses it' : 'remove this entry'} onClick={() => void remove(it.identity)}>
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        </details>
      )}
    </div>
  )
}
