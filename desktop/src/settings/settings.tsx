import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { openKV } from '../platform'
import type { EngineOptions } from '../engine'
import { parseProviders, type AssistProvider } from '../assist/providers'

export type BindMode = 'keep' | 'redact' | 'none'
/** what the assistant's tools send of the bind values */
export type AssistBinds = 'mask' | 'keep'
export type Theme = 'system' | 'light' | 'dark'

/** The app's settings, one key each in `settings.json` (store plugin, app data dir). */
export interface Settings {
  /** index cache directory; null = `<app cache dir>/mtkprof` */
  cacheDir: string | null
  /** index cache cap in GiB (the engine's `-cache-cap NG`); null = the engine's default */
  cacheCapGB: number | null
  /** defaults of the open options */
  binds: BindMode
  salt: string
  /** do not re-open last run's traces on start */
  startEmpty: boolean
  /** plan visualizer URL for the engine's plan links; '' = the engine's default */
  planVizUrl: string
  theme: Theme
  /** the assistant's model providers (no keys: those are asked on use) */
  assistProviders: AssistProvider[]
  assistBinds: AssistBinds
  /** an intent of the assistant (the show tool) waits as a chip in the chat until it is clicked, instead of moving the views at once */
  assistAskBeforeMoving: boolean
}

export const defaults: Settings = {
  cacheDir: null,
  cacheCapGB: null,
  binds: 'keep',
  salt: '',
  startEmpty: false,
  planVizUrl: '',
  theme: 'system',
  assistProviders: [],
  assistBinds: 'mask',
  assistAskBeforeMoving: false,
}

/** What `engine_start`/`engine_restart` get from the settings. */
export function engineOptionsOf(s: Settings): EngineOptions {
  const o: EngineOptions = {}
  if (s.cacheDir) o.cacheDir = s.cacheDir
  if (s.cacheCapGB && s.cacheCapGB > 0) o.cacheCap = `${s.cacheCapGB}G`
  if (s.planVizUrl.trim()) o.planVizUrl = s.planVizUrl.trim()
  return o
}

export const sameEngineOptions = (a: EngineOptions | undefined, b: EngineOptions | undefined) =>
  (a?.cacheDir ?? '') === (b?.cacheDir ?? '') &&
  (a?.cacheCap ?? '') === (b?.cacheCap ?? '') &&
  (a?.planVizUrl ?? '') === (b?.planVizUrl ?? '')

const FILE = 'settings.json'

async function loadSettings(): Promise<Settings> {
  const kv = await openKV(FILE)
  const s: Settings = { ...defaults }
  for (const k of Object.keys(defaults) as (keyof Settings)[]) {
    const v = await kv.get(k)
    if (v !== undefined && v !== null && typeof v === typeof defaults[k]) (s as unknown as Record<string, unknown>)[k] = v
    else if (v !== undefined && defaults[k] === null) (s as unknown as Record<string, unknown>)[k] = v
  }
  const p = parseProviders(s.assistProviders)
  if (p.problems.length) console.warn('settings: assistant providers:', p.problems.join('; '))
  s.assistProviders = p.providers
  if (s.assistBinds !== 'mask' && s.assistBinds !== 'keep') s.assistBinds = defaults.assistBinds
  return s
}

/** Applies the theme to the document (the lib's tokens follow `data-theme`, or the system without it). */
function applyTheme(t: Theme) {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
}

interface SettingsApi {
  settings: Settings
  update(patch: Partial<Settings>): void
}

const Ctx = createContext<SettingsApi | null>(null)

/** Loads the settings before rendering `children` (the engine starts with them). */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    loadSettings().then(setSettings, (e) => {
      console.error('settings:', e)
      setSettings({ ...defaults })
    })
  }, [])
  useEffect(() => {
    if (settings) applyTheme(settings.theme)
  }, [settings?.theme])
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    void openKV(FILE).then(async (kv) => {
      for (const [k, v] of Object.entries(patch)) await kv.set(k, v)
    })
  }, [])
  const value = useMemo(() => (settings ? { settings, update } : null), [settings, update])
  if (!value) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsApi {
  const s = useContext(Ctx)
  if (!s) throw new Error('no SettingsProvider above this component')
  return s
}
