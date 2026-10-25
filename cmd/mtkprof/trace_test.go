package main

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/remote/db"
)

func TestParseTraceArgs(t *testing.T) {
	c, err := parseTraceArgs([]string{"mtk@dbmint:1521/pdb1.world", "-sid", "37", "-serial", "4711", "-on", "-binds=false", "-plan-stat", "first_execution"})
	if err != nil {
		t.Fatal(err)
	}
	if c.spec != "mtk@dbmint:1521/pdb1.world" || c.sid != 37 || c.serial != 4711 || !c.on || c.off || !c.waits || c.binds || c.planStat != "first_execution" {
		t.Errorf("%+v", c)
	}
	// flags before the spec, defaults
	c, err = parseTraceArgs([]string{"-off", "-sid=1", "-serial=2", "-tcps", "u@h/s"})
	if err != nil || !c.off || !c.conn.tcps || c.planStat != "all_executions" || !c.waits || !c.binds {
		t.Errorf("%+v %v", c, err)
	}
	if c, err := parseTraceArgs([]string{"u@h/s", "-files", "-since", "3d"}); err != nil || c.since.Hours() != 72 {
		t.Fatalf("-since 3d: %+v %v", c, err)
	}
	if _, err := parseTraceArgs([]string{"u@h/s", "-files", "-since", "-1h"}); err == nil {
		t.Fatal("-since -1h accepted")
	}
	if c, err := parseTraceArgs([]string{"u@h/s", "-files", "-since", "2h", "-json"}); err != nil || !c.files || c.since.Hours() != 2 || !c.json {
		t.Errorf("%+v %v", c, err)
	}
	bad := map[string][]string{
		"password":        {"mtk/secret@dbmint/pdb1", "-sessions"},
		"exactly one":     {"u@h/s"},
		"exactly one ":    {"u@h/s", "-on", "-off", "-sid", "1", "-serial", "1"},
		"need -sid":       {"u@h/s", "-on"},
		"plan-stat":       {"u@h/s", "-on", "-sid", "1", "-serial", "1", "-plan-stat", "always"},
		"one connection":  {"-sessions"},
		"one connection ": {"u@h/s", "v@h/s", "-sessions"},
		"not defined":     {"u@h/s", "-sessions", "-password", "x"},
	}
	for want, args := range bad {
		_, err := parseTraceArgs(args)
		if err == nil || !strings.Contains(err.Error(), strings.TrimSpace(want)) {
			t.Errorf("%q: err %v, want %q", args, err, want)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Errorf("error shows the password: %v", err)
		}
	}
}

func TestParseRefArgs(t *testing.T) {
	c, err := parseRefArgs([]string{"-db", "mtk@dbmint/pdb1", "a.trc", "-lite", "b.trc"})
	if err != nil {
		t.Fatal(err)
	}
	if c.spec != "mtk@dbmint/pdb1" || !c.lite || !reflect.DeepEqual(c.files, []string{"a.trc", "b.trc"}) || c.out != "a.ref" {
		t.Errorf("%+v", c)
	}
	if c, _ := parseRefArgs([]string{"x.trc", "-db=u@h/s", "-o", "out"}); c == nil || c.out != "out" {
		t.Errorf("%+v", c)
	}
	for _, args := range [][]string{{"a.trc"}, {"-db", "u/pw@h/s", "a.trc"}, {"-db", "u@h/s"}} {
		if _, err := parseRefArgs(args); err == nil {
			t.Errorf("%q accepted", args)
		}
	}
}

func TestParseFetchDBArgs(t *testing.T) {
	if !fetchDBArgs([]string{"-name", "x", "-db", "u@h/s"}) || !fetchDBArgs([]string{"--db=u@h/s"}) || fetchDBArgs([]string{"u@h", "/path"}) || fetchDBArgs([]string{"--", "-db"}) {
		t.Error("fetchDBArgs")
	}
	c, err := parseFetchDBArgs([]string{"-db", "u@h/s", "-name", "cdb1_ora_1.trc", "-adr-home", "/d/rdbms/cdb1/cdb1"})
	if err != nil || c.out != "cdb1_ora_1.trc" || c.adrHome != "/d/rdbms/cdb1/cdb1" {
		t.Errorf("%+v %v", c, err)
	}
	for _, args := range [][]string{
		{"-db", "u@h/s"},
		{"-name", "x.trc"},
		{"-db", "u@h/s", "-name", "../x.trc"},
		{"-db", "u@h/s", "-name", "x.trc", "-o", "-", "-resume"},
		{"-db", "u@h/s", "-name", "x.trc", "extra"},
	} {
		if _, err := parseFetchDBArgs(args); err == nil {
			t.Errorf("%q accepted", args)
		}
	}
}

func TestOpenResume(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.trc")
	os.WriteFile(p, []byte("one\ntwo\nthr"), 0o644)
	f, next, err := db.OpenResume(p, 0o644)
	if err != nil || next.Lines != 2 || string(next.Tail) != "one\ntwo\n" {
		t.Fatalf("next %+v, %v", next, err)
	}
	f.WriteString("three\n")
	f.Close()
	if b, _ := os.ReadFile(p); string(b) != "one\ntwo\nthree\n" {
		t.Errorf("%q", b)
	}
	f, next, _ = db.OpenResume(filepath.Join(t.TempDir(), "new.trc"), 0o644)
	f.Close()
	if next.Lines != 0 || len(next.Tail) != 0 {
		t.Errorf("new file: next %+v", next)
	}
}

// cliConn is a minimal db.Conn: records statements, answers V$SESSION and
// V$DIAG_TRACE_FILE.
type cliConn struct{ log []string }

func (c *cliConn) Query(_ context.Context, q string, args ...any) (db.Rows, error) {
	c.log = append(c.log, q)
	switch {
	case strings.Contains(q, "from v$diag_trace_file f"):
		return &cliRows{rows: [][]any{{"/d/rdbms/cdb1/cdb1", "cdb1_ora_9.trc", nil, int64(3), int64(37), int64(4711), "APP", "/d/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc"}}}, nil
	}
	return nil, fmt.Errorf("ORA-00942: table or view does not exist")
}
func (c *cliConn) Exec(_ context.Context, q string, args ...any) error {
	c.log = append(c.log, fmt.Sprint(q, args))
	return nil
}
func (c *cliConn) Close() error { return nil }

type cliRows struct {
	rows [][]any
	i    int
}

func (r *cliRows) Next() bool   { r.i++; return r.i <= len(r.rows) }
func (r *cliRows) Err() error   { return nil }
func (r *cliRows) Close() error { return nil }
func (r *cliRows) Scan(dest ...any) error {
	for i, d := range dest {
		if p, ok := d.(*int64); ok {
			*p = r.rows[r.i-1][i].(int64)
			continue
		}
		if err := d.(sql.Scanner).Scan(r.rows[r.i-1][i]); err != nil {
			return err
		}
	}
	return nil
}

func TestTraceOnRun(t *testing.T) {
	c, err := parseTraceArgs([]string{"app@db1/prod", "-sid", "37", "-serial", "4711", "-on", "-binds=false"})
	if err != nil {
		t.Fatal(err)
	}
	conn := &cliConn{}
	var out bytes.Buffer
	if err := c.run(context.Background(), db.NewClient(conn), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(conn.log[0], "begin dbms_monitor.session_trace_enable(") || !strings.HasSuffix(conn.log[0], "[37 4711 1 0 ALL_EXECUTIONS]") {
		t.Errorf("exec %q", conn.log[0])
	}
	want := "SQL trace on for sid 37 serial# 4711 (waits, plan_stat all_executions)\n" +
		"trace file /d/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc\n" +
		"  fetch:   mtkprof fetch -db app@db1/prod -adr-home /d/rdbms/cdb1/cdb1 -name cdb1_ora_9.trc\n" +
		"  stop:    mtkprof trace app@db1/prod -sid 37 -serial 4711 -off\n"
	if out.String() != want {
		t.Errorf("output\n%s\nwant\n%s", out.String(), want)
	}
}

// ref -db end to end with a database that refuses every reference query:
// warnings, no bundle content, no error.
func TestRefDBRun(t *testing.T) {
	old := openDB
	defer func() { openDB = old }()
	var got db.Spec
	openDB = func(_ context.Context, s db.Spec, tls bool) (*db.Client, error) {
		got = s
		return db.NewClient(&cliConn{}), nil
	}
	dir := filepath.Join(t.TempDir(), "b")
	if err := cmdRef([]string{"-db", "mtk@dbmint:1521/pdb1", "../../testdata/traces/19c/io_waits.trc", "-o", dir, "-tls-skip-verify"}); err != nil {
		t.Fatal(err)
	}
	if got.Host != "dbmint" || got.User != "mtk" || !got.TLSSkipVerify {
		t.Errorf("spec %+v", got)
	}
	if st, err := os.Stat(filepath.Join(dir, "plans")); err != nil || !st.IsDir() {
		t.Errorf("bundle dir: %v", err)
	}
}

// fetchConn answers V$DIAG_INFO and three lines of one trace file.
type fetchConn struct{ cliConn }

func (c *fetchConn) Query(ctx context.Context, q string, args ...any) (db.Rows, error) {
	switch {
	case strings.Contains(q, "from v$diag_info"):
		return &cliRows{rows: [][]any{{"ADR Home", "/adr"}}}, nil
	case strings.Contains(q, "from v$diag_trace_file_contents"):
		if args[0] != "/adr" || args[1] != "x.trc" {
			return &cliRows{}, nil
		}
		if strings.Contains(q, "max(line_number)") {
			return &cliRows{rows: [][]any{{int64(3)}}}, nil
		}
		return &cliRows{rows: [][]any{{int64(1), "one\n"}, {int64(2), "two\n"}, {int64(3), "three\n"}}}, nil
	}
	return c.cliConn.Query(ctx, q, args...)
}

// `mtkprof fetch -db ...` is cmdFetchDB, whatever the argument order.
func TestFetchDispatchesDB(t *testing.T) {
	old := openDB
	defer func() { openDB = old }()
	openDB = func(context.Context, db.Spec, bool) (*db.Client, error) {
		return db.NewClient(&fetchConn{}), nil
	}
	out := filepath.Join(t.TempDir(), "x.trc")
	if err := fetchMain([]string{"-name", "x.trc", "-o", out, "-db", "mtk@h/s"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != "one\ntwo\nthree\n" {
		t.Errorf("file %q", b)
	}
}
