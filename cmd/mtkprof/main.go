// Command mtkprof analyses Oracle SQL trace (10046) files.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"net"
	"net/http"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/trace"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

var version = "0.1.0-dev"

func usage() {
	fmt.Fprintf(os.Stderr, `mtkprof %s - Oracle SQL trace (10046) analyzer

Usage:
  mtkprof report <trace.trc> [-o out.txt] [-sort elapsed|cpu|execs|disk] [-top N] [-binds N|none] [-execs N] [-sys]
  mtkprof pivot  <trace.trc> [-fact calls|waits] [-by dim[,dim]] [-measure m] [-window a,b] [-csv]   (-by '?' lists dims)
  mtkprof html   <trace.trc> [-o out.html] [-plan-viz-url URL]   self-contained interactive report
  mtkprof serve  <trace.trc> [-addr 127.0.0.1:8046] [-plan-viz-url URL]   interactive UI in the browser
  mtkprof json   <trace.trc> [-o out.json] [-facts=false] [-packed] [-plan-viz-url URL]
  mtkprof plan   <trace.trc> -sql_id X [-plan-hash H] [-exec N] [-o out.json] [-viz] [-plan-viz-url URL]
  mtkprof plan   <trace.trc> -list                    statements with STAT plans
  mtkprof export <trace.trc> [-o dir]                 CSV tables for DuckDB / Excel / Python
  mtkprof lint   <trace.trc>
  mtkprof version

Plans (plan):
  Exports STAT dumps as the JSON row array that ora-explain-plan-viz auto-detects.
  One plan selected -> the array; several plan hashes (no -plan-hash) -> an object
  {"<plan hash>": [rows], ...}. -viz prints an "Open in plan viz" link instead
  (the plan travels in the URL fragment only). -exec N picks the N-th dump of a hash.

Bind values (report, html, json, export, serve):
  -bind-values keep|redact|none   keep (default); redact = type, length and a stable
                                  hash per value; none = drop bind values entirely
  -redact-binds                   shorthand for -bind-values redact
  -redact-salt STRING             redact with a salted hash: equal values still match
                                  across traces using the same salt, but the tokens cannot
                                  be compared with hashes of known values without it
  -binds none                     shorthand for -bind-values none (on report, -binds N
                                  is still the number of bind sets printed per statement)
  The hash is for spotting equal values across executions, not for secrecy: short
  values can be recovered by brute force. SQL text (and its literals) is kept.

`, version)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "report":
		err = cmdReport(args)
	case "pivot":
		err = cmdPivot(args)
	case "json":
		err = cmdJSON(args)
	case "html":
		err = cmdHTML(args)
	case "export":
		err = cmdExport(args)
	case "serve":
		err = cmdServe(args)
	case "lint":
		err = cmdLint(args)
	case "plan":
		err = cmdPlan(args)
	case "version", "-v", "--version":
		fmt.Println("mtkprof", version)
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// parseArgs parses flags that may appear before or after the single
// positional trace file argument (Go's flag package stops at the first
// positional otherwise).
func parseArgs(fs *flag.FlagSet, args []string) string {
	file := ""
	for {
		fs.Parse(args)
		if fs.NArg() == 0 {
			break
		}
		if file != "" {
			fmt.Fprintf(os.Stderr, "unexpected argument %q\n", fs.Arg(0))
			usage()
		}
		file = fs.Arg(0)
		args = fs.Args()[1:]
	}
	if file == "" {
		usage()
	}
	return file
}

func openOut(path string) (io.WriteCloser, error) {
	if path == "" || path == "-" {
		return os.Stdout, nil
	}
	return os.Create(path)
}

func cmdReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	out := fs.String("o", "", "output file (default stdout)")
	opts := report.TextOptions{}
	fs.StringVar(&opts.Sort, "sort", "elapsed", "statement order: elapsed|self|cpu|execs|disk|query|rows|line")
	fs.IntVar(&opts.Top, "top", 0, "only the top N statements (0 = all)")
	fs.IntVar(&opts.Execs, "execs", 20, "executions to list per statement (0 = none, -1 = all)")
	opts.Binds = 5
	bf := addReportBindFlags(fs, &opts.Binds)
	fs.BoolVar(&opts.Sys, "sys", true, "include recursive SYS statements")
	fs.IntVar(&opts.Width, "width", 120, "report width")
	file := parseArgs(fs, args)
	m, err := buildModel(file)
	if err != nil {
		return err
	}
	bf.apply(m)
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	return report.Text(w, m, opts)
}

func cmdJSON(args []string) error {
	fs := flag.NewFlagSet("json", flag.ExitOnError)
	out := fs.String("o", "", "output file (default stdout)")
	facts := fs.Bool("facts", true, "include raw fact tables (calls, waits, binds)")
	packed := fs.Bool("packed", false, "pack fact columns into gzip+base64 blobs (smaller, faster to load)")
	pv := planVizFlag(fs)
	bf := addBindFlags(fs)
	file := parseArgs(fs, args)
	m, err := buildModel(file)
	if err != nil {
		return err
	}
	bf.apply(m)
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	return report.JSON(w, m, report.DocOptions{Facts: *facts, Packed: *packed, PlanVizURL: *pv})
}

func cmdHTML(args []string) error {
	fs := flag.NewFlagSet("html", flag.ExitOnError)
	out := fs.String("o", "", "output file (default <trace>.html)")
	facts := fs.Bool("facts", true, "include raw fact tables (needed for drill-down; omit for huge traces)")
	pv := planVizFlag(fs)
	bf := addBindFlags(fs)
	file := parseArgs(fs, args)
	if !ui.Built() {
		return fmt.Errorf("this binary was built without the web UI (run `make web` and rebuild)")
	}
	m, err := buildModel(file)
	if err != nil {
		return err
	}
	bf.apply(m)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: *facts, Packed: true, PlanVizURL: *pv})
	if err != nil {
		return err
	}
	path := *out
	if path == "" {
		path = strings.TrimSuffix(file, ".trc") + ".html"
	}
	if err := os.WriteFile(path, []byte(ui.Standalone(doc)), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %s (%.1f MB)\n", path, float64(len(doc))/1e6)
	return nil
}

func cmdExport(args []string) error {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	out := fs.String("o", "", "output directory (default <trace>.csv/)")
	bf := addBindFlags(fs)
	file := parseArgs(fs, args)
	m, err := buildModel(file)
	if err != nil {
		return err
	}
	bf.apply(m)
	dir := *out
	if dir == "" {
		dir = strings.TrimSuffix(file, ".trc") + ".csv"
	}
	files, err := report.ExportCSV(m, dir)
	for _, f := range files {
		fmt.Fprintln(os.Stderr, "wrote", f)
	}
	return err
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8046", "listen address")
	facts := fs.Bool("facts", true, "include raw fact tables")
	pv := planVizFlag(fs)
	bf := addBindFlags(fs)
	file := parseArgs(fs, args)
	m, err := buildModel(file)
	if err != nil {
		return err
	}
	bf.apply(m)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: *facts, Packed: true, PlanVizURL: *pv})
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/doc", func(w http.ResponseWriter, r *http.Request) {
		// local dev server: let `pnpm dev` load ?doc=http://127.0.0.1:8046/api/doc
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
	fmt.Fprintf(os.Stderr, "mtkprof: serving %s at http://%s/\n", file, ln.Addr())
	return http.Serve(ln, mux)
}

func buildModel(path string) (*model.Model, error) {
	start := time.Now()
	m, err := model.Build(path, model.Options{})
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "parsed %s: %d lines, %.1f MB in %s\n", path, m.Diag.Lines, float64(m.Diag.Bytes)/1e6, time.Since(start).Round(time.Millisecond))
	return m, nil
}

// lintHandler counts every record kind and keeps samples of unknown lines.
type lintHandler struct {
	trace.NopHandler
	unknown  []string
	markers  map[string]int
	calls    map[string]int
	events   map[string]int
	lobOps   map[string]int
	bindDty  map[int]int
	closeTyp map[int]int
	cursors  int
	maxDep   int
	nomatch  int
	mismatch []string
}

func (h *lintHandler) Unknown(line int, text []byte) {
	if len(h.unknown) < 50 {
		h.unknown = append(h.unknown, fmt.Sprintf("%7d: %s", line, text))
	}
}
func (h *lintHandler) Marker(m trace.Marker) { h.markers[m.Kind.String()]++ }
func (h *lintHandler) Cursor(c trace.CursorHeader) {
	h.cursors++
	if c.Dep > h.maxDep {
		h.maxDep = c.Dep
	}
	if len(c.Text) != c.Len {
		h.nomatch++
		if len(h.mismatch) < 20 {
			t := c.Text
			if len(t) > 50 {
				t = t[len(t)-50:]
			}
			h.mismatch = append(h.mismatch, fmt.Sprintf("%7d: len=%d got=%d diff=%+d dep=%d tail=%q", c.Line, c.Len, len(c.Text), len(c.Text)-c.Len, c.Dep, t))
		}
	}
}
func (h *lintHandler) Call(c trace.Call) {
	h.calls[c.Kind.String()]++
	if c.Kind.IsLob() {
		h.lobOps[c.Op]++
	}
	if c.Kind == trace.CallClose {
		h.closeTyp[c.Type]++
	}
}
func (h *lintHandler) Wait(w trace.Wait) { h.events[w.Name]++ }
func (h *lintHandler) Binds(b trace.BindSet) {
	for _, x := range b.Binds {
		h.bindDty[x.Dty]++
	}
}

func cmdLint(args []string) error {
	fs := flag.NewFlagSet("lint", flag.ExitOnError)
	file := parseArgs(fs, args)
	h := &lintHandler{markers: map[string]int{}, calls: map[string]int{}, events: map[string]int{}, lobOps: map[string]int{}, bindDty: map[int]int{}, closeTyp: map[int]int{}}
	start := time.Now()
	st, err := trace.ParseFile(file, h)
	if err != nil {
		return err
	}
	el := time.Since(start)
	fmt.Printf("file: %s\nlines: %d  bytes: %d  max line: %d  time: %s (%.0f MB/s)\n", file, st.Lines, st.Bytes, st.MaxLine, el.Round(time.Millisecond), float64(st.Bytes)/1e6/el.Seconds())
	fmt.Println("line kinds:")
	for k := trace.Kind(0); int(k) < len(st.Kinds); k++ {
		if st.Kinds[k] > 0 {
			fmt.Printf("  %-18s %d\n", k.String(), st.Kinds[k])
		}
	}
	printMap := func(title string, m map[string]int) {
		if len(m) == 0 {
			return
		}
		fmt.Println(title + ":")
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return m[keys[i]] > m[keys[j]] })
		for _, k := range keys {
			fmt.Printf("  %-45s %d\n", k, m[k])
		}
	}
	printMap("markers", h.markers)
	printMap("calls", h.calls)
	printMap("lob ops", h.lobOps)
	printMap("wait events", h.events)
	fmt.Printf("cursors: %d (max dep %d, %d with text length != len=)\n", h.cursors, h.maxDep, h.nomatch)
	for _, mm := range h.mismatch {
		fmt.Println("  ", mm)
	}
	if len(h.bindDty) > 0 {
		fmt.Print("bind datatypes:")
		for k, v := range h.bindDty {
			fmt.Printf(" %d:%d", k, v)
		}
		fmt.Println()
	}
	if len(h.closeTyp) > 0 {
		fmt.Print("close types:")
		for k, v := range h.closeTyp {
			fmt.Printf(" %d:%d", k, v)
		}
		fmt.Println()
	}
	if st.Unknown > 0 {
		fmt.Printf("UNKNOWN LINES: %d (first %d shown)\n", st.Unknown, len(h.unknown))
		for _, u := range h.unknown {
			fmt.Println(" ", u)
		}
	}
	return nil
}
