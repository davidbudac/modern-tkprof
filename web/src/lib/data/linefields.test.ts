import { describe, expect, it } from 'vitest'
import { decodeLine, elaOf, splitZeros, COMMAND_NAMES, type DecodeContext, type LineDecode } from './linefields'
import type { BindAt } from './bindat'

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
    expect(f(decodeLine(PARSING.replace('oct=3', 'oct=999'), 'parsing-in-cursor'))).toMatchObject({ Command: '999' })
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

const V = { verbose: true }
const SAMPLE = 'EXEC #139714635394512:c=174,e=174,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=0,tim=10960426058'
const byLabel = (d: LineDecode | null) => Object.fromEntries((d?.fields ?? []).map((x) => [x.label, x]))

describe('decodeLine verbose', () => {
  it('lists every token of a call in the order written, zeros included', () => {
    const d = decodeLine(SAMPLE, 'call', { clock: (t) => `12:00:00.${t % 1000}`, firstTim: 10960000000 }, V)!
    expect(d.kindLabel).toBe('Call')
    expect(d.fields.map((x) => x.raw)).toEqual(['c=174', 'e=174', 'p=0', 'cr=0', 'cu=0', 'mis=0', 'r=1', 'dep=0', 'og=1', 'plh=0', 'tim=10960426058', undefined])
    expect(d.fields.map((x) => x.label)).toEqual([
      'CPU', 'Elapsed', 'Physical reads', 'Consistent gets', 'Current gets', 'Library cache miss', 'Rows', 'Depth', 'Optimizer goal', 'Plan hash', 'Time', 'Elapsed − CPU',
    ])
    const f = byLabel(d)
    expect(f.CPU).toMatchObject({ value: '174 µs', hint: '174 µs', desc: 'CPU time this call consumed' })
    expect(f['Physical reads'].value).toBe('0')
    expect(f['Library cache miss']).toMatchObject({ value: 'soft parse / cursor found', desc: 'library-cache misses: 1 means a hard parse' })
    expect(f.Depth.value).toBe('top-level (issued by the client)')
    expect(f['Optimizer goal'].value).toBe('ALL_ROWS')
    expect(f['Plan hash'].value).toBe('0 (no plan hash yet)')
    expect(f.Time.value).toBe('+426 ms from start · 12:00:00.58')
    expect(f.Time.hint).toBe('10,960,426,058 µs on the process clock')
    expect(f['Elapsed − CPU']).toMatchObject({ value: '0 µs', desc: 'time not on CPU: waits or run-queue' })
  })
  it('translates recursive depth, hard parses, close types and unknown keys', () => {
    const f = byLabel(decodeLine(EXEC.replace('dep=1', 'dep=2').replace('e=1025', 'e=2000'), 'call', {}, V))
    expect(f.Depth.value).toBe('recursive, depth 2')
    expect(f['Library cache miss'].value).toBe('hard parse')
    expect(f['Elapsed − CPU']).toMatchObject({ value: '1.17 ms', hint: '1,168 µs' })
    expect(byLabel(decodeLine(CLOSE, 'call', {}, V))['Close type'].value).toBe('soft close, kept in the cursor cache')
    const u = decodeLine('FETCH #1:c=1,e=2,zz=7,tim=0', 'call', {}, V)!
    expect(u.fields.find((x) => x.label === 'zz')).toEqual({ label: 'zz', value: '7', raw: 'zz=7', desc: 'not a documented field' })
    expect(byLabel(decodeLine('FETCH #1:c=1,e=2,zz=7,tim=0', 'call', {}, V)).Time.value).toBe('0')
  })
  it('leaves the hover card output alone without verbose', () => {
    const d = decodeLine(SAMPLE, 'call', ctx)!
    expect(d.fields.every((x) => x.raw === undefined && x.desc === undefined)).toBe(true)
    expect(d.fields.map((x) => x.label)).not.toContain('Elapsed − CPU')
  })
  it('decodes a wait with named parameters, object and raw tokens', () => {
    const d = decodeLine(WAIT, 'wait', ctx, V)!
    expect(d.kindLabel).toBe('Wait event')
    expect(d.fields.map((x) => x.raw)).toEqual(["nam='db file sequential read'", 'ela= 100', undefined, 'file#=10', 'block#=66151', 'blocks=1', 'obj#=721', 'tim=10778995443'])
    expect(byLabel(d).Waited).toMatchObject({ value: '100 µs', hint: '100 µs' })
    expect(byLabel(d).Object.value).toBe('SYS.I_OBJ1 (721)')
    expect(byLabel(d)['file#']).toMatchObject({ value: '10', hint: 'p1' })
    const n = decodeLine(WAIT_NET, 'wait', {}, V)!
    expect(byLabel(n).Object.value).toBe('none (-1)')
  })
  it('decodes STAT, XCTEND, PARSING and errors', () => {
    const s = decodeLine(STAT, 'stat', ctx, V)!
    expect(s.fields.map((x) => x.label)).toEqual(['Plan line', 'Rows', 'Parent', 'Position', 'Object', 'Operation', 'Consistent gets', 'Physical reads', 'Physical writes', 'Starts', 'Time', 'Cost', 'Size', 'Estimated rows'])
    expect(byLabel(s).Time).toMatchObject({ value: '29 µs', raw: 'time=29 us' })
    expect(byLabel(s).Operation.value).toBe('TABLE ACCESS BY INDEX ROWID EXP_HEAD$')
    const x = byLabel(decodeLine(XCTEND, 'xctend', {}, V))
    expect(x.Outcome.value).toBe('commit')
    expect(x['Read only'].value).toBe('read-only transaction')
    expect(byLabel(decodeLine('XCTEND rlbk=1, rd_only=0, tim=5', 'xctend', {}, V))['Read only'].value).toBe('changes were made')
    const p = decodeLine(PARSING, 'parsing-in-cursor', {}, V)!
    expect(p.fields.map((y) => y.raw)).toEqual(['len=296', 'dep=0', 'uid=165', 'oct=3', 'lid=165', 'tim=10778820802', 'hv=3361819554', "ad='8652bd60'", "sqlid='f6jyzt7462kx2'"])
    expect(byLabel(p).Command.value).toBe('SELECT (3)')
    const e = decodeLine(PERR, 'parse-error', {}, V)!
    expect(byLabel(e).Error.value).toBe('ORA-00942')
    expect(e.fields.map((y) => y.label)).toEqual(['Length', 'Depth', 'Parsing user id', 'Command', 'Privilege user id', 'Time', 'Error'])
    expect(COMMAND_NAMES[170]).toBe('CALL METHOD')
    expect(byLabel(decodeLine(LOB, 'lob', {}, V)).Bytes.value).toBe('8,191')
    expect(byLabel(decodeLine(LOB, 'lob', {}, V))['LOB type'].raw).toBe('type=PERSISTENT LOB')
  })
  it('gives markers a raw token and a description', () => {
    const m = decodeLine('*** CLIENT ID:(abc) 2026-10-24T09:30:16.757605+00:00', 'marker', {}, V)!
    expect(m.fields.map((x) => x.raw)).toEqual(['(abc)', '2026-10-24T09:30:16.757605+00:00'])
    expect(m.fields[0].desc).toMatch(/set_identifier/)
    expect(decodeLine('*** CLIENT ID:(abc) 2026-10-24T09:30:16.757605+00:00', 'marker')!.fields[0]).toEqual({ label: 'Value', value: 'abc' })
  })
  it('decodes kinds without fields to their label and a remark', () => {
    const d = decodeLine('select 1 from dual', 'sql-text', {}, V)!
    expect(d).toMatchObject({ title: 'SQL text', kindLabel: 'SQL text', fields: [] })
    expect(d.note).toMatch(/statement/)
  })
})

describe('bind lines', () => {
  it('translates the attribute lines without any context', () => {
    const t = decodeLine('  oacdty=180 mxl=11(11) mxlc=00 mal=00 scl=00 pre=00', 'bind-line', {}, V)!
    const f = byLabel(t)
    expect(f.Datatype).toMatchObject({ value: 'TIMESTAMP (180)', raw: 'oacdty=180' })
    expect(f['Max length']).toMatchObject({ value: '11 (private 11)', raw: 'mxl=11(11)' })
    expect(f['Max array length'].value).toBe('0 (scalar)')
    expect(t.fields.map((x) => x.raw)).toEqual(['oacdty=180', 'mxl=11(11)', 'mxlc=00', 'mal=00', 'scl=00', 'pre=00'])
    const g = byLabel(decodeLine('  oacflg=03 fl2=1000000 frm=02 csi=873 siz=24 off=0', 'bind-line', {}, V))
    expect(g['Bind flags']).toMatchObject({ value: '03', desc: 'bind flags (hex, undocumented)' })
    expect(g['Bind flags 2'].value).toBe('1000000')
    expect(g['Character form'].value).toBe('national character set (NCHAR) (2)')
    expect(g['Character set'].value).toBe('AL32UTF8 (873)')
    expect(g['Buffer size'].value).toBe('24 bytes')
    const b = byLabel(decodeLine('  kxsbbbfp=7f713ee9fa20  bln=32  avl=00  flg=01', 'bind-line', {}, V))
    expect(b['Actual length']).toMatchObject({ value: '0 (NULL)', desc: 'actual value length (0 means NULL)' })
    expect(b['Buffer address'].value).toBe('7f713ee9fa20')
    expect(byLabel(decodeLine('  value=42', 'bind-line', {}, V)).Value).toMatchObject({ value: '42', raw: 'value=42' })
    // the hover card keeps its compact labels and now knows the full datatype table
    expect(f2('  oacdty=286 mxl=22(22)')).toMatchObject({ Datatype: 'VECTOR (286)' })
    expect(decodeLine('7F2B3C10 0A1D0101 00000101   [........]', 'bind-line')!.title).toBe('Memory dump of the bind value')
  })

  const set = [
    { pos: 0, type: 'NUMBER', value: '1', isNull: false, noDef: false, dump: false, mal: 0 },
    { pos: 1, type: 'TIMESTAMP', value: '2024-02-29 13:14:15.123457', isNull: false, noDef: false, dump: false, mal: 0, typed: '2024-02-29T13:14:15.123457' },
    { pos: 2, type: 'VARCHAR2', value: '', isNull: true, noDef: false, dump: false, mal: 3 },
    { pos: 3, type: '', value: '', isNull: false, noDef: true, dump: false, mal: 0 },
  ]
  const at = (pos: number, header = false): BindAt => ({ set: 7, header, pos: header ? -1 : pos, bind: header ? undefined : set.find((b) => b.pos === pos), dty: [2, 180, 1, 0][pos], binds: set, cursor: 3, stmt: 4 })
  it('adds the bind, datatype, value and typed value from the bind table', () => {
    const c = (pos: number): DecodeContext => ({ bindAt: () => at(pos) })
    const d = decodeLine('  value=29-FEB-24 01.14.15.123457 PM', 'bind-line', c(1), { line: 12 })!
    expect(d.fields.map((x) => x.label)).toEqual(['Bind', 'Datatype', 'Value', 'Typed value', 'Printed value'])
    expect(byLabel(d)).toMatchObject({ Bind: { value: ':1' }, Datatype: { value: 'TIMESTAMP (oacdty 180)' }, Value: { value: '2024-02-29 13:14:15.123457' }, 'Typed value': { value: '2024-02-29T13:14:15.123457', desc: 'ISO 8601 / base-64 ROWID form' } })
    expect(byLabel(decodeLine(' Bind#2', 'bind-line', c(2), { line: 1 }))).toMatchObject({ Value: { value: 'NULL' }, Array: { value: 'up to 3 elements', hint: 'mal=3' } })
    expect(byLabel(decodeLine('  No oacdef for this bind.', 'bind-line', c(3), { line: 1 })).Value.value).toBe('same definition as the previous bind (No oacdef)')
    const dump = decodeLine('Dump of memory from 0x1 to 0x2', 'bind-line', c(1), { line: 1 })!
    expect(dump.title).toBe('Memory dump of the bind value')
    expect(dump.note).toBe('the engine decodes DATE, TIMESTAMP and INTERVAL dumps: see the Value field')
    // no line, or no resolution: nothing added
    expect(decodeLine('  value=42', 'bind-line', c(1))!.fields).toEqual([{ label: 'Value', value: '42' }])
    expect(decodeLine('  value=42', 'bind-line', { bindAt: () => undefined }, { line: 3 })!.fields).toEqual([{ label: 'Value', value: '42' }])
  })
  it('summarises the bind set on the BINDS header', () => {
    const d = decodeLine(BINDS, 'binds', { bindAt: () => at(0, true) }, { line: 2 })!
    expect(d.fields.map((x) => x.label)).toEqual(['Bind set', 'Cursor'])
    expect(d.fields[0].value).toBe('4 binds: :0=1 :1=2024-02-29 13:14:15.123457 :2=NULL :3=(dup)')
    expect(d.fields[0].hint).toBe('bind set 7')
    expect(decodeLine(BINDS, 'binds', { bindAt: () => at(0, true) })!.fields).toEqual([{ label: 'Cursor', value: '#140646291810920' }])
    const v = decodeLine(BINDS, 'binds', { bindAt: () => at(0, true) }, { line: 2, verbose: true })!
    expect(v.fields[1]).toMatchObject({ raw: 'BINDS #140646291810920:' })
  })
})

function f2(line: string) { return f(decodeLine(line, 'bind-line')) }

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

describe('decodeLine gap before', () => {
  const gapCtx: DecodeContext = { gapBefore: (n) => (n === 5 ? { us: 2500, fromLine: 3 } : undefined) }
  const FIELD = {
    label: 'Gap before', value: '2.50 ms', hint: 'idle since line 3',
    desc: 'time between the end of the previous call or wait and the start of this one',
  }
  it('appends the derived field of a call and a wait in verbose mode', () => {
    expect(decodeLine(EXEC, 'call', gapCtx, { verbose: true, line: 5 })!.fields.at(-1)).toEqual(FIELD)
    expect(decodeLine(WAIT, 'wait', gapCtx, { verbose: true, line: 5 })!.fields.at(-1)).toEqual(FIELD)
  })
  it('leaves the card alone without verbose, a line number, a gap or for other kinds', () => {
    const none = (d: LineDecode | null) => d!.fields.some((x) => x.label === 'Gap before')
    expect(none(decodeLine(EXEC, 'call', gapCtx, { line: 5 }))).toBe(false)
    expect(none(decodeLine(EXEC, 'call', gapCtx, { verbose: true }))).toBe(false)
    expect(none(decodeLine(EXEC, 'call', gapCtx, { verbose: true, line: 6 }))).toBe(false)
    expect(none(decodeLine(XCTEND, 'xctend', gapCtx, { verbose: true, line: 5 }))).toBe(false)
  })
})

describe('splitZeros', () => {
  it('moves 0, 0 with a unit and no out of the rows, keeps the rest in order', () => {
    const { shown, zeros } = splitZeros([
      { label: 'CPU', value: '35 µs' }, { label: 'Physical reads', value: '0' }, { label: 'Elapsed', value: '0 µs' },
      { label: 'Library cache miss', value: 'no' }, { label: 'Rows', value: '0.5 ms' }, { label: 'Depth', value: '0 (top level)' },
    ])
    expect(shown.map((f) => f.label)).toEqual(['CPU', 'Rows'])
    expect(zeros).toEqual(['physical reads', 'elapsed', 'library cache miss', 'depth'])
  })
  it('keeps values that only start with a zero digit or the word no', () => {
    const { shown, zeros } = splitZeros([{ label: 'A', value: '0.25 ms' }, { label: 'B', value: '01:02' }, { label: 'C', value: 'none' }, { label: 'D', value: '10' }])
    expect(shown).toHaveLength(4)
    expect(zeros).toEqual([])
  })
})
