// The fixture of the system state, hang analysis and deadlock readings' tests: readings the engine gave for lab files (web/dev/diag-sys.fixture.json.gz, made by
// web/dev/diag-sys-fixture.mjs): the system state of diag_sysstate_l1 (level 1: a statement is the address of its library handle) and of big/diag_sysstate_l266
// (statements with their sql_id; a process whose body is in another event than its summary), the hang analysis of diag_hang (oradebug form) and diag_hang_event
// (the event form, three chains), and the deadlock graph of diag_deadlock.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { DiagNode, DiagReading } from './diag'

const path = fileURLToPath(new URL('../../../dev/diag-sys.fixture.json.gz', import.meta.url))

export const HAS_SYS_FIXTURE = existsSync(path)

export interface SysFixture { node: DiagNode; reading: DiagReading }
export type SysFixtures = Record<'sysL1' | 'sysL266' | 'hang' | 'hangEvent' | 'deadlock', SysFixture>

let cached: SysFixtures | null = null

export function loadSysFixtures(): SysFixtures {
  cached ??= JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as SysFixtures
  return cached
}
