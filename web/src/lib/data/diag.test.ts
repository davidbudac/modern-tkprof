import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DIAG_AHEAD, DIAG_KEYS, NoReading, kindOfLine, memoryDiagSource, memoryText, normalizeFile, normalizeOutline, type DiagNode } from './diag'
import { HAS_DIAG_FIXTURE, loadDiagFixture } from './diagfixture'

const GO = fileURLToPath(new URL('../../../../internal/diag/model.go', import.meta.url))

/** The JSON names of the fields of each struct of model.go: `req` always there, `opt` with omitempty. A field without a json tag (the scan's own) is not one. */
function goKeys(src: string): Record<string, { req: string[]; opt: string[] }> {
  const out: Record<string, { req: string[]; opt: string[] }> = {}
  for (const m of src.matchAll(/^type (\w+) struct \{\n([\s\S]*?)^\}/gm)) {
    const keys = { req: [] as string[], opt: [] as string[] }
    for (const line of m[2].split('\n')) {
      const t = /`json:"([^",]+)(,omitempty)?"`/.exec(line)
      if (!t) continue
      if (t[2]) keys.opt.push(t[1])
      else keys.req.push(t[1])
    }
    out[m[1]] = keys
  }
  return out
}

describe('the twin of internal/diag/model.go', () => {
  it.skipIf(!existsSync(GO))('has every struct and every JSON name of the Go file, optional where Go says omitempty (a field ahead of Go is listed)', () => {
    const go = goKeys(readFileSync(GO, 'utf8'))
    for (const [name, k] of Object.entries(go)) {
      const ts = DIAG_KEYS[name]
      expect(ts, `type ${name} is in model.go and not in DIAG_KEYS`).toBeDefined()
      const ahead = DIAG_AHEAD[name] ?? []
      const here = (xs: string[]) => xs.filter((x) => !ahead.includes(x) || k.req.includes(x) || k.opt.includes(x)).sort()
      expect(here(ts.req), `${name}: required fields`).toEqual([...k.req].sort())
      expect(here(ts.opt), `${name}: omitempty fields`).toEqual([...k.opt].sort())
    }
    for (const name of Object.keys(DIAG_KEYS)) expect(go[name], `DIAG_KEYS has ${name}, model.go does not`).toBeDefined()
  })

  it.skipIf(!HAS_DIAG_FIXTURE)('reads the engine\'s JSON of a real file: every key it has is declared, every required key is there', () => {
    const f = loadDiagFixture()
    const walk = (type: string, v: unknown, path: string) => {
      const k = DIAG_KEYS[type]
      const o = v as Record<string, unknown>
      for (const key of Object.keys(o)) expect([...k.req, ...k.opt], `${path}.${key} is not in the twin`).toContain(key)
      for (const key of k.req) expect(o, `${path} lacks ${key}`).toHaveProperty(key)
    }
    walk('File', f.file, 'file')
    f.file.sections.forEach((s, i) => walk('Section', s, `file.sections[${i}]`))
    f.file.outline.forEach((n, i) => walk('Node', n, `file.outline[${i}]`))
    for (const [id, kids] of Object.entries(f.children)) kids.forEach((n, i) => walk('Node', n, `${id}[${i}]`))
  })
})

describe('what Go leaves null', () => {
  it('is made empty', () => {
    const f = normalizeFile({ name: 'x', lines: 1, release: '', version: '', tested: true, records10046: 0, sections: null as never, unplaced: 0, outline: null as never, outlineTotal: 0 })
    expect(f.sections).toEqual([])
    expect(f.outline).toEqual([])
    expect(normalizeOutline({ node: 'n', children: null as never, more: undefined as never })).toEqual({ node: 'n', children: [], more: 0 })
  })
})

describe('the text of a memory source', () => {
  const lines = ['*** 2026-11-17T21:34:26.343784+00:00', ' ', 'dbkedDefDump(): Starting', '----- Error Stack Dump -----', 'ORA-00942: table or view does not exist']
  const t = memoryText(lines)
  const sig = new AbortController().signal

  it('gives pages as the server does, each line with its kind', async () => {
    const p = await t.page(2, 3, sig)
    expect(p.total).toBe(5)
    expect(p.from).toBe(2)
    expect(p.lines.map((l) => [l.t, l.k])).toEqual([[' ', 'blank'], ['dbkedDefDump(): Starting', 'diagnostic'], ['----- Error Stack Dump -----', 'diagnostic']])
    expect(kindOfLine('*** x')).toBe('marker')
    expect((await t.page(5, 10, sig)).lines).toHaveLength(1)
  })

  it('searches literally and by regular expression, in line order, with the limit and the case', async () => {
    const hits: number[] = []
    const end = await t.search({ q: 'ora-', regex: false, caseSensitive: false, from: 1, limit: 10 }, (h) => hits.push(h.line), sig)
    expect(hits).toEqual([5])
    expect(end).toEqual({ scanned: 5, truncated: false, done: true })
    const cs: number[] = []
    await t.search({ q: 'ora-', regex: false, caseSensitive: true, from: 1, limit: 10 }, (h) => cs.push(h.line), sig)
    expect(cs).toEqual([])
    const re: number[] = []
    await t.search({ q: '^-{5} \\w+', regex: true, caseSensitive: false, from: 1, limit: 10 }, (h) => re.push(h.line), sig)
    expect(re).toEqual([4])
    const lim: number[] = []
    const e2 = await t.search({ q: 'e', regex: false, caseSensitive: false, from: 1, limit: 2 }, (h) => lim.push(h.line), sig)
    expect(lim).toHaveLength(2)
    expect(e2.truncated).toBe(true)
    await expect(t.search({ q: '(', regex: true, caseSensitive: false, from: 1, limit: 2 }, () => {}, sig)).rejects.toThrow()
  })

  it('makes the lines of a file too big to hold on demand', async () => {
    const big = memoryText({ count: 10_000_000, at: (n) => `line ${n}` })
    const p = await big.page(9_999_999, 2000, sig)
    expect(p.total).toBe(10_000_000)
    expect(p.lines.map((l) => l.t)).toEqual(['line 9999999', 'line 10000000'])
  })
})

describe('a memory source', () => {
  const node = (i: number, kids = false): DiagNode => ({ id: `n${i}`, kind: 'title', title: `T${i}`, from: i * 10 + 1, to: i * 10 + 10, lines: 10, hasChildren: kids })
  const file = { name: 'm.trc', lines: 100, release: '', version: '19.27', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [node(0, true), node(1)], outlineTotal: 2 }

  it('answers the children of a node, paged by `after`, and a node it has none for with none', async () => {
    const kids = Array.from({ length: 5 }, (_, i) => node(i + 20))
    const s = memoryDiagSource(file, { n0: kids }, ['x'], { pageSize: 2 })
    expect(await s.outline('n0')).toMatchObject({ children: kids.slice(0, 2), more: 3, next: 2 })
    expect(await s.outline('n0', 2)).toMatchObject({ children: kids.slice(2, 4), more: 1, next: 4 })
    expect(await s.outline('n0', 4)).toMatchObject({ children: kids.slice(4), more: 0 })
    expect(await s.outline('n1')).toEqual({ node: 'n1', children: [], more: 0 })
    expect((await s.outline('root')).children).toEqual(file.outline)
  })

  it('rejects the reading of a node that has none with NoReading, and gives the ones it was given', async () => {
    const s = memoryDiagSource(file, {}, null, { readings: { n0: { kind: 'heap', rows: 3 } } })
    expect(s.text).toBeNull()
    expect(await s.reading('n0')).toEqual({ kind: 'heap', rows: 3 })
    await expect(s.reading('n1')).rejects.toBeInstanceOf(NoReading)
  })
})
