// The mtkprof desktop shell (Electron main process): runs the `mtkprof-engine` sidecar
// (docs/PLAN-DESKTOP.md § 2 at the repository root), restarts it when it crashes and hands its
// address and token to the UI; serves the UI from `mtkprof://app` (an origin of its own, which
// the engine allows); takes trace files handed to the app; keeps the stores, the window state and
// the remembered assistant keys. The page reaches all of it through `preload.ts`
// (`window.mtkprof`) and the commands below, never Node itself.

import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EngineManager, type EngineOptions } from './engine'
import * as files from './files'
import { log } from './log'
import { installMenu } from './menu'
import { EVENT as OPEN_EVENT, OpenQueue, pathsOfArgs } from './open'
import { cacheDir, dataDir, isUnder, logDir, setElectronPaths } from './paths'
import { KeyCommands, Secrets } from './secrets'
import { storeDelete, storeFlush, storeLoad, storeSet } from './store'
import { checkForUpdate, RELEASES_URL } from './updates'
import { SafeStorageVault, tauriKeychain } from './vault'
import { loadWindowState, trackWindowState } from './windowstate'

const SCHEME = 'mtkprof'
const ORIGIN = `${SCHEME}://app`
/** `pnpm dev:app`: the Vite dev server instead of the built UI (unpackaged runs only, loopback only). */
const DEV_URL = !app.isPackaged ? devUrl(process.env.MTKPROF_DEV_URL) : null

function devUrl(u: string | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u)
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return url.origin
  } catch {
    // below
  }
  console.error(`MTKPROF_DEV_URL must be http://127.0.0.1:<port> or http://localhost:<port>, not ${u}`)
  return null
}

/** The page's own origin: the built UI, or the dev server in a dev run. */
function own(u: string): boolean {
  try {
    const url = new URL(u)
    // Node's URL gives a custom scheme the origin "null": compare scheme and host
    if (url.protocol === `${SCHEME}:` && url.host === 'app') return true
    return DEV_URL !== null && url.origin === DEV_URL
  } catch {
    return false
  }
}

/** Dev runs, or `MTKPROF_SMOKE=1`: the UI offers "Kill engine" and `engine_kill` works. */
const devTools = () => !app.isPackaged || process.env.MTKPROF_SMOKE === '1'

setElectronPaths()
// a packaged app takes no debugger: no fuse covers Chromium's remote debugging switches
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1)
}
// smoke screenshots: a window under others (or on another space) keeps painting, so a capture is current
if (process.env.MTKPROF_SMOKE_SHOTS && devTools()) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

let win: BrowserWindow | null = null

function emit(event: string, payload: unknown = null) {
  if (win && !win.isDestroyed()) win.webContents.send('mtkprof:event', event, payload)
}

function sidecar(): string {
  const name = `mtkprof-engine${process.platform === 'win32' ? '.exe' : ''}`
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name)
  const os = { darwin: 'mac', win32: 'win' }[process.platform as string] ?? process.platform
  return path.join(app.getAppPath(), 'binaries', `${os}-${process.arch}`, name)
}

const engine = new EngineManager({
  sidecar: sidecar(),
  defaultCacheDir: path.join(cacheDir(), 'mtkprof'),
  allowOrigins: DEV_URL ? [ORIGIN, 'http://127.0.0.1:5173', 'http://localhost:5173'].join(',') : ORIGIN,
  emit,
})
const keys = new KeyCommands(
  new Secrets(new SafeStorageVault(), (m) => log.warn(m)),
  () => engine.endpoint(),
  tauriKeychain(),
)
const opens = new OpenQueue()

// ---- trace files handed to the app ----

function focus() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Queues one trace set and tells the UI; brings the window to the front. */
function requestOpen(paths: string[]) {
  if (!opens.push(paths)) return
  log.info(`open request: ${JSON.stringify(paths)}`)
  emit(OPEN_EVENT)
  focus()
}

/** argv without the program (and, in a dev run, without the main script). */
const argsOf = (argv: string[]) => argv.slice(app.isPackaged ? 1 : 2)

if (!app.requestSingleInstanceLock()) {
  // a second launch: the first one takes its argv (`second-instance`) and this one ends here
  app.exit(0)
}

// a second launch focuses the running window instead of starting another engine, and hands over
// the trace files on its command line
app.on('second-instance', (_e, argv, cwd) => {
  focus()
  requestOpen(pathsOfArgs(argsOf(argv), cwd))
})

// Finder double-click, "Open With", a drop on the Dock icon, `open -a mtkprof …`: one event per
// file, gathered into one trace set when they come together
let opened: string[] = []
let openedTimer: NodeJS.Timeout | null = null
app.on('open-file', (e, p) => {
  e.preventDefault()
  opened.push(p)
  if (openedTimer) clearTimeout(openedTimer)
  openedTimer = setTimeout(() => {
    const set = opened
    opened = []
    requestOpen(set)
  }, 150)
})

// ---- the UI ----

const dist = () => path.join(app.getAppPath(), 'dist')

const CSP = [
  "default-src 'self'",
  // the engine: its port changes with every start
  "connect-src 'self' http://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ')

/** `mtkprof://app/<path>`: the files of `dist/`; anything else is index.html. */
function serveUI() {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url)
    if (url.host !== 'app') return new Response('not found', { status: 404 })
    const root = dist()
    let rel: string
    try {
      rel = decodeURIComponent(url.pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    let file = path.join(root, rel)
    if (!isUnder(file, root)) return new Response('not found', { status: 404 })
    if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    const r = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(r.headers)
    headers.set('Content-Security-Policy', CSP)
    return new Response(r.body, { status: r.status, headers })
  })
}

/** An http(s) link to hand to the system browser, re-serialized; null for anything else. */
function webLink(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 200_000) return null
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function createWindow() {
  const saved = loadWindowState()
  win = new BrowserWindow({
    title: 'mtkprof',
    width: saved?.width ?? 1400,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: !(process.env.MTKPROF_SMOKE_SHOTS && devTools()),
    },
  })
  if (saved?.maximized) win.maximize()
  trackWindowState(win)
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

  const wc = win.webContents
  // a web link that would open a new window goes to the system browser; nothing else opens one
  wc.setWindowOpenHandler(({ url }) => {
    const link = webLink(url)
    if (link) void shell.openExternal(link)
    return { action: 'deny' }
  })
  // the page never navigates away (a file dropped outside the drop handling would load it)
  wc.on('will-navigate', (e, url) => {
    if (own(url)) return
    e.preventDefault()
    const link = webLink(url)
    if (link) void shell.openExternal(link)
  })
  // a reload or a crash ends the page's open writes
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) files.abortWrites()
  })
  wc.on('render-process-gone', (_e, d) => {
    files.abortWrites()
    log.error(`the page's process is gone: ${d.reason} (code ${d.exitCode})`)
  })
  void win.loadURL(DEV_URL ?? `${ORIGIN}/`)
}

// ---- commands ----

type Args = Record<string, unknown>

/** The engine options as the page sends them (settings), checked: they become the engine's flags. */
function engineOptions(o: unknown): EngineOptions | undefined {
  if (o === undefined || o === null) return undefined
  if (typeof o !== 'object') throw new Error('engine options: not an object')
  const { cacheDir: dir, cacheCap: cap, planVizUrl: viz } = o as Record<string, unknown>
  const out: EngineOptions = {}
  if (dir !== undefined && dir !== null) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0') || dir.length > 1024) throw new Error(`engine options: cache dir must be an absolute path: ${dir}`)
    out.cacheDir = dir
  }
  if (cap !== undefined && cap !== null) {
    if (typeof cap !== 'string' || !/^\d{1,6}[KMGT]?$/.test(cap)) throw new Error(`engine options: cache cap like 20G: ${cap}`)
    out.cacheCap = cap
  }
  if (viz !== undefined && viz !== null) {
    if (typeof viz !== 'string' || (viz !== '' && webLink(viz) === null)) throw new Error(`engine options: plan viz URL must be http(s): ${viz}`)
    out.planVizUrl = viz
  }
  return out
}
type Command = (a: Args) => unknown

function dialogFilters(f: unknown): Electron.FileFilter[] | undefined {
  if (!Array.isArray(f)) return undefined
  return f.map((x: { name?: unknown; extensions?: unknown }) => ({
    name: String(x?.name ?? ''),
    extensions: Array.isArray(x?.extensions) ? x.extensions.map(String) : ['*'],
  }))
}

const commands: Record<string, Command> = {
  engine_start: (a) => engine.start(engineOptions(a.opts)),
  engine_stop: () => engine.stop(),
  engine_restart: (a) => engine.restart(engineOptions(a.opts)),
  engine_status: () => engine.status(),
  engine_kill: () => {
    if (!devTools()) throw new Error('engine_kill is available in dev runs and smoke runs only')
    engine.kill()
  },
  engine_dev_tools: () => devTools(),

  app_version: () => app.getVersion(),
  app_info: () => ({
    cacheDir: engine.cacheDir(),
    defaultCacheDir: path.join(cacheDir(), 'mtkprof'),
    enginePath: sidecar(),
    dataDir: dataDir(),
    logDir: logDir(),
    smokeOpen: devTools() ? process.env.MTKPROF_SMOKE_OPEN || null : null,
  }),
  open_releases_page: () => shell.openExternal(RELEASES_URL),
  // only http(s), so a page can't launch local files or apps
  open_external_url: async (a) => {
    const url = webLink(a.url)
    if (!url) throw new Error(`not a web link: ${String(a.url).slice(0, 200)}`)
    await shell.openExternal(url)
    log.info(`opened a web link (${url.length} chars)`)
  },
  take_open_requests: () => opens.take(),
  update_check: () => checkForUpdate(),
  relaunch: () => {
    app.relaunch()
    app.quit()
  },
  log: (a) => {
    const m = typeof a.message === 'string' ? a.message : String(a.message ?? '')
    if (a.level === 'warn') log.warn(m, 'webview')
    else if (a.level === 'error') log.error(m, 'webview')
    else log.info(m, 'webview')
    if (m.startsWith('session ready')) smokeShot()
  },

  assist_key_answer: (a) => keys.answer(a.promptId, a.provider),
  assist_key_store_and_answer: (a) => keys.storeAndAnswer(a.promptId, a.provider, a.key, a.remember),
  assist_key_forget: (a) => keys.forget(a.provider),

  store_load: (a) => storeLoad(String(a.name)),
  store_set: (a) => storeSet(String(a.name), String(a.key), a.value),
  store_delete: (a) => storeDelete(String(a.name), String(a.key)),

  // a picked file may be read (open) or written (save) by the page for the rest of the run
  dialog_open: async (a) => {
    const directory = a.directory === true
    const props: Electron.OpenDialogOptions['properties'] = [directory ? 'openDirectory' : 'openFile']
    if (a.multiple === true) props.push('multiSelections')
    const r = await dialog.showOpenDialog(win!, {
      title: typeof a.title === 'string' ? a.title : undefined,
      properties: props,
      filters: directory ? undefined : dialogFilters(a.filters),
    })
    if (r.canceled || !r.filePaths.length) return null
    if (!directory) r.filePaths.forEach(files.allowRead)
    return r.filePaths
  },
  dialog_save: async (a) => {
    const name = typeof a.defaultName === 'string' ? path.basename(a.defaultName) : undefined
    const r = await dialog.showSaveDialog(win!, {
      title: typeof a.title === 'string' ? a.title : undefined,
      defaultPath: name ? path.join(app.getPath('downloads'), name) : undefined,
      filters: dialogFilters(a.filters),
    })
    if (r.canceled || !r.filePath) return null
    files.allowWrite(r.filePath)
    return r.filePath
  },
  allow_team_file: (a) => files.allowTeamFile(a.path),
  fs_read_text: (a) => files.readText(a.path),
  write_begin: (a) => files.writeBegin(a.target as files.WriteTarget),
  write_chunk: (a) => files.writeChunk(a.id, a.chunk),
  write_end: (a) => files.writeEnd(a.id, a.ok),
  cache_folder: (a) => files.cacheFolderPath(a.dir),
  cache_exists: (a) => files.cacheExists(a.dir, a.name),
  cache_list: (a) => files.cacheList(a.dir),
  cache_remove: (a) => files.cacheRemove(a.dir, a.name),
  open_report: (a) => files.openReport(a.path),
}

/** Only the app's own page may call: its main frame, of its own origin, in the app window. */
function trusted(e: IpcMainInvokeEvent): boolean {
  const f = e.senderFrame
  return e.sender === win?.webContents && !!f && f === e.sender.mainFrame && own(f.url)
}

/** Every command answers `{ok, value}` or `{ok: false, error}`: the page rejects with the message alone, as Tauri's invoke did. */
ipcMain.handle('mtkprof:invoke', async (e, cmd: unknown, args: unknown) => {
  if (!trusted(e)) return { ok: false, error: 'not the app window' }
  const f = typeof cmd === 'string' && Object.hasOwn(commands, cmd) ? commands[cmd] : undefined
  if (!f) return { ok: false, error: `unknown command ${String(cmd)}` }
  try {
    return { ok: true, value: (await f((args ?? {}) as Args)) ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// ---- life cycle ----

/**
 * CI smoke runs (`MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=<seconds>`) kill the engine once, that
 * many seconds after it first reports ready, so a screenshot after it shows the automatic restart.
 */
async function smokeKill() {
  const secs = Number.parseInt(process.env.MTKPROF_SMOKE_KILL_AFTER ?? '', 10)
  if (!devTools() || !Number.isFinite(secs)) return
  for (let i = 0; i < 120 && !engine.running(); i++) await new Promise((r) => setTimeout(r, 500))
  await new Promise((r) => setTimeout(r, secs * 1000))
  try {
    engine.kill()
  } catch (e) {
    log.error(`smoke: kill engine: ${e}`)
  }
}

/**
 * `MTKPROF_SMOKE_SHOTS=<dir>` (smoke runs): the window as a PNG 3 s after each "session ready",
 * `<dir>/session-<n>.png` (the first is the fixture's Overview, the second the re-open after the
 * engine restart). The window's own pixels, whatever else is on the screen.
 */
let shots = 0
function smokeShot() {
  const dir = devTools() ? process.env.MTKPROF_SMOKE_SHOTS : undefined
  if (!dir) return
  const n = ++shots
  setTimeout(async () => {
    try {
      const img = await win?.webContents.capturePage()
      if (!img) return
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `session-${n}.png`), img.toPNG())
      const toasts = await win?.webContents.executeJavaScript(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`)
      log.info(`smoke: screenshot session-${n}.png; toasts: ${toasts || '(none)'}`)
    } catch (e) {
      log.warn(`smoke: screenshot: ${e}`)
    }
  }, 3_000)
}

// every webContents (the window, any later one): no <webview>, no new windows
app.on('web-contents-created', (_e, c) => {
  c.on('will-attach-webview', (ev) => ev.preventDefault())
  c.setWindowOpenHandler(({ url }) => {
    const link = webLink(url)
    if (link) void shell.openExternal(link)
    return { action: 'deny' }
  })
})

/** The page may write to the clipboard (Copy buttons); every other permission (camera, location, notifications, …) is refused. */
function permissions() {
  const allowed = new Set(['clipboard-sanitized-write'])
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, perm, cb, d) => cb(allowed.has(perm) && own(d.requestingUrl)))
  ses.setPermissionCheckHandler((_wc, perm, origin) => allowed.has(perm) && own(origin))
}

void app.whenReady().then(() => {
  log.info(`mtkprof ${app.getVersion()} (Electron ${process.versions.electron}) starting`)
  files.adoptTeamFile(storeLoad('connections.json').teamPath)
  permissions()
  serveUI()
  installMenu(() => win, (ev) => emit(ev))
  createWindow()
  requestOpen(pathsOfArgs(argsOf(process.argv), process.cwd()))
  void smokeKill()
})

// the app ends with its window, on macOS too (as the Tauri shell did)
app.on('window-all-closed', () => app.quit())

let stopped = false
app.on('will-quit', (e) => {
  storeFlush()
  if (stopped) return
  e.preventDefault()
  // the engine also exits on its own when our end of its stdin closes
  void engine.stop().finally(() => {
    stopped = true
    app.quit()
  })
})
