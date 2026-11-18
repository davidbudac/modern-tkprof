// The fixture of the call stack and process readings' tests: readings the engine gave for lab files (web/dev/diag-stack.fixture.json.gz, made by
// web/dev/diag-stack-fixture.mjs): the call stack of diag_errorstack_l2 (taken on request, no error) with its nested process state, a process state dump
// (diag_procstate), the deadlock's call stack and process state, the diagnostic dump of diag_in_10046 (an error: ORA-00942), a process of a system state that
// blocks a session and one that is blocked (diag_sysstate_l1), and the two call stacks of an incident file (diag_oom_incident).
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { DiagNode, DiagReading } from './diag'

const path = fileURLToPath(new URL('../../../dev/diag-stack.fixture.json.gz', import.meta.url))

export const HAS_STACK_FIXTURE = existsSync(path)

export interface StackFixture { node: DiagNode; reading: DiagReading }
export type StackFixtures = Record<'errorstack' | 'errorstackProc' | 'procstate' | 'deadlock' | 'deadlockProc' | 'in10046' | 'sysBlocker' | 'sysBlocked' | 'incident' | 'incidentDump', StackFixture>

let cached: StackFixtures | null = null

export function loadStackFixtures(): StackFixtures {
  cached ??= JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as StackFixtures
  return cached
}
