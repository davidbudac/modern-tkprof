package db

// Integration test against a real database, skipped unless
//
//	MTKPROF_DB_TEST=user/password@host:port/service   e.g. mtk/mtk@localhost:1521/pdb1.world
//	MTKPROF_DB_TEST_TCPS=1                            optional: TCPS, certificate not verified
//	MTKPROF_DB_TEST_BIG=<trace_filename>              optional: a large trace in the same ADR
//	                                                  home, fetched to measure throughput
//	MTKPROF_DB_TEST_BIG_SHA256=<hex>                  optional: its expected sha256
//	MTKPROF_DB_TEST_FIXTURE=<trace_filename>          optional: the lab's copy of
//	                                                  testdata/traces/19c/basic_binds.trc, fetched and compared
//
// The password in the variable is for this test only; mtkprof itself never
// takes one from the environment. See docs/REMOTE.md for the grants.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/remote"
)

type fixedPassword string

func (p fixedPassword) Ask(context.Context, remote.Prompt) (string, error) { return string(p), nil }

func dbTestClient(t *testing.T) *Client {
	env := os.Getenv("MTKPROF_DB_TEST")
	if env == "" {
		t.Skip("MTKPROF_DB_TEST=user/password@host:port/service not set")
	}
	at := strings.LastIndexByte(env, '@')
	slash := strings.IndexByte(env, '/')
	if at < 0 || slash < 0 || slash > at {
		t.Fatal("MTKPROF_DB_TEST: want user/password@host:port/service")
	}
	spec, err := ParseSpec(env[:slash] + env[at:])
	if err != nil {
		t.Fatal(err)
	}
	tls := os.Getenv("MTKPROF_DB_TEST_TCPS") != ""
	spec.TLSSkipVerify = tls
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := Open(ctx, spec, fixedPassword(env[slash+1:at]), tls)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

type countWriter struct{ n int64 }

func (w *countWriter) Write(p []byte) (int, error) { w.n += int64(len(p)); return len(p), nil }

func TestDBMint(t *testing.T) {
	c := dbTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	v, err := c.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("version: %s", v)
	diag, err := c.DiagInfo(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("diag: ADR Home %s, Diag Trace %s, Default Trace File %s", diag.ADRHome, diag.DiagTrace, diag.DefaultTraceFile)
	if diag.ADRHome == "" || diag.DefaultTraceFile == "" {
		t.Errorf("v$diag_info incomplete: %v", diag.All)
	}

	ss, err := c.Sessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var me Session
	for _, s := range ss {
		if s.Self {
			if me.SID != 0 {
				t.Errorf("two own sessions: %d and %d", me.SID, s.SID)
			}
			me = s
		}
	}
	if me.SID == 0 {
		t.Fatalf("own session not among %d sessions", len(ss))
	}
	t.Logf("%d user sessions; own sid %d serial# %d tracefile %s", len(ss), me.SID, me.Serial, me.TraceFile)

	// trace this session, run a marked statement, stop
	if err := c.MyTrace(ctx, true); err != nil {
		t.Fatal(err)
	}
	var n int64
	if _, err := c.queryRow(ctx, "select /*+ mtkprof_e8 */ count(*) from dual", nil, &n); err != nil || n != 1 {
		t.Fatalf("marked statement: %d, %v", n, err)
	}
	if err := c.MyTrace(ctx, false); err != nil {
		t.Fatal(err)
	}

	files, err := c.TraceFiles(ctx, Filter{SID: me.SID, Serial: me.Serial})
	if err != nil {
		t.Fatal(err)
	}
	var tf TraceFile
	for _, f := range files {
		t.Logf("trace file %+v", f)
		if f.Name == filepath.Base(diag.DefaultTraceFile) {
			tf = f
		}
	}
	if tf.Name == "" {
		t.Fatalf("own trace file %s not listed (%d rows)", diag.DefaultTraceFile, len(files))
	}
	if tf.FromProcess {
		t.Fatal("V$DIAG_TRACE_FILE not readable (ORA-00942): grant select on sys.v_$diag_trace_file and v_$diag_trace_file_contents")
	}
	all, err := c.TraceFiles(ctx, Filter{Since: time.Now().Add(-time.Hour)})
	t.Logf("files modified in the last hour: %d (%v)", len(all), err)

	// a row is a record (one or more lines), line_number its last line, so
	// there are fewer rows than lines, with gaps and repeats in the numbers
	var lo, hi, cnt, nl sql.NullInt64
	if _, err := c.queryRow(ctx, "select min(line_number), max(line_number), count(*), sum(case when instr(payload, chr(10)) > 0 then 1 else 0 end) from v$diag_trace_file_contents where adr_home = :h and trace_filename = :f",
		[]any{tf.ADRHome, tf.Name}, &lo, &hi, &cnt, &nl); err != nil {
		t.Fatal(err)
	}
	t.Logf("line_number %d..%d, %d rows, %d payloads with a newline", lo.Int64, hi.Int64, cnt.Int64, nl.Int64)

	path := filepath.Join(t.TempDir(), tf.Name)
	out, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	lines, err := c.Fetch(ctx, tf.ADRHome, tf.Name, out, Resume{}, nil)
	out.Close()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	logRate(t, "own trace", lines, st.Size(), time.Since(start))
	if d := hi.Int64 - lines; d < 0 || d > 1 { // line_number of the last record is its line count, give or take a STAT line
		t.Errorf("fetched %d lines, max(line_number) is %d", lines, hi.Int64)
	}
	m, err := model.BuildFiles([]string{path}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, st := range m.Statements {
		found = found || strings.Contains(st.Text, "mtkprof_e8")
	}
	if !found {
		t.Errorf("marked statement not in the fetched trace (%d statements)", len(m.Statements))
	}
	// a copy cut after a few lines (and in the middle of one) resumes to the same file
	full, _ := os.ReadFile(path)
	for _, frac := range []int{0, 1, 2, 3} {
		cut := len(full) * frac / 4
		if frac == 3 {
			cut-- // inside a line
		}
		cut = bytes.LastIndexByte(full[:cut+1], '\n') + 1
		p2 := filepath.Join(t.TempDir(), "partial.trc")
		os.WriteFile(p2, append(append([]byte(nil), full[:cut]...), "partial li"...), 0o644)
		f, r, err := OpenResume(p2, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		_, err = c.Fetch(ctx, tf.ADRHome, tf.Name, f, r, nil)
		f.Close()
		if got, _ := os.ReadFile(p2); err != nil || !bytes.Equal(got, full) {
			t.Errorf("resume after %d bytes (%d lines): %v; copy differs from a fresh fetch: %v", cut, r.Lines, err, !bytes.Equal(got, full))
		}
	}
	if fx := os.Getenv("MTKPROF_DB_TEST_FIXTURE"); fx != "" {
		// the lab's copy of testdata/traces/19c/basic_binds.trc, byte for byte
		var got bytes.Buffer
		if _, err := c.Fetch(ctx, diag.ADRHome, fx, &got, Resume{}, nil); err != nil {
			t.Fatal(err)
		}
		want, _ := os.ReadFile("../../../testdata/traces/19c/basic_binds.trc")
		if !bytes.Equal(got.Bytes(), want) {
			t.Errorf("%s: %d bytes fetched, fixture has %d", fx, got.Len(), len(want))
		}
	}

	t.Run("dbms_monitor", func(t *testing.T) {
		err := c.Trace(ctx, me.SID, me.Serial, true, TraceOptions{Waits: true, Binds: true, PlanStat: "all_executions"})
		if err != nil {
			t.Fatalf("%v (grant execute on sys.dbms_monitor?)", err)
		}
		ss, _ := c.Sessions(ctx)
		for _, s := range ss {
			if s.Self && s.SQLTrace != "ENABLED" {
				t.Errorf("v$session.sql_trace = %q after enable", s.SQLTrace)
			}
		}
		if err := c.Trace(ctx, me.SID, me.Serial, false, TraceOptions{}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("ref", func(t *testing.T) {
		fm, err := model.Build("../../../testdata/traces/19c/io_waits.trc", model.Options{})
		if err != nil {
			t.Fatal(err)
		}
		for _, lite := range []bool{false, true} {
			dir := t.TempDir()
			err := c.FetchRef(ctx, fm, dir, lite, nil)
			var pe *PartialError
			if err != nil && !errors.As(err, &pe) {
				t.Fatal(err)
			}
			// mtk has no DBA_ views: full mode falls back to the ALL_ ones per
			// query (the datafiles query has no lite form and may fail); lite
			// mode must not fail at all
			if pe != nil {
				for _, f := range pe.Failed {
					if lite || f.Target != "datafiles.csv" || !refRefused(f.Err) {
						t.Errorf("lite=%v: %s failed: %v", lite, f.Target, f.Err)
					}
				}
				if lite && len(pe.Fallback) > 0 {
					t.Errorf("lite fell back: %v", pe.Fallback)
				}
				for _, f := range pe.Fallback {
					t.Logf("lite=%v: %s fell back to the lite query (%v)", lite, f.Target, f.Err)
				}
			}
			b, lerr := ref.LoadBundle(dir)
			if lerr != nil {
				t.Fatal(lerr)
			}
			fix, _ := ref.LoadBundle("../../../testdata/reference/bundle")
			t.Logf("lite=%v: %s (fixture: %s); %v", lite, b.Summary(), fix.Summary(), err)
			if _, err := os.Stat(filepath.Join(dir, "users.csv")); err != nil || len(b.Users) == 0 {
				t.Errorf("lite=%v: no users.csv", lite)
			}
			model.ApplyRef(fm, b)
		}
	})

	if big := os.Getenv("MTKPROF_DB_TEST_BIG"); big != "" {
		h := sha256.New()
		w := &countWriter{}
		start := time.Now()
		lines, err := c.Fetch(ctx, diag.ADRHome, big, io.MultiWriter(w, h), Resume{}, func(l int64) {
			t.Logf("  %d lines, %.1fs", l, time.Since(start).Seconds())
		})
		if err != nil {
			t.Fatal(err)
		}
		logRate(t, big, lines, w.n, time.Since(start))
		sum := hex.EncodeToString(h.Sum(nil))
		t.Logf("sha256 %s", sum)
		if want := os.Getenv("MTKPROF_DB_TEST_BIG_SHA256"); want != "" && want != sum {
			t.Errorf("sha256 %s, want %s", sum, want)
		}
	}
}

func logRate(t *testing.T, what string, lines, bytes int64, d time.Duration) {
	s := d.Seconds()
	t.Logf("fetch %s: %d lines, %.1f MB in %.2fs = %.0f lines/s, %.2f MB/s", what, lines, float64(bytes)/1e6, s, float64(lines)/s, float64(bytes)/1e6/s)
}
