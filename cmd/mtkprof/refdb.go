package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/remote/db"
)

// refCmd is a parsed `mtkprof ref -db <spec> <trace...>`.
type refCmd struct {
	spec     string
	conn     dbConnFlags
	out      string
	lite     bool
	noFollow bool
	files    []string
}

func parseRefArgs(args []string) (*refCmd, error) {
	c := &refCmd{}
	fs := flag.NewFlagSet("ref", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&c.spec, "db", "", "connection user@host[:port]/service (the password is prompted)")
	fs.StringVar(&c.out, "o", "", "bundle directory (default <trace>.ref)")
	fs.BoolVar(&c.lite, "lite", false, "ALL_ views only (no datafile names); for users without SELECT_CATALOG_ROLE")
	c.conn.register(fs)
	nf := addFollowFlag(fs)
	pos, err := splitPositional(fs, args)
	if err != nil {
		return nil, err
	}
	c.noFollow = *nf
	if c.spec == "" {
		return nil, errors.New("-db user@host[:port]/service is required (offline: mtkprof refscript)")
	}
	if _, err := db.ParseSpec(c.spec); err != nil {
		return nil, err
	}
	if len(pos) == 0 {
		return nil, errors.New("no trace files")
	}
	c.files = pos
	if c.out == "" {
		c.out = outBase(pos) + ".ref"
	}
	return c, nil
}

// cmdRef is `mtkprof ref -db`: run the reference queries of the trace
// (what `refscript` writes for SQL*Plus) on the database, write the bundle
// and show what -ref <dir> adds.
func cmdRef(args []string) error {
	c, err := parseRefArgs(args)
	if err != nil {
		return fmt.Errorf("ref: %w (usage: mtkprof ref -db <user@host[:port]/service> <trace...> [-o dir] [-lite] [-tcps])", err)
	}
	m, err := buildModel(c.files, c.noFollow)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	cl, err := c.conn.open(ctx, c.spec)
	if err != nil {
		return err
	}
	defer cl.Close()
	err = cl.FetchRef(ctx, m, c.out, c.lite, func(done, total int) {
		fmt.Fprintf(os.Stderr, "\rreference queries %d/%d", done, total)
		if done == total {
			fmt.Fprintln(os.Stderr)
		}
	})
	var pe *db.PartialError
	if errors.As(err, &pe) {
		for _, f := range pe.Failed {
			fmt.Fprintf(os.Stderr, "warning: %s not written: %v\n", f.Target, f.Err)
		}
		for _, f := range pe.Fallback {
			fmt.Fprintf(os.Stderr, "note: %s from the ALL_ views (the DBA_ view is not granted: %v)\n", f.Target, strings.SplitN(f.Err.Error(), "\n", 2)[0])
		}
		if !c.lite {
			fmt.Fprintln(os.Stderr, "hint: without SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY use -lite (ALL_ views)")
		}
	} else if err != nil {
		return err
	}
	if err := applyRef(m, c.out); err != nil {
		return err
	}
	fmt.Printf("mtkprof report %s -ref %s\n", strings.Join(c.files, " "), c.out)
	return nil
}

// fetchDBArgs reports whether a `mtkprof fetch` command line is the db
// form (-db <spec>); cmdFetch hands those to cmdFetchDB.
func fetchDBArgs(args []string) bool {
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "-db" || a == "--db" || strings.HasPrefix(a, "-db=") || strings.HasPrefix(a, "--db=") {
			return true
		}
	}
	return false
}

// fetchDBCmd is a parsed `mtkprof fetch -db`.
type fetchDBCmd struct {
	spec, adrHome, name, out string
	conn                     dbConnFlags
	resume                   bool
}

func parseFetchDBArgs(args []string) (*fetchDBCmd, error) {
	c := &fetchDBCmd{}
	fs := flag.NewFlagSet("fetch", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&c.spec, "db", "", "connection user@host[:port]/service (the password is prompted)")
	fs.StringVar(&c.adrHome, "adr-home", "", "ADR home of the file (default: the instance's, V$DIAG_INFO)")
	fs.StringVar(&c.name, "name", "", "trace file name (V$DIAG_TRACE_FILE.TRACE_FILENAME), e.g. cdb1_ora_4242.trc")
	fs.StringVar(&c.out, "o", "", "output file (default: the trace file name; - = stdout)")
	fs.BoolVar(&c.resume, "resume", false, "continue a partial -o file after its last complete line")
	c.conn.register(fs)
	pos, err := splitPositional(fs, args)
	if err != nil {
		return nil, err
	}
	if len(pos) > 0 {
		return nil, fmt.Errorf("unexpected arguments %q", pos)
	}
	if c.spec == "" || c.name == "" {
		return nil, errors.New("want -db user@host[:port]/service and -name <trace file>")
	}
	if _, err := db.ParseSpec(c.spec); err != nil {
		return nil, err
	}
	if strings.ContainsAny(c.name, `/\`) {
		return nil, fmt.Errorf("-name %q: a file name, not a path (the directory is -adr-home)", c.name)
	}
	if c.out == "" {
		c.out = c.name
	}
	if c.resume && c.out == "-" {
		return nil, errors.New("-resume needs an -o file")
	}
	return c, nil
}

// cmdFetchDB is `mtkprof fetch -db`: copy a trace out of
// V$DIAG_TRACE_FILE_CONTENTS.
func cmdFetchDB(args []string) error {
	c, err := parseFetchDBArgs(args)
	if err != nil {
		return fmt.Errorf("fetch: %w (usage: mtkprof fetch -db <user@host[:port]/service> -name F [-adr-home H] [-o file] [-resume])", err)
	}
	var w io.Writer = os.Stdout
	var from db.Resume
	if c.out != "-" {
		var f *os.File
		if c.resume {
			f, from, err = db.OpenResume(c.out, 0o644)
		} else {
			f, err = os.Create(c.out)
		}
		if err != nil {
			return err
		}
		defer f.Close()
		w = f
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	cl, err := c.conn.open(ctx, c.spec)
	if err != nil {
		return err
	}
	defer cl.Close()
	if c.adrHome == "" {
		d, err := cl.DiagInfo(ctx)
		if err != nil {
			return err
		}
		c.adrHome = d.ADRHome
	}
	cw := &countingWriter{w: w}
	warned := false
	n, err := cl.Fetch(ctx, c.adrHome, c.name, cw, from, func(lines int64) {
		fmt.Fprintf(os.Stderr, "\r%s: %d lines, %.1f MB", c.name, from.Lines+lines, float64(cw.n)/1e6)
		if cw.n > db.BigFetch && !warned {
			warned = true
			fmt.Fprintf(os.Stderr, "\nnote: past 200 MB; V$DIAG_TRACE_FILE_CONTENTS is slow, SSH (mtkprof fetch user@host <path>) is faster for big files\n")
		}
	})
	fmt.Fprintln(os.Stderr)
	if err != nil {
		if c.out != "-" {
			fmt.Fprintf(os.Stderr, "partial copy in %s (%d lines); continue with -resume\n", c.out, from.Lines+n)
		}
		return err
	}
	if from.Lines+n == 0 {
		return fmt.Errorf("fetch: %s/%s: no lines (wrong -adr-home or -name, or the file is not visible from this container)", c.adrHome, c.name)
	}
	if c.out != "-" {
		fmt.Fprintf(os.Stderr, "wrote %s (%d lines)\n", c.out, from.Lines+n)
	}
	return nil
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
