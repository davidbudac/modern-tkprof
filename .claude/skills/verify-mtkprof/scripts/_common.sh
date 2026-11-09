# sourced by the other scripts. Resolves the desktop dir (REPO), state dir and the state file.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$SKILL_DIR/../../../desktop" && pwd)"   # the desktop client; the engine and web/ are its parent
ROOT="${VERIFY_MTKPROF_ROOT:-/tmp/verify-mtkprof}"   # scratch + evidence root (evidence survives cleanup); set the env var to run beside another instance
STATE="$ROOT/state.env"                  # written by launch.sh, read by everything else
PW=/Users/davidbudac/.claude/skills/deck-to-pptx/node_modules/playwright/index.mjs
case "$(uname -m)" in arm64) ENGINE_BIN="$REPO/binaries/mac-arm64/mtkprof-engine";; *) ENGINE_BIN="$REPO/binaries/mac-x64/mtkprof-engine";; esac
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
