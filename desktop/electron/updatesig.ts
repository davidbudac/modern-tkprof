// The update's signature (DESIGN § Desktop app, Updates): a minisign signature by the updater key,
// as `scripts/update-feed.mjs` makes it with the Tauri CLI (`signer sign --app-version`) and puts it
// in the release's latest.json: base64 of the minisign signature file. Prehashed ("ED"): Ed25519
// over the file's BLAKE2b-512; the global signature covers that signature and the trusted comment
// (`timestamp:…\tfile:<name>\tversion:<v>`), so the file's name and version are signed too.
// Electron's BoringSSL has no BLAKE2b-512: the hash is @noble/hashes (pure JS), never
// createHash('blake2b512'), which works only in Node (so only the tests use it).

import { createPublicKey, verify } from 'node:crypto'
import { blake2b } from '@noble/hashes/blake2.js'

/** The updater key's public half (the Tauri shell's `plugins.updater.pubkey`, tag tauri-final). */
export const UPDATE_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE3RTY5NUQ4M0JGQjRGMjMKUldRalQvczcySlhtRjZ4c0dGRm44M2w2bmhKdkM3b1VUNTk5aSszeTMreVJ3ZENKbXdqMXd4cnMK'

/** An incremental BLAKE2b-512 of a download, fed as its bytes arrive. */
export const newHash = () => blake2b.create({ dkLen: 64 })

interface PublicKey {
  id: Buffer
  key: ReturnType<typeof createPublicKey>
}

/** `pub`: base64 of a minisign public key file (or the file's text). */
export function parsePublicKey(pub: string): PublicKey {
  const raw = Buffer.from(lines(text(pub))[1] ?? '', 'base64')
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('not a minisign public key')
  const x = raw.subarray(10).toString('base64url')
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }) }
}

/** What the signature says about the file, once it is verified. */
export interface Signed {
  file: string
  version: string
}

/**
 * Verifies `signature` (base64 of a minisign signature file) of a file whose BLAKE2b-512 is
 * `digest`, with the public key `pub`, and returns its trusted comment's file name and version.
 * Throws when anything does not hold.
 */
export function verifySignature(signature: string, digest: Uint8Array, pub: string = UPDATE_PUBKEY): Signed {
  const key = parsePublicKey(pub)
  const l = lines(text(signature))
  const sig = Buffer.from(l[1] ?? '', 'base64')
  const tc = l[2] ?? ''
  const global = Buffer.from(l[3] ?? '', 'base64')
  if (sig.length !== 74 || !tc.startsWith('trusted comment: ') || global.length !== 64) throw new Error('not a minisign signature')
  if (sig.subarray(0, 2).toString() !== 'ED') throw new Error('the signature is not over a prehashed file')
  if (!sig.subarray(2, 10).equals(key.id)) throw new Error('signed by another key')
  if (digest.length !== 64) throw new Error('not a BLAKE2b-512 digest')
  if (!verify(null, digest, key.key, sig.subarray(10))) throw new Error('the signature does not match the file')
  const comment = tc.slice('trusted comment: '.length)
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), key.key, global)) throw new Error('the trusted comment is not signed')
  const fields = new Map(comment.split('\t').map((f) => [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)]))
  const file = fields.get('file')
  const version = fields.get('version')
  if (!file || !version) throw new Error('the signature names no file or no version')
  return { file, version }
}

/** a minisign file's text: as it is, or base64 of it (latest.json, tauri.conf.json) */
function text(s: string): string {
  const t = s.trim()
  return t.startsWith('untrusted comment:') ? t : Buffer.from(t, 'base64').toString('utf8')
}

const lines = (t: string) => t.split(/\r?\n/)
