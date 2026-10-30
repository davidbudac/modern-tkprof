import { useEffect, useRef, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, type CachedLine, type PageCache } from '../data/linecache'
import { objectsAt, stmtLineIn, type AtObjects } from '../data/lines'
import { fmtWall, preview } from '../data/format'
import { decodeLine, type DecodeContext, type LineDecode } from '../data/linefields'
import { rememberBinds, type BindAt } from '../data/bindat'
import { sqlIds } from '../components/StmtLink'
import type { ApiClient } from '../data/client'
import type { Actions } from '../state/store'
import type { RefMods } from '../components/LineViewer'
import type { StmtPopup } from '../components/StmtPopover'

// What the Lines view and the line drawer share: how a viewer over the whole file is wired to the trace (the hover card, the
// references in the rows, the line card's answer for a line).

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** What the hover cards decode a line with: the trace's events, objects and clock. */
export function decodeContextOf(doc: TraceDoc, bindAt?: (line: number) => BindAt | undefined): DecodeContext {
  const events = new Map(doc.events.map((e) => [e.name, e]))
  let planObjs: Map<number, string> | undefined // obj → object of the plan lines, for traces without a reference bundle
  return {
    eventOf: (name) => events.get(name),
    objectName: (obj) => {
      const named = doc.objectName(obj)
      if (named) return named
      if (!planObjs) planObjs = new Map(doc.planLines.filter((p) => p.obj > 0 && p.object).map((p) => [p.obj, p.object]))
      return planObjs.get(obj)
    },
    clock: (tim) => (doc.wallOffsetUs ? fmtWall(tim + doc.wallOffsetUs, doc.tzOffsetMin, { micros: true }) : undefined),
    firstTim: doc.span.firstTim,
    bindAt,
  }
}

/** The viewer's `card`: the line decoded with the context. */
export function lineCardOf(ctx: DecodeContext): (line: number, text: string, kind: number) => LineDecode | null {
  return (line, text, kind) => decodeLine(text, LINE_KINDS[kind], ctx, { line })
}

/** The tooltip of a reference in a row (the viewer's `refTitle`). */
export function refTitleOf(doc: TraceDoc, ctx: DecodeContext): (kind: string, value: string, ids: CachedLine | undefined) => string | undefined {
  return (kind, value, ids) => {
    const describe = (id: number | undefined) => {
      const st = id === undefined || id < 0 ? undefined : doc.statements[id]
      return st ? [doc.label(st), preview(st.text, 60)].filter(Boolean).join(' · ') : undefined
    }
    switch (kind) {
      case 'cursor': {
        const c = ids && ids.cursor >= 0 ? doc.cursors[ids.cursor] : undefined
        return describe(ids && ids.stmt >= 0 ? ids.stmt : c?.statement)
      }
      case 'sqlid': return describe(sqlIds(doc).get(value)) ?? 'sql_id not in this trace'
      case 'obj': return ctx.objectName?.(Number(value)) ?? `obj ${value}`
      case 'plh': return `plan hash ${value}`
    }
    return undefined
  }
}

/** The click on a reference in a row (the viewer's `onRef`); `jump` moves the viewer to a line, `popup` opens the statement popup at the reference, `flash` says why nothing happened. */
export function refClickOf(
  doc: TraceDoc, file: number, ctx: DecodeContext, _actions: Actions, jump: (line: number) => void, flash: (msg: string) => void, popup: (p: StmtPopup) => void,
): (line: number, kind: string, value: string, ids: CachedLine | undefined, e: RefMods) => void {
  const anchorOf = (e: RefMods): StmtPopup['anchor'] => ({ x: e.x, y: e.y, rect: e.anchor })
  /** The cursor `number` of this file as the line `line` sees it: the nearest parse before it, else the first. */
  const cursorByNumber = (number: number, line: number) => {
    let before: (typeof doc.cursors)[number] | undefined, first: typeof before
    for (const c of doc.cursors) {
      if (c.number !== number || c.line <= 0 || doc.fileOfCursor(c.id) !== file) continue
      if (c.line <= line && (!before || c.line > before.line)) before = c
      if (!first || c.line < first.line) first = c
    }
    return before ?? first
  }
  const refCursor = (number: number, line: number, ids: CachedLine | undefined) => {
    const c = ids && ids.cursor >= 0 ? doc.cursors[ids.cursor] : undefined
    return c && c.number === number ? c : cursorByNumber(number, line)
  }
  /** The line of the plan line with `obj` in the plans of `stmt` in this file (the plan nearest to `line`), the STAT lines being adjacent from the plan's line. */
  const planLineOfObj = (stmt: number, obj: number, line: number) => {
    let best: number | undefined
    for (const p of doc.plansOf(stmt)) {
      if (p.line <= 0 || doc.fileOfCursor(p.cursor) !== file) continue
      for (let k = 0; k < p.n; k++) {
        if (doc.planLines[p.first + k]?.obj !== obj) continue
        const at = p.line + k
        if (best === undefined || Math.abs(at - line) < Math.abs(best - line)) best = at
      }
    }
    return best
  }
  return (line, kind, value, ids, e) => {
    const n = Number(value)
    switch (kind) {
      case 'cursor': {
        const c = refCursor(n, line, ids)
        if (!c) { flash(`no cursor #${value} in this file`); return }
        if (e.shiftKey) { if (c.line > 0) jump(c.line); return }
        if (doc.statements[c.statement]) popup({ stmt: c.statement, cursor: c.id, anchor: anchorOf(e), line }); else flash(`cursor #${value} has no statement`)
        return
      }
      case 'sqlid': {
        const st = sqlIds(doc).get(value)
        if (st === undefined) { flash(`no statement ${value} in this trace`); return }
        const at = e.shiftKey ? stmtLineIn(doc, file, st) : undefined
        if (at !== undefined) jump(at); else popup({ stmt: st, anchor: anchorOf(e), line })
        return
      }
      case 'obj': {
        let st: number | undefined = ids && ids.stmt >= 0 ? ids.stmt : undefined
        if (st === undefined) { const m = /#(\d+)/.exec(ids?.text ?? ''); if (m) st = refCursor(Number(m[1]), line, ids)?.statement }
        const at = st === undefined ? undefined : planLineOfObj(st, n, line)
        if (at !== undefined) { jump(at); return }
        const name = ctx.objectName?.(n)
        flash(name ? `${name} (obj ${value}) is not in this statement's plan` : `no plan line for obj ${value}`)
        return
      }
      case 'plh': {
        const st = ids && ids.stmt >= 0 ? ids.stmt : doc.plans.find((p) => p.planHash === n)?.statement
        if (st !== undefined && doc.statements[st]) popup({ stmt: st, anchor: anchorOf(e), line }); else flash(`no statement with plan hash ${value}`)
        return
      }
    }
  }
}

/** What a cached line's ids (`annot=2`) already say about it, or undefined when the line is not cached or has no ids (ctx, bindSet and planLine are filled in by `objectsAt`). */
export function cachedAt(cache: PageCache, line: number): AtObjects | undefined {
  const l = cache.line(line)
  if (!l || !(l.cursor >= 0 || l.stmt >= 0 || l.wait >= 0 || l.call >= 0)) return undefined
  return { call: l.call, stmt: l.stmt, cursor: l.cursor, execNo: l.execNo, wait: l.wait, bindSet: -1, ctx: -1, planLine: -1, kind: LINE_KINDS[l.kind] ?? 'unknown', execFrom: -1, execTo: -1, prevExec: -1, nextExec: -1, cursorLine: -1, closeLine: -1, object: '', bindLine: -1 }
}

/** What is at `line` for the line card: the cached ids at once, the engine's full answer 60 ms later (a quick run of selections asks once). */
export function useLineAt(client: ApiClient, doc: TraceDoc, file: number, cache: PageCache, line: number): { line: number; objs: AtObjects } | null {
  const [at, setAt] = useState<{ line: number; objs: AtObjects } | null>(null)
  const known = useRef(false)
  useEffect(() => {
    const first = cachedAt(cache, line)
    known.current = !!first
    if (first) setAt({ line, objs: first })
    const ac = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        await cache.load(cache.pageOf(line))
        const objs = await objectsAt(client, file, line, ac.signal)
        rememberBinds(doc, file, objs)
        if (!ac.signal.aborted) setAt({ line, objs })
      } catch (e) { if (!aborted(e) && !known.current) setAt(null) }
    }, 60)
    return () => { window.clearTimeout(timer); ac.abort() }
  }, [client, doc, file, cache, line])
  return at
}
