// Bundles the Electron main process (electron/main.ts) and the preload script (electron/preload.ts)
// into dist-electron/ as CommonJS (a sandboxed preload must be CommonJS). `--watch` rebuilds on change.
import * as esbuild from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

const options = {
  entryPoints: { main: join(root, 'electron/main.ts'), preload: join(root, 'electron/preload.ts') },
  outdir: join(root, 'dist-electron'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'info',
}

if (watch) await (await esbuild.context(options)).watch()
else await esbuild.build(options)
