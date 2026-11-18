import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client'
import { firstLineNaming, keyKind, namingRegexes, parseSession } from './diagmarks'

const matches = (by: Parameters<typeof namingRegexes>[0], line: string) => namingRegexes(by).map((r) => new RegExp(r).test(line))

describe('what names a statement or a session in a dump', () => {
  it('reads a session as sid.serial and nothing else', () => {
    expect(parseSession('52.41898')).toEqual({ sid: 52, serial: 41898 })
    expect(parseSession(' 1.2 ')).toEqual({ sid: 1, serial: 2 })
    expect(parseSession('pid 12')).toBeNull()
    expect(parseSession('')).toBeNull()
    expect(keyKind({ sqlId: 'a' })).toBe('statement')
    expect(keyKind({ session: '1.2' })).toBe('session')
  })

  it('names a statement by the forms a dump prints it in, and not by the 10046 record\'s own sqlid=', () => {
    const by = { sqlId: 'faaxujvpx61wd' }
    expect(matches(by, 'Current SQL Statement for this session (sql_id=faaxujvpx61wd) -----')).toEqual([true])
    expect(matches(by, 'Dump Cursor sql_id=faaxujvpx61wd (the cursor)')).toEqual([true])
    expect(matches(by, '    Name=select 1  SqlId=faaxujvpx61wd Type=CURSOR')).toEqual([true])
    expect(matches(by, "PARSING IN CURSOR #1 len=60 dep=0 uid=165 oct=3 lid=165 tim=1 hv=1 ad='0' sqlid='faaxujvpx61wd'")).toEqual([false])
    expect(matches(by, 'sql_id=faaxujvpx61wdx')).toEqual([false])
    expect(namingRegexes({ sqlId: '' })).toEqual([])
    expect(namingRegexes({ sqlId: "a'b" })).toEqual([])
  })

  it('names a session by its state object and the blocker lines first, the file\'s own marker last', () => {
    const by = { session: '52.41898' }
    expect(matches(by, '(session) sid: 52 ser: 41898 trans: 0x9ed3ecd8, creator: 0xa255f4d8')).toEqual([true, false])
    expect(matches(by, 'inst: 1, sid: 52, ser: 41898')).toEqual([true, false])
    expect(matches(by, '*** SESSION ID:(52.41898) 2026-11-17T21:34:26.343770+00:00')).toEqual([false, true])
    expect(matches(by, '(session) sid: 152 ser: 41898')).toEqual([false, false])
    expect(namingRegexes({ session: 'pid 12' })).toEqual([])
  })

  it('finds the first line with the best form, falls back to the next form, and null where nothing names it', async () => {
    const queries: string[] = []
    const client = {
      fetch: vi.fn(async (path: string) => {
        const q = new URL(path, 'http://x').searchParams.get('q') ?? ''
        queries.push(q)
        const hit = q.includes('SESSION ID') ? '{"line":24,"col":0,"text":"x"}\n' : ''
        return new Response(`${hit}{"done":true,"scanned":9,"truncated":false}\n`)
      }),
    } as unknown as ApiClient
    expect(await firstLineNaming(client, { session: '61.29861' })).toBe(24)
    expect(queries).toHaveLength(2)
    expect(await firstLineNaming(client, { sqlId: 'abc' })).toBeNull()
    expect(await firstLineNaming(client, { session: 'nope' })).toBeNull()
  })
})
