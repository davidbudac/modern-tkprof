// The fixture of the dump reader's tests: testdata/diag/19c/diag_errorstack_l2.trc as the engine served it (web/dev/diag-errorstack_l2.fixture.json.gz,
// made by web/dev/diag-fixture.mjs): the file's facts and top-level outline, the children of the nodes that have some (to depth 3) and every line.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { memoryDiagSource, type DiagFile, type DiagNode, type DiagReading, type DiagSource } from './diag'

const path = fileURLToPath(new URL('../../../dev/diag-errorstack_l2.fixture.json.gz', import.meta.url))

/** Whether the fixture file is there (the tests that need it are skipped otherwise). */
export const HAS_DIAG_FIXTURE = existsSync(path)

export interface DiagFixture { file: DiagFile; children: Record<string, DiagNode[]>; lines: string[] }

let cached: DiagFixture | null = null

export function loadDiagFixture(): DiagFixture & { source(o?: { digest?: boolean; readings?: Record<string, DiagReading> }): DiagSource } {
  cached ??= JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as DiagFixture
  const f = cached
  return { ...f, source: (o = {}) => memoryDiagSource(f.file, f.children, f.lines, o) }
}
