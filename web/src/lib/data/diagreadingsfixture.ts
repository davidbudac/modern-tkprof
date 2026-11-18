// The fixture of the readings' tests: readings the engine gave for lab files (web/dev/diag-readings.fixture.json.gz, made by web/dev/diag-readings-fixture.mjs):
// the first heap of diag_heap_sub (sub-heaps, three matching checks, free lists, permanent chunks) with the chunk lines of its largest comment, that heap's first
// sub-heap, a PDB-filtered heap of diag_heap_large_pdb (checks that cannot be made), the PGA summary and the PGA detail.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { DiagNode, DiagReading } from './diag'
import type { HeapLines } from './diagreadings'

const path = fileURLToPath(new URL('../../../dev/diag-readings.fixture.json.gz', import.meta.url))

export const HAS_READINGS_FIXTURE = existsSync(path)

export interface ReadingFixture { node: DiagNode; reading: DiagReading; lines?: HeapLines; linesOf?: string }
export type ReadingFixtures = Record<'heapPga' | 'heapKoh' | 'heapPdb' | 'pgaSummary' | 'pgaDetail', ReadingFixture>

let cached: ReadingFixtures | null = null

export function loadReadingFixtures(): ReadingFixtures {
  cached ??= JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as ReadingFixtures
  return cached
}
