// Command fakecli is the fake claude and codex CLIs of package fake: it acts
// as the one its name says. To run the engine's CLI backends against it, put
// a directory first on PATH that holds it under both names:
//
//	go build -o /tmp/fakecli/claude ./internal/assist/fake/cmd/fakecli
//	ln -s claude /tmp/fakecli/codex
//	PATH=/tmp/fakecli:$PATH mtkprof engine ...
//
// FAKE_CLI_SCRIPT replays another recording, FAKE_CLI_LOG logs each run.
package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/assist/fake"
)

func main() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	os.Exit(fake.CLI(name, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
