package remote

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"

	"golang.org/x/term"
)

// TerminalPrompter asks on the terminal: the CLI's Prompter. Secrets
// (Echo false) are read without echo; hostkey and confirm prompts read
// yes/no and answer "yes" or "no".
type TerminalPrompter struct {
	// In and Out are where to ask; nil: the controlling terminal (/dev/tty;
	// CONIN$ and CONOUT$ on Windows), else stdin and stderr.
	In  *os.File
	Out io.Writer

	mu sync.Mutex // one question at a time
}

// ErrNoTerminal is returned when there is no terminal to ask on.
var ErrNoTerminal = errors.New("no terminal to ask on")

// Ask implements Prompter. When ctx ends first, Ask returns at once and the
// pending read is abandoned.
func (t *TerminalPrompter) Ask(ctx context.Context, p Prompt) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	in, out, done, err := t.open()
	if err != nil {
		return "", err
	}
	yesNo := p.Kind == KindHostKey || p.Kind == KindConfirm
	text := p.Text
	if yesNo && !strings.Contains(strings.ToLower(text), "yes/no") {
		text = strings.TrimRight(text, " ") + " (yes/no) "
	}
	fmt.Fprint(out, text)
	type result struct {
		s   string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		defer done()
		if !p.Echo && !yesNo && term.IsTerminal(int(in.Fd())) {
			b, err := term.ReadPassword(int(in.Fd()))
			fmt.Fprintln(out)
			ch <- result{string(b), err}
			return
		}
		s, err := readLine(in)
		ch <- result{s, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			return "", r.err
		}
		if yesNo {
			if Yes(r.s, p) {
				return "yes", nil
			}
			return "no", nil
		}
		return r.s, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// open returns the input and output to ask on and a function releasing them.
func (t *TerminalPrompter) open() (*os.File, io.Writer, func(), error) {
	if t.In != nil {
		out := t.Out
		if out == nil {
			out = os.Stderr
		}
		return t.In, out, func() {}, nil
	}
	inName, outName := "/dev/tty", "/dev/tty"
	if runtime.GOOS == "windows" {
		inName, outName = "CONIN$", "CONOUT$"
	}
	if in, err := os.OpenFile(inName, os.O_RDWR, 0); err == nil {
		if t.Out != nil {
			return in, t.Out, func() { in.Close() }, nil
		}
		if inName == outName {
			return in, in, func() { in.Close() }, nil
		}
		if out, err := os.OpenFile(outName, os.O_WRONLY, 0); err == nil {
			return in, out, func() { in.Close(); out.Close() }, nil
		}
		in.Close()
	}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		out := t.Out
		if out == nil {
			out = os.Stderr
		}
		return os.Stdin, out, func() {}, nil
	}
	return nil, nil, nil, ErrNoTerminal
}

// readLine reads one line byte by byte (nothing past the newline is consumed).
func readLine(r io.Reader) (string, error) {
	var b []byte
	var c [1]byte
	for {
		n, err := r.Read(c[:])
		if n == 1 {
			if c[0] == '\n' {
				break
			}
			b = append(b, c[0])
			if len(b) > 64<<10 {
				return "", errors.New("answer too long")
			}
		}
		if err != nil {
			if err == io.EOF && len(b) > 0 {
				break
			}
			return "", err
		}
	}
	return strings.TrimRight(string(b), "\r"), nil
}
