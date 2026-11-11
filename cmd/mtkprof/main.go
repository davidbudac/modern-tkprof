// Command mtkprof analyses Oracle SQL trace (10046) files.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"sort"
	"strings"
	"time"

	"net"
	"net/http"
	"os/signal"
	"syscall"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	slicepkg "github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

var version = "0.1.0-dev"

func usage() {
	fmt.Fprintf(os.Stderr, `mtkprof %s - Oracle SQL trace (10046) analyzer

Usage:
  mtkprof <trace...> [report and html flags]   writes <trace>.txt (text report) and <trace>.html next to the trace
  mtkprof report <trace...> [-o out.txt] [-sort elapsed|cpu|execs|disk] [-top N] [-binds N|none] [-execs N] [-sys] [-aggregate]
  mtkprof brief  <trace...> [-case file] [-notes file] [-binds mask|keep|none] [-from tim -to tim] [-contexts ids] [-max-statements N] [-max-sql N] [-max-plan-lines N] [-ref dir] [-o out.md]   Markdown brief for an LLM agent
  mtkprof pivot  <trace...> [-fact calls|waits] [-by dim[,dim]] [-measure m] [-window a,b] [-csv]   (-by '?' lists dims)
  mtkprof html   <trace...> [-o out.html] [-plan-viz-url URL] [-aggregate]   self-contained HTML report
  mtkprof serve  <trace...> [-addr 127.0.0.1:8046] [-plan-viz-url URL] [-aggregate] [-spill[=DIR]]   browser UI
  mtkprof open   <trace...> [-app PATH]               open the traces in the desktop app (one tab; starts the app if needed)
  mtkprof engine [-listen 127.0.0.1:0] [-cache DIR] [-cache-cap 20G] [-allow-origin O,...] [-idle-exit D] [-idle D] [-detach]   desktop sidecar (token: env MTKPROF_TOKEN)
  mtkprof engine cache ls|rm <identity>|wipe [-cache DIR]   the engine's index cache
  mtkprof fetch  <user@host[:port]> <remote-path>... [-o dir] [-transport auto|cli|lib] [-no-gzip]   copy traces over SSH (resumes)
  mtkprof fetch -db <db-spec> -name F [-adr-home H] [-o file] [-resume]   copy a trace out of the database via V$DIAG_TRACE_FILE_CONTENTS
  mtkprof follow <user@host[:port]> <remote-path> [-o file|-] [-transport auto|cli|lib]   stream a growing trace (tail -f)
  mtkprof follow <user@host[:port]> <remote-path> -serve[=127.0.0.1:8046] [-o file] [-batch-ms 1000]   live report of it in the browser
  mtkprof askpass "<prompt>"                         SSH_ASKPASS helper (asks the engine, else the terminal)
  mtkprof mcp [-binds mask|keep] [trace...]           stdio MCP server of the analysis tools for an agent (claude mcp add mtkprof -- mtkprof mcp); the desktop engine sets MTKPROF_ENGINE, MTKPROF_TOKEN, MTKPROF_SESSION, MTKPROF_CONVERSATION
  mtkprof json   <trace...> [-o out.json] [-facts=false] [-packed] [-plan-viz-url URL] [-aggregate]
  mtkprof compare <a.trc> <b.trc> [-n 30] [-o out.txt]   text diff, B against A
  mtkprof html|serve|json <a.trc> <b.trc> -compare ...    both traces + diff (Compare tab)
  mtkprof plan   <trace...> -sql_id X [-plan-hash H] [-exec N] [-o out.json] [-viz] [-plan-viz-url URL]
  mtkprof plan   <trace...> -list                    statements with STAT plans
  mtkprof export <trace...> [-o dir]                 CSV tables
  mtkprof refscript <trace...> [-lite] [-o ref.sql]  SQL*Plus script collecting names and plans
  mtkprof refscript <trace...> -paste [-plans] [-o names.sql]  script printing the names to paste into the app
  mtkprof ref -db <db-spec> <trace...> [-o dir] [-lite]  run those queries on the database, write the bundle
  mtkprof trace <db-spec> -sid S -serial N -on|-off [-waits=true] [-binds=true] [-plan-stat all_executions]   SQL trace of a session
  mtkprof trace <db-spec> -sessions | -files [-sid S -serial N] [-since 2h] | -diag   [-json]
  mtkprof findings-config                            default finding thresholds as JSON
  mtkprof lint   <trace...>
  mtkprof version

Memory modes:
  -lowmem (report pivot html json serve export): bind values not retained; numbers unchanged
  -aggregate (report html json serve): calls and waits folded into aggregates while reading,
             not stored; implies -lowmem and -facts=false; memory ~ statement count.
             Omitted: executions tables, bind sections, fact tables (drill-down, pivot,
             server-side slicing). Unchanged: summary lines, call tables, profiles,
             sessions, time buckets, findings.
  -spill[=DIR] (serve): -aggregate build + calls, waits and binds written to fixed-width
             temp files in DIR (default system temp dir); Pivot, Timeline, executions and
             event drill-downs answered by scanning them. Disk ~ trace size; files removed
             on exit. -lowmem omits binds; -bind-values redact|none applies. DIR needs
             the = form.

Trace sets (<trace...>):
  Files and/or directories (*.trc, not recursive) form one logical trace.
  "TRACE CONTINUES IN FILE" / "TRACE CONTINUED FROM FILE" chains are followed (marker
  path, else same name next to the file, else among the inputs, else a sibling whose
  header names it) and parsed as one stream; -no-follow disables. Independent files:
  separate session contexts. PX slave traces (P000...) attach to their query
  coordinator by time window, client id, module and action.

Plans (plan):
  Output: STAT dumps as the ora-explain-plan-viz JSON row array. One plan: the array;
  several plan hashes (no -plan-hash): {"<plan hash>": [rows], ...}. -viz: "Open in
  plan viz" URL instead (plan in the URL fragment only). -exec N: N-th dump of a hash.

Reference bundle (report, html, json, export, serve, pivot, plan):
  -ref dir   output of the `+"`mtkprof refscript`"+` script: objects.csv, datafiles.csv,
             users.csv, plans/<sql_id>.txt (each optional). Names for obj#, file#, user
             ids; DBMS_XPLAN text. Only `+"`ref -db`"+` connects to a database. -lite: ALL_
             views only. -ref file: the saved output of the `+"`refscript -paste`"+` script.
             See docs/REF-BUNDLE.md.

Remote (fetch, follow, trace, ref -db, askpass):
  <user@host[:port]> is SSH (system ssh, or the Go library with -transport lib); <db-spec>
  is user@host[:port]/service (Easy Connect, port 1521 by default). Passwords, passphrases
  and host-key questions are asked on the terminal (or one line of stdin per question when
  stdin is a pipe), never a flag or an argument; nothing is stored. -tcps: TLS
  (-tls-skip-verify: do not check the certificate). fetch -db and fetch resume a partial
  file (-resume for -db with -o). Grants, transports, verification: docs/REMOTE.md. The
  other commands stay offline.

Finding thresholds (report, html, serve, json):
  -findings-config file.json   any subset of the threshold keys (unknown keys: error);
                               "-" = stdin. Defaults: `+"`mtkprof findings-config`"+`.

Bind values (report, html, json, export, serve):
  -bind-values keep|redact|none   keep (default); redact = type, length, stable hash per
                                  value; none = dropped
  -redact-binds                   = -bind-values redact
  -redact-salt STRING             salted redaction hash: equal values match across traces
                                  with the same salt; not comparable to unsalted hashes
  -binds none                     = -bind-values none (report: -binds N = bind sets
                                  printed per statement)
  Hashes are not secret: short values are brute-forceable. SQL text and literals are kept.

`, version)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	tuneGC()
	stopProf := startProfiles()
	var err error
	switch cmd {
	case "report":
		err = cmdReport(args)
	case "compare":
		err = cmdCompare(args)
	case "brief":
		err = cmdBrief(args)
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
	case "engine":
		err = cmdEngine(args)
	case "open":
		err = cmdOpen(args)
	case "askpass":
		err = cmdAskpass(args)
	case "mcp":
		err = cmdMCP(args)
	case "fetch":
		err = cmdFetch(args)
	case "follow":
		err = cmdFollow(args)
	case "findings-config":
		err = cmdFindingsConfig(args)
	case "lint":
		err = cmdLint(args)
	case "plan":
		err = cmdPlan(args)
	case "refscript":
		err = cmdRefScript(args)
	case "ref":
		err = cmdRef(args)
	case "trace":
		err = cmdTrace(args)
	case "version", "-v", "--version":
		fmt.Println("mtkprof", version)
	case "-h", "--help", "help":
		usage()
	default:
		if !isTraceArg(cmd) {
			fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
			usage()
		}
		err = cmdDefault(os.Args[1:])
	}
	stopProf()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// tuneGC lowers the collector's heap growth target from the default 100 %.
// The memory of a big trace is a few huge pointer-free slices (the fact
// tables), which the collector does not scan, so collecting earlier costs
// little and keeps the peak close to the live size. GOGC in the environment
// wins.
func tuneGC() {
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(40)
	}
}

// startProfiles is a hidden developer hook: MTKPROF_CPUPROFILE / MTKPROF_MEMPROFILE
// name files for `go tool pprof`. The heap profile is taken at exit with
// alloc_space available (inuse_space is the heap at the end of the command).
func startProfiles() (stop func()) {
	var cpu *os.File
	if p := os.Getenv("MTKPROF_CPUPROFILE"); p != "" {
		if f, err := os.Create(p); err == nil {
			cpu = f
			pprof.StartCPUProfile(f)
		}
	}
	return func() {
		if cpu != nil {
			pprof.StopCPUProfile()
			cpu.Close()
		}
		if p := os.Getenv("MTKPROF_MEMPROFILE"); p != "" {
			if f, err := os.Create(p); err == nil {
				runtime.GC()
				pprof.Lookup("allocs").WriteTo(f, 0)
				f.Close()
			}
		}
	}
}

// parseArgs parses flags that may appear before, between or after the
// positional trace paths (Go's flag package stops at the first positional
// otherwise). At least one path is required.
func parseArgs(fs *flag.FlagSet, args []string) []string {
	var files []string
	for {
		fs.Parse(args)
		if fs.NArg() == 0 {
			break
		}
		files = append(files, fs.Arg(0))
		args = fs.Args()[1:]
	}
	if len(files) == 0 {
		usage()
	}
	return files
}

// lowMem is -lowmem: build the model without bind values and collect garbage
// more eagerly (see model.Options.NoFacts). Set by addFollowFlag, read by
// buildModel and the commands that print binds.
var lowMem bool

// aggregate is -aggregate: build the aggregation-only model (model.Options.Aggregate).
// aggTh are the finding thresholds its accumulator decides the per-execution
// rules with (set by the commands before the model is built).
var (
	aggregate bool
	aggTh     = analyze.DefaultThresholds()
)

// addAggregateFlag registers -aggregate (report, html, json, serve).
func addAggregateFlag(fs *flag.FlagSet) {
	fs.BoolVar(&aggregate, "aggregate", false, "fold calls and waits into aggregates, do not store them (implies -lowmem and -facts=false; no executions tables, bind sections or fact tables)")
}

// spillFlag is -spill[=DIR] (serve): aggregation-only build plus the fact rows
// on disk (internal/slice Spill). Bare -spill uses os.TempDir(); the directory
// goes in the same argument (-spill=DIR) because a following word is a trace.
type spillFlag struct {
	on  bool
	dir string
}

func (f *spillFlag) String() string {
	if f == nil || !f.on {
		return "false"
	}
	if f.dir == "" {
		return "true"
	}
	return f.dir
}

func (f *spillFlag) Set(v string) error {
	switch v {
	case "", "true":
		f.on, f.dir = true, ""
	case "false":
		f.on, f.dir = false, ""
	default:
		f.on, f.dir = true, v
	}
	return nil
}

func (f *spillFlag) IsBoolFlag() bool { return true }

// spillCfg is set by serve -spill before the model is built; spill is the
// spill the build created (nil until then).
var (
	spillCfg spillFlag
	spill    *slicepkg.Spill
)

// useThresholds makes the thresholds of -findings-config known to buildModel.
func useThresholds(th *analyze.Thresholds) {
	if th != nil {
		aggTh = *th
	}
}

// addFollowFlag registers -no-follow and -lowmem, shared by every command that
// reads traces.
func addFollowFlag(fs *flag.FlagSet) *bool {
	fs.BoolVar(&lowMem, "lowmem", false, "do not retain bind values (no BINDS sections, binds columns or binds.csv rows); other numbers unchanged")
	return fs.Bool("no-follow", false, "do not follow TRACE CONTINUES IN / CONTINUED FROM to unnamed files")
}

// outBase is the default output name stem for a trace set: the first input
// without its .trc extension (or the directory name).
func outBase(files []string) string {
	return strings.TrimSuffix(strings.TrimRight(files[0], "/\\"), ".trc")
}

func openOut(path string) (io.WriteCloser, error) {
	if path == "" || path == "-" {
		return os.Stdout, nil
	}
	return os.Create(path)
}

func cmdRefScript(args []string) error {
	fs := flag.NewFlagSet("refscript", flag.ExitOnError)
	out := fs.String("o", "", "output file (default stdout)")
	lite := fs.Bool("lite", false, "ALL_ views only, runnable by any schema (no datafile names)")
	paste := fs.Bool("paste", false, "names script: prints the names to paste into the app (or to save as a file for -ref) instead of spooling ref/")
	plans := fs.Bool("plans", false, "with -paste: DBMS_XPLAN plans too (a much longer output)")
	nf := addFollowFlag(fs)
	files := parseArgs(fs, args)
	if *paste && *lite {
		return fmt.Errorf("-lite: not with -paste (the names script reads the ALL_ views by itself when the DBA_ views are not readable)")
	}
	if *plans && !*paste {
		return fmt.Errorf("-plans: with -paste only (the spooling script always collects plans)")
	}
	m, err := buildTrace("no object names to collect", files, *nf)
	if err != nil {
		return err
	}
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	script := report.RefScript(m, report.RefScriptOptions{Lite: *lite})
	if *paste {
		script = report.RefPasteScript(m, report.RefPasteOptions{Plans: *plans})
	}
	_, err = io.WriteString(w, script)
	return err
}

func cmdReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	rf := refFlag(fs)
	out := fs.String("o", "", "output file (default stdout)")
	opts := report.TextOptions{}
	fc := findingsFlag(fs)
	fs.StringVar(&opts.Sort, "sort", "elapsed", "statement order: elapsed|self|cpu|execs|disk|query|rows|line")
	fs.IntVar(&opts.Top, "top", 0, "only the top N statements (0 = all)")
	fs.IntVar(&opts.Execs, "execs", 20, "executions to list per statement (0 = none, -1 = all)")
	opts.Binds = 5
	bf := addReportBindFlags(fs, &opts.Binds)
	fs.BoolVar(&opts.Sys, "sys", true, "include recursive SYS statements")
	fs.IntVar(&opts.Width, "width", 120, "report width")
	nf := addFollowFlag(fs)
	addAggregateFlag(fs)
	files := parseArgs(fs, args)
	var err error
	opts.Thresholds, err = loadThresholds(*fc)
	if err != nil {
		return err
	}
	useThresholds(opts.Thresholds)
	m, err := buildModel(files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	bf.apply(m)
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	oi, done, err := optInput(m, bf, false, true)
	if err != nil {
		return err
	}
	defer done()
	if oi != nil { // a 10053 file: its digest
		return report.OptText(w, oi)
	}
	return report.Text(w, m, opts)
}

func cmdJSON(args []string) error {
	if hasCompareFlag(args) {
		return cmdCompareDoc("json", args)
	}
	fs := flag.NewFlagSet("json", flag.ExitOnError)
	rf := refFlag(fs)
	out := fs.String("o", "", "output file (default stdout)")
	facts := fs.Bool("facts", true, "include raw fact tables (calls, waits, binds)")
	packed := fs.Bool("packed", false, "pack fact columns into gzip+base64 blobs (smaller, faster to load)")
	pv := planVizFlag(fs)
	fc := findingsFlag(fs)
	bf := addBindFlags(fs)
	nf := addFollowFlag(fs)
	addAggregateFlag(fs)
	files := parseArgs(fs, args)
	th, err := loadThresholds(*fc)
	if err != nil {
		return err
	}
	useThresholds(th)
	m, err := buildModel(files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	bf.apply(m)
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	do, done, err := withOpt(report.DocOptions{Facts: *facts && !aggregate, Packed: *packed, PlanVizURL: *pv, Thresholds: th}, m, bf, true)
	if err != nil {
		return err
	}
	defer done()
	return report.JSON(w, m, do)
}

func cmdHTML(args []string) error {
	if hasCompareFlag(args) {
		return cmdCompareDoc("html", args)
	}
	fs := flag.NewFlagSet("html", flag.ExitOnError)
	rf := refFlag(fs)
	out := fs.String("o", "", "output file (default <trace>.html)")
	facts := fs.Bool("facts", true, "include raw fact tables (needed for drill-down)")
	pv := planVizFlag(fs)
	fc := findingsFlag(fs)
	bf := addBindFlags(fs)
	nf := addFollowFlag(fs)
	addAggregateFlag(fs)
	files := parseArgs(fs, args)
	if !ui.Built() {
		return fmt.Errorf("built without the web UI (make web, then rebuild)")
	}
	th, err := loadThresholds(*fc)
	if err != nil {
		return err
	}
	useThresholds(th)
	m, err := buildModel(files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	bf.apply(m)
	path := *out
	if path == "" {
		path = outBase(files) + ".html"
	}
	do, done, err := withOpt(report.DocOptions{Facts: *facts && !aggregate, Packed: true, PlanVizURL: *pv, Thresholds: th}, m, bf, true)
	if err != nil {
		return err
	}
	defer done()
	return writeHTML(path, m, do)
}

// writeHTML writes the self-contained HTML report of m to path.
func writeHTML(path string, m *model.Model, opts report.DocOptions) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	err = ui.WriteStandalone(bw, func(w io.Writer) error {
		return report.WriteDocument(w, m, opts)
	})
	if err == nil {
		err = bw.Flush()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if fi, serr := os.Stat(path); serr == nil {
		fmt.Fprintf(os.Stderr, "wrote %s (%.1f MB)\n", path, float64(fi.Size())/1e6)
	}
	return nil
}

func cmdExport(args []string) error {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	rf := refFlag(fs)
	out := fs.String("o", "", "output directory (default <trace>.csv/)")
	bf := addBindFlags(fs)
	nf := addFollowFlag(fs)
	files := parseArgs(fs, args)
	m, err := buildTrace("nothing to export", files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	bf.apply(m)
	dir := *out
	if dir == "" {
		dir = outBase(files) + ".csv"
	}
	written, err := report.ExportCSV(m, dir)
	for _, f := range written {
		fmt.Fprintln(os.Stderr, "wrote", f)
	}
	return err
}

// maxLinesPerRequest caps GET /api/lines.
const maxLinesPerRequest = slicepkg.MaxLines

func cmdServe(args []string) error {
	if hasCompareFlag(args) {
		return cmdCompareDoc("serve", args)
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	rf := refFlag(fs)
	addr := fs.String("addr", "127.0.0.1:8046", "listen address")
	facts := fs.Bool("facts", true, "send the raw fact tables to the browser")
	slice := fs.Bool("slice", false, "server answers the UI's group-by queries (/api/pivot, ...); implied by -facts=false")
	pv := planVizFlag(fs)
	fc := findingsFlag(fs)
	nf := addFollowFlag(fs)
	addAggregateFlag(fs)
	fs.Var(&spillCfg, "spill", "-aggregate build + calls, waits and binds spilled to temp files in DIR (default system temp dir; -spill=DIR form); drill-downs scan them; removed on exit")
	bf := addBindFlags(fs)
	files := parseArgs(fs, args)
	// Without the fact tables in the document the browser has nothing to slice: the
	// server keeps the model and answers the queries (docs/ARCHITECTURE.md § Server-side slicing).
	// An aggregation-only model has no facts to slice either: the document is all there is,
	// unless -spill keeps the facts on disk.
	slicing := (*slice || !*facts) && !aggregate
	if spillCfg.on {
		slicing = true
	}
	if aggregate || spillCfg.on {
		*facts = false
	}
	th, err := loadThresholds(*fc)
	if err != nil {
		return err
	}
	useThresholds(th)
	bindMode, bindSalt = bf.mode, bf.salt
	m, err := buildModel(files, *nf)
	if err != nil {
		closeSpill()
		return err
	}
	defer closeSpill()
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	bf.apply(m)
	// A 10053 file: the document says so ("opt.file"), and the two api/opt routes
	// answer for its dumps. No digest: the browser reads the routes.
	oi, done, err := optInput(m, bf, false, false)
	if err != nil {
		return err
	}
	defer done()
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: *facts, Packed: true, PlanVizURL: *pv, Thresholds: th, Slice: slicing, Opt: oi})
	if err != nil {
		return err
	}
	var src slicepkg.FactSource
	if spill != nil {
		debug.FreeOSMemory() // the build churned through the heap; give the pages back before idling
		if src, err = spill.Source(); err != nil {
			return fmt.Errorf("spill: %w", err)
		}
		sz := spill.Sizes()
		var total int64
		for _, n := range sz {
			total += n
		}
		fmt.Fprintf(os.Stderr, "mtkprof: spilled %d calls, %d waits to %s: %.1f MB (calls %.1f, waits %.1f, binds %.1f, indexes %.1f)\n", src.NumCalls(), src.NumWaits(), spill.Dir(),
			float64(total)/1e6, float64(sz["calls.bin"])/1e6, float64(sz["waits.bin"])/1e6, float64(sz["bindsets.bin"]+sz["binds.bin"]+sz["bindvals.bin"])/1e6, float64(sz["calls.stmt"]+sz["waits.stmt"])/1e6)
	}
	// One line index per input file; ?file=i selects it (0 = first file).
	var lis []*trace.LineIndex
	for _, fe := range m.File.Files {
		f := fe.Path
		li, err := trace.OpenLineIndex(f)
		if err != nil {
			return err
		}
		defer li.Close()
		lis = append(lis, li)
	}
	mux := http.NewServeMux()
	if osrv := optServer(m, oi, lis); osrv != nil {
		defer osrv.Close()
		mux.Handle("/api/opt/dump", osrv.DumpHandler())
		mux.Handle("/api/opt/text", osrv.TextHandler())
	}
	// The slicing modes serve the line endpoints too (lines incl. annot=1,
	// lines/at, at, search); /api/doc below is the longer pattern's exception.
	if src != nil || slicing {
		if src == nil {
			src = slicepkg.MemSource(m)
		}
		ss := slicepkg.NewServer(m, src).WithLines(lis)
		ss.Thresholds = th // api/findings: those of the document's findings
		mux.Handle("/api/", ss.Handler())
	} else {
		m = nil // the model is not needed any more: the document is built, only the line indexes serve requests
		debug.FreeOSMemory()
		mux.Handle("/api/lines", slicepkg.LinesHandler(lis))
	}
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
	fmt.Fprintf(os.Stderr, "mtkprof: serving %s at http://%s/\n", strings.Join(files, " "), ln.Addr())
	return http.Serve(ln, mux)
}

// bindMode and bindSalt are the bind flags as serve -spill needs them while
// the model is built (the spill writes the values, so it redacts them).
var (
	bindMode model.BindMode
	bindSalt string
)

// closeSpill removes the spill files (no-op without -spill).
func closeSpill() {
	if spill != nil {
		spill.Close()
	}
}

// removeSpillOnSignal removes the spill files when the process is told to stop,
// also while the trace is still being read.
func removeSpillOnSignal(sp *slicepkg.Spill) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-ch
		sp.Close()
		os.Exit(130)
	}()
}

func buildModel(files []string, noFollow bool) (*model.Model, error) {
	start := time.Now()
	// A 10053 file is a run of its own: left out of a set of 10046 files, the
	// first of a set of 10053 files (the others are named in a note).
	optNotes = nil
	if exp, err := model.ExpandInputs(files); err == nil && len(exp) > 1 {
		if kept, notes := model.OptInputs(exp); len(notes) > 0 {
			files, optNotes = kept, notes
			for _, n := range notes {
				fmt.Fprintln(os.Stderr, "note:", n)
			}
		}
	}
	aggMode := aggregate || spillCfg.on
	if (lowMem || aggMode) && os.Getenv("GOGC") == "" {
		debug.SetGCPercent(20)
	}
	opts := model.Options{NoFollow: noFollow, NoFacts: lowMem || aggMode}
	if aggMode {
		th := aggTh
		opts.Aggregate = true
		opts.NewSink = func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) }
	}
	if spillCfg.on {
		var err error
		spill, err = slicepkg.NewSpill(slicepkg.SpillOptions{Dir: spillCfg.dir, Key: slicepkg.SpillKey(files), BindMode: bindMode, Salt: bindSalt})
		if err != nil {
			return nil, fmt.Errorf("spill: %w", err)
		}
		removeSpillOnSignal(spill)
		opts.SpillBinds = !lowMem && bindMode != model.BindsNone
		opts.NewTee = spill.Attach
	}
	m, err := model.BuildFiles(files, opts)
	if err != nil {
		return nil, err
	}
	m.Diag.Notes = append(m.Diag.Notes, optNotes...)
	what := files[0]
	if n := len(m.File.Files); n > 1 {
		what = fmt.Sprintf("%d files (%s ...)", n, m.File.Files[0].Name)
	}
	if p := os.Getenv("MTKPROF_HEAPPROFILE"); p != "" { // heap in use right after the build
		if f, err := os.Create(p); err == nil {
			runtime.GC()
			pprof.WriteHeapProfile(f)
			f.Close()
		}
	}
	fmt.Fprintf(os.Stderr, "parsed %s: %d lines, %.1f MB in %s\n", what, m.Diag.Lines, float64(m.Diag.Bytes)/1e6, time.Since(start).Round(time.Millisecond))
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

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func cmdLint(args []string) error {
	fs := flag.NewFlagSet("lint", flag.ExitOnError)
	files := parseArgs(fs, args)
	paths, err := model.ExpandInputs(files)
	if err != nil {
		return err
	}
	for _, file := range paths {
		if err := lintFile(file); err != nil {
			return err
		}
	}
	return nil
}

func lintFile(file string) error {
	h := &lintHandler{markers: map[string]int{}, calls: map[string]int{}, events: map[string]int{}, lobOps: map[string]int{}, bindDty: map[int]int{}, closeTyp: map[int]int{}}
	start := time.Now()
	st, err := trace.ParseFile(file, h)
	if err != nil {
		return err
	}
	el := time.Since(start)
	fmt.Printf("file: %s\nlines: %d  bytes: %d  max line: %d  time: %s (%.0f MB/s)\n", file, st.Lines, st.Bytes, st.MaxLine, el.Round(time.Millisecond), float64(st.Bytes)/1e6/el.Seconds())
	fmt.Printf("file kind: %s\n", st.FileKind())
	fmt.Println("line kinds:")
	for k := trace.Kind(0); int(k) < len(st.Kinds); k++ {
		if st.Kinds[k] > 0 {
			fmt.Printf("  %-18s %d\n", k.String(), st.Kinds[k])
		}
	}
	if len(st.Dumps) > 0 {
		fmt.Printf("dumps: %d (optimizer, event 10053)\n", len(st.Dumps))
		for _, d := range st.Dumps {
			cut := ""
			if d.Cut {
				cut = "  cut"
			}
			fmt.Printf("  lines %d-%d  sql_id %s%s\n", d.First, d.Last, orDash(d.SQLID), cut)
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
