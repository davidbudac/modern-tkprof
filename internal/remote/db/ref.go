package db

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// RefError is one reference query that failed.
type RefError struct {
	Target string // bundle file, e.g. datafiles.csv
	Err    error
}

// PartialError: FetchRef wrote the bundle, but these queries failed (like
// the script's "whenever sqlerror continue"); their files are absent. Fallback
// lists the full-mode queries that were refused (ORA-00942 or ORA-01031: no
// DBA_ views) and answered by their lite counterpart instead; their files are
// there, from the ALL_ views, and Err is the refusal. Either list may be empty.
type PartialError struct{ Failed, Fallback []RefError }

func (e *PartialError) Error() string {
	var s []string
	for _, f := range e.Failed {
		s = append(s, f.Target+": "+f.Err.Error())
	}
	var b strings.Builder
	if len(s) > 0 {
		b.WriteString("reference bundle incomplete: " + strings.Join(s, "; "))
	}
	if len(e.Fallback) > 0 {
		var t []string
		for _, f := range e.Fallback {
			t = append(t, f.Target)
		}
		if b.Len() > 0 {
			b.WriteString("; ")
		}
		b.WriteString("lite queries used for " + strings.Join(t, ", "))
	}
	return b.String()
}

// refRefused: the error a user without the DBA_ views (SELECT_CATALOG_ROLE or
// SELECT ANY DICTIONARY) gets from a full-mode query.
func refRefused(err error) bool { return IsORA(err, 942) || IsORA(err, 1031) }

// FetchRef runs report.RefQueries for m and writes the reference bundle
// into dir in the layout internal/ref.LoadBundle reads (the files the
// refscript spools): objects.csv, datafiles.csv, users.csv as SQL*Plus
// "markup csv on quote on" writes them, plans/<sql_id>.txt with one
// DBMS_XPLAN row per line. Then the caller applies it (ref.LoadBundle +
// model.ApplyRef). progress(done, total) after each query. A failed query
// does not stop the others; they come back as a *PartialError. In full mode a
// query refused for lack of the DBA_ views is run again as its lite
// counterpart (ALL_ views); the datafiles query has none and fails.
func (c *Client) FetchRef(ctx context.Context, m *model.Model, dir string, lite bool, progress func(done, total int)) error {
	qs := report.RefQueries(m, lite)
	if err := os.MkdirAll(filepath.Join(dir, "plans"), 0o755); err != nil {
		return err
	}
	var lites map[string]report.RefQuery
	var failed, fellBack []RefError
	for i, q := range qs {
		if err := ctx.Err(); err != nil {
			return err
		}
		var data []byte
		var err error
		if q.Name == "plan" {
			data = c.refPlan(ctx, q)
		} else {
			data, err = c.refCSV(ctx, q)
			if err != nil && !lite && refRefused(err) {
				if lites == nil {
					lites = map[string]report.RefQuery{}
					for _, l := range report.RefQueries(m, true) {
						lites[l.Target] = l
					}
				}
				if l, ok := lites[q.Target]; ok {
					refused := err
					if data, err = c.refCSV(ctx, l); err == nil {
						fellBack = append(fellBack, RefError{Target: q.Target, Err: refused})
					}
				}
			}
		}
		path := filepath.Join(dir, filepath.FromSlash(q.Target))
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			failed = append(failed, RefError{Target: q.Target, Err: err})
			os.Remove(path) // no stale file from an earlier run
		} else if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
		if progress != nil {
			progress(i+1, len(qs))
		}
	}
	if len(failed) > 0 || len(fellBack) > 0 {
		return &PartialError{Failed: failed, Fallback: fellBack}
	}
	return nil
}

// refCSV runs a CSV query: header quoted, number columns bare, others
// quoted with "" doubling, NULL empty.
func (c *Client) refCSV(ctx context.Context, q report.RefQuery) ([]byte, error) {
	rows, err := c.conn.Query(ctx, q.SQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var b bytes.Buffer
	for i, col := range q.Columns {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(csvQuote(col.Name))
	}
	b.WriteByte('\n')
	vals := make([]sql.NullString, len(q.Columns))
	dest := make([]any, len(vals))
	for i := range vals {
		dest[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		for i, v := range vals {
			if i > 0 {
				b.WriteByte(',')
			}
			if !v.Valid {
				continue
			}
			if q.Columns[i].Number {
				b.WriteString(v.String)
			} else {
				b.WriteString(csvQuote(v.String))
			}
		}
		b.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func csvQuote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// refPlan does what the script's PL/SQL block does: DISPLAY_CURSOR, and
// DISPLAY_AWR when the cursor "cannot be found" or gave nothing; an error
// becomes a note line, as the block's exception handler prints it.
func (c *Client) refPlan(ctx context.Context, q report.RefQuery) []byte {
	var lines []string
	miss, err := c.planLines(ctx, q.SQL, &lines, true)
	if err == nil && (miss || len(lines) == 0) {
		_, err = c.planLines(ctx, q.Fallback, &lines, false)
	}
	if err != nil {
		lines = append(lines, report.RefPlanError(q.SQLID, oneLine(err)))
	} else if len(lines) == 0 {
		lines = append(lines, report.RefPlanNone(q.SQLID))
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// planLines appends the rows of a DBMS_XPLAN query, trailing blanks trimmed
// (trimspool). checkMiss: a first row with report.RefPlanMissing ends the
// query unprinted, miss = true.
func (c *Client) planLines(ctx context.Context, sqlText string, lines *[]string, checkMiss bool) (miss bool, err error) {
	rows, err := c.conn.Query(ctx, sqlText)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	first := true
	for rows.Next() {
		var p sql.NullString
		if err := rows.Scan(&p); err != nil {
			return false, err
		}
		if first && checkMiss && strings.Contains(p.String, report.RefPlanMissing) {
			return true, nil
		}
		first = false
		*lines = append(*lines, strings.TrimRight(p.String, " \t\r"))
	}
	return false, rows.Err()
}

func oneLine(err error) string {
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}
