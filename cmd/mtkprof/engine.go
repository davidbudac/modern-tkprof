package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
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
		return cmdEngineCache(args[1:])
	}
	fs := flag.NewFlagSet("engine", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:0", "listen address (port 0 = any free port)")
	cache := fs.String("cache", "", "index cache directory (default <user cache dir>/mtkprof)")
	cacheCap := fs.String("cache-cap", "20G", "index cache size limit (bytes; suffixes K, M, G, T = powers of 1024)")
	origins := fs.String("allow-origin", "", "comma-separated CORS origins (e.g. tauri://localhost,http://tauri.localhost)")
	idle := fs.Duration("idle-exit", 0, "exit after this long without sessions and requests (0 = never)")
	evict := fs.Duration("idle", 0, "close a session after this long without requests on it and without a running job (cache entry stays; live sessions never; 0 = never)")
	pv := planVizFlag(fs)
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
	capBytes, err := parseSize(*cacheCap)
	if err != nil || capBytes <= 0 {
		return fmt.Errorf("engine: -cache-cap %q: want a positive size like 20G", *cacheCap)
	}
	dir := *cache
	if dir == "" {
		if dir, err = engine.CacheDefaultDir(); err != nil {
			dir = filepath.Join(os.TempDir(), "mtkprof")
		}
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
	eng, err := engine.New(engine.Options{Token: token, AllowOrigins: allow, CacheDir: dir, CacheCap: capBytes, Version: version, PlanVizURL: *pv, IdleEvict: *evict,
		Logf: func(format string, a ...any) { fmt.Fprintf(os.Stderr, "mtkprof engine: "+format+"\n", a...) }})
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
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
	eng.Close() // ends the event streams and jobs, closes the sessions (their cache entries stay)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	hs.Shutdown(ctx)
	return nil
}

// parseSize reads a byte count with an optional K, M, G or T suffix (powers
// of 1024; a trailing "B" or "iB" is allowed: 20G, 20GB, 20GiB, 512M).
func parseSize(v string) (int64, error) {
	v = strings.TrimSpace(strings.ToUpper(v))
	v = strings.TrimSuffix(strings.TrimSuffix(v, "B"), "I")
	mult := int64(1)
	if n := len(v); n > 0 {
		if i := strings.IndexByte("KMGT", v[n-1]); i >= 0 {
			mult, v = int64(1)<<(10*(i+1)), v[:n-1]
		}
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil || n < 0 || n > math.MaxInt64/mult {
		return 0, fmt.Errorf("bad size %q", v)
	}
	return n * mult, nil
}
