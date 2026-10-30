import { describe, expect, it } from 'vitest'
import type { TraceDoc } from './doc'
import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'
import { BIND_TYPE_NAMES, CHARSET_NAMES, FORM_NAMES, bindAtOf, rememberBinds } from './bindat'
import type { AtObjects } from './lines'

/*
 * testdoc.ts cannot build bind sets (its facts hold `bindSets: { n: 0 }`), so the document is a cast object with only what
 * `bindAtOf` and `bindsOf` read: bindSets (line, cursor, stmt, first, count), binds (pos, dty, flags, mal, kind, type, value, typed)
 * and fileOfCursor. Cursor 2 lives in file 1, cursors 0 and 1 in file 0.
 */
const I = (a: number[]) => Int32Array.from(a)
const doc = {
  bindSets: { n: 2, line: I([2, 30]), cursor: I([0, 2]), stmt: I([0, 1]), first: I([0, 3]), count: I([3, 1]) },
  binds: {
    n: 4, set: I([0, 0, 0, 1]), pos: I([0, 1, 2, 0]), dty: I([2, 180, 0, 1]), flags: I([0, 0, 2, 1]), mal: I([0, 0, 0, 5]), avl: I([2, 11, 0, 0]), kind: I([1, 3, 0, 0]),
    type: ['NUMBER', 'TIMESTAMP', '', 'VARCHAR2'], value: ['1', '2024-02-29 13:14:15.123457', '', ''], typed: ['', '2024-02-29T13:14:15.123457', '', ''],
  },
  fileOfCursor: (c: number) => (c === 2 ? 1 : 0),
} as unknown as TraceDoc

// file 0: a BINDS block of three binds at lines 2..17 between two calls
const BLOCK: [string, LineKind][] = [
  ['EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1', 'call'], // 1
  ['BINDS #139714635394512:', 'binds'], // 2
  ['', 'blank'], // 3
  [' Bind#0', 'bind-line'], // 4
  ['  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00', 'bind-line'], // 5
  ['  oacflg=03 fl2=1000000 frm=00 csi=00 siz=24 off=0', 'bind-line'], // 6
  ['  kxsbbbfp=7f1234  bln=22  avl=02  flg=05', 'bind-line'], // 7
  ['  value=1', 'bind-line'], // 8
  [' Bind#1', 'bind-line'], // 9
  ['  oacdty=180 mxl=11(11) mxlc=00 mal=00 scl=00 pre=00', 'bind-line'], // 10
  ['  oacflg=03 fl2=1000000 frm=00 csi=00 siz=16 off=0', 'bind-line'], // 11
  ['  kxsbbbfp=7f1240  bln=11  avl=11  flg=05', 'bind-line'], // 12
  ['  value=Unhandled datatype (-73) found in kxsbndinf', 'bind-line'], // 13
  ["Dump of memory from 0x7f1240 to 0x7f124b", 'unknown'], // 14
  ['7F2B3C10 0A1D0101 00000101   [........]', 'unknown'], // 15
  [' Bind#2', 'bind-line'], // 16
  ['  No oacdef for this bind.', 'bind-line'], // 17
  ['EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=2', 'call'], // 18
]
// file 1: one bind at lines 30..33
const OTHER: [string, LineKind][] = [
  ['BINDS #2:', 'binds'], // 30
  [' Bind#0', 'bind-line'], // 31
  ['  oacdty=01 mxl=32(32) mxlc=00 mal=05 scl=00 pre=00', 'bind-line'], // 32
  ['  value=', 'bind-line'], // 33
]

/** a PageCache stand-in: only `line(n)` is read; lines outside `lines` are "not cached" */
function fakeCache(lines: Map<number, [string, LineKind]>) {
  return {
    line: (n: number) => {
      const l = lines.get(n)
      return l ? { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: -1, cursor: -1, execNo: -1, wait: -1 } : undefined
    },
  }
}
const make = (...parts: [number, [string, LineKind][]][]) => {
  const m = new Map<number, [string, LineKind]>()
  for (const [from, ls] of parts) ls.forEach((l, i) => m.set(from + i, l))
  return fakeCache(m)
}
const cache = make([1, BLOCK], [30, OTHER])

describe('bindAtOf', () => {
  const at = bindAtOf(doc, 0, cache)
  it('resolves the BINDS header to its set', () => {
    const a = at(2)!
    expect(a).toMatchObject({ set: 0, header: true, pos: -1, cursor: 0, stmt: 0 })
    expect(a.bind).toBeUndefined()
    expect(a.binds.map((b) => b.pos)).toEqual([0, 1, 2])
  })
  it('resolves every line of a bind to that bind', () => {
    for (const n of [4, 5, 6, 7, 8]) expect(at(n), `line ${n}`).toMatchObject({ set: 0, header: false, pos: 0, bind: { type: 'NUMBER', value: '1' }, dty: 2 })
    // the memory dump below value=Unhandled datatype belongs to Bind#1
    for (const n of [9, 10, 13, 14, 15]) expect(at(n), `line ${n}`).toMatchObject({ pos: 1, bind: { type: 'TIMESTAMP', typed: '2024-02-29T13:14:15.123457' }, dty: 180 })
    expect(at(17)).toMatchObject({ pos: 2, bind: { noDef: true } })
  })
  it('does not claim a blank start line, but walks through blank lines (Bind#0 sits below one)', () => {
    expect(at(3)).toBeUndefined()
    expect(at(4)).toMatchObject({ set: 0, pos: 0 })
  })
  it('is undefined outside bind blocks', () => {
    expect(at(1)).toBeUndefined()
    expect(at(18)).toBeUndefined()
    expect(at(99)).toBeUndefined()
  })
  it('is undefined when the text between the line and its header is not cached', () => {
    const m = new Map<number, [string, LineKind]>()
    BLOCK.forEach((l, i) => { if (i + 1 !== 6) m.set(i + 1, l) }) // line 6 missing
    const holey = bindAtOf(doc, 0, fakeCache(m))
    expect(holey(8)).toBeUndefined()
    expect(holey(5)).toMatchObject({ pos: 0 })
  })
  it('reads only the sets of the given file', () => {
    expect(bindAtOf(doc, 1, cache)(2)).toBeUndefined()
    expect(at(30)).toBeUndefined()
    const b = bindAtOf(doc, 1, cache)
    expect(b(30)).toMatchObject({ set: 1, header: true, cursor: 2 })
    expect(b(33)).toMatchObject({ set: 1, pos: 0, bind: { type: 'VARCHAR2', isNull: true, mal: 5 } })
  })
  it('is undefined when no set starts at the header', () => {
    const m = new Map<number, [string, LineKind]>([[50, ['BINDS #9:', 'binds']], [51, [' Bind#0', 'bind-line']]])
    expect(bindAtOf(doc, 0, fakeCache(m))(51)).toBeUndefined()
  })
})

describe('rememberBinds', () => {
  // an engine session: the document has no bind sets, the engine's /api/at answers carry them
  const bare = { bindSets: { n: 0 }, binds: {}, fileOfCursor: () => 0 } as unknown as TraceDoc
  const answer = (bindSet: number, bindLine: number, binds?: AtObjects['binds']): AtObjects => ({
    call: 3, stmt: 7, cursor: 4, execNo: 1, wait: -1, bindSet, ctx: 0, planLine: -1, kind: 'bind-line',
    execFrom: -1, execTo: -1, prevExec: -1, nextExec: -1, cursorLine: -1, closeLine: -1, object: '', bindLine, binds,
  })
  const row = (pos: number, type: string, value: string) => ({ pos, type, value, isNull: false, noDef: false, dump: false, mal: 0 })
  it('is undefined until an answer was remembered, then resolves the block from the engine\'s binds', () => {
    const d = { ...bare } as TraceDoc
    expect(bindAtOf(d, 0, cache)(8)).toBeUndefined()
    rememberBinds(d, 0, answer(5, 2, [row(0, 'NUMBER', '1'), row(1, 'TIMESTAMP', 'x'), row(2, '', '')]))
    const at = bindAtOf(d, 0, cache)
    expect(at(2)).toMatchObject({ set: 5, header: true, cursor: 4, stmt: 7 })
    expect(at(8)).toMatchObject({ set: 5, pos: 0, bind: { type: 'NUMBER', value: '1' } })
    expect(at(14)).toMatchObject({ set: 5, pos: 1, bind: { type: 'TIMESTAMP' } })
    expect(at(18)).toBeUndefined()
    expect(bindAtOf(d, 1, cache)(8)).toBeUndefined() // another file
  })
  it('ignores answers without a bind set', () => {
    const d = { ...bare } as TraceDoc
    rememberBinds(d, 0, answer(-1, -1))
    rememberBinds(d, 0, answer(5, 2)) // no binds
    expect(bindAtOf(d, 0, cache)(8)).toBeUndefined()
  })
  it('prefers the document tables', () => {
    rememberBinds(doc, 0, answer(9, 2, [row(0, 'RAW', 'zz')]))
    expect(bindAtOf(doc, 0, cache)(8)).toMatchObject({ set: 0, bind: { type: 'NUMBER' } })
  })
})

describe('tables', () => {
  it('names the datatypes, forms and character sets', () => {
    expect(BIND_TYPE_NAMES[2]).toBe('NUMBER')
    expect(BIND_TYPE_NAMES[180]).toBe('TIMESTAMP')
    expect(BIND_TYPE_NAMES[231]).toBe('TIMESTAMP WITH LOCAL TIME ZONE')
    expect(FORM_NAMES[2]).toMatch(/NCHAR/)
    expect(CHARSET_NAMES[873]).toBe('AL32UTF8')
  })
})
