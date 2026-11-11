import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OPT_KEYS, completeText, memoryOptSource, normalizeDump, sparseText, splitLines, textLineCount, type OptDump } from './opt'
import { HAS_FIXTURE, loadFixture } from './optfixture'

const GO = fileURLToPath(new URL('../../../../internal/opt/model.go', import.meta.url))

/** The JSON names of the fields of each struct of model.go: `req` always there, `opt` with omitempty. An embedded struct is not a field (its fields are the outer's). */
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

describe('the twin of internal/opt/model.go', () => {
  it.skipIf(!existsSync(GO))('has every struct and every JSON name of the Go file, optional where Go says omitempty', () => {
    const go = goKeys(readFileSync(GO, 'utf8'))
    for (const [name, k] of Object.entries(go)) {
      const ts = OPT_KEYS[name]
      expect(ts, `type ${name} is in model.go and not in OPT_KEYS`).toBeDefined()
      expect([...ts.req].sort(), `${name}: required fields`).toEqual([...k.req].sort())
      expect([...ts.opt].sort(), `${name}: omitempty fields`).toEqual([...k.opt].sort())
    }
    for (const name of Object.keys(OPT_KEYS)) expect(go[name], `OPT_KEYS has ${name}, model.go does not`).toBeDefined()
  })

  it.skipIf(!HAS_FIXTURE)('reads a real model JSON: every key it has is declared, every required key is there', () => {
    const f = loadFixture()
    const walk = (type: string, v: unknown, path: string) => {
      const k = OPT_KEYS[type]
      expect(k, `${path}: unknown type ${type}`).toBeDefined()
      const o = v as Record<string, unknown>
      for (const key of Object.keys(o)) expect([...k.req, ...k.opt], `${path}.${key} is not in the twin`).toContain(key)
      for (const key of k.req) expect(o, `${path} lacks ${key}`).toHaveProperty(key)
    }
    const each = (type: string, list: unknown[] | undefined, path: string) => (list ?? []).forEach((x, i) => walk(type, x, `${path}[${i}]`))
    walk('File', f.raw.file, 'file')
    each('DumpInfo', f.raw.file.dumps, 'file.dumps')
    const node = (n: Record<string, unknown>, path: string) => { walk('Node', n, path); each('Node', n.children as unknown[], path + '.children'); if (n.verdict) walk('Verdict', n.verdict, path + '.verdict'); for (const c of (n.children as Record<string, unknown>[] | undefined) ?? []) node(c, path + '/' + c.id) }
    for (const d of f.raw.dumps) {
      const p = `dump ${d.idx}`
      // a Dump is its own fields and the embedded DumpInfo's
      const k = OPT_KEYS.Dump
      const info = OPT_KEYS.DumpInfo
      for (const key of Object.keys(d)) expect([...k.req, ...k.opt, ...info.req, ...info.opt], `${p}.${key}`).toContain(key)
      for (const key of [...k.req, ...info.req]) expect(d, `${p} lacks ${key}`).toHaveProperty(key)
      node(d.tree as unknown as Record<string, unknown>, p + '.tree')
      each('Landmark', d.landmarks, p + '.landmarks'); each('Fold', d.folds, p + '.folds'); each('Run', d.runs, p + '.runs'); each('SQL', d.sql, p + '.sql')
      each('Term', d.legend, p + '.legend'); each('Banner', d.banners, p + '.banners'); each('Hint', d.hints, p + '.hints'); each('Bind', d.binds, p + '.binds')
      each('Param', d.altered, p + '.altered'); each('Range', d.digest, p + '.digest')
      if (d.plan) {
        walk('Plan', d.plan, p + '.plan'); each('PlanRow', d.plan.rows, p + '.plan.rows')
        for (const [id, q] of Object.entries(d.plan.qbs)) walk('PlanQB', q, `${p}.plan.qbs.${id}`)
        for (const [id, l] of Object.entries(d.plan.preds)) each('PlanPred', l, `${p}.plan.preds.${id}`)
      }
    }
  })
})

describe('texts', () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f']
  it('splits a file into lines without the trailing newline and the carriage returns', () => {
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('x')).toEqual(['x'])
  })
  it('a complete text gives the lines of its range and nothing outside it', () => {
    const t = completeText(all, 2, 4)
    expect(t.complete).toBe(true)
    expect([t.get(1), t.get(2), t.get(4), t.get(5)]).toEqual([undefined, 'b', 'd', undefined])
    expect(textLineCount(t)).toBe(3)
  })
  it('a sparse text holds the lines of its ranges only', () => {
    const t = sparseText(1, 6, [{ from: 2, to: 3 }, { from: 6, to: 9 }], (l) => all[l - 1])
    expect(t.complete).toBe(false)
    expect([1, 2, 3, 4, 5, 6, 7].map((l) => t.get(l))).toEqual([undefined, 'b', 'c', undefined, undefined, 'f', undefined])
    expect(textLineCount(t)).toBe(3)
  })
})

describe('the in-memory source', () => {
  it.skipIf(!HAS_FIXTURE)('serves the dumps and their text, complete or as a digest', async () => {
    const f = loadFixture()
    const s = f.source()
    expect(s.file.dumps).toHaveLength(2)
    const d1 = await s.dump(1)
    const t1 = await s.text(1)
    expect([t1.from, t1.to, t1.complete]).toEqual([d1.viewFrom, d1.viewTo, true])
    expect(t1.get(d1.viewFrom)).toMatch(/^Registered qb:/)
    const dg = f.source(true)
    const t2 = await dg.text(1)
    expect(t2.complete).toBe(false)
    expect(t2.get(d1.stmtLine)).toBeDefined()
    expect(t2.get(d1.viewFrom + 1000)).toBeUndefined()
    await expect(s.dump(5)).rejects.toThrow()
  })
  it('normalizes what Go leaves null', () => {
    const d = normalizeDump({ landmarks: null, folds: null, runs: null, sql: null, legend: [{ term: 'a', text: 'b', line: 1, codes: null }], banners: null, roles: null, hints: null, binds: null, altered: null, bindLines: null, digest: null, tables: null, plan: { from: 1, head: 2, tableTo: 3, to: 4, cols: null, rows: null, qbs: null, preds: null } } as unknown as OptDump)
    expect(d.landmarks).toEqual([])
    expect(d.roles).toEqual({})
    expect(d.legend[0].codes).toEqual([])
    expect(d.plan?.rows).toEqual([])
    expect(d.plan?.qbs).toEqual({})
    expect(memoryOptSource).toBeTypeOf('function')
  })
})
