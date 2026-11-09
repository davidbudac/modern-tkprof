// The Vault of secrets.ts over Electron's safeStorage: `<data dir>/secrets.json`, each secret
// encrypted with the key safeStorage keeps in the OS keychain, base64 in the file.

import { safeStorage } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, IDENTIFIER } from './paths'
import { VaultUnavailable, type Legacy, type Vault } from './secrets'

export class SafeStorageVault implements Vault {
  private file = path.join(dataDir(), 'secrets.json')

  private check() {
    if (!safeStorage.isEncryptionAvailable()) throw new VaultUnavailable('no keychain: encryption is not available')
    // without a Secret Service or kwallet the "encryption" uses a fixed password
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new VaultUnavailable('no keychain: no Secret Service or kwallet')
    }
  }

  private read(): Record<string, string> {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return v && typeof v === 'object' ? v : {}
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error(`keychain: ${e}`)
    }
  }

  private write(all: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  get(account: string): string | null {
    this.check()
    const v = this.read()[account]
    if (typeof v !== 'string') return null
    try {
      return safeStorage.decryptString(Buffer.from(v, 'base64'))
    } catch (e) {
      throw new Error(`keychain: ${e}`)
    }
  }

  set(account: string, secret: string): void {
    this.check()
    const all = this.read()
    all[account] = safeStorage.encryptString(secret).toString('base64')
    this.write(all)
  }

  delete(account: string): void {
    const all = this.read()
    if (!(account in all)) return
    delete all[account]
    this.write(all)
  }
}

/**
 * macOS: a secret of the Tauri shell's keychain entries (service `com.davidbudac.mtkprof`), read
 * with `security`; macOS asks the user to allow it (the entry belonged to the other app). Null when
 * there is none or the user refused.
 */
export function tauriKeychain(): Legacy | null {
  if (process.platform !== 'darwin') return null
  return (account) =>
    new Promise((resolve) => {
      execFile('/usr/bin/security', ['find-generic-password', '-s', IDENTIFIER, '-a', account, '-w'], { timeout: 120_000 }, (err, out) =>
        resolve(err ? null : out.replace(/\n$/, '')),
      )
    })
}
