package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/davidbudac/modern-tkprof/internal/assist"
)

// cmdMCP is `mtkprof mcp`: the analysis tools as a stdio MCP server. It talks
// to a running engine (assist.EnvEngine and assist.EnvToken) about one of its
// sessions (assist.EnvSession), on behalf of a conversation
// (assist.EnvConversation, optional). Stdout carries the protocol and nothing
// else; stdin is the agent's requests, not an engine's lifetime pipe.
func cmdMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	fs.Parse(args)
	if fs.NArg() > 0 {
		return fmt.Errorf("mcp: unexpected argument %q", fs.Arg(0))
	}
	s := &assist.MCP{Engine: os.Getenv(assist.EnvEngine), Token: os.Getenv(assist.EnvToken), Session: os.Getenv(assist.EnvSession),
		Conversation: os.Getenv(assist.EnvConversation), Name: "mtkprof", Version: version, Log: os.Stderr}
	if s.Engine == "" || s.Token == "" {
		fmt.Fprintf(os.Stderr, "mtkprof mcp: %s and %s must be set (the engine to ask and its token)\n", assist.EnvEngine, assist.EnvToken)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return s.Serve(ctx, os.Stdin, os.Stdout)
}
