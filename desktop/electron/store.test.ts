import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { storeFlush, storeLoad, storeSet } from './store'

let profile = ''
const data = () => path.join(profile, 'data')
const kept = (name: string) => fs.readdirSync(data()).filter((f) => f.startsWith(`${name}.corrupt-`))

beforeAll(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mtkprof-store-'))
  process.env.MTKPROF_PROFILE = profile
  fs.mkdirSync(data(), { recursive: true })
})
afterAll(() => {
  delete process.env.MTKPROF_PROFILE
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('stores', () => {
  it('writes a change and reads nothing from a missing file', () => {
    expect(Object.keys(storeLoad('settings.json'))).toEqual([])
    storeSet('settings.json', 'theme', 'dark')
    storeFlush()
    expect(JSON.parse(fs.readFileSync(path.join(data(), 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' })
    expect(fs.existsSync(path.join(data(), 'settings.json.tmp'))).toBe(false)
    expect(kept('settings.json')).toEqual([])
  })

  it('keeps a file it cannot parse', () => {
    const file = path.join(data(), 'annotations.json')
    const broken = '{"notes": {"a": "three weeks of work"'
    fs.writeFileSync(file, broken)
    expect(Object.keys(storeLoad('annotations.json'))).toEqual([])
    const aside = kept('annotations.json')
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(data(), aside[0]), 'utf8')).toBe(broken)
    storeSet('annotations.json', 'n', 1)
    storeFlush()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ n: 1 })
    expect(fs.readFileSync(path.join(data(), aside[0]), 'utf8')).toBe(broken)
  })

  it('keeps a file that is JSON but not an object', () => {
    const file = path.join(data(), 'workspace.json')
    fs.writeFileSync(file, '[1, 2, 3]')
    expect(Object.keys(storeLoad('workspace.json'))).toEqual([])
    const aside = kept('workspace.json')
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(data(), aside[0]), 'utf8')).toBe('[1, 2, 3]')
  })

  it('does not write over a file it could not read', () => {
    // a directory in the file's place: the read fails, and not with ENOENT
    const file = path.join(data(), 'library.json')
    fs.mkdirSync(file)
    expect(Object.keys(storeLoad('library.json'))).toEqual([])
    storeSet('library.json', 'k', 'v')
    expect(() => storeFlush()).not.toThrow()
    expect(fs.statSync(file).isDirectory()).toBe(true)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(kept('library.json')).toEqual([])
  })
})
