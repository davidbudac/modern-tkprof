import { describe, expect, it } from 'vitest'
import { matchIndexes, rankCommands, sectionsOf, stepActive, type Command } from './CommandPalette'

const cmd = (id: string, label: string, group = 'View', extra: Partial<Command> = {}): Command => ({ id, label, group, run() {}, ...extra })
const ids = (l: Command[]) => l.map((c) => c.id)

const cmds = [
  cmd('wrap', 'Toggle line wrap'),
  cmd('heat', 'Toggle heat map'),
  cmd('goto', 'Go to line', 'Navigate'),
  cmd('next', 'Next error', 'Navigate'),
  cmd('prev', 'Previous error', 'Navigate'),
  cmd('slow', 'Show slow waits', 'Presets'),
]

describe('matchIndexes', () => {
  it('returns nothing for an empty query or no match', () => {
    expect(matchIndexes('Go to line', '')).toEqual([])
    expect(matchIndexes('Go to line', 'xyz')).toEqual([])
  })
  it('marks a contiguous run, ignoring case', () => {
    expect(matchIndexes('Go to line', 'LIN')).toEqual([6, 7, 8])
  })
  it('prefers a run at a word start', () => {
    expect(matchIndexes('Toggle line', 'li')).toEqual([7, 8])
    expect(matchIndexes('Reline lines', 'lin')).toEqual([7, 8, 9])
  })
  it('falls back to a subsequence, preferring word starts', () => {
    expect(matchIndexes('Toggle heat map', 'thm')).toEqual([0, 7, 12])
    expect(matchIndexes('cab a', 'ab')).toEqual([1, 2])
  })
  it('lets spaces in a query go unmatched in a subsequence', () => {
    expect(matchIndexes('Toggle heat map', 'tog hm')).toEqual([0, 1, 2, 7, 12])
  })
})

describe('rankCommands', () => {
  it('returns everything for an empty query, recent ids first', () => {
    expect(ids(rankCommands(cmds, '', []))).toEqual(ids(cmds))
    expect(ids(rankCommands(cmds, '  ', ['next', 'wrap', 'gone', 'next']))).toEqual(['next', 'wrap', 'heat', 'goto', 'prev', 'slow'])
  })
  it('filters by subsequence', () => {
    expect(ids(rankCommands(cmds, 'err', []))).toEqual(['next', 'prev'])
    expect(rankCommands(cmds, 'zzz', [])).toEqual([])
  })
  it('ranks a prefix above a word start above the rest', () => {
    const l = [cmd('a', 'Rewrap lines'), cmd('b', 'Wrapped words'), cmd('c', 'Toggle wrap')]
    expect(ids(rankCommands(l, 'wrap', []))).toEqual(['b', 'c', 'a'])
  })
  it('ranks a contiguous run above a scattered subsequence', () => {
    const l = [cmd('a', 'Show all errors in view'), cmd('b', 'Show errors')]
    expect(ids(rankCommands(l, 'errors', []))).toEqual(['b', 'a'])
    const m = [cmd('x', 'Toggle heat map'), cmd('y', 'Hide trace map')]
    expect(ids(rankCommands(m, 'hm', []))[0]).toBe('x')
  })
  it('matches on the group when the label does not match, ranked lower', () => {
    const l = [cmd('a', 'Slow waits', 'Presets'), cmd('b', 'Presets reset', 'View')]
    expect(ids(rankCommands(l, 'presets', []))).toEqual(['b', 'a'])
  })
  it('lifts a recent command among equals, keeping the order otherwise', () => {
    const l = [cmd('a', 'Go one'), cmd('b', 'Go two'), cmd('c', 'Go six')]
    expect(ids(rankCommands(l, 'go', []))).toEqual(['a', 'b', 'c'])
    expect(ids(rankCommands(l, 'go', ['c']))[0]).toBe('c')
  })
  it('keeps disabled commands in the list', () => {
    expect(ids(rankCommands([cmd('a', 'Go', 'G', { disabled: true })], 'go', []))).toEqual(['a'])
  })
})

describe('sectionsOf', () => {
  it('groups by first appearance and puts recent ones first', () => {
    const l = rankCommands(cmds, '', ['slow', 'next'])
    const s = sectionsOf(l, new Set(['slow', 'next']))
    expect(s.map((x) => x.head)).toEqual(['Recent', 'View', 'Navigate'])
    expect(ids(s[0].items)).toEqual(['slow', 'next'])
    expect(ids(s[2].items)).toEqual(['goto', 'prev'])
  })
  it('groups a ranked list without a Recent section', () => {
    const s = sectionsOf(rankCommands(cmds, 'e', []), null)
    expect(s.map((x) => x.head).includes('Recent')).toBe(false)
    expect(s.flatMap((x) => ids(x.items)).sort()).toEqual(ids(rankCommands(cmds, 'e', [])).sort())
  })
})

describe('stepActive', () => {
  const l = [cmd('a', 'a'), cmd('b', 'b', 'g', { disabled: true }), cmd('c', 'c'), cmd('d', 'd')]
  it('skips disabled rows and wraps', () => {
    expect(stepActive(l, 0, 1, true)).toBe(2)
    expect(stepActive(l, 3, 1, true)).toBe(0)
    expect(stepActive(l, 0, -1, true)).toBe(3)
  })
  it('stops at the ends without wrapping', () => {
    expect(stepActive(l, 3, 1, false)).toBe(3)
    expect(stepActive(l, 0, -1, false)).toBe(0)
    expect(stepActive(l, -1, 1, false)).toBe(0)
    expect(stepActive(l, l.length, -1, false)).toBe(3)
  })
  it('stays put when nothing is enabled', () => {
    const off = [cmd('a', 'a', 'g', { disabled: true })]
    expect(stepActive(off, -1, 1, false)).toBe(-1)
    expect(stepActive([], -1, 1, true)).toBe(-1)
  })
})
