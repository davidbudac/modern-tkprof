import { describe, expect, it } from 'vitest'
import { AUTO_CHECK_BYTES, MAX_CHECK_BYTES, autoCheckOf, canExport, checkPath, currentOf, jsonSettle, jsonView, type JSONState } from './cutstate'

type P = { lines: number; bytes: number }
const A = '/api/cut?from=1&to=2'
const B = '/api/cut?from=1&to=9'

describe('useJSON state (F10)', () => {
  it('settled on the same path: the data is current', () => {
    const st: JSONState<P> = { path: A, data: { lines: 10, bytes: 100 } }
    const v = jsonView(st, A)
    expect(v).toEqual({ data: { lines: 10, bytes: 100 }, path: A, loading: false, error: undefined })
    expect(currentOf(v, A)).toEqual({ lines: 10, bytes: 100 })
  })

  it('another path pending: the data is retained for drawing but is not current', () => {
    const st: JSONState<P> = { path: A, data: { lines: 10, bytes: 100 } }
    const v = jsonView(st, B)
    expect(v.loading).toBe(true)
    expect(v.data).toEqual({ lines: 10, bytes: 100 })
    expect(v.path).toBe(A)
    expect(v.error).toBeUndefined()
    expect(currentOf(v, B)).toBeUndefined()
  })

  it('an error: no data, the error belongs to its path only', () => {
    const st: JSONState<P> = { path: B, error: 'boom' }
    expect(jsonView(st, B)).toEqual({ data: undefined, path: null, loading: false, error: 'boom' })
    expect(currentOf(jsonView(st, B), B)).toBeUndefined()
    // a newer path is loading: the old error is not shown for it
    expect(jsonView(st, A)).toMatchObject({ loading: true, error: undefined })
  })

  it('no path: nothing, not loading', () => {
    expect(jsonView({ path: A, data: { lines: 1, bytes: 1 } }, null)).toEqual({ path: null, loading: false })
    expect(currentOf(jsonView<P>({ path: null }, null), null)).toBeUndefined()
  })

  it('an aborted request never lands, whatever it settled with', () => {
    const st: JSONState<P> = { path: B, data: { lines: 2, bytes: 2 } }
    expect(jsonSettle(st, A, { data: { lines: 1, bytes: 1 } }, true)).toBe(st)
    expect(jsonSettle(st, A, { error: 'aborted' }, true)).toBe(st)
    expect(jsonSettle(st, A, { data: { lines: 1, bytes: 1 } }, false)).toEqual({ path: A, data: { lines: 1, bytes: 1 } })
    expect(jsonSettle(st, A, { error: 'x' }, false)).toEqual({ path: A, error: 'x' })
  })

  it('a late answer of an older query cannot regress the shown plan (out-of-order completion)', () => {
    // A requested, then B; B lands first; A's request was aborted when B was asked for
    let st: JSONState<P> = { path: null }
    st = jsonSettle(st, B, { data: { lines: 9, bytes: 9 } }, false)
    st = jsonSettle(st, A, { data: { lines: 1, bytes: 1 } }, true)
    expect(currentOf(jsonView(st, B), B)).toEqual({ lines: 9, bytes: 9 })
  })

  it("a live session's next snapshot: the same path's answer of the earlier document is not current", () => {
    // the client stays, the document is swapped: the plan of snapshot 1 must not authorise an export of snapshot 2
    const doc1 = { rev: 1 }
    const doc2 = { rev: 2 }
    const st = jsonSettle<P>({ path: null }, A, { data: { lines: 10, bytes: 100 } }, false, doc1)
    expect(currentOf(jsonView(st, A, doc1), A)).toEqual({ lines: 10, bytes: 100 })
    const v = jsonView(st, A, doc2)
    expect(v).toMatchObject({ loading: true, path: null, error: undefined })
    expect(v.data).toEqual({ lines: 10, bytes: 100 }) // still drawn, dimmed, while the new snapshot is planned
    expect(currentOf(v, A)).toBeUndefined()
    expect(autoCheckOf(currentOf(v, A))).toBe(false)
    expect(checkPath(currentOf(v, A), 'from=1&to=2', null)).toBeNull()
    // an error of the earlier snapshot is not shown for the new one either
    const bad = jsonSettle<P>({ path: null }, A, { error: 'boom' }, false, doc1)
    expect(jsonView(bad, A, doc2)).toMatchObject({ loading: true, error: undefined })
    // the new snapshot's answer is current
    const st2 = jsonSettle(st, A, { data: { lines: 12, bytes: 120 } }, false, doc2)
    expect(currentOf(jsonView(st2, A, doc2), A)).toEqual({ lines: 12, bytes: 120 })
  })
})

describe('the re-parse check (F11)', () => {
  const q = 'from=1&to=9'
  it('a retained small plan never checks a new selection automatically', () => {
    const small: JSONState<P> = { path: A, data: { lines: 10, bytes: 100 } }
    const current = currentOf(jsonView(small, B), B)
    expect(current).toBeUndefined()
    expect(autoCheckOf(current)).toBe(false)
    expect(checkPath(current, q, null)).toBeNull()
    expect(checkPath(current, q, q)).toBeNull() // asked for, but its plan is not there yet
  })

  it('a current small plan with lines checks itself; an empty one never', () => {
    expect(checkPath({ lines: 10, bytes: 100 }, q, null)).toBe(`/api/cut/check?${q}`)
    expect(autoCheckOf({ lines: 0, bytes: 0 })).toBe(false)
    expect(checkPath({ lines: 0, bytes: 0 }, q, q)).toBeNull()
  })

  it('a large plan is checked only when asked for this very query', () => {
    const big = { lines: 1e6, bytes: AUTO_CHECK_BYTES }
    expect(autoCheckOf(big)).toBe(false)
    expect(checkPath(big, q, null)).toBeNull()
    expect(checkPath(big, q, 'from=1&to=2')).toBeNull()
    expect(checkPath(big, q, q)).toBe(`/api/cut/check?${q}`)
  })

  it('above the engine limit an asked-for check says force=1', () => {
    const huge = { lines: 1e8, bytes: MAX_CHECK_BYTES + 1 }
    expect(checkPath(huge, q, q)).toBe(`/api/cut/check?${q}&force=1`)
    expect(checkPath(huge, '', '')).toBe('/api/cut/check?force=1')
  })
})

describe('exporting the new file', () => {
  it('needs the current plan to keep something and no export running', () => {
    expect(canExport(undefined, false)).toBe(false)
    expect(canExport({ lines: 0 }, false)).toBe(false)
    expect(canExport({ lines: 10 }, true)).toBe(false)
    expect(canExport({ lines: 10 }, false)).toBe(true)
  })
})
