package main

import (
	"os"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshcli"
)

// ssh runs SSH_ASKPASS (this binary) with nothing but the prompt text as its
// argument; the environment of the ssh mtkprof spawns marks it
// (MTKPROF_ASKPASS=1), so the binary is the askpass helper whatever the
// arguments are.
func init() {
	if os.Getenv(sshcli.EnvAskpassMode) == "1" && (len(os.Args) < 2 || os.Args[1] != "askpass") {
		os.Exit(sshcli.RunAskpass(os.Args[1:], os.Stdout, os.Stderr, &remote.TerminalPrompter{}))
	}
}

// cmdAskpass is `mtkprof askpass "<prompt text>"`: with MTKPROF_ENGINE (and
// MTKPROF_TOKEN, MTKPROF_PROMPT_CONN) set it asks the engine (POST
// /engine/askpass), otherwise the terminal; prints the answer.
func cmdAskpass(args []string) error {
	os.Exit(sshcli.RunAskpass(args, os.Stdout, os.Stderr, &remote.TerminalPrompter{}))
	return nil
}
