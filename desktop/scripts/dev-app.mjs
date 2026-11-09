// `pnpm dev:app`: the app against the Vite dev server (hot reload of the UI). Starts Vite on
// 127.0.0.1:5173, bundles the main process, then runs Electron with MTKPROF_DEV_URL; quitting the
// app stops Vite. Rebuild the main process (`pnpm build:electron`) and restart for changes there.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import electron from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, configFile: join(root, 'vite.config.ts') })
await server.listen()
const url = 'http://127.0.0.1:5173/'

await new Promise((resolve, reject) =>
  spawn(process.execPath, [join(root, 'scripts/build-electron.mjs')], { stdio: 'inherit' }).on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`build-electron exited ${c}`)))),
)

const app = spawn(String(electron), [root, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, MTKPROF_DEV_URL: url } })
app.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
