package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"golang.org/x/term"
)

// termPrompter asks on the terminal: the question on stderr, the answer
// from stdin without echo when stdin is a terminal, else one line of stdin
// (echo pw | mtkprof trace ...). Minimal stand-in for E7's
// remote.TerminalPrompter; the integrator keeps one of the two.
type termPrompter struct{}

var stdinLines = bufio.NewReader(os.Stdin)

func (termPrompter) Ask(ctx context.Context, p remote.Prompt) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, p.Text)
	fd := int(os.Stdin.Fd())
	if !p.Echo && term.IsTerminal(fd) {
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	line, err := stdinLines.ReadString('\n')
	if err != nil && (err != io.EOF || line == "") {
		return "", fmt.Errorf("no answer to %q: %w", strings.TrimSpace(p.Text), err)
	}
	return strings.TrimRight(line, "\r\n"), nil
}
