// The fixture of the 10053 tests: the converted model of the mock-up's trace (web/dev/opt-two.model.json, made by web/dev/opt-convert.mjs) and
// that trace's text. When the Go scanner serves the model, the fixture is regenerated from it (and the text becomes testdata/opt/19c/opt_two.trc).
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { memoryOptSource, normalizeDump, splitLines, type OptDump, type OptFile } from './opt'

const dev = fileURLToPath(new URL('../../../dev/opt-two.model.json', import.meta.url))
const trc = fileURLToPath(new URL('../../../../docs/mockups/10053-reader/data/two.trc', import.meta.url))

/** Whether the fixture files are there (the tests that need them are skipped otherwise). */
export const HAS_FIXTURE = existsSync(dev) && existsSync(trc)

export function loadFixture() {
  const raw = JSON.parse(readFileSync(dev, 'utf8')) as { file: OptFile; dumps: OptDump[] }
  const lines = splitLines(readFileSync(trc, 'utf8'))
  return { raw, file: raw.file, dumps: raw.dumps.map(normalizeDump), lines, source: (digest = false) => memoryOptSource(raw.file, raw.dumps, lines, { digest }) }
}
