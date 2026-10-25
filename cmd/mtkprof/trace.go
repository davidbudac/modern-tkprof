package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote/db"
)

// openDB connects for the db subcommands (trace, ref -db, fetch -db),
// prompting for the password on the terminal. Tests replace it.
var openDB = func(ctx context.Context, s db.Spec, tls bool) (*db.Client, error) {
	return db.Open(ctx, s, termPrompter{}, tls)
}

// dbConnFlags are the connection flags every db subcommand takes.
type dbConnFlags struct {
	tcps, skipVerify bool
}

func (f *dbConnFlags) register(fs *flag.FlagSet) {
	fs.BoolVar(&f.tcps, "tcps", false, "connect with TCPS (TLS); the port is then usually 2484")
	fs.BoolVar(&f.skipVerify, "tls-skip-verify", false, "TCPS: do not verify the server certificate")
}

func (f *dbConnFlags) open(ctx context.Context, spec string) (*db.Client, error) {
	s, err := db.ParseSpec(spec)
	if err != nil {
		return nil, err
	}
	s.TLSSkipVerify = f.skipVerify
	return openDB(ctx, s, f.tcps)
}

// splitPositional parses flags that may come before, between or after the
// positional arguments and returns the positionals. Errors instead of
// exiting, so the parsing is testable.
func splitPositional(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

// traceCmd is a parsed `mtkprof trace` command line.
type traceCmd struct {
	spec                  string
	conn                  dbConnFlags
	sid, serial           int
	on, off               bool
	waits, binds          bool
	planStat              string
	sessions, files, diag bool
	since                 time.Duration
	json                  bool
}

func parseTraceArgs(args []string) (*traceCmd, error) {
	c := &traceCmd{}
	fs := flag.NewFlagSet("trace", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	c.conn.register(fs)
	fs.IntVar(&c.sid, "sid", 0, "session id (V$SESSION.SID)")
	fs.IntVar(&c.serial, "serial", 0, "session serial# (V$SESSION.SERIAL#)")
	fs.BoolVar(&c.on, "on", false, "switch SQL trace on (DBMS_MONITOR.SESSION_TRACE_ENABLE)")
	fs.BoolVar(&c.off, "off", false, "switch SQL trace off (DBMS_MONITOR.SESSION_TRACE_DISABLE)")
	fs.BoolVar(&c.waits, "waits", true, "-on: trace wait events")
	fs.BoolVar(&c.binds, "binds", true, "-on: trace bind values")
	fs.StringVar(&c.planStat, "plan-stat", "all_executions", "-on: STAT lines: never|first_execution|all_executions")
	fs.BoolVar(&c.sessions, "sessions", false, "list user sessions (V$SESSION)")
	fs.BoolVar(&c.files, "files", false, "list trace files (V$DIAG_TRACE_FILE; -sid/-serial: of that session)")
	fs.DurationVar(&c.since, "since", 0, "-files: only files modified within this duration (e.g. 2h)")
	fs.BoolVar(&c.diag, "diag", false, "show the server version and V$DIAG_INFO")
	fs.BoolVar(&c.json, "json", false, "-sessions, -files, -diag: JSON output")
	pos, err := splitPositional(fs, args)
	if err != nil {
		return nil, err
	}
	if len(pos) != 1 {
		return nil, errors.New("want one connection spec user@host[:port]/service")
	}
	if _, err := db.ParseSpec(pos[0]); err != nil {
		return nil, err
	}
	c.spec = pos[0]
	n := 0
	for _, b := range []bool{c.on, c.off, c.sessions, c.files, c.diag} {
		if b {
			n++
		}
	}
	if n != 1 {
		return nil, errors.New("want exactly one of -on, -off, -sessions, -files, -diag")
	}
	if (c.on || c.off) && (c.sid <= 0 || c.serial <= 0) {
		return nil, errors.New("-on/-off need -sid and -serial")
	}
	if !db.ValidPlanStat(c.planStat) {
		return nil, fmt.Errorf("-plan-stat %q: want never, first_execution or all_executions", c.planStat)
	}
	return c, nil
}

func cmdTrace(args []string) error {
	c, err := parseTraceArgs(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			usage()
		}
		return fmt.Errorf("trace: %w (usage: mtkprof trace <user@host[:port]/service> -sid S -serial N -on|-off | -sessions | -files | -diag)", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	cl, err := c.conn.open(ctx, c.spec)
	if err != nil {
		return err
	}
	defer cl.Close()
	return c.run(ctx, cl, os.Stdout)
}

func (c *traceCmd) run(ctx context.Context, cl *db.Client, out io.Writer) error {
	switch {
	case c.diag:
		v, err := cl.Version(ctx)
		if err != nil {
			return err
		}
		d, err := cl.DiagInfo(ctx)
		if err != nil {
			return err
		}
		if c.json {
			return writeJSON(out, map[string]any{"version": v, "diag": d})
		}
		fmt.Fprintf(out, "version             %s\nADR home            %s\ntrace directory     %s\nthis session's file %s\n", v, d.ADRHome, d.DiagTrace, d.DefaultTraceFile)
		return nil
	case c.sessions:
		ss, err := cl.Sessions(ctx)
		if err != nil {
			return err
		}
		if c.json {
			return writeJSON(out, ss)
		}
		tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "SID\tSERIAL#\tUSERNAME\tSTATUS\tSQL_TRACE\tLOGON\tOSUSER\tMACHINE\tPROGRAM\tMODULE\tSQL_ID\t")
		for _, s := range ss {
			me := ""
			if s.Self {
				me = " (this)"
			}
			fmt.Fprintf(tw, "%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s%s\t\n", s.SID, s.Serial, s.Username, s.Status, s.SQLTrace,
				s.LogonTime.Format("2006-01-02 15:04:05"), s.OSUser, s.Machine, s.Program, s.Module, s.SQLID, me)
		}
		return tw.Flush()
	case c.files:
		f := db.Filter{SID: c.sid, Serial: c.serial}
		if c.since > 0 {
			f.Since = time.Now().Add(-c.since)
		}
		fs, err := cl.TraceFiles(ctx, f)
		if err != nil {
			return err
		}
		if c.json {
			return writeJSON(out, fs)
		}
		tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "MODIFIED\tSID\tSERIAL#\tUSERNAME\tADR_HOME\tTRACE_FILENAME\t")
		for _, t := range fs {
			mod, sid, ser := "-", "", ""
			if !t.Modified.IsZero() {
				mod = t.Modified.Format("2006-01-02 15:04:05")
			}
			if t.SID > 0 {
				sid, ser = fmt.Sprint(t.SID), fmt.Sprint(t.Serial)
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t\n", mod, sid, ser, t.Username, t.ADRHome, t.Name)
		}
		if err := tw.Flush(); err != nil {
			return err
		}
		if len(fs) > 0 && fs[0].FromProcess {
			fmt.Fprintln(os.Stderr, "note: V$DIAG_TRACE_FILE is not readable (ORA-00942); listed V$PROCESS.TRACEFILE of live sessions instead; fetch -db needs V$DIAG_TRACE_FILE_CONTENTS (docs/REMOTE-db.md)")
		}
		return nil
	}
	o := db.TraceOptions{Waits: c.waits, Binds: c.binds, PlanStat: c.planStat}
	if err := cl.Trace(ctx, c.sid, c.serial, c.on, o); err != nil {
		return err
	}
	if c.off {
		fmt.Fprintf(out, "SQL trace off for sid %d serial# %d\n", c.sid, c.serial)
		return nil
	}
	var what []string
	if c.waits {
		what = append(what, "waits")
	}
	if c.binds {
		what = append(what, "binds")
	}
	what = append(what, "plan_stat "+strings.ToLower(c.planStat))
	fmt.Fprintf(out, "SQL trace on for sid %d serial# %d (%s)\n", c.sid, c.serial, strings.Join(what, ", "))
	if fs, err := cl.TraceFiles(ctx, db.Filter{SID: c.sid, Serial: c.serial}); err == nil && len(fs) > 0 {
		fmt.Fprintf(out, "trace file %s\n  fetch:   mtkprof fetch -db %s -adr-home %s -name %s\n  stop:    mtkprof trace %s -sid %d -serial %d -off\n",
			firstNonEmpty(fs[0].Path, fs[0].Name), c.spec, fs[0].ADRHome, fs[0].Name, c.spec, c.sid, c.serial)
	}
	return nil
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

func writeJSON(w io.Writer, v any) error {
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(v)
}
