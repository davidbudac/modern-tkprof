package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

// isTraceArg tells whether the first argument starts the default command
// (`mtkprof <trace...>`) rather than naming a subcommand: a flag, an existing
// path, or something that looks like one (so a mistyped file name reports
// "no such file" instead of "unknown command").
func isTraceArg(a string) bool {
	if strings.HasPrefix(a, "-") && a != "-" {
		return true
	}
	if _, err := os.Stat(a); err == nil {
		return true
	}
	return strings.ContainsAny(a, `/\.`)
}

// defaultOut is the stem of the default command's outputs: the first input
// as given (trace.trc -> trace.trc.txt, trace.trc.html), a directory without
// its trailing separator.
func defaultOut(files []string) string {
	return strings.TrimRight(files[0], `/\`)
}

// cmdDefault is `mtkprof <trace...>`: one parse, the text report written to
// <trace>.txt and the HTML report to <trace>.html. It takes the flags of
// report and html.
func cmdDefault(args []string) error {
	fs := flag.NewFlagSet("mtkprof", flag.ExitOnError)
	rf := refFlag(fs)
	opts := report.TextOptions{}
	fc := findingsFlag(fs)
	fs.StringVar(&opts.Sort, "sort", "elapsed", "statement order: elapsed|self|cpu|execs|disk|query|rows|line")
	fs.IntVar(&opts.Top, "top", 0, "only the top N statements (0 = all)")
	fs.IntVar(&opts.Execs, "execs", 20, "executions to list per statement (0 = none, -1 = all)")
	opts.Binds = 5
	bf := addReportBindFlags(fs, &opts.Binds)
	fs.BoolVar(&opts.Sys, "sys", true, "include recursive SYS statements")
	fs.IntVar(&opts.Width, "width", 120, "report width")
	facts := fs.Bool("facts", true, "HTML: include raw fact tables (needed for drill-down)")
	pv := planVizFlag(fs)
	nf := addFollowFlag(fs)
	addAggregateFlag(fs)
	files := parseArgs(fs, args)
	th, err := loadThresholds(*fc)
	if err != nil {
		return err
	}
	opts.Thresholds = th
	useThresholds(th)
	m, err := buildModel(files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	bf.apply(m)
	base := defaultOut(files)
	txt := base + ".txt"
	f, err := os.Create(txt)
	if err != nil {
		return err
	}
	oi, done, oerr := optInput(m, bf, true, true) // one scan for the text and the HTML
	if oerr != nil {
		f.Close()
		return oerr
	}
	defer done()
	if oi != nil { // a 10053 file: the text report is its digest
		err = report.OptText(f, oi)
	} else {
		err = report.Text(f, m, opts)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "wrote", txt)
	if !ui.Built() {
		return fmt.Errorf("built without the web UI (make web, then rebuild): %s.html not written", base)
	}
	return writeHTML(base+".html", m, report.DocOptions{Facts: *facts && !aggregate, Packed: true, PlanVizURL: *pv, Thresholds: th, Opt: oi})
}
