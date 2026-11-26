// The app's updates (DESIGN § Desktop app, Updates). The check asks GitHub for the newest release,
// compares it with the app's version and reads that release's latest.json (scripts/update-feed.mjs):
// the signed download of this platform. The download is hashed as it arrives and its minisign
// signature checked against the updater key built in (updatesig.ts): the file, its name for this
// platform and the offered version must all be signed. Then the install, per kind:
//   mac       swaps the .app bundle (extracted next to it, so the renames stay on one volume)
//   appimage  replaces the running AppImage ($APPIMAGE)
//   deb       pkexec dpkg -i (the package `mtkprof`)
//   nsis      runs the installer silently; it starts the app again (never run on Windows yet)
// and relaunches the app. Where none applies (a dev build, a translocated app, a disk image, a
// folder the user cannot write, a release without latest.json or without this platform), the
// update is offered as "Download": the release page.
// The page names nothing: it asks to check, download and install; the URL, the file and the
// version stay here.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { access, chmod, constants, copyFile, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { app, net } from 'electron'
import { log } from './log'
import { newHash, verifySignature } from './updatesig'

export const RELEASES_URL = 'https://github.com/davidbudac/modern-tkprof/releases'
const LATEST = 'https://api.github.com/repos/davidbudac/modern-tkprof/releases/latest'
const feedUrl = (tag: string) => `${RELEASES_URL}/download/${tag}/latest.json`
/** temporary folders of downloads and of a macOS swap; removed on the next start */
const STAGE = 'mtkprof-update-'

export interface Available {
  version: string
  currentVersion: string
  date?: string
  /** the app installs it itself; false: "Download" opens the release page (`why`) */
  installs: boolean
  why?: string
}

/** `a` is a newer `X.Y.Z` than `b`. */
export function newer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [p(a), p(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

export type How =
  | { kind: 'mac'; bundle: string; feedKey: string; arch: 'aarch64' | 'x64' }
  | { kind: 'appimage'; file: string; feedKey: string }
  | { kind: 'deb'; feedKey: string }
  | { kind: 'nsis'; feedKey: string }

/** The artifact this install takes, by the name the signature must carry. */
export function artifactName(how: How, version: string): string {
  switch (how.kind) {
    case 'mac':
      return `mtkprof_${version}_${how.arch}.app.tar.gz`
    case 'appimage':
      return `mtkprof_${version}_amd64.AppImage`
    case 'deb':
      return `mtkprof_${version}_amd64.deb`
    case 'nsis':
      return `mtkprof_${version}_x64-setup.exe`
  }
}

/** The feed's entry for this install, or why there is none. */
export function feedEntry(feed: unknown, how: How, version: string): { url: string; signature: string } | string {
  const f = feed as { version?: unknown; platforms?: Record<string, { url?: unknown; signature?: unknown }> }
  if (f?.version !== version) return `latest.json is for version ${String(f?.version)}, not ${version}`
  const e = f.platforms?.[how.feedKey]
  if (typeof e?.url !== 'string' || typeof e.signature !== 'string') return `latest.json has no ${how.feedKey}`
  if (!/^https:\/\//.test(e.url) && !(feedOverride() && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(e.url))) return `not an https download: ${e.url}`
  return { url: e.url, signature: e.signature }
}

/** How this app installs an update, or why it cannot. */
async function installKind(): Promise<How | string> {
  if (!app.isPackaged) return 'a development build'
  const exe = app.getPath('exe')
  const writable = async (p: string) => access(p, constants.W_OK).then(() => true, () => false)
  if (process.platform === 'darwin') {
    const bundle = path.resolve(exe, '..', '..', '..')
    if (!bundle.endsWith('.app')) return `not in an app bundle: ${exe}`
    if (bundle.includes('/AppTranslocation/')) return 'macOS runs the app from a temporary copy: move mtkprof to Applications first'
    if (bundle.startsWith('/Volumes/')) return 'the app runs from the disk image: drag it to Applications first'
    const parent = path.dirname(bundle)
    if (!(await writable(parent)) || !(await writable(bundle))) return `no permission to replace ${bundle}`
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
    return { kind: 'mac', bundle, arch, feedKey: `darwin-${arch === 'aarch64' ? 'aarch64' : 'x86_64'}-app` }
  }
  if (process.platform === 'linux') {
    if (process.arch !== 'x64') return `no ${process.arch} build in the releases`
    const image = process.env.APPIMAGE
    if (image) {
      if (!(await writable(path.dirname(image))) || !(await writable(image))) return `no permission to replace ${image}`
      return { kind: 'appimage', file: image, feedKey: 'linux-x86_64-appimage' }
    }
    if (exe.startsWith('/opt/') && existsSync('/var/lib/dpkg/info/mtkprof.list')) {
      if (!onPath('pkexec')) return 'pkexec is not installed (it asks for the password dpkg needs)'
      return { kind: 'deb', feedKey: 'linux-x86_64-deb' }
    }
    return 'neither the AppImage nor the .deb package'
  }
  if (process.platform === 'win32') {
    if (process.arch !== 'x64') return `no ${process.arch} build in the releases`
    if (!existsSync(path.join(path.dirname(exe), 'Uninstall mtkprof.exe'))) return 'not installed by the mtkprof installer'
    // a key the Tauri-era updater does not read (it takes windows-x86_64[-nsis])
    return { kind: 'nsis', feedKey: 'windows-x86_64-electron' }
  }
  return `no updates for ${process.platform}`
}

const onPath = (bin: string) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && existsSync(path.join(d, bin)))

/** Smoke and test runs (`MTKPROF_SMOKE=1`, as MTKPROF_PROFILE): another latest.json, the version in it. */
function feedOverride(): string | null {
  const u = process.env.MTKPROF_UPDATE_FEED
  return u && (!app.isPackaged || process.env.MTKPROF_SMOKE === '1') ? u : null
}

interface Offer {
  version: string
  how: How
  url: string
  signature: string
  /** the verified download */
  file?: string
  /** the download while it runs */
  downloading?: Promise<void>
}
let offer: Offer | null = null

async function getJson(url: string): Promise<unknown> {
  const r = await net.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'mtkprof-desktop' }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`)
  return r.json()
}

export async function checkForUpdate(): Promise<Available | null> {
  const current = app.getVersion()
  const override = feedOverride()
  let tag: string
  let date: string | undefined
  let feed: unknown = null
  if (override) {
    feed = await getJson(override)
    tag = `v${String((feed as { version?: unknown })?.version)}`
    if (!newer(tag, current)) return (offer = null)
  } else {
    const rel = (await getJson(LATEST)) as { tag_name?: string; published_at?: string; draft?: boolean; prerelease?: boolean }
    if (!rel.tag_name || rel.draft || rel.prerelease || !newer(rel.tag_name, current)) return (offer = null)
    tag = rel.tag_name
    date = rel.published_at
  }
  const version = tag.replace(/^v/, '')
  const available = { version, currentVersion: current, date }
  const no = (why: string): Available => {
    offer = null
    log.info(`update ${version}: offered as a download: ${why}`)
    return { ...available, installs: false, why }
  }
  const how = await installKind()
  if (typeof how === 'string') return no(how)
  if (!override) {
    try {
      feed = await getJson(feedUrl(tag))
    } catch (e) {
      return no(`no latest.json in ${tag} (${(e as Error).message})`)
    }
  }
  const entry = feedEntry(feed, how, version)
  if (typeof entry === 'string') return no(entry)
  // the same update again (Check now, or the page's check during a smoke run): keep the offer, so a
  // download that is running or done stays the one to install
  if (offer?.version === version && offer.url === entry.url && offer.signature === entry.signature) return { ...available, installs: true }
  offer = { version, how, ...entry }
  log.info(`update ${version}: installs as ${how.kind} from ${entry.url}`)
  return { ...available, installs: true }
}

/**
 * Downloads the offered update into a temporary folder, hashing it as it arrives, and verifies its
 * signature before anything opens it. `progress` gets the bytes so far and the length (when known).
 */
export async function downloadUpdate(progress: (done: number, total: number | null) => void): Promise<void> {
  const o = offer
  if (!o) throw new Error('no update to download')
  if (o.file) return
  o.downloading ??= download(o, progress).finally(() => (o.downloading = undefined))
  return o.downloading
}

async function download(o: Offer, progress: (done: number, total: number | null) => void): Promise<void> {
  const dir = await mkdtemp(path.join(app.getPath('temp'), STAGE))
  const name = artifactName(o.how, o.version)
  const file = path.join(dir, name)
  const r = await net.fetch(o.url, { headers: { 'User-Agent': 'mtkprof-desktop' } })
  if (!r.ok || !r.body) throw new Error(`GET ${o.url}: HTTP ${r.status}`)
  const total = Number(r.headers.get('content-length')) || null
  const hash = newHash()
  const out = createWriteStream(file)
  let done = 0
  let last = 0
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
      done += chunk.length
      if (done - last >= 1 << 20 || done === total) {
        last = done
        progress(done, total)
      }
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())))
  } catch (e) {
    out.destroy()
    await rm(dir, { recursive: true, force: true })
    throw e
  }
  progress(done, total)
  try {
    const signed = verifySignature(o.signature, hash.digest())
    if (signed.file !== name) throw new Error(`the signature is for ${signed.file}, not ${name}`)
    if (signed.version !== o.version) throw new Error(`the signature is for version ${signed.version}, not ${o.version}`)
    if (!newer(signed.version, app.getVersion())) throw new Error(`${signed.version} is not newer than ${app.getVersion()}`)
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    log.warn(`update ${o.version}: ${name} rejected: ${(e as Error).message}`)
    throw new Error(`the download is not signed by mtkprof: ${(e as Error).message}`)
  }
  log.info(`update ${o.version}: ${name} downloaded (${done} bytes), signature verified`)
  o.file = file
}

/** Installs the downloaded update and ends the app (relaunched, or started by the installer). */
export async function installUpdate(): Promise<void> {
  const o = offer
  if (!o?.file) throw new Error('no verified download to install')
  const { how, file, version } = o
  log.info(`update ${version}: installing (${how.kind})`)
  switch (how.kind) {
    case 'mac': {
      log.info(`update ${version}: replacing ${how.bundle}`)
      const stage = await mkdtemp(path.join(path.dirname(how.bundle), `.${STAGE}`))
      let fresh: string
      try {
        await run('/usr/bin/tar', ['-xzf', file, '-C', stage])
        const apps = (await readdir(stage)).filter((n) => n.endsWith('.app'))
        if (apps.length !== 1) throw new Error(`the archive holds ${apps.length} apps`)
        fresh = path.join(stage, apps[0])
        const plist = path.join(fresh, 'Contents', 'Info.plist')
        const plistValue = async (k: string) => (await run('/usr/bin/plutil', ['-extract', k, 'raw', plist])).trim()
        if ((await plistValue('CFBundleIdentifier')) !== 'com.davidbudac.mtkprof') throw new Error('the archive holds another app')
        const v = await plistValue('CFBundleShortVersionString')
        if (v !== version) throw new Error(`the archive holds version ${v}, not ${version}`)
      } catch (e) {
        await rm(stage, { recursive: true, force: true })
        throw e
      }
      const old = path.join(stage, 'previous.app')
      await rename(how.bundle, old)
      try {
        await rename(fresh, how.bundle)
      } catch (e) {
        await rename(old, how.bundle)
        throw e
      }
      break
    }
    case 'appimage': {
      const next = path.join(path.dirname(how.file), `.${path.basename(how.file)}.update`)
      await copyFile(file, next)
      await chmod(next, 0o755)
      await rename(next, how.file)
      break
    }
    case 'deb':
      await run('pkexec', ['dpkg', '-i', file])
      break
    case 'nsis':
      // electron-builder's NSIS flags: an update (keeps the user's data), silent, then start the app
      spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      log.info(`update ${version}: the installer runs; quitting`)
      app.quit()
      return
  }
  log.info(`update ${version}: installed; relaunching`)
  // no arguments: the files of the first launch come back with the workspace
  app.relaunch(how.kind === 'appimage' ? { execPath: how.file, args: [] } : { args: [] })
  app.quit()
}

/** Removes what earlier updates left behind: downloads, and the old bundle of a macOS swap. */
export async function cleanUpUpdates(): Promise<void> {
  const dirs = [app.getPath('temp')]
  if (process.platform === 'darwin' && app.isPackaged) dirs.push(path.resolve(app.getPath('exe'), '..', '..', '..', '..'))
  for (const d of dirs) {
    const names = await readdir(d).catch(() => [] as string[])
    for (const n of names) {
      if (!n.startsWith(STAGE) && !n.startsWith(`.${STAGE}`)) continue
      await rm(path.join(d, n), { recursive: true, force: true }).then(
        () => log.info(`update: removed ${path.join(d, n)}`),
        () => {},
      )
    }
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('error', reject)
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} ${args[0]}: exit ${code}: ${err.trim().slice(0, 300)}`))))
  })
}
