import { describe, expect, it } from 'vitest'
import { decodeLine, elaOf, type DecodeContext, type LineDecode } from './linefields'

// one real line per kind (testdata/traces/19c)
const EXEC = 'EXEC #140646291810920:c=832,e=1025,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=3937172027,tim=54958079261'
const CLOSE = 'CLOSE #140646291822992:c=5,e=4,dep=0,type=1,tim=54958074538'
const WAIT = "WAIT #140124363549808: nam='db file sequential read' ela= 100 file#=10 block#=66151 blocks=1 obj#=721 tim=10778995443"
const WAIT_NET = "WAIT #139745605258360: nam='SQL*Net message from client' ela= 122 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10804499849"
const STAT = "STAT #140124363549808 id=1 cnt=0 pid=0 pos=1 obj=720 op='TABLE ACCESS BY INDEX ROWID EXP_HEAD$ (cr=2 pr=0 pw=0 str=1 time=29 us cost=2 size=68 card=1)'"
const BINDS = 'BINDS #140646291810920:'
const PARSING = "PARSING IN CURSOR #140124363561040 len=296 dep=0 uid=165 oct=3 lid=165 tim=10778820802 hv=3361819554 ad='8652bd60' sqlid='f6jyzt7462kx2'"
const XCTEND = 'XCTEND rlbk=0, rd_only=1, tim=10817777368'
const ERR = 'ERROR #140396176538616:err=1 tim=10804229719'
const PERR = 'PARSE ERROR #140396176538616:len=31 dep=0 uid=165 oct=3 lid=165 tim=10804212367 err=942'
const LOB = 'LOBREAD: type=PERSISTENT LOB,bytes=8191,c=661,e=1153,p=4,cr=1,cu=0,tim=11043951189'

const ctx: DecodeContext = {
  eventOf: (n) => (n === 'db file sequential read' ? { class: 'User I/O', p1Name: 'file#', p2Name: 'block#', p3Name: 'blocks' } : undefined),
  objectName: (o) => (o === 721 ? 'SYS.I_OBJ1' : undefined),
  clock: (t) => `12:00:00.${t % 1000}`,
  firstTim: 54958000000,
}
const f = (d: LineDecode | null) => Object.fromEntries((d?.fields ?? []).map((x) => [x.label, x.value]))

describe('decodeLine', () => {
  it('decodes a call', () => {
    const d = decodeLine(EXEC, 'call', ctx)!
    expect(d.title).toBe('EXEC #140646291810920')
    expect(f(d)).toMatchObject({
      CPU: '832 µs', Elapsed: '1.02 ms', 'Physical reads': '0', 'Library cache miss': 'hard parse', Rows: '0', Depth: '1',
      'Optimizer goal': 'ALL_ROWS', 'Plan hash': '3937172027', Time: '+79.3 ms from start · 12:00:00.261',
    })
  })
  it('decodes a close and falls back to the raw tim without context', () => {
    const d = decodeLine(CLOSE, 'call')!
    expect(f(d)).toMatchObject({ CPU: '5 µs', 'Close type': 'soft close, kept in the cursor cache', Time: '54958074538' })
    expect(f(d)['Library cache miss']).toBeUndefined()
  })
  it('decodes a wait with the event parameter names, object and class', () => {
    const d = decodeLine(WAIT, 'wait', ctx)!
    expect(f(d)).toMatchObject({
      Event: 'db file sequential read', Waited: '100 µs', Class: 'User I/O', 'file#': '10', 'block#': '66151', blocks: '1', Object: 'SYS.I_OBJ1 (721)',
    })
    expect(d.fields.find((x) => x.label === 'Object')?.hint).toBe('obj#=721')
  })
  it('falls back to the trace labels for parameters, and drops obj#=-1', () => {
    const d = decodeLine(WAIT_NET, 'wait')!
    expect(f(d)).toMatchObject({ Event: 'SQL*Net message from client', Waited: '122 µs', 'driver id': '1952673792', '#bytes': '1', p3: '0' })
    expect(f(d).Object).toBeUndefined()
  })
  it('decodes a STAT line', () => {
    const d = decodeLine(STAT, 'stat', ctx)!
    expect(f(d)).toMatchObject({
      'Plan line': '1 (parent 0)', Operation: 'TABLE ACCESS BY INDEX ROWID EXP_HEAD$', Rows: '0', Starts: '1', 'Consistent gets': '2', Time: '29 µs', Cost: '2', Size: '68', 'Estimated rows': '1',
    })
    expect(f(d).Object).toBe('720')
  })
  it('decodes the bind lines', () => {
    expect(decodeLine(BINDS, 'binds')!.fields[0].value).toBe('#140646291810920')
    expect(decodeLine(' Bind#0', 'bind-line')!.fields[0]).toEqual({ label: 'Position', value: '0' })
    expect(f(decodeLine('  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00', 'bind-line'))).toMatchObject({ Datatype: 'NUMBER (2)', 'Max length': '22' })
    const buf = decodeLine('  kxsbbbfp=7f713ee9fa20  bln=32  avl=00  flg=01', 'bind-line')!
    expect(f(buf)).toMatchObject({ 'Actual length': '0 (NULL)', 'Buffer length': '32', Flags: '01' })
    expect(buf.note).toMatch(/NULL/)
    expect(f(decodeLine('  value=42', 'bind-line'))).toEqual({ Value: '42' })
    expect(decodeLine('  value=Unhandled datatype (-73) found in kxsbndinf', 'bind-line')!.note).toMatch(/memory dump/)
    expect(decodeLine('  No oacdef for this bind.', 'bind-line')!.note).toMatch(/dup/)
  })
  it('decodes XCTEND', () => {
    expect(f(decodeLine(XCTEND, 'xctend'))).toMatchObject({ Outcome: 'commit', 'Read only': 'yes, nothing to commit' })
    expect(f(decodeLine('XCTEND rlbk=1, rd_only=0, tim=0', 'xctend'))).toMatchObject({ Outcome: 'rollback', 'Read only': 'no' })
  })
  it('decodes PARSING IN CURSOR', () => {
    const d = decodeLine(PARSING, 'parsing-in-cursor', ctx)!
    expect(f(d)).toMatchObject({ Length: '296', Depth: '0', Command: 'SELECT (3)', 'Hash value': '3361819554', Address: '8652bd60', 'SQL ID': 'f6jyzt7462kx2' })
    expect(f(decodeLine(PARSING.replace('oct=3', 'oct=99'), 'parsing-in-cursor'))).toMatchObject({ Command: '99' })
  })
  it('decodes errors', () => {
    expect(f(decodeLine(ERR, 'error'))).toMatchObject({ Error: 'ORA-00001' })
    const d = decodeLine(PERR, 'parse-error')!
    expect(d.title).toBe('PARSE ERROR #140396176538616')
    expect(f(d)).toMatchObject({ Error: 'ORA-00942', Length: '31', Command: 'SELECT (3)' })
  })
  it('decodes LOB operations', () => {
    expect(f(decodeLine(LOB, 'lob'))).toMatchObject({ 'LOB type': 'PERSISTENT LOB', Bytes: '8,191', Elapsed: '1.15 ms' })
  })
  it('decodes markers', () => {
    expect(f(decodeLine('*** SESSION ID:(274.33259) 2026-10-24T09:30:16.757605+00:00', 'marker'))).toMatchObject({ SID: '274', 'Serial#': '33259', Time: '2026-10-24T09:30:16.757605+00:00' })
    const m = decodeLine('*** MODULE NAME:(mtk_bind_types) 2026-10-24T09:30:16.757615+00:00', 'marker')!
    expect(m.title).toBe('Module name')
    expect(f(m).Value).toBe('mtk_bind_types')
    const t = decodeLine('*** 2026-10-22T11:35:03.510078+00:00 (PDB1(3))', 'marker')!
    expect(t.title).toBe('Timestamp')
    expect(f(t)).toMatchObject({ Container: 'PDB1(3)' })
    expect(decodeLine('*** TRACE CONTINUED FROM FILE /u01/trace/x.trc ***', 'marker')!.fields[0].value).toBe('/u01/trace/x.trc')
  })
  it('returns null where there is nothing to decode', () => {
    for (const k of ['blank', 'header', 'separator', 'sql-text', 'end-of-stmt', 'unknown', 'rpc'] as const) expect(decodeLine('whatever', k, ctx)).toBeNull()
    expect(decodeLine('not a call line', 'call')).toBeNull()
  })
})

describe('elaOf', () => {
  it('reads e= of calls and ela= of waits', () => {
    expect(elaOf(EXEC, 'call')).toBe(1025)
    expect(elaOf(CLOSE, 'call')).toBe(4)
    expect(elaOf(WAIT, 'wait')).toBe(100)
    expect(elaOf(WAIT_NET, 'wait')).toBe(122)
  })
  it('is -1 for other kinds and lines without the field', () => {
    expect(elaOf(STAT, 'stat')).toBe(-1)
    expect(elaOf(EXEC, 'wait')).toBe(-1)
    expect(elaOf('PARSE #1:c=1', 'call')).toBe(-1)
  })
})
