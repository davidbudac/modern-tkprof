import { describe, expect, it } from 'vitest'
import { GUIDE_LINES, GUIDE_SECTIONS, KIND_NAME, glossaryOf, glossaryRegex, guideLine } from './optguide'

describe('the guide data', () => {
  it('has a source on every entry (sourced or silent): the format reference, or the trace\'s own legend', () => {
    for (const [k, e] of Object.entries(GUIDE_SECTIONS)) {
      expect(e.source, `section ${k}`).toMatch(/^docs\/trace-format-10053\.md/)
      expect(e.title, `section ${k}`).not.toBe('')
      expect(e.text, `section ${k}`).not.toBe('')
    }
    for (const e of GUIDE_LINES) expect(e.source, `line ${e.title}`).toMatch(/^docs\/trace-format-10053\.md/)
  })
  it('says nothing about a trace\'s decisions: no entry text names a cost or a verdict value', () => {
    for (const e of [...Object.values(GUIDE_SECTIONS), ...GUIDE_LINES]) expect(e.text).not.toMatch(/\bbecause the (optimizer|cost)|\bshould\b|\bbetter\b|\bslow\b/i)
  })
  it('names every kind of section the scanner makes (those without a guide entry say so in the panel)', () => {
    for (const k of Object.keys(GUIDE_SECTIONS)) expect(KIND_NAME[k], `KIND_NAME of ${k}`).toBeDefined()
  })
  it('finds the first entry that matches a line', () => {
    expect(guideLine('  Best:: AccessPath: IndexRange')?.title).toBe('Best:: AccessPath')
    expect(guideLine('Join order aborted: cost > best plan cost')?.title).toBe('Join order aborted')
    expect(guideLine('just some line')).toBeNull()
  })
})

describe('the glossary', () => {
  const dump = { legend: [{ term: 'NL', text: 'nested loops (join)', line: 120, codes: [] as [string, string][] }, { term: 'dmeth', text: 'distribution method', line: 130, codes: [['1', 'no partitioning required'], ['2', 'value partitioned']] as [string, string][] }] }
  const g = glossaryOf(dump, { name: 'x.trc' })
  it('is the dump\'s own legend with the line it is read from, plus the few sourced extra terms', () => {
    expect(g.get('NL')).toEqual({ term: 'NL', text: 'nested loops (join)', source: 'trace Legend, x.trc line 120' })
    expect(g.get('dmeth')?.text).toBe('distribution method: 1 no partitioning required; 2 value partitioned')
    expect(g.get('GBP')?.text).toBe('group-by placement')
    expect(g.get('GBP')?.source).toMatch(/trace-format-10053\.md/)
    expect([...g.keys()].sort()).toEqual(['BJ', 'GBP', 'NL', 'SPD', 'TE', 'dmeth', 'objn'])
  })
  it('a legend term wins over an extra term of the same name', () => {
    expect(glossaryOf({ legend: [{ term: 'GBP', text: 'the trace says', line: 5, codes: [] }] }, { name: 'x' }).get('GBP')?.text).toBe('the trace says')
  })
  it('finds whole words, the longest first, nothing inside another word', () => {
    const re = glossaryRegex(g)!
    const found = (s: string) => Array.from(s.matchAll(re), (m) => m[0])
    expect(found('NL Join: NLX NL_x anNL, (NL)')).toEqual(['NL', 'NL'])
    expect(found('dmeth: 2')).toEqual(['dmeth'])
    expect(glossaryRegex(new Map())).toBeNull()
  })
})
