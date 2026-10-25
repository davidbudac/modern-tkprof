package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"syscall"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshconn"
	"golang.org/x/term"
)

// cliPrompter asks for credentials (tests replace it).
var cliPrompter = func() remote.Prompter { return &remote.TerminalPrompter{} }

// cliSSH connects to spec ("user@host[:port]") for fetch and follow.
func cliSSH(spec, transport string) (remote.SSH, error) {
	t, err := remote.ParseTarget(spec)
	if err != nil {
		return nil, err
	}
	return sshconn.New(t, sshconn.Options{Transport: transport, Conn: t.String(), Prompter: cliPrompter(),
		OnSwitch: func(err error) {
			fmt.Fprintf(os.Stderr, "mtkprof: ssh did not use SSH_ASKPASS (%v); using the Go SSH library\n", err)
		}})
}

// cliContext is the context of fetch and follow: it ends at SIGINT or
// SIGTERM (tests replace it).
var cliContext = func() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// cmdFetch is `mtkprof fetch <user@host[:port]> <remote-path>... [-o dir]`:
// copies remote traces over SSH (system ssh with prompts on this terminal,
// or the Go library), resuming partial local files; prints the local paths.
func cmdFetch(args []string) error {
	return fetchMain(args, os.Stdout, os.Stderr)
}

func fetchMain(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("fetch", flag.ExitOnError)
	out := fs.String("o", ".", "directory to write the files into")
	transport := fs.String("transport", "auto", "ssh transport: auto (system ssh if found), cli (system ssh) or lib (Go library)")
	noGzip := fs.Bool("no-gzip", false, "do not compress on the host (cli transport)")
	pos := parseArgs(fs, args)
	if len(pos) < 2 {
		return fmt.Errorf("fetch: want <user@host[:port]> <remote-path>...")
	}
	locals := map[string]bool{}
	for _, p := range pos[1:] {
		l := filepath.Join(*out, path.Base(p))
		if locals[l] {
			return fmt.Errorf("fetch: two remote files named %s", path.Base(p))
		}
		locals[l] = true
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		return err
	}
	s, err := cliSSH(pos[0], *transport)
	if err != nil {
		return fmt.Errorf("fetch: %w", err)
	}
	defer s.Close()
	ctx, stop := cliContext()
	defer stop()
	show := false
	if f, ok := stderr.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		show = true
	}
	for _, p := range pos[1:] {
		e, err := remote.Stat(ctx, s, p)
		if err != nil {
			return fmt.Errorf("fetch: %w", err)
		}
		local := filepath.Join(*out, path.Base(p))
		start, last := time.Now(), time.Time{}
		progress := func(n int64) {
			if show && time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				fmt.Fprintf(stderr, "\r%s  %s / %s", path.Base(p), mb(n), mb(e.Size))
			}
		}
		n, err := remote.FetchFile(ctx, s, p, local, e.Size, *noGzip, progress)
		if show {
			fmt.Fprintf(stderr, "\r%s  %s in %s\n", path.Base(p), mb(n), time.Since(start).Round(100*time.Millisecond))
		}
		if err != nil {
			return fmt.Errorf("fetch %s: %w (run again to resume at %s)", p, err, mb(n))
		}
		fmt.Fprintln(stdout, local)
	}
	return nil
}

func mb(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/1e6) }

// cmdFollow is `mtkprof follow <user@host[:port]> <remote-path> [-o file]`:
// streams the remote file and what is appended to it (tail -f) to stdout
// (-o -, the default) or a file (resumed at its size) until Ctrl-C.
func cmdFollow(args []string) error {
	return followMain(args, os.Stdout, os.Stderr)
}

func followMain(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("follow", flag.ExitOnError)
	out := fs.String("o", "-", "file to append to (resumed at its size), - = stdout")
	transport := fs.String("transport", "auto", "ssh transport: auto, cli or lib")
	pos := parseArgs(fs, args)
	if len(pos) != 2 {
		return fmt.Errorf("follow: want <user@host[:port]> <remote-path>")
	}
	s, err := cliSSH(pos[0], *transport)
	if err != nil {
		return fmt.Errorf("follow: %w", err)
	}
	defer s.Close()
	ctx, stop := cliContext()
	defer stop()
	w, off := stdout, int64(0)
	if *out != "-" {
		e, err := remote.Stat(ctx, s, pos[1])
		if err != nil {
			return fmt.Errorf("follow: %w", err)
		}
		f, err := os.OpenFile(*out, os.O_RDWR|os.O_CREATE, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		if off, err = f.Seek(0, io.SeekEnd); err == nil && off > e.Size {
			if err = f.Truncate(0); err == nil {
				off, err = f.Seek(0, io.SeekStart)
			}
		}
		if err != nil {
			return err
		}
		w = f
	}
	err = remote.FollowTo(ctx, s, pos[1], w, off, nil, func(format string, a ...any) {
		fmt.Fprintf(stderr, "mtkprof: "+format+"\n", a...)
	})
	if ctx.Err() != nil {
		return nil // Ctrl-C
	}
	return fmt.Errorf("follow: %w", err)
}
