package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/trace"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

// hasCompareFlag reports whether args contain the explicit -compare flag
// (html, serve and json then take exactly two traces).
func hasCompareFlag(args []string) bool {
	for _, a := range args {
		switch a {
		case "-compare", "--compare", "-compare=true", "--compare=true":
			return true
		}
	}
	return false
}

// parseTwo is parseArgs for exactly two positional trace files.
func parseTwo(fs *flag.FlagSet, args []string) (string, string, error) {
	var files []string
	for {
		fs.Parse(args)
		if fs.NArg() == 0 {
			break
		}
		files = append(files, fs.Arg(0))
		args = fs.Args()[1:]
	}
	if len(files) != 2 {
		return "", "", fmt.Errorf("want exactly two trace files (A then B), got %d", len(files))
	}
	return files[0], files[1], nil
}

// buildPair parses both traces and applies -ref and the bind flags to each.
func buildPair(fa, fb, ref string, bf *bindFlags) (*model.Model, *model.Model, error) {
	var ms [2]*model.Model
	for i, f := range []string{fa, fb} {
		m, err := buildModel([]string{f}, false)
		if err != nil {
			return nil, nil, err
		}
		if err := applyRef(m, ref); err != nil {
			return nil, nil, err
		}
		bf.apply(m)
		ms[i] = m
	}
	return ms[0], ms[1], nil
}

// cmdCompare is `mtkprof compare a.trc b.trc`: a text report of B against A.
func cmdCompare(args []string) error {
	fs := flag.NewFlagSet("compare", flag.ExitOnError)
	out := fs.String("o", "", "output file (default stdout)")
	n := fs.Int("n", 30, "rows per table")
	width := fs.Int("width", 120, "report width")
	fa, fb, err := parseTwo(fs, args)
	if err != nil {
		return err
	}
	a, err := buildModel([]string{fa}, false)
	if err != nil {
		return err
	}
	b, err := buildModel([]string{fb}, false)
	if err != nil {
		return err
	}
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	return report.CompareText(w, a, b, analyze.Compare(a, b), report.CompareOptions{Top: *n, Width: *width})
}

// cmdCompareDoc is `json|html|serve a.trc b.trc -compare`.
func cmdCompareDoc(kind string, args []string) error {
	fs := flag.NewFlagSet(kind+" -compare", flag.ExitOnError)
	fs.Bool("compare", true, "compare two traces: both traces + diff")
	rf := refFlag(fs)
	out := fs.String("o", "", "output file (default stdout for json, <a>-vs-<b>.html for html)")
	facts := fs.Bool("facts", true, "include raw fact tables")
	packed := fs.Bool("packed", false, "pack fact columns into gzip+base64 blobs (json; html and serve always do)")
	addr := fs.String("addr", "127.0.0.1:8046", "listen address (serve)")
	pv := planVizFlag(fs)
	bf := addBindFlags(fs)
	fa, fb, err := parseTwo(fs, args)
	if err != nil {
		return err
	}
	if kind == "html" && !ui.Built() {
		return fmt.Errorf("built without the web UI (make web, then rebuild)")
	}
	a, b, err := buildPair(fa, fb, *rf, bf)
	if err != nil {
		return err
	}
	opts := report.DocOptions{Facts: *facts, Packed: *packed || kind != "json", PlanVizURL: *pv}
	switch kind {
	case "json":
		w, err := openOut(*out)
		if err != nil {
			return err
		}
		defer w.Close()
		return report.CompareJSON(w, a, b, opts)
	case "html":
		doc, err := report.CompareBytes(a, b, opts)
		if err != nil {
			return err
		}
		path := *out
		if path == "" {
			path = strings.TrimSuffix(fa, ".trc") + "-vs-" + strings.TrimSuffix(filepath.Base(fb), ".trc") + ".html"
		}
		if err := os.WriteFile(path, []byte(ui.Standalone(doc)), 0o644); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "wrote %s (%.1f MB)\n", path, float64(len(doc))/1e6)
		return nil
	}
	doc, err := report.CompareBytes(a, b, opts)
	if err != nil {
		return err
	}
	var lis [2]*trace.LineIndex
	for i, f := range []string{fa, fb} {
		if lis[i], err = trace.OpenLineIndex(f); err != nil {
			return err
		}
		defer lis[i].Close()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/lines", func(w http.ResponseWriter, r *http.Request) {
		li := lis[0]
		if r.URL.Query().Get("side") == "b" {
			li = lis[1]
		}
		from, _ := strconv.Atoi(r.URL.Query().Get("from"))
		n, err := strconv.Atoi(r.URL.Query().Get("n"))
		if err != nil || n > maxLinesPerRequest {
			n = maxLinesPerRequest
		}
		bs, err := li.Read(from, n)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Total-Lines", strconv.Itoa(li.Lines()))
		w.Write(bs)
	})
	mux.HandleFunc("/api/doc", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "*")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(doc)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, ui.Index())
	})
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "mtkprof: serving comparison %s vs %s at http://%s/\n", fa, fb, ln.Addr())
	return http.Serve(ln, mux)
}
