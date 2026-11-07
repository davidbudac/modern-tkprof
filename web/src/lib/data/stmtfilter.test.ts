import { describe, expect, it } from 'vitest'
import { filterChipParts, filterChipText, linesInRuns, mergeRuns, runFolds, runLines } from './stmtfilter'
import { foldHiding, visibleCount, type Fold } from './folds'

describe('the statement filter\'s folds', () => {
  const shown = (folds: Fold[], total: number) => { const out: number[] = []; for (let n = 1; n <= total; n++) if (!foldHiding(n, folds)) out.push(n); return out }

  it('keeps the runs and folds every stretch between them under the last kept line before it', () => {
    const f = runFolds([[3, 5], [9, 9], [12, 14]], 20, 'statement')
    expect(f.map((x) => [x.from, x.to])).toEqual([[1, 2], [5, 8], [9, 11], [14, 20]])
    expect(shown(f, 20)).toEqual([1, 3, 4, 5, 9, 12, 13, 14])
  })
  it('says how many lines come before the first run, on line 1', () => {
    const f = runFolds([[10, 12]], 12, 'statement')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ from: 1, to: 9, filter: true, auto: true, summary: '9 lines before the first statement' })
    expect(f[0].quiet).toBeUndefined() // the handle reads as a row with a summary
  })
  it('has no leading fold when the first run starts on line 1, and no trailing fold when the last ends the file', () => {
    expect(runFolds([[1, 4], [7, 9]], 9, 's').map((x) => [x.from, x.to])).toEqual([[4, 6]])
  })
  it('hides the whole file when the statements have no line in it', () => {
    const f = runFolds([], 50, 'statement')
    expect(f).toEqual([{ from: 1, to: 50, summary: 'no statement in this file', auto: true, filter: true }])
    expect(visibleCount(50, f)).toBe(1)
    expect(runFolds([], 0, 'statement')).toEqual([])
  })
  it('does not fold past the last run the engine sent when the list is cut', () => {
    expect(runFolds([[3, 4], [8, 8]], 100, 's', true).map((x) => [x.from, x.to])).toEqual([[1, 2], [4, 7]])
    expect(runFolds([[3, 4], [8, 8]], 100, 's', false).map((x) => [x.from, x.to])).toEqual([[1, 2], [4, 7], [8, 100]])
  })
  it('quiet filter folds: the handle is a kept row', () => {
    const f = runFolds([[3, 5]], 9, 's')
    expect(f[1]).toMatchObject({ from: 5, to: 9, quiet: true, filter: true })
  })
})

describe('runs', () => {
  it('merge when they touch or overlap', () => {
    expect(mergeRuns([[1, 3], [4, 6], [8, 12], [9, 9], [20, 21]])).toEqual([[1, 6], [8, 12], [20, 21]])
  })
  it('the lines of a list that lie in the runs, merged where adjacent (the Δ filter and the statement filter together)', () => {
    expect(linesInRuns([[5, 10], [20, 30]], [1, 5, 6, 9, 11, 25, 31, 40])).toEqual([[5, 6], [9, 9], [25, 25]])
    expect(linesInRuns([], [1, 2])).toEqual([])
    expect(linesInRuns([[1, 5]], [])).toEqual([])
  })
  it('count their lines', () => {
    expect(runLines([[1, 3], [7, 7]])).toBe(4)
  })
})

describe('the filter chip', () => {
  it('names a single statement by its sql_id and several by their number', () => {
    expect(filterChipParts(['c7ry5gr75qv4b'])).toEqual({ word: 'Filter: ', name: 'c7ry5gr75qv4b', unit: '', doing: '' })
    expect(filterChipText(filterChipParts(['a', 'b']))).toBe('Filter: 2 statements')
  })
  it('adds the lines it shows once the engine has answered, with a + while the list is cut', () => {
    expect(filterChipParts(['a'], 1204).doing).toBe(' · 1,204 lines')
    expect(filterChipParts(['a'], 1).doing).toBe(' · 1 line')
    expect(filterChipText(filterChipParts(['a', 'b', 'c'], 100000, true))).toBe('Filter: 3 statements · 100,000+ lines')
  })
})
