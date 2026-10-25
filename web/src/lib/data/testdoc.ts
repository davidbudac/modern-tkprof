// A small hand-built trace set for the unit tests (not a trace fixture: it only has the columns the code under test reads).
import { TraceDoc } from './doc'
import type { RawDocument, StmtStats, CallStats, FileEntry, Context } from './types'

export const zeroCallStats = (): CallStats => ({
  count: 0, misses: 0, cpu: 0, elapsed: 0, disk: 0, query: 0, current: 0, rows: 0, waitUs: 0, idleUs: 0,
  selfCpu: 0, selfElapsed: 0, selfDisk: 0, selfQuery: 0, selfCurrent: 0,
})

export function zeroStmt(id: number): StmtStats {
  return {
    id, parse: zeroCallStats(), exec: zeroCallStats(), fetch: zeroCallStats(), close: zeroCallStats(), other: zeroCallStats(), total: zeroCallStats(), allCalls: zeroCallStats(),
    elapsed: 0, selfElapsed: 0, cpu: 0, selfCpu: 0, waitUs: 0, idleUs: 0, childUs: 0, executions: 0, hardParses: 0, cursors: 1, errors: 0, minDepth: 0, maxDepth: 0, topLevel: true,
    firstWallUs: 0, lastWallUs: 0, firstTim: 0, lastTim: 0, parents: null, children: null, plans: null, planHashes: null,
  }
}

export interface CallSpec {
  ctx: number; stmt: number; kind: number; e: number; c?: number; tim?: number; parent?: number; dep?: number; mis?: number; r?: number
  selfE?: number; selfC?: number; waitEla?: number; idleEla?: number
}

const file = (idx: number, name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  idx, path: `/t/${name}`, name, size: 1000 * (idx + 1), lines: 100 * (idx + 1), firstTim: 1000 * (idx + 1), lastTim: 1000 * (idx + 1) + 500, firstWallUs: 0, lastWallUs: 0,
  processPid: String(100 + idx), instance: 'ORCL', traceFile: name, px: false, chain: idx, followed: false, ...extra,
})

/**
 * Files: 0 `qc.trc` (contexts 0, 1), 1 `px_p000.trc` (context 2, a PX slave attached to context 0), 2 `other.trc` (context 3).
 * Statements 0 and 1 (no wall clock, one cursor each).
 */
export async function makeDoc(calls: CallSpec[], opts: { files?: FileEntry[]; contexts?: Partial<Context>[] } = {}): Promise<TraceDoc> {
  const files = opts.files ?? [file(0, 'qc.trc'), file(1, 'px_p000.trc', { px: true }), file(2, 'other.trc')]
  const ctxs: Partial<Context>[] = opts.contexts ?? [
    { fileIdx: 0 }, { fileIdx: 0 }, { fileIdx: 1, px: true, parent: 0, process: '4242' }, { fileIdx: 2 },
  ]
  const col = (f: (c: CallSpec, i: number) => number) => calls.map(f)
  const raw = {
    tool: 'test', version: '1', generated: '', format: 3,
    file: { path: '/t/qc.trc', headers: [], traceFile: 'qc.trc', version: '19', instance: 'ORCL', node: '', machine: '', systemName: '', processPid: '1', truncated: false, files },
    span: { firstTim: 1000, lastTim: 4000 },
    statements: [0, 1].map((id) => ({ id, kind: 0, sqlId: `sql${id}`, text: `select ${id}`, cursors: [id], hashValue: id, firstLine: 1, parsingUserId: 1, minDepth: 0 })),
    cursors: [0, 1].map((id) => ({ id, context: 0 })),
    contexts: ctxs.map((c, id) => ({ id, line: id + 1, sessionId: '', clientId: '', service: '', module: '', action: '', clientDriver: '', containerId: '', process: '', ...c })),
    events: [], plans: [], planLines: [], transactions: [], errors: [], markers: [],
    diag: { lines: 0, bytes: 0, unknownLines: 0, unattributedWaits: 0, timeAnchors: 0, lineKinds: {} },
    unknown: null,
    facts: {
      calls: {
        n: calls.length,
        line: col((_, i) => i + 1), kind: col((c) => c.kind), cursor: col((c) => c.stmt), stmt: col((c) => c.stmt),
        c: col((c) => c.c ?? 0), e: col((c) => c.e), p: col(() => 0), cr: col(() => 0), cu: col(() => 0), mis: col((c) => c.mis ?? 0), r: col((c) => c.r ?? 0),
        dep: col((c) => c.dep ?? 0), og: col(() => 0), plh: col(() => 0), tim: col((c) => c.tim ?? 0), type: col(() => 0),
        parent: col((c) => c.parent ?? -1), selfE: col((c) => c.selfE ?? c.e), selfC: col((c) => c.selfC ?? c.c ?? 0), selfP: col(() => 0), selfCR: col(() => 0), selfCU: col(() => 0),
        ctx: col((c) => c.ctx), execNo: col(() => 0), bindSet: col(() => -1), waitEla: col((c) => c.waitEla ?? 0), idleEla: col((c) => c.idleEla ?? 0), nWaits: col(() => 0), flags: col(() => 0),
      },
      waits: { n: 0 }, bindSets: { n: 0 }, binds: { n: 0, type: [], value: [] },
    },
    stats: { statements: [zeroStmt(0), zeroStmt(1)], profile: { label: '', totalUs: 0, cpuUs: 0, waitUs: 0, idleUs: 0, unaccountedUs: 0, rows: [] }, events: [], timeline: [], bucketUs: 0 },
  }
  return TraceDoc.fromRaw(raw as unknown as RawDocument)
}
