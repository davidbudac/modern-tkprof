package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"syscall"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/engine"
	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshconn"
	"github.com/davidbudac/modern-tkprof/internal/ui"
	"golang.org/x/term"
)

// cliPrompter asks for credentials (tests replace it): on the controlling
// terminal, or, when stdin is a pipe, one line of stdin per question
// (echo pw | mtkprof trace ...). The one prompter of every CLI command that
// connects.
var cliPrompter = func() remote.Prompter {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return &remote.TerminalPrompter{In: os.Stdin}
	}
	return &remote.TerminalPrompter{}
}

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
// With -db it is `fetch -db <db-spec> -name F` (cmdFetchDB): the trace out of
// V$DIAG_TRACE_FILE_CONTENTS.
func cmdFetch(args []string) error {
	return fetchMain(args, os.Stdout, os.Stderr)
}

func fetchMain(args []string, stdout, stderr io.Writer) error {
	if fetchDBArgs(args) {
		return cmdFetchDB(args)
	}
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
// (-o -, the default) or a file (resumed at its size) until Ctrl-C. With
// -serve[=ADDR] it parses the stream as it grows and serves the live report
// (followServe).
func cmdFollow(args []string) error {
	return followMain(args, os.Stdout, os.Stderr)
}

func followMain(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("follow", flag.ExitOnError)
	out := fs.String("o", "-", "file to append to (resumed at its size), - = stdout")
	transport := fs.String("transport", "auto", "ssh transport: auto, cli or lib")
	var serve serveFlag
	fs.Var(&serve, "serve", "parse the trace as it grows and serve the live report (browser UI, /api/doc?rev= long poll, the engine's per-session /api routes) at ADDR (-serve=ADDR form, default "+defaultServeAddr+"); -o keeps the mirror (default: a temporary one)")
	batch := fs.Int("batch-ms", 1000, "-serve: the next snapshot of the report at most every N ms (50 to 60000)")
	bf := addBindFlags(fs)
	pos := parseArgs(fs, args)
	if len(pos) != 2 {
		return fmt.Errorf("follow: want <user@host[:port]> <remote-path>")
	}
	if serve.on && *out != "-" {
		if _, err := os.Stat(filepath.Dir(*out)); err != nil {
			return fmt.Errorf("follow: -o: %w", err)
		}
	}
	s, err := cliSSH(pos[0], *transport)
	if err != nil {
		return fmt.Errorf("follow: %w", err)
	}
	defer s.Close()
	ctx, stop := cliContext()
	defer stop()
	if serve.on {
		o := engine.SessionOptions{Follow: true, BatchMs: *batch, Binds: [...]string{"keep", "redact", "none"}[bf.mode], Salt: bf.salt}
		if err := followServe(ctx, s, pos[1], *out, serve.addr, o, stderr); err != nil {
			return fmt.Errorf("follow: %w", err)
		}
		return nil
	}
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

const defaultServeAddr = "127.0.0.1:8046"

// serveFlag is -serve[=ADDR] (follow): bare -serve listens on
// defaultServeAddr; the address goes in the same argument because a
// following word is the host or the path.
type serveFlag struct {
	on   bool
	addr string
}

func (f *serveFlag) String() string {
	if f == nil || !f.on {
		return "false"
	}
	return f.addr
}

func (f *serveFlag) Set(v string) error {
	switch v {
	case "", "true":
		f.on, f.addr = true, defaultServeAddr
	case "false":
		f.on, f.addr = false, ""
	default:
		f.on, f.addr = true, v
	}
	return nil
}

func (f *serveFlag) IsBoolFlag() bool { return true }

// followServe is follow -serve: an in-process engine follows the remote
// file p into a live session (engine.FollowRemote: the mirror at out, or
// in a temporary directory for -o -, the files of a TRACE CONTINUES IN
// chain next to it) and its per-session routes are served at addr under
// /api/ (GET only: no reference bundle upload), the browser UI at /; until
// ctx ends. The session's spill and a temporary mirror are removed then.
func followServe(ctx context.Context, s remote.SSH, p, out, addr string, o engine.SessionOptions, stderr io.Writer) error {
	if _, err := remote.Stat(ctx, s, p); err != nil { // fail now, not in the session
		return err
	}
	tmp, err := os.MkdirTemp("", "mtkprof-follow-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	local := out
	if local == "-" {
		local = filepath.Join(tmp, "mirror", path.Base(p))
	}
	logf := func(format string, a ...any) { fmt.Fprintf(stderr, "mtkprof: "+format+"\n", a...) }
	eng, err := engine.New(engine.Options{CacheDir: filepath.Join(tmp, "cache"), Version: version, Logf: logf})
	if err != nil {
		return err
	}
	defer eng.Close()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	id, err := eng.FollowRemote(s, p, local, o)
	if err != nil {
		ln.Close()
		return err
	}
	api := eng.SessionHandler(id)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		// open to other origins like serve's /api/doc (pnpm dev); reads only
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "X-Total-Lines, X-Rev")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		api.ServeHTTP(w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, ui.Index())
	})
	hs := &http.Server{Handler: mux}
	go hs.Serve(ln)
	logf("following %s into %s, serving the live report at http://%s/ (Ctrl-C stops)", p, local, ln.Addr())
	<-ctx.Done()
	hs.Close()
	if info, ok := eng.SessionInfo(id); ok && info.State == engine.SessionFailed {
		logf("the follow had stopped: %s", info.Error)
	}
	return nil
}
