// Builds the mtkprof-engine sidecar (cmd/mtkprof at the repository root, invoked by the shell as
// `mtkprof-engine engine`) for the host, or for `--target <os>-<arch>` (os: mac, win, linux; arch:
// x64, arm64; $TARGET works too), into binaries/<os>-<arch>/mtkprof-engine[.exe]: the folder
// electron-builder copies into the app's resources/bin (electron-builder.yml extraResources) and
// the dev run (`pnpm app`) starts the engine from.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(root, '..') // the repository root: go.mod, cmd/mtkprof

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()

const hostOs = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
const argTarget = process.argv.indexOf('--target')
const target = (argTarget > 0 && process.argv[argTarget + 1]) || process.env.TARGET || `${hostOs}-${process.arch}`
const [os, arch] = target.split('-')

const goos = { mac: 'darwin', win: 'windows', linux: 'linux' }[os]
const goarch = { x64: 'amd64', arm64: 'arm64' }[arch]
if (!goos || !goarch) throw new Error(`unsupported target ${target} (want mac|win|linux - x64|arm64)`)

let version = 'dev'
try {
  version = run('git', ['describe', '--tags', '--always', '--dirty'], { cwd: engine })
} catch {
  // no git metadata (tarball checkout): keep "dev"
}

const ext = goos === 'windows' ? '.exe' : ''
const out = join(root, 'binaries', `${os}-${arch}`, `mtkprof-engine${ext}`)
mkdirSync(dirname(out), { recursive: true })
const ldflags = `-s -w -X main.version=${version} -X github.com/davidbudac/modern-tkprof/internal/report.Version=${version}`
console.log(`building mtkprof ${version} for ${goos}/${goarch} -> ${out}`)
execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', out, './cmd/mtkprof'], {
  cwd: engine,
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
})
