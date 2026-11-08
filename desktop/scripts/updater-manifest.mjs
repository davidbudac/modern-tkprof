#!/usr/bin/env node
// The updater's manifest of a release: latest.json, from the signed updater artifacts in out/.
// usage: node scripts/updater-manifest.mjs <tag> <out dir> > latest.json
//
// The app asks https://github.com/davidbudac/modern-tkprof/releases/latest/download/latest.json
// (tauri.conf.json plugins.updater.endpoints) and takes the entry `<os>-<arch>-<bundle>`, else
// `<os>-<arch>` (tauri-plugin-updater). The URLs point at the release's assets, so the files
// must be uploaded under the names they have in out/. Fails unless every platform the release
// ships has its artifact and .sig.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [tag, dir] = process.argv.slice(2)
if (!tag || !dir || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: updater-manifest.mjs <vX.Y.Z> <out dir>')
  process.exit(2)
}
const version = tag.slice(1)
const files = new Set(readdirSync(dir))
const base = `https://github.com/davidbudac/modern-tkprof/releases/download/${tag}`

/** [the artifact's name in out/, the manifest keys it answers] */
const artifacts = [
  [`mtkprof_${version}_aarch64.app.tar.gz`, ['darwin-aarch64-app', 'darwin-aarch64']],
  [`mtkprof_${version}_x64.app.tar.gz`, ['darwin-x86_64-app', 'darwin-x86_64']],
  [`mtkprof_${version}_x64-setup.exe`, ['windows-x86_64-nsis', 'windows-x86_64']],
  // the AppImage replaces itself; a .deb install runs dpkg through pkexec (a password prompt)
  [`mtkprof_${version}_amd64.AppImage`, ['linux-x86_64-appimage', 'linux-x86_64'], { optional: true }],
  [`mtkprof_${version}_amd64.deb`, ['linux-x86_64-deb']],
]

const platforms = {}
const missing = []
for (const [name, keys, opts] of artifacts) {
  if (!files.has(name) || !files.has(`${name}.sig`)) {
    if (!opts?.optional) missing.push(files.has(name) ? `${name}.sig` : name)
    continue
  }
  const signature = readFileSync(join(dir, `${name}.sig`), 'utf8').trim()
  // the trusted comment names the version it was signed for (requireSignedVersion checks it)
  const trusted = Buffer.from(signature, 'base64').toString('utf8')
  if (!trusted.includes(`version:${version}`)) {
    console.error(`updater-manifest: ${name}.sig is not signed for version ${version}`)
    process.exit(1)
  }
  for (const k of keys) platforms[k] = { signature, url: `${base}/${encodeURIComponent(name)}` }
}
if (missing.length) {
  console.error(`updater-manifest: missing in ${dir}: ${missing.join(', ')} (built without the signing key?)`)
  process.exit(1)
}

const manifest = {
  version,
  notes: `https://github.com/davidbudac/modern-tkprof/releases/tag/${tag}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
}
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
