import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LineKind } from './lines'
import { describeLine, parseStat, planDump, statementTones, type Seg } from './readable'

// lines of testdata/traces/19c/io_waits.trc
const trc = readFileSync(new URL('../../../../testdata/traces/19c/io_waits.trc', import.meta.url), 'utf8').split('\n')
const text = (segs: Seg[]) => segs.map((s) => (typeof s === 'string' ? s : s.t)).join('')

describe('describeLine', () => {
  it('a call: elapsed, CPU, rows, gets and a hard parse', () => {
    const v = describeLine('PARSE #139745604251096:c=92,e=907,p=0,cr=0,cu=0,mis=1,r=0,dep=0,og=1,plh=3570327658,tim=10804502774', 'call', 87)
    expect(v.label).toBe('PARSE')
    expect(text(v.parts)).toBe('907 µs · cpu 92 µs · hard parse')
    expect(v.bar).toEqual({ us: 907, cpu: 92, role: 'cpu' })
  })
  it('a wait: its time, event, object and parameters', () => {
    const line = trc.find((l) => l.includes("nam='direct path read' ") && l.includes('obj#=108611'))!
    const v = describeLine(line, 'wait', 1, { objectName: (o) => (o === 108611 ? 'MTK_ORDERS' : undefined), eventOf: () => ({ class: 'User I/O', idle: false, role: 'userio' }) })
    expect(v.label).toBe('WAIT')
    expect(text(v.parts)).toMatch(/^[\d.]+ (µs|ms) · direct path read · MTK_ORDERS · file number \d+  first dba \d+  block cnt \d+$/)
    expect(v.bar?.role).toBe('userio')
  })
  it('a STAT line: the operation, object, rows against the estimate', () => {
    const s = parseStat("STAT #139745604251096 id=2 cnt=100001 pid=1 pos=1 obj=108611 op='TABLE ACCESS FULL MTK_ORDERS (cr=498 pr=496 pw=0 str=1 time=634138 us cost=137 size=1300000 card=100000)'")!
    expect(s).toMatchObject({ id: 2, pid: 1, op: 'TABLE ACCESS FULL', name: 'MTK_ORDERS', cnt: 100001, card: 100000, time: 634138, cr: 498 })
  })
})

describe('planDump', () => {
  it('depth and own time of each plan line', () => {
    const at = trc.findIndex((l) => l.startsWith('STAT #139745604251096 id=1')) + 1
    const lineAt = (n: number) => ({ text: trc[n - 1], kind: (trc[n - 1].startsWith('STAT ') ? 'stat' : 'unknown') as LineKind })
    const d = planDump(lineAt, at + 1)
    expect(d.get(at)).toEqual({ depth: 0, self: 636589 - 634138, root: 636589 })
    expect(d.get(at + 1)).toEqual({ depth: 1, self: 634138, root: 636589 })
  })
})

describe('statementTones', () => {
  it('ranks by elapsed; recursive SYS SQL stays neutral', () => {
    const t = statementTones([{ id: 0, parsingUserId: 0, minDepth: 1 }, { id: 1, parsingUserId: 5, minDepth: 0 }, { id: 2, parsingUserId: 5, minDepth: 0 }], (id) => [900, 10, 20][id])
    expect(t.get(0)).toBeUndefined()
    expect(t.get(2)).toEqual({ token: '--c-cpu', shade: 0 })
    expect(t.get(1)).toEqual({ token: '--c-network', shade: 0 })
  })
})
