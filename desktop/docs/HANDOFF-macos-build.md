# macOS build and smoke test by hand

For a session on the MacBook Pro. **Since the move to local CI,
`scripts/ci-local.sh` does steps 3 to 5 in one go** (`--only checks,macos`;
`--skip-smoke` to leave out the screenshots) and collects the DMGs in `out/`
with `SHA256SUMS`; the whole recipe, the Linux and Windows legs and releases
are in the README ("Local CI and releases"). The numbered steps stay as the
by-hand version and for debugging a single step. Nothing here commits, pushes
or tags. (The old `.github/workflows/build.yml` it mirrored is gone: CI is
local by decision, GitHub Actions costs money.)

Last full run: v0.5.0 on 2026-11-02 on an Apple M4, macOS 27 (checks, both
DMGs, smoke on arm64 and x64; Rosetta 2 is installed there now).

## 1. Checkout

```
gh auth status                      # davidbudac
git clone https://github.com/davidbudac/modern-tkprof.git ~/claude_projects/modern-tkprof
cd ~/claude_projects/modern-tkprof
git checkout vX.Y.Z                 # the release tag (since 2026-11-02 the app is desktop/ here;
                                    # v0.3.0 and v0.4.0 were built from the archived mtkprof-desktop repo)
cd desktop
```

## 2. Prerequisites (install only what is missing; no sudo without asking David)

- Xcode command line tools (`xcode-select --install`)
- Rust via rustup, stable; `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
- Node 24 (CI's version; 26 works too) and pnpm: the root `package.json` pins `pnpm@12.9.1`,
  and any pnpm 10+ switches to it by itself (no corepack needed)
- Go, version from the repository's `go.mod` (1.27.3; an older `go` downloads it via the toolchain line)
- Rosetta 2, only for the x64 smoke on Apple Silicon
  (`softwareupdate --install-rosetta --agree-to-license`, admin); building x64 does not need it
- Screen Recording permission for the app that runs the shell (Terminal, T3 Code, …):
  without it `screencapture` fails with `could not create image from display` and the
  smoke has no screenshots

## 3. Checks (`ci-local.sh --only checks`)

```
pnpm install --frozen-lockfile
pnpm gen:api && git diff --exit-code -- src/engine/api.d.ts
pnpm typecheck
pnpm test
```

## 4. Build both targets (`ci-local.sh --only macos`)

For `T` in `aarch64-apple-darwin` and `x86_64-apple-darwin`:

```
pnpm build:engine --target T
pnpm tauri build --target T --bundles dmg --ci
ls -la src-tauri/target/T/release/bundle/dmg/
```

About 1.5 min of Rust per target on the M4. `--bundles dmg` deletes the
intermediate `bundle/macos/mtkprof.app`; mount the DMG to get the app.

## 5. Smoke (arm64; x64 needs Rosetta; part of `--only macos`)

```
scripts/smoke.sh aarch64-apple-darwin macos-arm64
scripts/smoke.sh x86_64-apple-darwin macos-x64      # with Rosetta only
```

It launches the built app (`src-tauri/target/T/release/mtkprof-desktop`, the
sidecar next to it; no bundle, no quarantine) with `MTKPROF_SMOKE=1`, opens
`testdata/traces/19c/io_waits.trc` (repository root), kills the engine once after 15 s
and expects a restart and the trace re-opened. Output:
`out-smoke/macos-arm64-ready.png`, `out-smoke/macos-arm64-restarted.png`,
`out-smoke/macos-arm64.log`. The ready screenshot must show the Overview and
"1 sessions"; the restarted one the toast "Engine restarted" and "restarts 1"
in the status bar. The app's own log is
`~/Library/Logs/com.davidbudac.mtkprof/mtkprof.log`.

## 6. The DMG and Gatekeeper

Without clicking (the app copied out of the DMG):

```
mkdir -p /private/tmp/mtk-dmg/mnt /private/tmp/mtk-dmg/app
hdiutil attach -nobrowse -readonly -mountpoint /private/tmp/mtk-dmg/mnt src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/mtkprof_*_aarch64.dmg
ditto /private/tmp/mtk-dmg/mnt/mtkprof.app /private/tmp/mtk-dmg/app/mtkprof.app
hdiutil detach /private/tmp/mtk-dmg/mnt
codesign --verify --deep --strict -v /private/tmp/mtk-dmg/app/mtkprof.app   # valid on disk, satisfies its DR
MTKPROF_SMOKE=1 MTKPROF_SMOKE_OPEN=$(cd .. && pwd)/testdata/traces/19c/io_waits.trc \
  /private/tmp/mtk-dmg/app/mtkprof.app/Contents/MacOS/mtkprof-desktop      # the bundled sidecar starts
```

Use `/private/tmp`, not `/tmp`: `/tmp` is a symlink and Tauri refuses to start
a sidecar whose path contains one (`StartingBinary found current_exe() that
contains a symlink on a non-allowed platform`); `/Applications` is fine.

What a downloaded copy shows: put a quarantine flag on a separate copy and
`open` it (`xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" <app>`).
Expected since `bundle.macOS.signingIdentity: "-"`: "mtkprof.app" Not Opened /
"Apple could not verify…" (Move to Trash, Done), and System Settings →
Privacy & Security → Security lists "mtkprof.app was blocked" with *Open
Anyway*. Before it (v0.3.0 as tagged, linker-only ad-hoc signature, bundle
unsigned) it was "mtkprof.app is damaged and can't be opened", which has no
Open Anyway. Answer the dialog by hand: killing `CoreServicesUIAgent` brings
it back and leaves the quarantined copy hanging at exec.

By hand (optional): open the DMG, drag the app to Applications, start it,
*Done*, Privacy & Security → *Open Anyway*, open any `.trc`, one screenshot.

## 7. Report

Machine (`uname -a`, chip), tool versions, pass/fail per step, DMG paths and
sizes, smoke result and screenshot paths, Gatekeeper notes, workarounds.
A Rust/Tauri build error that looks like a code bug: report the text, do not
fix it. Record the outcome in `docs/HANDOFF.md` (repository root) § Open.

## Limits of the local CI

- macOS x64 is smoke-tested only where Rosetta 2 is installed; without it
  `ci-local.sh` reports the x64 smoke as skipped (`arch -x86_64 /usr/bin/true`
  fails with "Bad CPU type in executable").
- Windows is cross-built in the Linux image with `cargo-xwin` and never run:
  there is no Windows smoke locally. Smoke it on a Windows box
  (`scripts/smoke.sh x86_64-pc-windows-msvc windows-x64` from Git Bash) before
  trusting a release.
- Linux and Windows build in the amd64 Docker image (`ci/Dockerfile`, Rosetta
  on this Mac). The AppImage that failed in a plain Docker run on a Linux host
  (linuxdeploy's static-pie runtime: `cannot execute: required file not found`)
  builds fine under OrbStack with `APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true`;
  it is built by default (`--no-appimage` to skip). The installers themselves
  are never installed or launched, only the release binary is smoked.
- Debian bookworm's `nsis` (3.08) lacks `Include/Win/RestartManager.nsh`, which
  Tauri's NSIS template includes: the image carries NSIS 3.11 (data from the
  official zip, `makensis` built from the source tarball).
