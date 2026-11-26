#!/usr/bin/env node
// The update feed: latest.json of each GitHub release, signed downloads per platform. Two readers:
// - the Electron app (electron/updates.ts): it finds the newest release through GitHub's API, reads
//   that release's latest.json, takes its platform's entry, verifies the download's minisign
//   signature against the key built into it (electron/updatesig.ts) and that the signature names
//   the file and the version, then installs it in place (DESIGN § Desktop app, Updates).
// - Tauri-era installs (v0.6.0 and older): their updater reads latest.json of the newest release
//   (tauri.conf.json plugins.updater on the tauri-final tag), takes `<os>-<arch>-<bundle>`, else
//   `<os>-<arch>`, and checks the same signature (requireSignedVersion).
// The artifacts, signed with the one updater key:
//   macOS    mtkprof_<v>_<aarch64|x64>.app.tar.gz (scripts/ci-local.sh): the .app bundle is swapped
//            and relaunched
//   Linux    the AppImage (the running AppImage is replaced) and the .deb (pkexec dpkg -i; the
//            package is `mtkprof` in both shells, so dpkg upgrades it)
//   Windows  the NSIS installer: for the Electron app under windows-x86_64-electron (run silently,
//            it starts the app again), for Tauri installs under windows-x86_64[-nsis] (it removes
//            the Tauri install first, build/installer.nsh). Only with --with-windows until an
//            update is tried on Windows
// Signs each artifact in <out dir> (writes <file>.sig) with the Tauri CLI and prints latest.json.
// The key: TAURI_SIGNING_PRIVATE_KEY (the key or a path), else ~/.tauri/mtkprof-updater.key;
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD if it has one.
// usage: node scripts/update-feed.mjs <vX.Y.Z> <out dir> [--with-windows] > latest.json
// Testing (desktop/README.md § Updates): --partial signs what is there, --base <url> points the
// manifest at another server (a local one, with MTKPROF_UPDATE_FEED or an old app built with that endpoint).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TAURI_CLI = '@tauri-apps/cli@2.12.4' // the CLI of the last Tauri release; --app-version binds the version

const args = process.argv.slice(2)
const withWindows = args.includes('--with-windows')
const partial = args.includes('--partial')
const baseAt = args.indexOf('--base')
const baseArg = baseAt >= 0 ? args.splice(baseAt, 2)[1] : null
const [tag, dir] = args.filter((a) => !a.startsWith('--'))
if (!tag || !dir || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: update-feed.mjs <vX.Y.Z> <out dir> [--with-windows] > latest.json')
  process.exit(2)
}
const version = tag.slice(1)

let key = process.env.TAURI_SIGNING_PRIVATE_KEY || ''
if (!key && existsSync(join(homedir(), '.tauri', 'mtkprof-updater.key'))) key = join(homedir(), '.tauri', 'mtkprof-updater.key')
if (!key) {
  console.error('update-feed: no updater key (TAURI_SIGNING_PRIVATE_KEY or ~/.tauri/mtkprof-updater.key): no app could update')
  process.exit(1)
}
const keyArgs = existsSync(key) ? ['-f', key] : ['-k', key]
const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''

/** [the artifact's name in <out dir>, the manifest keys it answers, required] */
const artifacts = [
  [`mtkprof_${version}_aarch64.app.tar.gz`, ['darwin-aarch64-app', 'darwin-aarch64'], true],
  [`mtkprof_${version}_x64.app.tar.gz`, ['darwin-x86_64-app', 'darwin-x86_64'], true],
  [`mtkprof_${version}_amd64.AppImage`, ['linux-x86_64-appimage', 'linux-x86_64'], false],
  [`mtkprof_${version}_amd64.deb`, ['linux-x86_64-deb'], true],
]
if (withWindows) artifacts.push([`mtkprof_${version}_x64-setup.exe`, ['windows-x86_64-electron', 'windows-x86_64-nsis', 'windows-x86_64'], true])

const files = new Set(readdirSync(dir))
const base = baseArg ?? `https://github.com/davidbudac/modern-tkprof/releases/download/${tag}`
const platforms = {}
for (const [name, keys, required] of artifacts) {
  if (!files.has(name)) {
    if (required && !partial) {
      console.error(`update-feed: ${name} is not in ${dir}`)
      process.exit(1)
    }
    continue
  }
  execFileSync('pnpm', ['dlx', TAURI_CLI, 'signer', 'sign', ...keyArgs, '-p', password, '--app-version', version, join(dir, name)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const signature = readFileSync(join(dir, `${name}.sig`), 'utf8').trim()
  if (!Buffer.from(signature, 'base64').toString('utf8').includes(`version:${version}`)) {
    console.error(`update-feed: ${name}.sig does not name version ${version}`)
    process.exit(1)
  }
  for (const k of keys) platforms[k] = { signature, url: `${base}/${encodeURIComponent(name)}` }
}

const manifest = {
  version,
  notes: `https://github.com/davidbudac/modern-tkprof/releases/tag/${tag}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
}
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
