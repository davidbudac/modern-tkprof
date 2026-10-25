package engine

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/db"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

const bundleFixture = "../../testdata/reference/bundle"

// oraDriver is a fake Oracle: it accepts one password and answers queries
// from a handler.
type oraDriver struct {
	password string

	mu      sync.Mutex
	pws     []string // passwords tried
	tls     []bool
	skip    []bool
	conns   int
	execs   []oraCall
	queries []string
	froms   []int64 // first line of every fetch query
	closed  int
	query   func(q string, args []any) ([][]any, error)
}

type oraCall struct {
	SQL  string
	Args []any
}

func (d *oraDriver) Connect(_ context.Context, s db.Spec, pw string, tls bool) (db.Conn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.pws, d.tls, d.skip = append(d.pws, pw), append(d.tls, tls), append(d.skip, s.TLSSkipVerify)
	if pw != d.password {
		return nil, errors.New("ORA-01017: invalid username/password; logon denied")
	}
	d.conns++
	return &oraConn{d: d}, nil
}

func (d *oraDriver) connects() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conns
}

func (d *oraDriver) sent() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.queries)
}

func (d *oraDriver) executed() []oraCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.execs)
}

type oraConn struct{ d *oraDriver }

func (c *oraConn) Query(ctx context.Context, q string, args ...any) (db.Rows, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.d.mu.Lock()
	c.d.queries = append(c.d.queries, q)
	c.d.mu.Unlock()
	rows, err := c.d.query(q, args)
	if err != nil {
		return nil, err
	}
	return &oraRows{rows: rows, i: -1}, nil
}

func (c *oraConn) Exec(_ context.Context, q string, args ...any) error {
	c.d.mu.Lock()
	c.d.execs = append(c.d.execs, oraCall{q, args})
	c.d.mu.Unlock()
	return nil
}

func (c *oraConn) Close() error {
	c.d.mu.Lock()
	c.d.closed++
	c.d.mu.Unlock()
	return nil
}

type oraRows struct {
	rows [][]any
	i    int
}

func (r *oraRows) Next() bool   { r.i++; return r.i < len(r.rows) }
func (r *oraRows) Err() error   { return nil }
func (r *oraRows) Close() error { return nil }
func (r *oraRows) Scan(dest ...any) error {
	row := r.rows[r.i]
	if len(dest) != len(row) {
		return fmt.Errorf("fake: scan %d columns into %d", len(row), len(dest))
	}
	for i, d := range dest {
		var err error
		switch d := d.(type) {
		case sql.Scanner:
			err = d.Scan(row[i])
		case *string:
			var n sql.NullString
			err = n.Scan(row[i])
			*d = n.String
		case *int64:
			var n sql.NullInt64
			err = n.Scan(row[i])
			*d = n.Int64
		case *int:
			var n sql.NullInt64
			err = n.Scan(row[i])
			*d = int(n.Int64)
		case *time.Time:
			var n sql.NullTime
			err = n.Scan(row[i])
			*d = n.Time
		default:
			err = fmt.Errorf("fake: cannot scan into %T", d)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// useOra installs the fake driver for the test.
func useOra(t *testing.T, d *oraDriver) {
	t.Helper()
	old := dbDriver
	dbDriver = d
	t.Cleanup(func() { dbDriver = old })
}

var t0 = time.Date(2026, 10, 24, 9, 30, 0, 0, time.UTC)

// basicOra answers the quick calls.
func basicOra(pw string) *oraDriver {
	d := &oraDriver{password: pw}
	d.query = func(q string, args []any) ([][]any, error) {
		switch {
		case strings.Contains(q, "version_full from v$instance"):
			return [][]any{{"19.24.0.0.0"}}, nil
		case strings.Contains(q, "from v$diag_info"):
			return [][]any{{"ADR Home", "/u01/diag/rdbms/cdb1/cdb1"}, {"Diag Trace", "/u01/diag/rdbms/cdb1/cdb1/trace"},
				{"Default Trace File", "/u01/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_7.trc"}}, nil
		case strings.Contains(q, "from v$session s left join v$process p"):
			return [][]any{
				{int64(37), int64(4711), "MTK", "oracle", "dbmint", "sqlplus", nil, nil, "ACTIVE", "abc", t0, "DISABLED", "/u01/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc", int64(0)},
				{int64(12), int64(5), "MTK", "oracle", "dbmint", "mtkprof", nil, nil, "INACTIVE", nil, t0.Add(-time.Hour), "DISABLED", "/u01/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_7.trc", int64(1)},
			}, nil
		case strings.Contains(q, "from v$diag_trace_file f"):
			return [][]any{{"/u01/diag/rdbms/cdb1/cdb1", "cdb1_ora_9.trc", t0, int64(3), int64(37), int64(4711), "MTK", "/u01/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc"}}, nil
		}
		return nil, fmt.Errorf("ORA-00942: unexpected query %q", q)
	}
	return d
}

func putDB(t *testing.T, ts *httptest.Server, id string, extra map[string]any) resp {
	def := map[string]any{"id": id, "kind": "db", "host": "dbmint", "port": 1521, "user": "mtk", "service": "pdb1"}
	for k, v := range extra {
		def[k] = v
	}
	return call(t, ts, "POST", "/engine/connections", def)
}

func pwAnswers(answers ...string) func(PromptEvent) map[string]any {
	var mu sync.Mutex
	return func(pe PromptEvent) map[string]any {
		mu.Lock()
		defer mu.Unlock()
		if pe.Kind != remote.KindPassword || len(answers) == 0 {
			return map[string]any{"cancel": true}
		}
		a := answers[0]
		if len(answers) > 1 {
			answers = answers[1:]
		}
		return map[string]any{"answer": a}
	}
}

func TestDBConnectionRoutes(t *testing.T) {
	d := basicOra("secret")
	useOra(t, d)
	e, ts := newServed(t)
	a := autoAnswer(t, e, ts, map[string]string{remote.KindPassword: "secret"})

	r := putDB(t, ts, "ora", map[string]any{"tcps": true, "tlsSkipVerify": true, "port": 2484})
	if r.code != 200 {
		t.Fatalf("put %d %s", r.code, r.body)
	}
	if ci := decode[struct{ Connection ConnectionInfo }](t, r.body).Connection; !ci.TCPS || !ci.TLSSkipVerify || ci.Service != "pdb1" || ci.Kind != "db" {
		t.Errorf("info %+v", ci)
	}
	for name, bad := range map[string]map[string]any{
		"skip without tcps": {"tlsSkipVerify": true, "tcps": false},
		"no service":        {"service": ""},
		"no user":           {"user": ""},
		"bad service":       {"service": "a/b"},
	} {
		if r := putDB(t, ts, "x", bad); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.body)
		}
	}
	if r := call(t, ts, "POST", "/engine/connections", map[string]any{"id": "s", "kind": "ssh", "host": "h", "tcps": true}); r.code != 400 {
		t.Errorf("ssh with tcps: %d", r.code)
	}

	r = call(t, ts, "POST", "/engine/connections/ora/test", nil)
	if r.code != 200 {
		t.Fatalf("test %d %s", r.code, r.body)
	}
	ct := decode[ConnectionTest](t, r.body)
	if ct.Server != "19.24.0.0.0" || ct.Transport != "tcps" || ct.Diag == nil || ct.Diag.ADRHome != "/u01/diag/rdbms/cdb1/cdb1" || ct.Diag.TraceDir != "/u01/diag/rdbms/cdb1/cdb1/trace" {
		t.Errorf("test %+v", ct)
	}
	if !d.tls[0] || !d.skip[0] {
		t.Errorf("tls %v skip %v", d.tls, d.skip)
	}

	r = call(t, ts, "GET", "/engine/connections/ora/diag", nil)
	if dg := decode[struct {
		Dirs    []string
		AdrHome string
	}](t, r.body); r.code != 200 || !slices.Equal(dg.Dirs, []string{"/u01/diag/rdbms/cdb1/cdb1/trace"}) || dg.AdrHome != "/u01/diag/rdbms/cdb1/cdb1" {
		t.Errorf("diag %d %s", r.code, r.body)
	}

	r = call(t, ts, "GET", "/engine/connections/ora/sessions", nil)
	ss := decode[struct{ Sessions []db.Session }](t, r.body).Sessions
	if r.code != 200 || len(ss) != 2 || ss[0].SID != 37 || ss[0].Serial != 4711 || ss[0].Self || !ss[1].Self || ss[1].TraceFile == "" || !ss[0].LogonTime.Equal(t0) {
		t.Errorf("sessions %d %s", r.code, r.body)
	}

	r = call(t, ts, "GET", "/engine/connections/ora/tracefiles?sid=37&serial=4711&since=2h", nil)
	fs := decode[struct{ Files []db.TraceFile }](t, r.body).Files
	if r.code != 200 || len(fs) != 1 || fs[0].Name != "cdb1_ora_9.trc" || fs[0].SID != 37 || fs[0].ConID != 3 || fs[0].ADRHome != "/u01/diag/rdbms/cdb1/cdb1" {
		t.Errorf("tracefiles %d %s", r.code, r.body)
	}
	q := d.sent()[len(d.sent())-1]
	if !strings.Contains(q, "s.sid = :sid") || !strings.Contains(q, "s.serial# = :serial") || !strings.Contains(q, "f.modify_time >=") {
		t.Errorf("filters not in the query:\n%s", q)
	}
	for _, bad := range []string{"sid=x", "serial=-1", "since=soon", "since=-1h"} {
		if r := call(t, ts, "GET", "/engine/connections/ora/tracefiles?"+bad, nil); r.code != 400 {
			t.Errorf("tracefiles?%s: %d", bad, r.code)
		}
	}

	// trace on / off / self
	post := func(body map[string]any) resp { return call(t, ts, "POST", "/engine/connections/ora/trace", body) }
	r = post(map[string]any{"sid": 37, "serial": 4711, "enable": true, "binds": false, "planStat": "first_execution"})
	if tr := decode[struct {
		Enabled   bool
		TraceFile string
	}](t, r.body); r.code != 200 || !tr.Enabled || !strings.HasSuffix(tr.TraceFile, "cdb1_ora_9.trc") {
		t.Errorf("trace on %d %s", r.code, r.body)
	}
	r = post(map[string]any{"sid": 37, "serial": 4711, "enable": false})
	if r.code != 200 || strings.Contains(string(r.body), "traceFile") {
		t.Errorf("trace off %d %s", r.code, r.body)
	}
	r = post(map[string]any{"self": true, "enable": true})
	if r.code != 200 || !strings.Contains(string(r.body), "cdb1_ora_7.trc") {
		t.Errorf("self on %d %s", r.code, r.body)
	}
	ex := d.executed()
	if len(ex) != 3 || !strings.Contains(ex[0].SQL, "session_trace_enable") ||
		fmt.Sprint(ex[0].Args) != "[37 4711 1 0 FIRST_EXECUTION]" ||
		!strings.Contains(ex[1].SQL, "session_trace_disable") || fmt.Sprint(ex[1].Args) != "[37 4711]" ||
		!strings.Contains(ex[2].SQL, "dbms_session.session_trace_enable") {
		t.Errorf("executed %+v", ex)
	}
	for name, bad := range map[string]map[string]any{
		"no enable":    {"sid": 1, "serial": 2},
		"no sid":       {"enable": true},
		"self and sid": {"self": true, "sid": 1, "serial": 2, "enable": true},
		"plan stat":    {"sid": 1, "serial": 2, "enable": true, "planStat": "some"},
		"unknown":      {"sid": 1, "serial": 2, "enable": true, "x": 1},
	} {
		if r := post(bad); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.body)
		}
	}

	// one session, one password prompt for all of it
	if k := a.kinds(); !slices.Equal(k, []string{"password"}) {
		t.Errorf("prompts %v", k)
	}
	if p := a.prompts()[0]; p.Connection != "ora" || !strings.Contains(p.Text, "mtk@dbmint:2484/pdb1") || p.Echo {
		t.Errorf("prompt %+v", p)
	}
	if d.connects() != 1 {
		t.Errorf("%d connects", d.connects())
	}

	// a driver error is a remote error
	inner := d.query
	d.query = func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "from v$session") {
			return nil, errors.New("ORA-00942: table or view does not exist")
		}
		return inner(q, args)
	}
	r = call(t, ts, "GET", "/engine/connections/ora/sessions", nil)
	if r.code != 502 || !strings.Contains(string(r.body), `"remote"`) || !strings.Contains(string(r.body), "ORA-00942") {
		t.Errorf("driver error %d %s", r.code, r.body)
	}

	// delete closes the session; a new definition asks for the password again
	if r := call(t, ts, "DELETE", "/engine/connections/ora", nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed != 1 {
		t.Errorf("%d sessions closed", closed)
	}
	d.query = inner
	putDB(t, ts, "ora", nil)
	call(t, ts, "POST", "/engine/connections/ora/test", nil)
	if k := a.kinds(); !slices.Equal(k, []string{"password", "password"}) {
		t.Errorf("prompts after delete %v", k)
	}
	// ssh-only routes
	if r := call(t, ts, "POST", "/engine/connections/ora/follow", map[string]any{"path": "/x/y.trc"}); r.code != 400 {
		t.Errorf("follow %d", r.code)
	}
}

func TestDBPasswordRetries(t *testing.T) {
	d := basicOra("right")
	useOra(t, d)
	e, ts := newServed(t)
	a := autoAnswerFn(t, ts, pwAnswers("bad", "right"))
	_ = e
	putDB(t, ts, "ora", nil)
	if r := call(t, ts, "POST", "/engine/connections/ora/test", nil); r.code != 200 {
		t.Fatalf("test %d %s", r.code, r.body)
	}
	ps := a.prompts()
	if len(ps) != 2 || strings.HasPrefix(ps[0].Text, "Wrong") || !strings.HasPrefix(ps[1].Text, "Wrong user name or password") {
		t.Errorf("prompts %+v", ps)
	}
	call(t, ts, "GET", "/engine/connections/ora/sessions", nil)
	if len(a.prompts()) != 2 {
		t.Errorf("asked again: %d prompts", len(a.prompts()))
	}

	// the password is never right: three tries, a remote error, nothing cached
	d2 := basicOra("right")
	useOra(t, d2)
	e2, ts2 := newServed(t)
	_ = e2
	a2 := autoAnswerFn(t, ts2, pwAnswers("nope"))
	putDB(t, ts2, "ora", nil)
	r := call(t, ts2, "POST", "/engine/connections/ora/test", nil)
	if r.code != 502 || !strings.Contains(string(r.body), "ORA-01017") {
		t.Errorf("wrong password %d %s", r.code, r.body)
	}
	if n := len(a2.prompts()); n != 3 {
		t.Errorf("%d prompts for three tries", n)
	}
	call(t, ts2, "POST", "/engine/connections/ora/test", nil)
	if n := len(a2.prompts()); n != 6 { // asked three times again: the rejected password was not cached
		t.Errorf("%d prompts after two rounds of three tries", n)
	}

	// cancelling the prompt
	d3 := basicOra("right")
	useOra(t, d3)
	_, ts3 := newServed(t)
	autoAnswerFn(t, ts3, func(PromptEvent) map[string]any { return map[string]any{"cancel": true} })
	putDB(t, ts3, "ora", nil)
	if r := call(t, ts3, "POST", "/engine/connections/ora/test", nil); r.code != 409 || !strings.Contains(string(r.body), `"cancelled"`) {
		t.Errorf("cancelled %d %s", r.code, r.body)
	}
	if len(d3.pws) != 0 {
		t.Errorf("connected after a cancel: %v", d3.pws)
	}
}

// fetchOra fakes V$DIAG_TRACE_FILE_CONTENTS for a file of n one-line
// records "line k\n" (line_number k).
func fetchOra(n int, adr, name string) *oraDriver {
	d := basicOra("pw")
	basic := d.query
	d.query = func(q string, args []any) ([][]any, error) {
		if !strings.Contains(q, "from v$diag_trace_file_contents") {
			return basic(q, args)
		}
		if args[0] != adr || args[1] != name {
			return nil, nil
		}
		if strings.Contains(q, "max(line_number)") {
			return [][]any{{int64(n)}}, nil
		}
		a, b := args[2].(int64), args[3].(int64)
		d.mu.Lock()
		d.froms = append(d.froms, a)
		d.mu.Unlock()
		var rows [][]any
		for k := a; k <= b && k <= int64(n); k++ {
			rows = append(rows, []any{k, "line " + strconv.FormatInt(k, 10) + "\n"})
		}
		return rows, nil
	}
	return d
}

func wantLines(from, to int) string {
	var b strings.Builder
	for k := from; k <= to; k++ {
		fmt.Fprintf(&b, "line %d\n", k)
	}
	return b.String()
}

func TestDBFetchJob(t *testing.T) {
	const adr, name, n = "/u01/diag/rdbms/cdb1/cdb1", "cdb1_ora_9.trc", db.FetchChunk + 10000
	d := fetchOra(n, adr, name)
	useOra(t, d)
	e, ts := newServed(t)
	a := autoAnswer(t, e, ts, map[string]string{remote.KindPassword: "pw"})
	putDB(t, ts, "ora", nil)
	local := filepath.Join(e.srv.remoteDir("ora"), name)

	for _, bad := range []map[string]any{{}, {"name": "../x.trc"}, {"name": "a/b.trc"}, {"name": ".."}, {"name": "x.trc", "paths": []string{"/a"}}} {
		if r := call(t, ts, "POST", "/engine/connections/ora/fetch", bad); r.code != 400 {
			t.Errorf("fetch %v: %d %s", bad, r.code, r.body)
		}
	}

	// a partial local file: 100 complete lines and half of the next
	os.MkdirAll(filepath.Dir(local), 0o700)
	os.WriteFile(local, []byte(wantLines(1, 100)+"lin"), 0o600)

	r := call(t, ts, "POST", "/engine/connections/ora/fetch", map[string]any{"adrHome": adr, "name": name})
	if r.code != 202 {
		t.Fatalf("fetch %d %s", r.code, r.body)
	}
	fr := decode[struct {
		Job        JobInfo
		LocalPaths []string
	}](t, r.body)
	if fr.Job.Kind != "fetch" || fr.Job.Unit != "lines" || fr.Job.Connection != "ora" || !slices.Equal(fr.LocalPaths, []string{local}) {
		t.Errorf("accepted %+v", fr)
	}
	j := waitJob(t, ts, fr.Job.ID)
	if j.State != JobDone || j.Done != n || j.Unit != "lines" || !slices.Equal(j.LocalPaths, []string{local}) {
		t.Fatalf("job %+v", j)
	}
	got, _ := os.ReadFile(local)
	if string(got) != wantLines(1, n) {
		t.Errorf("file has %d bytes, want %d", len(got), len(wantLines(1, n)))
	}
	// the partial line was cut and the first chunk started db.ResumeBack
	// line numbers before the end of the 100 complete lines
	d.mu.Lock()
	if len(d.froms) == 0 || d.froms[0] != 100-db.ResumeBack {
		t.Errorf("fetched from lines %v", d.froms)
	}
	d.mu.Unlock()
	if fi, _ := os.Stat(local); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}
	if k := a.kinds(); !slices.Equal(k, []string{"password"}) {
		t.Errorf("prompts %v", k)
	}

	// fetching a complete file again changes nothing
	r = call(t, ts, "POST", "/engine/connections/ora/fetch", map[string]any{"adrHome": adr, "name": name})
	j = waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID)
	got, _ = os.ReadFile(local)
	if j.State != JobDone || j.Done != n || string(got) != wantLines(1, n) {
		t.Errorf("second fetch %+v", j)
	}

	// the adrHome defaults to V$DIAG_INFO's; an unknown file has no lines
	r = call(t, ts, "POST", "/engine/connections/ora/fetch", map[string]any{"name": "nope.trc"})
	j = waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID)
	if j.State != JobFailed || !strings.Contains(j.Message, "no lines") {
		t.Errorf("unknown file %+v", j)
	}
}

// The resume point and a failure in the middle: the chunk before it is kept
// and a second fetch continues after it.
func TestDBFetchResumeAfterError(t *testing.T) {
	const adr, name, n = "/adr", "x.trc", db.FetchChunk + 5
	d := fetchOra(n, adr, name)
	useOra(t, d)
	var mu sync.Mutex
	var froms []int64
	fail := true
	inner := d.query
	d.query = func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "from v$diag_trace_file_contents") {
			mu.Lock()
			defer mu.Unlock()
			if len(args) < 4 { // max(line_number)
				return inner(q, args)
			}
			froms = append(froms, args[2].(int64))
			if fail && args[2].(int64) > 1 {
				return nil, errors.New("ORA-03113: end-of-file on communication channel")
			}
		}
		return inner(q, args)
	}
	e, ts := newServed(t)
	autoAnswer(t, e, ts, map[string]string{remote.KindPassword: "pw"})
	putDB(t, ts, "ora", nil)
	fetch := func() JobInfo {
		r := call(t, ts, "POST", "/engine/connections/ora/fetch", map[string]any{"adrHome": adr, "name": name})
		if r.code != 202 {
			t.Fatalf("%d %s", r.code, r.body)
		}
		return waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID)
	}
	j := fetch()
	if j.State != JobFailed || !strings.Contains(j.Message, "ORA-03113") || j.Done != db.FetchChunk || len(j.LocalPaths) != 0 {
		t.Fatalf("failed job %+v", j)
	}
	local := filepath.Join(e.srv.remoteDir("ora"), name)
	if b, _ := os.ReadFile(local); string(b) != wantLines(1, db.FetchChunk) {
		t.Errorf("partial file has %d bytes", len(b))
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	j = fetch()
	if b, _ := os.ReadFile(local); j.State != JobDone || j.Done != n || string(b) != wantLines(1, n) {
		t.Errorf("resumed job %+v", j)
	}
	mu.Lock()
	defer mu.Unlock()
	if want := []int64{1, db.FetchChunk + 1, db.FetchChunk - db.ResumeBack}; !slices.Equal(froms, want) {
		t.Errorf("fetched from lines %v, want %v", froms, want)
	}
}

func TestDBFetchConflict(t *testing.T) {
	const adr, name = "/adr", "x.trc"
	d := fetchOra(10, adr, name)
	useOra(t, d)
	release := make(chan struct{})
	inner := d.query
	d.query = func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "from v$diag_trace_file_contents") {
			<-release
		}
		return inner(q, args)
	}
	e, ts := newServed(t)
	autoAnswer(t, e, ts, map[string]string{remote.KindPassword: "pw"})
	putDB(t, ts, "ora", nil)
	body := map[string]any{"adrHome": adr, "name": name}
	r := call(t, ts, "POST", "/engine/connections/ora/fetch", body)
	if r.code != 202 {
		t.Fatal(r.code, string(r.body))
	}
	id := decode[struct{ Job JobInfo }](t, r.body).Job.ID
	if r := call(t, ts, "POST", "/engine/connections/ora/fetch", body); r.code != 409 {
		t.Errorf("second fetch of the file: %d %s", r.code, r.body)
	}
	if r := putDB(t, ts, "ora", nil); r.code != 409 {
		t.Errorf("replace while a job runs: %d", r.code)
	}
	close(release)
	if j := waitJob(t, ts, id); j.State != JobDone || j.Done != 10 {
		t.Errorf("job %+v", j)
	}
}

// docMasked is the session's document without its build time.
func docMasked(t *testing.T, ts *httptest.Server, sid string) []byte {
	t.Helper()
	r := call(t, ts, "GET", "/s/"+sid+"/api/doc", nil)
	if r.code != 200 {
		t.Fatalf("doc %d %s", r.code, r.body)
	}
	return generatedRe.ReplaceAll(r.body, nil)
}

// expectedDoc is the document of the trace with the bundle in dir applied
// directly (the cache hit gives the model a session would start from).
func expectedDoc(t *testing.T, e *env, trace, dir string) []byte {
	t.Helper()
	abs, _ := filepath.Abs(trace)
	co, err := e.srv.Cache().OpenTrace(context.Background(), []string{abs}, CacheOpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer co.Close()
	if !co.Hit {
		t.Fatal("not a cache hit")
	}
	if dir != "" {
		b, err := ref.LoadBundle(dir)
		if err != nil {
			t.Fatal(err)
		}
		model.ApplyRef(co.Model, b)
	}
	doc, err := report.DocumentBytes(co.Model, report.DocOptions{Facts: false, Packed: true, Slice: true})
	if err != nil {
		t.Fatal(err)
	}
	return generatedRe.ReplaceAll(doc, nil)
}

func openTS(t *testing.T, ts *httptest.Server, trace string) SessionInfo {
	t.Helper()
	r := call(t, ts, "POST", "/engine/sessions", map[string]any{"paths": []string{trace}})
	if r.code != 202 {
		t.Fatalf("open %d %s", r.code, r.body)
	}
	id := decode[openResp](t, r.body).Session.ID
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		si := decode[SessionInfo](t, call(t, ts, "GET", "/engine/sessions/"+id, nil).body)
		if si.State != SessionOpening {
			if si.State != SessionReady {
				t.Fatalf("session %+v", si)
			}
			return si
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("session still opening")
	return SessionInfo{}
}

func sessionRev(t *testing.T, ts *httptest.Server, id string) int {
	return decode[SessionInfo](t, call(t, ts, "GET", "/engine/sessions/"+id, nil).body).Rev
}

func TestRefDir(t *testing.T) {
	e, ts := newServed(t)
	trace := traces + "io_waits.trc"
	s1 := openTS(t, ts, trace)
	d1 := docMasked(t, ts, s1.ID)
	if s1.Rev != 1 {
		t.Errorf("rev %d", s1.Rev)
	}
	if bytes.Equal(d1, expectedDoc(t, e, trace, bundleFixture)) {
		t.Fatal("the bundle changes nothing (test is vacuous)")
	}
	if !bytes.Equal(d1, expectedDoc(t, e, trace, "")) {
		t.Fatal("document without a bundle differs from a direct build")
	}

	ev := openSSE(t, ts)
	post := func(sid string, body map[string]any) resp { return call(t, ts, "POST", "/s/"+sid+"/api/ref", body) }
	r := post(s1.ID, map[string]any{"dir": bundleFixture})
	if r.code != 202 {
		t.Fatalf("ref %d %s", r.code, r.body)
	}
	job := decode[struct{ Job JobInfo }](t, r.body).Job
	if job.Kind != "ref" || job.Session != s1.ID || job.Connection != "" {
		t.Errorf("job %+v", job)
	}
	if j := waitJob(t, ts, job.ID); j.State != JobDone || !strings.Contains(j.Message, "objects") {
		t.Fatalf("ref job %+v", j)
	}
	if rev := sessionRev(t, ts, s1.ID); rev != 2 {
		t.Errorf("rev %d after the bundle", rev)
	}
	// a session event with rev 2 was published
	deadline := time.Now().Add(10 * time.Second)
	seen := false
	for !seen && time.Now().Before(deadline) {
		typ, data := ev.next()
		if typ == "session" {
			var se SessionEvent
			se = decode[SessionEvent](t, []byte(data))
			seen = se.ID == s1.ID && se.Rev == 2
		}
	}
	if !seen {
		t.Error("no session event with rev 2")
	}
	d2 := docMasked(t, ts, s1.ID)
	if !bytes.Equal(d2, expectedDoc(t, e, trace, bundleFixture)) {
		t.Error("document after the bundle differs from ApplyRef applied directly")
	}
	if r := call(t, ts, "GET", "/s/"+s1.ID+"/api/doc?rev=1", nil); r.code != 200 || !bytes.Equal(generatedRe.ReplaceAll(r.body, nil), d2) {
		t.Error("?rev= changes the document")
	}
	if _, err := os.Stat(filepath.Join(e.cache, "ref", s1.Identity, "objects.csv")); err != nil {
		t.Errorf("bundle not kept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.cache, "ref", s1.Identity, "plans", "52nzchs09dgn1.txt")); err != nil {
		t.Errorf("plan not kept: %v", err)
	}

	// the same bundle again: same document, rev 3
	j := waitJob(t, ts, decode[struct{ Job JobInfo }](t, post(s1.ID, map[string]any{"dir": bundleFixture}).body).Job.ID)
	if j.State != JobDone || sessionRev(t, ts, s1.ID) != 3 || !bytes.Equal(docMasked(t, ts, s1.ID), d2) {
		t.Errorf("applied twice: %+v rev %d", j, sessionRev(t, ts, s1.ID))
	}

	// an empty directory fails and changes nothing
	empty := t.TempDir()
	j = waitJob(t, ts, decode[struct{ Job JobInfo }](t, post(s1.ID, map[string]any{"dir": empty}).body).Job.ID)
	if j.State != JobFailed || !strings.Contains(j.Message, "no usable files") || sessionRev(t, ts, s1.ID) != 3 || !bytes.Equal(docMasked(t, ts, s1.ID), d2) {
		t.Errorf("empty bundle %+v rev %d", j, sessionRev(t, ts, s1.ID))
	}
	if _, err := os.Stat(filepath.Join(e.cache, "ref", s1.Identity, "objects.csv")); err != nil {
		t.Errorf("a failed ref dropped the kept bundle: %v", err)
	}
	if ents, _ := os.ReadDir(filepath.Join(e.cache, "ref")); len(ents) != 1 {
		t.Errorf("leftovers in ref/: %v", ents)
	}

	// requests
	for name, body := range map[string]map[string]any{
		"neither":    {},
		"both":       {"dir": bundleFixture, "connection": "x"},
		"not a dir":  {"dir": trace},
		"missing":    {"dir": "/no/such/dir"},
		"lite + dir": {"dir": bundleFixture, "lite": true},
		"unknown":    {"dir": bundleFixture, "x": 1},
	} {
		if r := post(s1.ID, body); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.body)
		}
	}
	if r := post(s1.ID, map[string]any{"connection": "nope"}); r.code != 404 {
		t.Errorf("unknown connection: %d", r.code)
	}
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "lab", "kind": "ssh", "host": "h"})
	if r := post(s1.ID, map[string]any{"connection": "lab"}); r.code != 400 {
		t.Errorf("ssh connection: %d", r.code)
	}

	// opening the trace again (a cache hit) applies the kept bundle
	s2 := openTS(t, ts, trace)
	if !s2.Hit || s2.Rev != 1 || s2.Identity != s1.Identity {
		t.Errorf("reopen %+v", s2)
	}
	if !bytes.Equal(docMasked(t, ts, s2.ID), d2) {
		t.Error("the reopened session does not have the bundle")
	}

	// close both: the kept bundle goes with a cache wipe
	call(t, ts, "DELETE", "/engine/sessions/"+s1.ID, nil)
	call(t, ts, "DELETE", "/engine/sessions/"+s2.ID, nil)
	if r := call(t, ts, "DELETE", "/engine/cache", nil); r.code != 200 {
		t.Fatalf("wipe %d", r.code)
	}
	if ents, _ := os.ReadDir(filepath.Join(e.cache, "ref")); len(ents) != 0 {
		t.Errorf("ref/ after the wipe: %v", ents)
	}
	s3 := openTS(t, ts, trace)
	if s3.Hit || !bytes.Equal(docMasked(t, ts, s3.ID), d1) {
		t.Errorf("after the wipe %+v", s3)
	}
}

// bundleOra fakes the reference views from testdata/reference/bundle.
func bundleOra(t *testing.T, pw string) *oraDriver {
	read := func(name string) ([]string, [][]any) {
		raw, err := os.ReadFile(filepath.Join(bundleFixture, name))
		if err != nil {
			t.Fatal(err)
		}
		var header []string
		var rows [][]any
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			rec, err := csv.NewReader(strings.NewReader(line)).Read()
			if err != nil {
				t.Fatal(err)
			}
			if header == nil {
				header = rec
				continue
			}
			row := make([]any, len(rec))
			quoted := splitQuoted(line)
			for i, c := range rec {
				switch {
				case quoted[i] == "":
				case strings.HasPrefix(quoted[i], `"`):
					row[i] = c
				default:
					n, _ := strconv.ParseInt(c, 10, 64)
					row[i] = n
				}
			}
			rows = append(rows, row)
		}
		return header, rows
	}
	oh, objs := read("objects.csv")
	fh, files := read("datafiles.csv")
	uh, users := read("users.csv")
	plan, _ := os.ReadFile(filepath.Join(bundleFixture, "plans", "52nzchs09dgn1.txt"))
	d := &oraDriver{password: pw}
	d.query = func(q string, _ []any) ([][]any, error) {
		switch {
		case strings.Contains(q, " from dba_objects"), strings.Contains(q, " from all_objects"):
			return filterIn(q, oh, objs, "OBJECT_ID", "DATA_OBJECT_ID"), nil
		case strings.Contains(q, " from v$datafile"):
			return filterIn(q, fh, files, "ABS_FILE#"), nil
		case strings.Contains(q, " from dba_users"), strings.Contains(q, " from all_users"):
			return filterIn(q, uh, users, "USER_ID"), nil
		case strings.Contains(q, "display_cursor('52nzchs09dgn1'"):
			var rows [][]any
			for _, l := range strings.Split(strings.TrimSuffix(string(plan), "\n"), "\n") {
				var v any = l + "   "
				if l == "" {
					v = nil
				}
				rows = append(rows, []any{v})
			}
			return rows, nil
		case strings.Contains(q, "display_cursor("):
			return [][]any{{"SQL_ID: x, child number: 0 cannot be found"}}, nil
		case strings.Contains(q, "display_awr("):
			return nil, nil
		}
		return nil, fmt.Errorf("ORA-00942: unexpected query %q", q)
	}
	return d
}

func splitQuoted(line string) []string {
	var out []string
	var cur strings.Builder
	in := false
	for _, r := range line {
		switch {
		case r == '"':
			in = !in
			cur.WriteRune(r)
		case r == ',' && !in:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	return append(out, cur.String())
}

var inList = regexp.MustCompile(`(\w+#?) in \(([^)]*)\)`)

func filterIn(q string, header []string, rows [][]any, cols ...string) [][]any {
	keep := map[string]map[int64]bool{}
	for _, m := range inList.FindAllStringSubmatch(q, -1) {
		k := strings.ToUpper(m[1])
		if keep[k] == nil {
			keep[k] = map[int64]bool{}
		}
		for _, f := range strings.FieldsFunc(m[2], func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
			n, _ := strconv.ParseInt(f, 10, 64)
			keep[k][n] = true
		}
	}
	var out [][]any
	for _, r := range rows {
		for _, c := range cols {
			if v, ok := r[slices.Index(header, c)].(int64); ok && keep[c][v] {
				out = append(out, r)
				break
			}
		}
	}
	return out
}

func TestRefConnection(t *testing.T) {
	d := bundleOra(t, "pw")
	useOra(t, d)
	e, ts := newServed(t)
	a := autoAnswer(t, e, ts, map[string]string{remote.KindPassword: "pw"})
	trace := traces + "io_waits.trc"
	s := openTS(t, ts, trace)
	d1 := docMasked(t, ts, s.ID)
	putDB(t, ts, "ora", nil) // never tested: the job asks for the password

	r := call(t, ts, "POST", "/s/"+s.ID+"/api/ref", map[string]any{"connection": "ora"})
	if r.code != 202 {
		t.Fatalf("ref %d %s", r.code, r.body)
	}
	job := decode[struct{ Job JobInfo }](t, r.body).Job
	if job.Kind != "ref" || job.Connection != "ora" || job.Unit != "queries" {
		t.Errorf("job %+v", job)
	}
	j := waitJob(t, ts, job.ID)
	if j.State != JobDone || j.Total == 0 || j.Done != j.Total || strings.Contains(j.Message, "skipped") {
		t.Fatalf("ref job %+v", j)
	}
	if k := a.kinds(); !slices.Equal(k, []string{"password"}) {
		t.Errorf("prompts %v", k)
	}
	d2 := docMasked(t, ts, s.ID)
	if bytes.Equal(d1, d2) || !bytes.Equal(d2, expectedDoc(t, e, trace, bundleFixture)) {
		t.Error("the document after the database bundle differs from the fixture bundle's")
	}
	if rev := sessionRev(t, ts, s.ID); rev != 2 {
		t.Errorf("rev %d", rev)
	}
	// the queries are the reference queries of the trace, on a session of the job's own
	if n := d.connects(); n != 1 {
		t.Errorf("%d connects", n)
	}
	d.mu.Lock()
	if d.closed != 1 {
		t.Errorf("%d sessions closed", d.closed)
	}
	d.mu.Unlock()
	if sent := d.sent(); len(sent) < 4 || !strings.Contains(sent[0], "dba_objects") {
		t.Errorf("queries %q", sent)
	}

	// without the DBA_ views the query is answered from the ALL_ views, and the job says so
	inner := d.query
	d.query = func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "dba_users") {
			return nil, errors.New("ORA-00942: table or view does not exist")
		}
		return inner(q, args)
	}
	r = call(t, ts, "POST", "/s/"+s.ID+"/api/ref", map[string]any{"connection": "ora"})
	j = waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID)
	if j.State != JobDone || !strings.Contains(j.Message, "lite queries (ALL_ views) used for users.csv") || strings.Contains(j.Message, "skipped") {
		t.Fatalf("fallback job %+v", j)
	}
	if _, err := os.Stat(filepath.Join(e.cache, "ref", s.Identity, "users.csv")); err != nil {
		t.Errorf("users.csv from the lite query missing: %v", err)
	}

	// a query that fails is skipped and named; the rest is applied
	d.query = func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "dba_users") || strings.Contains(q, "all_users") {
			return nil, errors.New("ORA-00942: table or view does not exist")
		}
		return inner(q, args)
	}
	r = call(t, ts, "POST", "/s/"+s.ID+"/api/ref", map[string]any{"connection": "ora"})
	j = waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID)
	if j.State != JobDone || !strings.Contains(j.Message, "users.csv") || !strings.Contains(j.Message, "ORA-00942") || !strings.Contains(j.Message, "lite") {
		t.Fatalf("partial job %+v", j)
	}
	if sessionRev(t, ts, s.ID) != 4 || bytes.Equal(docMasked(t, ts, s.ID), d2) {
		t.Error("the partial bundle was not applied (or it equals the full one)")
	}
	if _, err := os.Stat(filepath.Join(e.cache, "ref", s.Identity, "users.csv")); !os.IsNotExist(err) {
		t.Error("users.csv kept from the earlier bundle")
	}

	// lite uses the ALL_ views only
	d.query = func(q string, args []any) ([][]any, error) {
		if l := strings.ToLower(q); strings.Contains(l, "dba_") || strings.Contains(l, "v$datafile") {
			t.Errorf("lite ran %q", q)
		}
		return inner(q, args)
	}
	r = call(t, ts, "POST", "/s/"+s.ID+"/api/ref", map[string]any{"connection": "ora", "lite": true})
	if j := waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID); j.State != JobDone {
		t.Errorf("lite job %+v", j)
	}

	// every query fails: nothing to apply, the job fails and the session keeps its document
	d.query = func(string, []any) ([][]any, error) {
		return nil, errors.New("ORA-03113: end-of-file on communication channel")
	}
	rev := sessionRev(t, ts, s.ID)
	before := docMasked(t, ts, s.ID)
	r = call(t, ts, "POST", "/s/"+s.ID+"/api/ref", map[string]any{"connection": "ora"})
	if j := waitJob(t, ts, decode[struct{ Job JobInfo }](t, r.body).Job.ID); j.State != JobFailed || !strings.Contains(j.Message, "no usable files") ||
		sessionRev(t, ts, s.ID) != rev || !bytes.Equal(docMasked(t, ts, s.ID), before) {
		t.Errorf("all queries failing: %+v", j)
	}
}
