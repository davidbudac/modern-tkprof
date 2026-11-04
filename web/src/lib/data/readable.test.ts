import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LineKind } from './lines'
import { bindAttrSegs, describeLine, describeMarker, parseStat, planDump, sqlSegs, statementTones, type Seg } from './readable'

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
    expect(text(v.parts)).toMatch(/^[\d.]+ (µs|ms) · direct path read · MTK_ORDERS · file \d+ · block \d+ · \d+ blocks?$/)
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

describe('a STAT line as a plan row', () => {
  it('its columns, and an estimate 10× off flagged', () => {
    const at = trc.findIndex((l) => l.startsWith('STAT #139745604251096 id=2')) + 1
    const v = describeLine(trc[at - 1], 'stat', at, { planAt: () => ({ depth: 1, self: 634138, root: 636589 }) })
    expect(v.plan).toMatchObject({ id: 2, depth: 1, op: 'TABLE ACCESS FULL', name: 'MTK_ORDERS', starts: 1, eRows: 100000, aRows: 100001, cost: 137, time: 634138, cr: 498, pr: 496, pw: 0, off: false })
    const off = describeLine("STAT #1 id=3 cnt=1000 pid=2 pos=1 obj=5 op='INDEX RANGE SCAN T_PK (cr=70 pr=0 pw=0 str=1 time=644 us cost=3 size=0 card=50)'", 'stat', 1)
    expect(off.plan?.off).toBe(true)
  })
})

describe('the rest of the lines, readable', () => {
  it('wait parameters: labelled, the noise left out', () => {
    const dpr = describeLine("WAIT #139745604251096: nam='direct path read' ela= 39 file number=12 first dba=169947 block cnt=5 obj#=108611 tim=10805135198", 'wait', 1)
    expect(text(dpr.parts)).toBe('39 µs · direct path read · obj# 108611 · file 12 · block 169947 · 5 blocks')
    const net = describeLine("WAIT #139745605258360: nam='SQL*Net more data to client' ela= 38 driver id=1952673792 #bytes=8103 p3=0 obj#=-1 tim=10804499034", 'wait', 1)
    expect(text(net.parts)).toBe('38 µs · SQL*Net more data to client · 8,103 bytes')
  })
  it('bind attribute lines (testdata/traces/19c/basic_binds.trc lines 56-59)', () => {
    expect(text(bindAttrSegs('  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00'))).toBe('type NUMBER, up to 22 bytes')
    expect(text(bindAttrSegs('  oacflg=03 fl2=1400000 frm=00 csi=00 siz=72 off=0'))).toBe('no character set (not a character type)')
    expect(text(bindAttrSegs('  kxsbbbfp=7f713eea01f8  bln=22  avl=02  flg=05'))).toBe('value length 2 of a 22-byte buffer')
    expect(text(bindAttrSegs('  value=42'))).toBe('as printed: 42')
    expect(text(bindAttrSegs('  oacflg=10 fl2=0001 frm=01 csi=873 siz=32 off=0'))).toMatch(/^character set AL32UTF8 · /)
  })
  it('*** markers by name, timestamps as a clock time', () => {
    const m = describeMarker('*** MODULE NAME:(mtk_basic_binds) 2026-10-22T11:35:03.510108+00:00')
    expect([m.label, text(m.parts)]).toEqual(['MODULE', 'mtk_basic_binds'])
    expect(m.wall).toMatchObject({ clock: '11:35:03.510', micros: '108' })
    const t = describeMarker('*** 2026-10-22T11:35:03.510078+00:00 (PDB1(3))')
    expect([t.label, text(t.parts)]).toEqual(['TIME', '2026-10-22 UTC+00:00 · PDB1(3)'])
    expect(t.wall).toMatchObject({ clock: '11:35:03.510', micros: '078' })
  })
  it('SQL text: keywords, strings and binds apart', () => {
    const s = sqlSegs("select c.id from mtk_cust c where c.name = 'x' and c.id = :b1 -- note")
    expect(s.filter((x) => typeof x !== 'string').map((x) => typeof x === 'string' ? '' : `${x.c}:${x.t}`))
      .toEqual(['kw:select', 'kw:from', 'kw:where', "str:'x'", 'kw:and', 'bind::b1', 'cmt:-- note'])
    expect(text(s)).toBe("select c.id from mtk_cust c where c.name = 'x' and c.id = :b1 -- note")
  })
})
