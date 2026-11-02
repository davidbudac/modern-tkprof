// The shared UI library (engine/web/src/lib) resolves its imports from this package, so every
// runtime dependency of engine/web must be declared here with the same specifier. Fails otherwise.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const ours = read('package.json')
const lib = read('engine/web/package.json')
const have = { ...ours.dependencies, ...ours.devDependencies }
const bad = []
for (const [name, spec] of Object.entries(lib.dependencies ?? {})) {
  const want = spec.startsWith('file:./') ? 'file:engine/web/' + spec.slice('file:./'.length) : spec
  if (have[name] !== want) bad.push(`${name}: engine/web wants ${want}, package.json has ${have[name] ?? 'nothing'}`)
}
if (bad.length) {
  console.error('dependencies out of step with engine/web/package.json:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log('lib dependencies in step with engine/web')
