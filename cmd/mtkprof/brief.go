package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	slicepkg "github.com/davidbudac/modern-tkprof/internal/slice"
)

func cmdBrief(args []string) error {
	fs := flag.NewFlagSet("brief", flag.ExitOnError)
	rf := refFlag(fs)
	out := fs.String("o", "", "output file (default stdout)")
	fc := findingsFlag(fs)
	caseFile := fs.String("case", "", "file with the case description (\"-\" = stdin)")
	notesFile := fs.String("notes", "", "JSON file with notes: an array of annotations, or an object with a \"notes\" array (the desktop's annotations.json entry)")
	binds := fs.String("binds", "mask", "bind values: mask (type, length, hash salted per brief), keep, none")
	salt := fs.String("salt", "", "salt of the masked bind hashes (default random per brief)")
	var o report.BriefOptions
	fs.IntVar(&o.MaxStatements, "max-statements", 0, fmt.Sprintf("statements listed at most (default %d, max %d)", report.BriefDefaultStatements, report.BriefMaxStatements))
	fs.IntVar(&o.MaxSQLChars, "max-sql", 0, fmt.Sprintf("characters of one statement's SQL (default %d)", report.BriefDefaultSQLChars))
	fs.IntVar(&o.MaxPlanLines, "max-plan-lines", 0, fmt.Sprintf("lines of one plan (default %d, -1 = no plans)", report.BriefDefaultPlanLines))
	var f analyze.Filter
	fs.Int64Var(&f.StartTim, "from", 0, "window start, tim in µs (0 = from the start)")
	fs.Int64Var(&f.EndTim, "to", 0, "window end, tim in µs (0 = to the end)")
	ctxs := fs.String("contexts", "", "session context ids, comma separated (default all)")
	nf := addFollowFlag(fs)
	files := parseArgs(fs, args)
	var err error
	if o.Binds, err = report.ParseBriefBinds(*binds); err != nil {
		return err
	}
	o.Salt = *salt
	if o.Thresholds, err = loadThresholds(*fc); err != nil {
		return err
	}
	useThresholds(o.Thresholds)
	if *caseFile != "" {
		b, err := readFileOrStdin(*caseFile)
		if err != nil {
			return err
		}
		o.Case = string(b)
	}
	if *notesFile != "" {
		if o.Notes, err = readNotes(*notesFile); err != nil {
			return err
		}
	}
	m, err := buildTrace("no brief to make", files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	if f.Contexts, err = parseContexts(*ctxs, len(m.Contexts)); err != nil {
		return err
	}
	if f.EndTim != 0 && f.EndTim < f.StartTim {
		return fmt.Errorf("-to %d is before -from %d", f.EndTim, f.StartTim)
	}
	res, err := report.Brief(context.Background(), m, slicepkg.MemSource(m), f, o)
	if err != nil {
		return err
	}
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(w, res.Markdown); err != nil {
		w.Close()
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "estimated tokens: %d\n", res.EstTokens)
	return nil
}

func readFileOrStdin(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

func readNotes(path string) ([]report.Note, error) {
	data, err := readFileOrStdin(path)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimSpace(data)
	if bytes.HasPrefix(data, []byte("{")) {
		var entry struct {
			Notes json.RawMessage `json:"notes"`
		}
		if err := json.Unmarshal(data, &entry); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		data = entry.Notes
	}
	var notes []report.Note
	if len(data) > 0 {
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&notes); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	return notes, nil
}

func parseContexts(v string, n int) ([]model.ID, error) {
	var out []model.ID
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		x, err := strconv.Atoi(p)
		if err != nil || x < 0 || x >= n {
			return nil, fmt.Errorf("-contexts: %q is not a context id (0..%d)", p, n-1)
		}
		out = append(out, model.ID(x))
	}
	return out, nil
}
