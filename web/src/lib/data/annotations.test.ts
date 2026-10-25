import { describe, expect, it } from 'vitest'
import {
  annotationsFile, annotationsMarkdown, mergeAnnotations, mergeBookmarks, parseAnnotationsFile, resolveExec, resolveStmt, stmtRef, textHash,
  type Annotation,
} from './annotations'
import type { Statement } from './types'

const st = (id: number, sqlId: string, text: string, cursors: number[] = []): Statement =>
  ({ id, kind: 0, sqlId, hashValue: 0, text, len: text.length, commandType: 3, commandName: 'SELECT', parsingUserId: 0, privilegeUserId: 0, minDepth: 0, firstLine: 1, cursors })

describe('statement refs', () => {
  it('hash text with FNV-1a and resolve by sql_id + text, else by a unique sql_id', () => {
    expect(textHash('')).toBe('811c9dc5')
    expect(textHash('a')).toBe('e40c292c')
    const a = st(0, 'abc', 'select 1 from dual'), b = st(1, 'def', 'select 2 from dual'), b2 = st(2, 'def', 'select 2 from dual /* other */')
    const doc = { statements: [a, b, b2] }
    expect(resolveStmt(doc, stmtRef(b2))).toBe(2)
    expect(resolveStmt(doc, { sqlId: 'abc', hash: 'ffffffff' })).toBe(0) // re-parsed text, the only abc
    expect(resolveStmt(doc, { sqlId: 'def', hash: 'ffffffff' })).toBeNull() // two candidates
    expect(resolveStmt(doc, { sqlId: 'zzz', hash: stmtRef(a).hash })).toBeNull()
    // a statement in another document position keeps its note
    expect(resolveStmt({ statements: [b, { ...a, id: 1 }] }, stmtRef(a))).toBe(1)
  })

  it('resolves an execution to its cursor by the cursor line', () => {
    const doc = { statements: [st(0, 'abc', 'x', [0, 1])], cursors: [{ id: 0, statement: 0, line: 10 }, { id: 1, statement: 0, line: 90 }] }
    const a: Annotation = { id: 'e', kind: 'execution', note: '', created: 0, updated: 0, stmt: stmtRef(doc.statements[0]), execNo: 3, cursorLine: 90 }
    expect(resolveExec(doc, a)).toEqual({ stmt: 0, cursor: 1, execNo: 3 })
    expect(resolveExec(doc, { ...a, cursorLine: 5 })).toEqual({ stmt: 0, cursor: 0, execNo: 3 })
  })
})

describe('merge', () => {
  it('merges notes by id, the newer one wins', () => {
    const cur: Annotation[] = [
      { id: 'a', kind: 'window', note: 'old', created: 1, updated: 5, from: 1, to: 2 },
      { id: 'b', kind: 'window', note: 'keep', created: 2, updated: 9, from: 1, to: 2 },
    ]
    const inc: Annotation[] = [
      { id: 'a', kind: 'window', note: 'new', created: 1, updated: 6, from: 1, to: 2 },
      { id: 'b', kind: 'window', note: 'stale', created: 2, updated: 3, from: 1, to: 2 },
      { id: 'c', kind: 'window', note: 'added', created: 0, updated: 1, from: 1, to: 2 },
    ]
    expect(mergeAnnotations(cur, inc).map((a) => `${a.id}:${a.note}`)).toEqual(['c:added', 'a:new', 'b:keep'])
  })
  it('merges bookmarks by line, the newer one wins', () => {
    const m = mergeBookmarks([{ file: 0, line: 5, label: 'x', note: 'old', updated: 2 }], [{ file: 0, line: 5, label: 'x', note: 'new', updated: 3 }, { file: 0, line: 1, label: 'y' }])
    expect(m).toEqual([{ file: 0, line: 1, label: 'y' }, { file: 0, line: 5, label: 'x', note: 'new', updated: 3 }])
  })
})

describe('file format', () => {
  const notes: Annotation[] = [
    { id: 's', kind: 'statement', note: 'full scan\non big table', created: 1, updated: 1700000000000, stmt: { sqlId: 'abc', hash: '01234567' } },
    { id: 'e', kind: 'execution', note: 'outlier', created: 2, updated: 2, stmt: { sqlId: 'abc', hash: '01234567' }, execNo: 7, cursorLine: 40 },
    { id: 'w', kind: 'window', note: 'batch run', created: 3, updated: 3, from: 100, to: 200, label: 'batch' },
  ]
  const bms = [{ file: 0, line: 12, label: 'PARSING IN CURSOR', note: 'here', updated: 4 }, { file: 1, line: 3, label: 'plain' }]

  it('round-trips through JSON (notes and bookmarks apart again)', () => {
    const f = annotationsFile('id-1', 'orcl_ora_1.trc', notes, bms, new Date('2026-10-25T10:00:00Z'))
    expect(f.version).toBe(1)
    expect(f.annotations).toHaveLength(5)
    const back = parseAnnotationsFile(JSON.stringify(f))
    expect(back.identity).toBe('id-1')
    expect(back.trace).toBe('orcl_ora_1.trc')
    expect(back.annotations).toEqual(notes)
    expect(back.bookmarks).toEqual(bms)
    expect(back.skipped).toBe(0)
  })

  it('rejects other files and skips broken entries', () => {
    expect(() => parseAnnotationsFile('nope')).toThrow(/not JSON/)
    expect(() => parseAnnotationsFile('{"pivots":[]}')).toThrow(/not an annotations file/)
    expect(() => parseAnnotationsFile('{"version":2,"annotations":[]}')).toThrow(/version 2/)
    const r = parseAnnotationsFile(JSON.stringify({ version: 1, identity: 'x', trace: 't', annotations: [notes[0], { id: 'w', kind: 'window', note: '', created: 0, updated: 0, from: 5, to: 1 }, { kind: 'statement' }] }))
    expect(r.annotations).toHaveLength(1)
    expect(r.skipped).toBe(2)
  })

  it('writes Markdown grouped by kind', () => {
    const md = annotationsMarkdown(annotationsFile('id-1', 'orcl_ora_1.trc', notes, bms, new Date('2026-10-25T10:00:00Z')), { time: (t) => `+${t}µs`, fileName: (f) => `f${f}.trc` })
    expect(md).toContain('# Notes: orcl_ora_1.trc')
    expect(md).toContain('- identity: `id-1`')
    expect(md).toContain('- exported: 2026-10-25T10:00:00Z')
    const order = ['## Statements', '## Executions', '## Time windows', '## Lines'].map((h) => md.indexOf(h))
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]))).toBe(true)
    expect(md).toContain('### `abc` _(2023-11-14T22:13:20Z)_\n\n> full scan\n> on big table')
    expect(md).toContain('### `abc` execution #7')
    expect(md).toContain('### **batch** +100µs → +200µs')
    expect(md).toContain('### f0.trc line 12: `PARSING IN CURSOR`')
  })
})

describe('execution notes', () => {
  it('tell executions of different cursors apart', async () => {
    const { execNotes, execKey } = await import('./annotations')
    const ref = { sqlId: 'abc', hash: '1' }
    const mk = (id: string, cursorLine: number): Annotation => ({ id, kind: 'execution', note: id, created: 0, updated: 0, stmt: ref, execNo: 1, cursorLine })
    const m = execNotes([mk('a', 10), mk('b', 90)], ref)
    expect(m.get(execKey(10, 1))?.note).toBe('a')
    expect(m.get(execKey(90, 1))?.note).toBe('b')
    expect(m.get(execKey(50, 1))).toBeUndefined()
  })
})
