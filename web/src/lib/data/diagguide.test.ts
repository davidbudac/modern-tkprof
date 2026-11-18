import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GUIDE, GUIDE_SOURCE, KIND_NAME, guideFor } from './diagguide'

const DOC = fileURLToPath(new URL('../../../../' + GUIDE_SOURCE, import.meta.url))
const kinds = (t: string, kind = 'title') => guideFor({ kind, title: t }).map((g) => g.title)

describe('the guide is sourced or silent', () => {
  it.skipIf(!existsSync(DOC))('cites for every entry a section that the format reference has', () => {
    const headings = new Set([...readFileSync(DOC, 'utf8').matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].trim()))
    for (const g of GUIDE) expect(headings.has(g.src), `${g.title}: § ${g.src} is not a heading of ${GUIDE_SOURCE}`).toBe(true)
  })

  it('gives every entry a title and a text, and no two the same title', () => {
    for (const g of GUIDE) { expect(g.title, g.src).not.toBe(''); expect(g.text.length, g.title).toBeGreaterThan(40) }
    expect(new Set(GUIDE.map((g) => g.title)).size).toBe(GUIDE.length)
  })

  it('is silent for a kind of node nobody wrote about', () => {
    expect(guideFor({ kind: 'banner', title: 'CURRENT SESSION\'S INSTANTIATION STATE' })).toEqual([])
    expect(kinds('Something Else')).toEqual([])
    expect(kinds('Parser State')).toEqual(['Error stack, SQL, PL/SQL stack and call stack'])
  })

  it('speaks of the kinds the outline has: sections, state objects, frames, heap parts, hang chains', () => {
    expect(kinds('', 'heap')).toEqual(['A heap dump'])
    expect(kinds('', 'diagdump')).toEqual(['A diagnostic dump'])
    expect(kinds('', 'procstate')).toEqual(['Process state'])
    expect(kinds('', 'so')).toEqual(['State object'])
    expect(kinds('', 'frame')).toEqual(['Binary stack dump and its frames'])
    expect(kinds('Binary Stack Dump')).toEqual(['Binary stack dump and its frames'])
    expect(kinds('', 'chain')).toEqual(['Hang analysis'])
    expect(kinds('', 'extent')).toEqual(['Extents of a heap'])
    expect(kinds('', 'bucket')).toEqual(['Free lists'])
    expect(kinds('', 'trace10046')).toEqual(['SQL trace (10046) lines'])
    expect(kinds('Dump Cursor sql_id=86trfcf9m9n9f')).toEqual(['Cursor dumps'])
  })

  it('names every kind the outline can have', () => {
    for (const k of ['header', 'other', 'trace10046', 'heap', 'pga-summary', 'pga-detail', 'diagdump', 'procstate', 'sysstate', 'hang', 'deadlock', 'incident', 'title', 'banner', 'frame', 'process', 'so', 'chain', 'toc', 'extents', 'extent', 'freelists', 'bucket', 'unpinned', 'permanent', 'subheaps']) {
      expect(KIND_NAME[k], k).toBeTruthy()
    }
  })
})
