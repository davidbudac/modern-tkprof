import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { joinPath } from './loginpath'
import { OpenQueue, pathsOfArgs } from './open'
import { checkId, KeyCommands, Secrets, VaultUnavailable, type Vault } from './secrets'
import { newer } from './updates'

describe('open requests', () => {
  it('args become absolute paths without flags', () => {
    expect(pathsOfArgs(['a.trc', '-psn_0_123', '/x/b.trc', '', '--inspect'], '/traces', path.posix)).toEqual(['/traces/a.trc', '/x/b.trc'])
    expect(pathsOfArgs(['a.trc', 'D:\\x\\b.trc'], 'C:\\traces', path.win32)).toEqual(['C:\\traces\\a.trc', 'D:\\x\\b.trc'])
  })

  it('queues trace sets until taken', () => {
    const q = new OpenQueue()
    expect(q.push([])).toBe(false)
    expect(q.push(['/a.trc'])).toBe(true)
    q.push(['/b.trc', '/c.trc'])
    expect(q.take()).toEqual([['/a.trc'], ['/b.trc', '/c.trc']])
    expect(q.take()).toEqual([])
  })
})

describe('engine PATH', () => {
  it('keeps order, drops repeats and adds the agent dirs', () => {
    expect(joinPath(['/a:/usr/local/bin:/b', '/b:/c::'], '/home/u')).toBe('/a:/usr/local/bin:/b:/c:/opt/homebrew/bin:/home/u/.local/bin')
    expect(joinPath(['', '/usr/bin:/bin'], '')).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
  })
})

describe('updates', () => {
  it('compares versions', () => {
    expect(newer('v0.7.0', '0.6.0')).toBe(true)
    expect(newer('v0.6.10', '0.6.9')).toBe(true)
    expect(newer('v0.6.0', '0.6.0')).toBe(false)
    expect(newer('v0.5.9', '0.6.0')).toBe(false)
  })
})

/** A keychain in memory; `down` makes it unavailable. */
class Mock implements Vault {
  items = new Map<string, string>()
  constructor(public down = false) {}
  private check() {
    if (this.down) throw new VaultUnavailable('no keychain: test')
  }
  get(a: string) {
    this.check()
    return this.items.get(a) ?? null
  }
  set(a: string, s: string) {
    this.check()
    this.items.set(a, s)
  }
  delete(a: string) {
    this.check()
    this.items.delete(a)
  }
}

const EP = 'openai https://api.example.com/v1'

describe('assistant keys', () => {
  it('remembers in the keychain under the provider account', () => {
    const v = new Mock()
    const s = new Secrets(v)
    expect(s.keep('openai', EP, 'sk-1', true)).toBe('keychain')
    expect(JSON.parse(v.items.get('assist:openai')!)).toEqual({ endpoint: EP, key: 'sk-1' })
    expect(s.find('openai', EP)).toEqual({ key: 'sk-1' })
    s.forget('openai')
    expect(s.find('openai', EP)).toEqual({ missing: true, keychain: true })
  })

  it('a key answers only for the endpoint it was kept for', () => {
    const s = new Secrets(new Mock())
    s.keep('openai', EP, 'sk-1', true)
    expect(s.find('openai', 'openai https://evil.example.com/v1')).toEqual({ missing: true, keychain: true })
    expect(s.find('other', EP)).toEqual({ missing: true, keychain: true })
  })

  it('a secret of another shape answers for none', () => {
    const v = new Mock()
    v.items.set('assist:openai', 'sk-plain')
    expect(new Secrets(v).find('openai', EP)).toEqual({ missing: true, keychain: true })
  })

  it('a key not remembered is not stored', () => {
    const v = new Mock()
    expect(new Secrets(v).keep('openai', EP, 'sk-1', false)).toBe('engine')
    expect(v.items.size).toBe(0)
  })

  it('without a keychain a remembered key lasts the session', () => {
    const s = new Secrets(new Mock(true))
    expect(s.find('openai', EP)).toEqual({ missing: true, keychain: false })
    expect(s.keep('openai', EP, 'sk-1', true)).toBe('session')
    expect(s.find('openai', EP)).toEqual({ key: 'sk-1' })
    expect(s.find('openai', 'openai https://other/v1')).toEqual({ missing: true, keychain: false })
    s.forget('openai')
    expect(s.find('openai', EP)).toEqual({ missing: true, keychain: false })
  })

  it('ids must be engine ids', () => {
    expect(checkId('prompt', 'p-1.a:b_c')).toBe('p-1.a:b_c')
    for (const bad of ['', 'a/b', '../x', 'a b', 'x'.repeat(129), 7]) expect(() => checkId('prompt', bad)).toThrow(/not an id/)
  })
})

/** A fake engine: `GET`/`POST /engine/prompts/{id}`, recording the requests. */
function fakeEngine(prompt: { kind: string; connection: string; endpoint?: string } | null) {
  const seen: { method: string; url: string; auth?: string; body: string }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body })
      if (!prompt) return void res.writeHead(404).end()
      if (req.method === 'GET') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(prompt))
      res.writeHead(204).end()
    })
  })
  return new Promise<{ addr: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo
      resolve({ addr: `127.0.0.1:${a.port}`, seen, close: () => server.close() })
    }),
  )
}

describe('key commands against the engine', () => {
  let close = () => {}
  afterEach(() => close())

  it('answers the prompt with the remembered key and the engine token', async () => {
    const e = await fakeEngine({ kind: 'apikey', connection: 'openai', endpoint: EP })
    close = e.close
    const s = new Secrets(new Mock())
    s.keep('openai', EP, 'sk-1', true)
    const k = new KeyCommands(s, () => ({ addr: e.addr, token: 'tok' }))
    expect(await k.answer('p1', 'openai')).toEqual({ status: 'answered' })
    expect(e.seen.map((r) => [r.method, r.url, r.auth])).toEqual([
      ['GET', '/engine/prompts/p1', 'Bearer tok'],
      ['POST', '/engine/prompts/p1', 'Bearer tok'],
    ])
    expect(JSON.parse(e.seen[1].body)).toEqual({ answer: 'sk-1' })
  })

  it("only the provider's own key prompt is answered", async () => {
    const e = await fakeEngine({ kind: 'apikey', connection: 'other', endpoint: EP })
    close = e.close
    const s = new Secrets(new Mock())
    s.keep('openai', EP, 'sk-1', true)
    const k = new KeyCommands(s, () => ({ addr: e.addr, token: 'tok' }))
    await expect(k.answer('p1', 'openai')).rejects.toThrow(/not the key prompt of openai/)
    expect(e.seen.every((r) => r.method === 'GET')).toBe(true)
  })

  it('a typed key is kept only after the engine took it', async () => {
    const e = await fakeEngine({ kind: 'apikey', connection: 'openai', endpoint: EP })
    close = e.close
    const v = new Mock()
    const k = new KeyCommands(new Secrets(v), () => ({ addr: e.addr, token: 'tok' }))
    expect(await k.storeAndAnswer('p1', 'openai', ' sk-2 ', true)).toBe('keychain')
    expect(JSON.parse(e.seen[1].body)).toEqual({ answer: 'sk-2' })
    expect(JSON.parse(v.items.get('assist:openai')!)).toEqual({ endpoint: EP, key: 'sk-2' })
  })

  it('a gone prompt is an error without the key', async () => {
    const e = await fakeEngine(null)
    close = e.close
    const v = new Mock()
    const k = new KeyCommands(new Secrets(v), () => ({ addr: e.addr, token: 'tok' }))
    await expect(k.storeAndAnswer('p1', 'openai', 'sk-2', true)).rejects.toThrow(/gone/)
    expect(e.seen).toHaveLength(1)
    expect(v.items.size).toBe(0)
  })

  it('needs a running engine', async () => {
    const k = new KeyCommands(new Secrets(new Mock()), () => null)
    await expect(k.answer('p1', 'openai')).rejects.toThrow(/not running/)
  })
})
