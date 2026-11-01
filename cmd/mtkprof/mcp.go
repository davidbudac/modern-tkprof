package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/davidbudac/modern-tkprof/internal/assist"
)

// cmdMCP is `mtkprof mcp`: the analysis tools as a stdio MCP server. Stdout
// carries the protocol and nothing else; stdin is the agent's requests, not an
// engine's lifetime pipe.
//
// With assist.EnvEngine set it is the desktop engine's bridge: it talks to the
// running engine (assist.EnvEngine and assist.EnvToken) about one of its
// sessions (assist.EnvSession), on behalf of a conversation
// (assist.EnvConversation, optional). Without it the tools run in process on
// the traces given here or opened with the open_trace tool, for an agent
// outside mtkprof (`claude mcp add mtkprof -- mtkprof mcp`).
func cmdMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	binds := fs.String("binds", "mask", "bind values in the tools' answers: mask (type, length, hash salted per server) or keep")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: mtkprof mcp [-binds mask|keep] [trace...]\n\n"+
			"Serves mtkprof's analysis tools over MCP on stdin/stdout for an agent such as Claude Code:\n\n"+
			"  claude mcp add -s user mtkprof -- mtkprof mcp\n\n"+
			"The agent opens traces with the open_trace tool; traces given here are opened on the first tool call.\n\n")
		fs.PrintDefaults()
	}
	var files []string
	for {
		fs.Parse(args)
		if fs.NArg() == 0 {
			break
		}
		files = append(files, fs.Arg(0))
		args = fs.Args()[1:]
	}
	if *binds != "mask" && *binds != "keep" {
		return fmt.Errorf("mcp: -binds: want mask or keep, not %q", *binds)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	s := &assist.MCP{Name: "mtkprof", Version: version, Log: os.Stderr}
	if engine := os.Getenv(assist.EnvEngine); engine != "" {
		if len(files) > 0 {
			return fmt.Errorf("mcp: %s is set: the engine's session is the trace, not %s", assist.EnvEngine, files[0])
		}
		s.Engine, s.Token = engine, os.Getenv(assist.EnvToken)
		s.Session, s.Conversation = os.Getenv(assist.EnvSession), os.Getenv(assist.EnvConversation)
		if s.Token == "" {
			fmt.Fprintf(os.Stderr, "mtkprof mcp: %s is set but %s is not (the engine's token)\n", assist.EnvEngine, assist.EnvToken)
			os.Exit(2)
		}
		return s.Serve(ctx, os.Stdin, os.Stdout)
	}
	l := &assist.Local{KeepBinds: *binds == "keep", Log: os.Stderr}
	defer l.Close()
	if len(files) > 0 {
		l.OpenLater(files)
	}
	s.Local, s.Instructions = l, assist.LocalInstructions
	return s.Serve(ctx, os.Stdin, os.Stdout)
}
