import { describe, expect, it } from 'vitest'
import { filterChipParts, filterChipText, hlStops, linesInRuns, mergeRuns, runFolds, runLines } from './stmtfilter'
import { composeFilterFolds, foldHiding, visibleCount, type Fold } from './folds'
import { hotStep } from './lines'

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

describe('hlStops: where the highlighted statements show up', () => {
  it('merges the runs of every statement into one list of starts, in line order, each once', () => {
    const s = hlStops([{ runs: [[10, 20], [90, 95]] }, { runs: [[21, 30], [50, 60]] }, { runs: [[50, 52]] }])
    expect(s.starts).toEqual([10, 21, 50, 90])
    expect(s.runs).toBe(5)
    expect([s.first, s.last]).toEqual([10, 95])
  })
  it('keeps the start of a statement that begins right where another ends: a stop each', () => {
    expect(hlStops([{ runs: [[1, 4]] }, { runs: [[5, 9]] }]).starts).toEqual([1, 5])
  })
  it('stepping over them with hotStep: next and previous start, never the line itself', () => {
    const { starts } = hlStops([{ runs: [[10, 20], [90, 95]] }, { runs: [[50, 60]] }])
    expect(hotStep(starts, 10, 1)).toBe(50)
    expect(hotStep(starts, 30, -1)).toBe(10) // from the middle of a run: the start of that run
    expect(hotStep(starts, 50, -1)).toBe(10)
    expect(hotStep(starts, 95, 1)).toBeUndefined()
    expect(hotStep(starts, 5, -1)).toBeUndefined()
  })
  it('nothing highlighted, or no lines of it in this file: no stops, no bounds', () => {
    expect(hlStops([])).toEqual({ starts: [], first: 0, last: 0, runs: 0, truncated: false })
    expect(hlStops([{ runs: [] }], true)).toEqual({ starts: [], first: 0, last: 0, runs: 0, truncated: true })
  })
})

describe('the statement filter with the view\'s own folds', () => {
  // io_waits.trc-like: a statement parsed at 73..77 (rule 73, CURSOR 74, text 75, END OF STMT 76, PARSE 77), a bind block at 78..84 whose attribute lines fold under the bind at 80,
  // its run is 73..95; the next statement's run is 118..131; the rule above it (118) belongs to it, the frame fold of that rule has its handle at 117
  const quiet = (from: number, to: number, more: Partial<Fold> = {}): Fold => ({ from, to, summary: '', auto: true, quiet: true, ...more })
  const own = [quiet(72, 73, { frame: true }), quiet(75, 76, { frame: true }), quiet(80, 84), quiet(117, 118, { frame: true }), quiet(121, 122, { frame: true })]
  const total = 140
  const shown = (folds: Fold[]) => { const out: number[] = []; for (let n = 1; n <= total; n++) if (!foldHiding(n, folds)) out.push(n); return out }

  it('shows only the statement\'s own rows: no framing line, no attribute line of a bind', () => {
    const rows = shown(composeFilterFolds(own, runFolds([[73, 95], [118, 131]], total, 'statement')))
    for (const hidden of [73, 76, 80 + 1, 82, 83, 84, 118, 122]) expect(rows).not.toContain(hidden)
    expect(rows).toContain(74) // CURSOR
    expect(rows).toContain(80) // the bind's own row
    expect(rows).toContain(95) // CLOSE
    expect(rows).toContain(119) // the next run's CURSOR
    expect(rows).not.toContain(100) // another statement's line
  })
  it('without the composition the framing and attribute rows are back (the regression)', () => {
    const rows = shown(runFolds([[73, 95], [118, 131]], total, 'statement'))
    for (const row of [73, 76, 81, 118]) expect(rows).toContain(row)
  })
})
