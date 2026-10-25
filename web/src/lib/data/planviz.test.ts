import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TraceDoc } from './doc'
import { MAX_LINK_CHARS, planRows, planVizUrl, type PlanRow } from './planviz'
import type { RawDocument } from './types'

const pl = (id: number, parentId: number, depth: number, op: string, extra = {}) =>
  ({ plan: 0, id, parentId, pos: id, depth, obj: 0, op, object: '', rows: 10 * (id + 1), starts: 1, cr: 5, pr: 1, pw: 0, timeUs: 100, cost: -1, size: -1, card: -1, hasStats: true, ...extra })

async function tinyDoc(): Promise<TraceDoc> {
  const raw = {
    format: 3, version: 'test',
    file: {}, span: { firstTim: 0, lastTim: 0, firstWallUs: 0, lastWallUs: 0, firstLine: 1, lastLine: 1 },
    statements: [{ id: 0, sqlId: 'abc123', text: 'select * from t', cursors: [0] }],
    cursors: [{ id: 0, statement: 0, line: 3, context: 0 }],
    plans: [{ id: 0, line: 40, cursor: 0, statement: 0, planHash: 777, first: 0, n: 3 }],
    planLines: [
      pl(1, 0, 0, 'SELECT STATEMENT'),
      pl(2, 1, 1, 'TABLE ACCESS FULL', { object: 'T', obj: 55, card: 1000, size: 8000, cost: 3 }),
      pl(3, 2, 2, 'INDEX RANGE SCAN'),
    ],
    markers: [], diag: {}, stats: { statements: [], profile: { rows: [] }, events: [] },
  } as unknown as RawDocument
  return TraceDoc.fromRaw(raw)
}

describe('planRows', () => {
  it('builds one row per plan line; the root has no parent_id', async () => {
    const doc = await tinyDoc()
    const rows = planRows(doc, doc.plans[0])
    expect(rows).toHaveLength(3)
    expect(rows[0]).not.toHaveProperty('parent_id')
    expect(rows[1].parent_id).toBe(1)
    expect(rows[2].parent_id).toBe(2)
    expect(rows[1]).toMatchObject({ id: 2, depth: 1, operation: 'TABLE ACCESS FULL', object_name: 'T', object_id: 55, cardinality: 1000, bytes: 8000, cost: 3 })
    expect(rows[0]).not.toHaveProperty('cardinality') // -1 = unknown is omitted
    expect(rows[0]).toMatchObject({ actual_rows: 20, starts: 1, actual_elapsed_time: 100, cr_buffer_gets: 5, physical_reads: 1, sql_id: 'abc123', plan_hash_value: '777' })
  })

  it('puts sql_text, execution and trace_line on the first row only', async () => {
    const doc = await tinyDoc()
    const rows = planRows(doc, doc.plans[0])
    expect(rows[0]).toMatchObject({ sql_text: 'select * from t', execution: 1, trace_line: 40 })
    for (const r of rows.slice(1)) for (const k of ['sql_text', 'execution', 'trace_line']) expect(r).not.toHaveProperty(k)
  })
})

describe('planVizUrl', () => {
  const rows: PlanRow[] = [{ id: 1, depth: 0, operation: 'SELECT STATEMENT' }, { id: 2, parent_id: 1, depth: 1, operation: 'TABLE ACCESS FULL' }]

  it('round-trips through the fragment', async () => {
    const url = await planVizUrl('https://viz.example/app/#old', rows)
    expect(url.startsWith('https://viz.example/app/#gz=')).toBe(true)
    const b64 = url.slice(url.indexOf('#gz=') + 4)
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/)
    const payload = JSON.parse(gunzipSync(Buffer.from(b64, 'base64url')).toString('utf8'))
    expect(payload.viewMode).toBe('hierarchical')
    expect(payload.plans).toHaveLength(1)
    expect(JSON.parse(payload.plans[0].rawInput)).toEqual(rows)
  })

  it('a big, incompressible plan exceeds MAX_LINK_CHARS (the UI then copies JSON instead of linking)', async () => {
    let seed = 1
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff).toString(36)
    const big: PlanRow[] = Array.from({ length: 4000 }, (_, i) => ({ id: i, depth: 1, operation: rnd() + rnd() + rnd() + rnd() + rnd() + rnd() }))
    expect((await planVizUrl('https://viz.example/', big)).length).toBeGreaterThan(MAX_LINK_CHARS)
  })
})
