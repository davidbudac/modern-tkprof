package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/engine"
)

// minTokenLen is the shortest MTKPROF_TOKEN the engine accepts.
const minTokenLen = 32

// cmdEngine runs the desktop app's sidecar (docs/PLAN-DESKTOP.md § 2): the
// engine's HTTP server on a loopback port, one JSON ready line on stdout, exit
// on stdin EOF (the parent is gone) unless -detach, on SIGINT/SIGTERM, or
// after -idle-exit without sessions and requests.
func cmdEngine(args []string) error {
	if len(args) > 0 && args[0] == "cache" {
		// TODO(E2): return cmdEngineCache(args[1:])
		return fmt.Errorf("engine cache: not available yet")
	}
	fs := flag.NewFlagSet("engine", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:0", "listen address (port 0 = any free port)")
	cache := fs.String("cache", "", "cache directory (default <user cache dir>/mtkprof)")
	origins := fs.String("allow-origin", "", "comma-separated CORS origins (e.g. tauri://localhost,http://tauri.localhost)")
	idle := fs.Duration("idle-exit", 0, "exit after this long without sessions and requests (0 = never)")
	detach := fs.Bool("detach", false, "keep running when stdin closes")
	fs.Parse(args)
	if fs.NArg() > 0 {
		return fmt.Errorf("engine: unexpected argument %q", fs.Arg(0))
	}
	token := os.Getenv("MTKPROF_TOKEN")
	if len(token) < minTokenLen {
		fmt.Fprintf(os.Stderr, "mtkprof engine: MTKPROF_TOKEN must hold a secret of at least %d bytes\n", minTokenLen)
		os.Exit(2)
	}
	dir := *cache
	if dir == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			base = os.TempDir()
		}
		dir = filepath.Join(base, "mtkprof")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("engine: cache dir: %w", err)
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(20) // every session is an aggregate + spill build, as serve -spill
	}
	var allow []string
	for _, o := range strings.Split(*origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			allow = append(allow, o)
		}
	}
	eng := engine.New(engine.Options{Token: token, AllowOrigins: allow, CacheDir: dir, Version: version,
		Logf: func(format string, a ...any) { fmt.Fprintf(os.Stderr, "mtkprof engine: "+format+"\n", a...) }})
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		eng.Close()
		return err
	}
	hs := &http.Server{Handler: eng.Handler(), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()

	ready, _ := json.Marshal(struct {
		Ready    bool   `json:"ready"`
		Addr     string `json:"addr"`
		Version  string `json:"version"`
		Protocol int    `json:"protocol"`
	}{true, ln.Addr().String(), version, engine.Protocol})
	os.Stdout.Write(append(ready, '\n'))

	stop := make(chan string, 4)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { stop <- (<-sig).String() }()
	if !*detach {
		go func() {
			io.Copy(io.Discard, os.Stdin)
			stop <- "stdin closed"
		}()
	}
	if *idle > 0 {
		go func() {
			tick := time.NewTicker(min(*idle/4, time.Second))
			defer tick.Stop()
			for range tick.C {
				if eng.IdleFor() >= *idle {
					stop <- "idle"
					return
				}
			}
		}()
	}
	var why string
	select {
	case why = <-stop:
	case err := <-served:
		eng.Close()
		return err
	}
	fmt.Fprintf(os.Stderr, "mtkprof engine: stopping (%s)\n", why)
	eng.Close() // ends the event streams and jobs, removes the spill directories
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	hs.Shutdown(ctx)
	return nil
}
