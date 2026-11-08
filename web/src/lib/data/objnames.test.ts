import { describe, expect, it } from 'vitest'
import { containerNames, DEFAULT_NAME_OPTS, nameOptsOf, objectNames, objParts, objText, typeOfOp } from './objnames'
import type { Marker, PlanLine } from './types'

const line = (obj: number, op: string, object: string): PlanLine => ({
  plan: 0, id: 1, parentId: 0, pos: 1, depth: 0, obj, op, object, rows: 0, starts: 0, cr: 0, pr: 0, pw: 0, timeUs: 0, cost: 0, size: 0, card: 0, hasStats: true,
})

describe('object names', () => {
  it('read the type off a plan operation', () => {
    expect(typeOfOp('TABLE ACCESS FULL')).toBe('TABLE')
    expect(typeOfOp('INDEX RANGE SCAN')).toBe('INDEX')
    expect(typeOfOp('LOAD TABLE CONVENTIONAL')).toBe('TABLE')
    expect(typeOfOp('MAT_VIEW ACCESS FULL')).toBe('MATERIALIZED VIEW')
    expect(typeOfOp('HASH JOIN')).toBeUndefined()
  })
  it('come from the bundle first, then from the plans (io_waits: MTK_CUST, I_EXP_HEAD$), a later plan line filling in a type', () => {
    const names = objectNames(
      [{ id: 108609, owner: 'MTK', name: 'MTK_CUST', type: 'TABLE' }],
      [line(108609, 'TABLE ACCESS FULL', 'MTK_CUST'), line(721, 'HASH JOIN', 'I_EXP_HEAD$'), line(721, 'INDEX UNIQUE SCAN', 'I_EXP_HEAD$'), line(0, 'SORT AGGREGATE', '')],
    )
    expect(names.get(108609)).toEqual({ obj: 108609, name: 'MTK_CUST', owner: 'MTK', sub: undefined, type: 'TABLE', from: 'ref' })
    expect(names.get(721)).toEqual({ obj: 721, name: 'I_EXP_HEAD$', type: 'INDEX', from: 'plan' })
    expect(names.has(0)).toBe(false)
  })
  it('are written with what the options ask for', () => {
    const o = { obj: 5, name: 'SALES', owner: 'SH', sub: 'P2026Q1', type: 'TABLE PARTITION', from: 'ref' as const }
    expect(objText(o, DEFAULT_NAME_OPTS, 'PDB1')).toBe('SH.SALES.P2026Q1')
    expect(objText(o, { schema: false, pdb: true, sub: false, num: true }, 'PDB1')).toBe('PDB1/SALES #5')
    expect(objText({ obj: 9, from: 'none' }, DEFAULT_NAME_OPTS)).toBe('obj# 9')
    expect(objText({ obj: -1, from: 'none' }, DEFAULT_NAME_OPTS)).toBe('no object')
    expect(objParts({ obj: 721, name: 'I_EXP_HEAD$', from: 'plan' }, DEFAULT_NAME_OPTS)).toEqual({ name: 'I_EXP_HEAD$', known: true })
  })
  it('take their options back from storage, the defaults for what is missing', () => {
    expect(nameOptsOf({ pdb: true, schema: 'yes' })).toEqual({ ...DEFAULT_NAME_OPTS, pdb: true })
    expect(nameOptsOf(null)).toEqual(DEFAULT_NAME_OPTS)
  })
})

describe('container names', () => {
  it('come from the timestamp lines (PDB1(3)); other markers do not count', () => {
    const m = (kind: number, text: string): Marker => ({ line: 1, kind, text, time: '', hasTime: true })
    expect([...containerNames([m(1, 'PDB1(3)'), m(1, 'CDB$ROOT(1)'), m(1, ''), m(8, 'X(9)'), m(1, 'PDB1(3)')])]).toEqual([['3', 'PDB1'], ['1', 'CDB$ROOT']])
  })
})
