import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { artifactName, feedEntry, type How } from './updates'
import { newHash, verifySignature } from './updatesig'

const fixture = (n: string) => readFileSync(new URL(`./testdata/${n}`, import.meta.url))
const digest = (b: Uint8Array) => newHash().update(b).digest()

describe('update signature', () => {
  // signed with the real updater key by the Tauri CLI, as scripts/update-feed.mjs signs a release
  // (`signer sign --app-version 0.0.1`): the format and the built-in public key agree
  const file = fixture('signed-fixture.txt')
  const sig = fixture('signed-fixture.txt.sig').toString()

  it('verifies a Tauri CLI signature with the built-in key and reads its file and version', () => {
    expect(verifySignature(sig, digest(file))).toEqual({ file: 'signed-fixture.txt', version: '0.0.1' })
  })

  it('hashes like OpenSSL BLAKE2b-512, chunk by chunk (Electron has no blake2b512)', () => {
    const data = randomBytes(3 * 2 ** 20 + 17)
    const h = newHash()
    for (let i = 0; i < data.length; i += 65_521) h.update(data.subarray(i, i + 65_521))
    expect(Buffer.from(h.digest()).toString('hex')).toBe(createHash('blake2b512').update(data).digest('hex'))
  })

  it('refuses another file', () => {
    expect(() => verifySignature(sig, digest(Buffer.concat([file, Buffer.from('x')])))).toThrow('does not match the file')
  })

  it('refuses a changed trusted comment (the version)', () => {
    const t = Buffer.from(sig, 'base64').toString().replace('version:0.0.1', 'version:9.9.9')
    expect(() => verifySignature(Buffer.from(t).toString('base64'), digest(file))).toThrow('trusted comment is not signed')
  })

  it('refuses another key, and verifies with its own', () => {
    const k = minisignKey()
    const other = k.sign(file, 'file:a.txt\tversion:1.2.3')
    expect(() => verifySignature(other, digest(file))).toThrow('another key')
    expect(verifySignature(other, digest(file), k.pub)).toEqual({ file: 'a.txt', version: '1.2.3' })
  })
})

describe('update feed', () => {
  // the shape of a release's latest.json (v0.9.1, trimmed)
  const feed = {
    version: '0.9.1',
    platforms: {
      'darwin-aarch64-app': { signature: 's1', url: 'https://github.com/davidbudac/modern-tkprof/releases/download/v0.9.1/mtkprof_0.9.1_aarch64.app.tar.gz' },
      'linux-x86_64-deb': { signature: 's2', url: 'http://example.com/mtkprof_0.9.1_amd64.deb' },
    },
  }
  const mac: How = { kind: 'mac', bundle: '/Applications/mtkprof.app', arch: 'aarch64', feedKey: 'darwin-aarch64-app' }

  it('takes the entry of this platform, https only', () => {
    expect(feedEntry(feed, mac, '0.9.1')).toEqual(feed.platforms['darwin-aarch64-app'])
    expect(feedEntry(feed, { kind: 'deb', feedKey: 'linux-x86_64-deb' }, '0.9.1')).toMatch(/not an https download/)
    expect(feedEntry(feed, { kind: 'nsis', feedKey: 'windows-x86_64-electron' }, '0.9.1')).toMatch(/no windows-x86_64-electron/)
    expect(feedEntry(feed, mac, '0.9.2')).toMatch(/for version 0.9.1, not 0.9.2/)
  })

  it('names the artifacts as the release does', () => {
    expect(artifactName(mac, '0.9.1')).toBe('mtkprof_0.9.1_aarch64.app.tar.gz')
    expect(artifactName({ ...mac, arch: 'x64', feedKey: 'darwin-x86_64-app' }, '0.9.1')).toBe('mtkprof_0.9.1_x64.app.tar.gz')
    expect(artifactName({ kind: 'appimage', file: '/x', feedKey: '' }, '0.9.1')).toBe('mtkprof_0.9.1_amd64.AppImage')
    expect(artifactName({ kind: 'deb', feedKey: '' }, '0.9.1')).toBe('mtkprof_0.9.1_amd64.deb')
    expect(artifactName({ kind: 'nsis', feedKey: '' }, '0.9.1')).toBe('mtkprof_0.9.1_x64-setup.exe')
  })
})

/** a minisign key of the test's own, and prehashed signatures in the Tauri CLI's shape */
function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const id = randomBytes(8)
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const pubText = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`
  return {
    pub: Buffer.from(pubText).toString('base64'),
    sign(data: Uint8Array, comment: string) {
      const s = sign(null, digest(data), privateKey)
      const g = sign(null, Buffer.concat([s, Buffer.from(comment)]), privateKey)
      const text = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, s]).toString('base64')}\ntrusted comment: ${comment}\n${g.toString('base64')}\n`
      return Buffer.from(text).toString('base64')
    },
  }
}
