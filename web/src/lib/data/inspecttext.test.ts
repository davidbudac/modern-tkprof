import { describe, expect, it } from 'vitest'
import { bindCell, cursorOfText, decodeAsText, refOfField } from './inspecttext'
import { decodeLine } from './linefields'
import type { ExecSummary } from './execsummary'

describe('decodeAsText', () => {
  it('lists label: value (raw) per field', () => {
    const t = decodeAsText({ title: 'EXEC', kindLabel: 'Call', note: 'n', fields: [{ label: 'CPU', value: '174 µs', raw: 'c=174' }, { label: 'Depth', value: '0' }] }, 12)
    expect(t).toBe('Line 12 · Call · EXEC\nCPU: 174 µs (c=174)\nDepth: 0\nn')
  })
})

describe('bindCell', () => {
  const b = { value: 'x', isNull: false, noDef: false, dump: false }
  it('names the special cases', () => {
    expect(bindCell(b)).toBe('x')
    expect(bindCell({ ...b, isNull: true })).toBe('NULL')
    expect(bindCell({ ...b, noDef: true })).toBe('(same as previous)')
    expect(bindCell({ ...b, dump: true, value: '' })).toBe('(memory dump)')
  })
})

describe('decodeAsText with an execution', () => {
  it('adds an Execution block', () => {
    const ex: ExecSummary = { execNo: 2, total: 5, elapsedUs: 1500, cpuUs: 400, rows: 7, fetches: 1, disk: 3, gets: 1200, hardParse: false, waits: [{ event: 1, count: 2, us: 900 }], waitUs: 900, plh: 99, bindLine: 0 }
    const t = decodeAsText({ title: 'EXEC', fields: [{ label: 'Rows', value: '7' }] }, 3, ex, () => 'db file sequential read')
    const lines = t.split('\n')
    expect(lines.slice(0, 4)).toEqual(['Line 3 · EXEC', 'Rows: 7', '', 'Execution 2 of 5 · plan hash 99'])
    expect(t).toContain('Elapsed: 1.50 ms')
    expect(t).toContain('Waits: 2 · 900 µs')
    expect(t).toContain('  db file sequential read · 2 · 900 µs')
  })
})

describe('refOfField', () => {
  it('reads the token, not the display text', () => {
    expect(refOfField({ label: 'Plan hash', value: '1234', raw: 'plh=1234' })).toEqual({ kind: 'plh', value: '1234' })
    expect(refOfField({ label: 'Plan hash', value: '0 (no plan hash yet)', raw: 'plh=0' })).toBeNull()
    expect(refOfField({ label: 'Object', value: 'SCOTT.EMP (123)', raw: 'obj#=123', hint: 'obj#=123' })).toEqual({ kind: 'obj', value: '123' })
    expect(refOfField({ label: 'Object', value: 'none (-1)', raw: 'obj#=-1' })).toBeNull()
    expect(refOfField({ label: 'Object', value: '77', hint: 'obj#=77' })).toEqual({ kind: 'obj', value: '77' })
    expect(refOfField({ label: 'Object', value: '0 (none)', raw: 'obj=0' })).toBeNull()
    expect(refOfField({ label: 'SQL ID', value: 'abcd1234efgh5', raw: "sqlid='abcd1234efgh5'" })).toEqual({ kind: 'sqlid', value: 'abcd1234efgh5' })
    expect(refOfField({ label: 'SQL ID', value: 'short', raw: "sqlid='short'" })).toBeNull()
    expect(refOfField({ label: 'Event', value: 'db file sequential read', raw: "nam='db file sequential read'" })).toEqual({ kind: 'event', value: 'db file sequential read' })
    expect(refOfField({ label: 'Cursor', value: '#139', raw: 'BINDS #139:' })).toEqual({ kind: 'cursor', value: '139' })
    expect(refOfField({ label: 'CPU', value: '1 µs', raw: 'c=1' })).toBeNull()
    expect(refOfField({ label: 'Rows', value: '5' })).toBeNull()
  })

  it('finds the references of the lines the decoder emits', () => {
    const refs = (text: string, kind: Parameters<typeof decodeLine>[1]) =>
      (decodeLine(text, kind, {}, { verbose: true })?.fields ?? []).map(refOfField).filter(Boolean)
    expect(refs('EXEC #139:c=0,e=10,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=555,tim=100', 'call')).toEqual([{ kind: 'plh', value: '555' }])
    expect(refs("WAIT #139: nam='db file sequential read' ela= 45 file#=1 block#=2 blocks=1 obj#=88 tim=100", 'wait')).toEqual([{ kind: 'event', value: 'db file sequential read' }, { kind: 'obj', value: '88' }])
    expect(refs("PARSING IN CURSOR #139 len=10 dep=0 uid=1 oct=3 lid=1 tim=1 hv=1 ad='abc' sqlid='abcd1234efgh5'", 'parsing-in-cursor')).toEqual([{ kind: 'sqlid', value: 'abcd1234efgh5' }])
    expect(refs('BINDS #139:', 'binds')).toEqual([{ kind: 'cursor', value: '139' }])
  })
})

describe('cursorOfText', () => {
  it('reads the #N a line starts with', () => {
    expect(cursorOfText('EXEC #139:c=0,e=1')).toBe('139')
    expect(cursorOfText("WAIT #139: nam='x' ela= 1")).toBe('139')
    expect(cursorOfText('STAT #139 id=1 cnt=0')).toBe('139')
    expect(cursorOfText('BINDS #139:')).toBe('139')
    expect(cursorOfText('PARSING IN CURSOR #139 len=5')).toBe('139')
    expect(cursorOfText('PARSE ERROR #139:len=5')).toBe('139')
    expect(cursorOfText('WAIT #0: nam=\'x\' ela= 1')).toBeNull()
    expect(cursorOfText('XCTEND rlbk=0')).toBeNull()
    expect(cursorOfText('select * from t where a = #5')).toBeNull()
  })
})
