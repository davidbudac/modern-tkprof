// Builds the mtkprof-engine sidecar (cmd/mtkprof of the engine submodule, invoked by the shell
// as `mtkprof-engine engine`) for the host (or $TARGET / --target)
// Rust target triple into src-tauri/binaries/mtkprof-engine-<triple>[.exe], the name Tauri's
// externalBin expects.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(root, 'engine')

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()

const argTarget = process.argv.indexOf('--target')
const triple =
  (argTarget > 0 && process.argv[argTarget + 1]) ||
  process.env.TARGET ||
  /^host: (\S+)$/m.exec(run('rustc', ['-vV']))?.[1]
if (!triple) throw new Error('cannot determine the Rust target triple (rustc -vV)')

// Rust target triple -> GOOS/GOARCH
const goos = triple.includes('windows') ? 'windows' : triple.includes('apple') ? 'darwin' : triple.includes('linux') ? 'linux' : null
const goarch = triple.startsWith('x86_64') ? 'amd64' : triple.startsWith('aarch64') ? 'arm64' : null
if (!goos || !goarch) throw new Error(`unsupported target ${triple}`)

let version = 'dev'
try {
  version = run('git', ['describe', '--tags', '--always', '--dirty'], { cwd: engine })
} catch {
  // no git metadata (tarball checkout): keep "dev"
}

const ext = goos === 'windows' ? '.exe' : ''
const out = join(root, 'src-tauri', 'binaries', `mtkprof-engine-${triple}${ext}`)
mkdirSync(dirname(out), { recursive: true })
const ldflags = `-s -w -X main.version=${version} -X github.com/davidbudac/modern-tkprof/internal/report.Version=${version}`
console.log(`building mtkprof ${version} for ${goos}/${goarch} -> ${out}`)
execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', out, './cmd/mtkprof'], {
  cwd: engine,
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
})
