import { describe, expect, it } from 'vitest'
import { execSummaryLines, execSummaryOf, loadExecSummary, topWaits } from './execsummary'
import type { ExecDetail } from './source'
import type { Execution } from './derive'
import { makeDoc } from './testdoc'
import { CallKind } from './types'

const part = (calls = 0) => ({ calls, c: 0, e: 0, p: 0, cr: 0, cu: 0, r: 0 })
const detail: ExecDetail = {
  plh: 42, parse: part(1), exec: part(1), fetch: part(3), total: part(5),
  waits: [{ event: 0, count: 2, us: 100 }, { event: 1, count: 1, us: 900 }, { event: 2, count: 4, us: 100 }], execWaits: 0, binds: [], bindLine: 17, line: 10,
}
const row: Execution = { line: 10, cursor: 3, execNo: 2, exec: 0, fetches: 3, startTim: 0, endTim: 1500, e: 1500, c: 400, p: 5, cr: 100, cu: 20, r: 7, waitEla: 0, idleEla: 0, bindSet: -1, ctx: 0 }

describe('execSummaryOf', () => {
  it('takes the numbers of the row and the waits of the detail', () => {
    const s = execSummaryOf(detail, row, 9)
    expect(s).toMatchObject({ execNo: 2, total: 9, elapsedUs: 1500, cpuUs: 400, rows: 7, fetches: 3, disk: 5, gets: 120, hardParse: false, waitUs: 1100, plh: 42, bindLine: 17 })
    expect(execSummaryOf(detail, row, 9, true).hardParse).toBe(true)
  })
  it('falls back to the detail for the fetch count', () => {
    expect(execSummaryOf(detail, { ...row, fetches: 0 }, 1).fetches).toBe(3)
  })
})

describe('topWaits', () => {
  it('sorts by time and keeps n', () => {
    const s = execSummaryOf(detail, row, 1)
    expect(topWaits(s, 2).map((w) => w.event)).toEqual([1, 2])
    expect(topWaits(s).length).toBe(3)
  })
})

describe('execSummaryLines', () => {
  it('names the waits', () => {
    const l = execSummaryLines(execSummaryOf(detail, row, 9), (id) => `ev${id}`)
    expect(l[0]).toBe('Execution 2 of 9 · plan hash 42')
    expect(l).toContain('Waits: 7 · 1.10 ms')
    expect(l[l.length - 3]).toBe('  ev1 · 1 · 900 µs')
  })
})

describe('loadExecSummary', () => {
  it('finds the execution of a statement, caches it and gives null for an unknown one', async () => {
    const doc = await makeDoc([
      { ctx: 0, stmt: 0, kind: CallKind.parse, e: 50, mis: 1 },
      { ctx: 0, stmt: 0, kind: CallKind.exec, e: 100, r: 3 },
    ])
    const none = await loadExecSummary(doc, 0, 0, 99)
    expect(none).toBeNull()
    const a = await loadExecSummary(doc, 0, 0, 0)
    expect(a).toMatchObject({ execNo: 0, total: 1, elapsedUs: 100, rows: 3, hardParse: true })
    expect(await loadExecSummary(doc, 0, 0, 0)).toBe(a)
  })
})
