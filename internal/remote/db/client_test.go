package db

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

var ctx = context.Background()

func TestParseSpec(t *testing.T) {
	ok := []struct {
		in, str string
		want    Spec
	}{
		{"mtk@dbmint:1521/pdb1.world", "mtk@dbmint:1521/pdb1.world", Spec{User: "mtk", Host: "dbmint", Port: 1521, Service: "pdb1.world"}},
		{"mtk@dbmint/pdb1", "mtk@dbmint:1521/pdb1", Spec{User: "mtk", Host: "dbmint", Port: 1521, Service: "pdb1"}},
		{"system@10.0.0.5:1522/ORCLPDB1", "system@10.0.0.5:1522/ORCLPDB1", Spec{User: "system", Host: "10.0.0.5", Port: 1522, Service: "ORCLPDB1"}},
		{"u@[::1]:1521/svc", "u@[::1]:1521/svc", Spec{User: "u", Host: "::1", Port: 1521, Service: "svc"}},
		{"u@[fe80::1]/svc", "u@[fe80::1]:1521/svc", Spec{User: "u", Host: "fe80::1", Port: 1521, Service: "svc"}},
		{"c##ops@db-host.example.com:2484/prod_rw", "c##ops@db-host.example.com:2484/prod_rw", Spec{User: "c##ops", Host: "db-host.example.com", Port: 2484, Service: "prod_rw"}},
	}
	for _, c := range ok {
		got, err := ParseSpec(c.in)
		if err != nil || got != c.want || got.String() != c.str {
			t.Errorf("ParseSpec(%q) = %+v (%q), %v; want %+v", c.in, got, got.String(), err, c.want)
		}
	}
	bad := map[string]string{
		"mtk/secret@dbmint:1521/pdb1": "password",
		"mtk:secret@dbmint:1521/pdb1": "password",
		"mtk/p@ss@dbmint/pdb1":        "password",
		"dbmint:1521/pdb1":            "user@host",
		"@dbmint/pdb1":                "no user",
		"mtk@dbmint:1521":             "no service",
		"mtk@dbmint:1521/":            "no service",
		"mtk@dbmint:99999/pdb1":       "bad port",
		"mtk@dbmint:x/pdb1":           "bad port",
		"mtk@::1/pdb1":                "bad host",
		"mtk@/pdb1":                   "no host",
		"mtk@h/pdb1/extra":            "bad service",
	}
	for in, msg := range bad {
		_, err := ParseSpec(in)
		if err == nil || !strings.Contains(err.Error(), msg) {
			t.Errorf("ParseSpec(%q) err = %v, want %q", in, err, msg)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Errorf("error leaks the password: %v", err)
		}
	}
	if s := (Spec{User: "u", Host: "h", Service: "s"}).String(); s != "u@h:1521/s" {
		t.Errorf("String() with port 0 = %q", s)
	}
}

func TestOpenPromptsAndRetries(t *testing.T) {
	fc := &fakeConn{}
	d := &fakeDriver{password: "right", conn: fc}
	p := &fakePrompter{answers: []string{"wrong", "right"}}
	s := Spec{ID: "c1", User: "mtk", Host: "dbmint", Port: 1521, Service: "pdb1"}
	c, err := OpenWith(ctx, d, s, p, true)
	if err != nil {
		t.Fatal(err)
	}
	if !d.tls || !reflect.DeepEqual(d.got, []string{"wrong", "right"}) {
		t.Errorf("driver got %v tls=%v", d.got, d.tls)
	}
	if len(p.asked) != 2 || p.asked[0].Kind != remote.KindPassword || p.asked[0].Connection != "c1" || p.asked[0].Echo ||
		p.asked[0].Text != "Password for mtk@dbmint:1521/pdb1: " || !strings.HasPrefix(p.asked[1].Text, "Wrong user name or password.") {
		t.Errorf("prompts %+v", p.asked)
	}
	c.Close()
	if !fc.closed {
		t.Error("Close did not close the conn")
	}

	// three wrong answers: give up with the ORA- error; a cancel stops at once
	p = &fakePrompter{answers: []string{"a", "b", "c", "d"}}
	if _, err := OpenWith(ctx, d, s, p, false); err == nil || !IsORA(err, 1017) || len(p.asked) != 3 {
		t.Errorf("err %v after %d prompts", err, len(p.asked))
	}
	p = &fakePrompter{}
	if _, err := OpenWith(ctx, d, s, p, false); !errors.Is(err, errEOF()) {
		t.Errorf("cancel: %v", err)
	}
}

func errEOF() error { _, err := (&fakePrompter{}).Ask(ctx, remote.Prompt{}); return err }

func TestVersionFallback(t *testing.T) {
	fc := &fakeConn{query: func(q string, _ []any) ([][]any, error) {
		switch q {
		case "select version_full from v$instance":
			return nil, oraErr(942, "table or view does not exist")
		case "select banner_full from v$version where rownum = 1":
			return [][]any{{"Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.3.0.0.0"}}, nil
		}
		return nil, errors.New("unexpected")
	}}
	v, err := NewClient(fc).Version(ctx)
	if err != nil || v != "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production Version 19.3.0.0.0" {
		t.Errorf("Version = %q, %v", v, err)
	}
	fc = &fakeConn{query: func(q string, _ []any) ([][]any, error) { return [][]any{{"19.24.0.0.0"}}, nil }}
	if v, _ := NewClient(fc).Version(ctx); v != "19.24.0.0.0" || len(fc.calls) != 1 {
		t.Errorf("Version = %q after %d queries", v, len(fc.calls))
	}
}

func TestDiagInfo(t *testing.T) {
	fc := &fakeConn{query: func(q string, _ []any) ([][]any, error) {
		want(t, q, "select name, value from v$diag_info")
		return [][]any{
			{"Diag Enabled", "TRUE"},
			{"ADR Home", "/u01/app/oracle/diag/rdbms/cdb1/cdb1"},
			{"Diag Trace", "/u01/app/oracle/diag/rdbms/cdb1/cdb1/trace"},
			{"Default Trace File", "/u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_4242.trc"},
			{"Active Problem Count", int64(0)},
		}, nil
	}}
	d, err := NewClient(fc).DiagInfo(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if d.ADRHome != "/u01/app/oracle/diag/rdbms/cdb1/cdb1" || d.DiagTrace != d.ADRHome+"/trace" || d.DefaultTraceFile != d.DiagTrace+"/cdb1_ora_4242.trc" || d.All["Active Problem Count"] != "0" {
		t.Errorf("%+v", d)
	}
}

func TestSessions(t *testing.T) {
	logon := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	fc := &fakeConn{query: func(q string, _ []any) ([][]any, error) {
		want(t, q, `select s.sid, s.serial#, s.username, s.osuser, s.machine, s.program, s.module, s.action, s.status, s.sql_id, s.logon_time, s.sql_trace, p.tracefile,
       case when s.sid = to_number(sys_context('USERENV', 'SID')) then 1 else 0 end
  from v$session s left join v$process p on p.addr = s.paddr
 where s.type = 'USER'
 order by s.logon_time desc, s.sid`)
		return [][]any{
			{int64(37), int64(4711), "MTK", "db", "laptop", "mtkprof", "mtkprof", nil, "ACTIVE", "9babjv8yq8ru3", logon, "DISABLED", "/t/cdb1_ora_1.trc", int64(1)},
			{float64(12), "301", "APP", "app", "srv1", "JDBC Thin Client", nil, nil, "INACTIVE", nil, logon.Add(-time.Hour), "ENABLED", nil, int64(0)},
		}, nil
	}}
	ss, err := NewClient(fc).Sessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ss) != 2 || !ss[0].Self || ss[1].Self || ss[0].SID != 37 || ss[0].Serial != 4711 || ss[0].LogonTime != logon || ss[0].SQLID != "9babjv8yq8ru3" ||
		ss[1].SID != 12 || ss[1].Serial != 301 || ss[1].SQLTrace != "ENABLED" || ss[1].Module != "" || ss[0].TraceFile != "/t/cdb1_ora_1.trc" {
		t.Errorf("%+v", ss)
	}
}

const traceFilesBase = `select f.adr_home, f.trace_filename, f.modify_time, f.con_id, s.sid, s.serial#, s.username, p.tracefile
  from v$diag_trace_file f
  left join v$process p on substr(p.tracefile, -length(f.trace_filename) - 1) in ('/' || f.trace_filename, '\' || f.trace_filename)
  left join v$session s on s.paddr = p.addr`

func TestTraceFiles(t *testing.T) {
	mod := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	var gotArgs []any
	fc := &fakeConn{query: func(q string, args []any) ([][]any, error) {
		gotArgs = args
		return [][]any{{"/d/rdbms/cdb1/cdb1", "cdb1_ora_9.trc", mod, int64(3), int64(37), int64(4711), "MTK", "/d/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc"},
			{"/d/rdbms/cdb1/cdb1", "cdb1_mmon_2.trc", mod, int64(1), nil, nil, nil, nil}}, nil
	}}
	c := NewClient(fc)
	fs, err := c.TraceFiles(ctx, Filter{})
	if err != nil {
		t.Fatal(err)
	}
	want(t, fc.calls[0].SQL, traceFilesBase+"\n order by f.modify_time desc, f.trace_filename")
	if len(gotArgs) != 0 || len(fs) != 2 || fs[0] != (TraceFile{ADRHome: "/d/rdbms/cdb1/cdb1", Name: "cdb1_ora_9.trc", Path: "/d/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc", Modified: mod, ConID: 3, SID: 37, Serial: 4711, Username: "MTK"}) ||
		fs[1].SID != 0 || fs[1].Path != "" {
		t.Errorf("%+v %v", fs, gotArgs)
	}

	since := time.Date(2026, 10, 25, 8, 0, 0, 0, time.FixedZone("CET", 3600))
	if _, err := c.TraceFiles(ctx, Filter{SID: 37, Serial: 4711, Since: since}); err != nil {
		t.Fatal(err)
	}
	want(t, fc.calls[1].SQL, traceFilesBase+`
 where s.sid = :sid
   and s.serial# = :serial
   and f.modify_time >= timestamp '1970-01-01 00:00:00 +00:00' + numtodsinterval(:since, 'SECOND')
 order by f.modify_time desc, f.trace_filename`)
	if !reflect.DeepEqual(gotArgs, []any{37, 4711, since.Unix()}) {
		t.Errorf("args %v", gotArgs)
	}
}

func TestTraceFilesFallback(t *testing.T) {
	fc := &fakeConn{query: func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "v$diag_trace_file") {
			return nil, oraErr(942, "table or view does not exist")
		}
		want(t, q, `select p.tracefile, s.sid, s.serial#, s.username
  from v$process p join v$session s on s.paddr = p.addr
 where p.tracefile is not null
   and s.sid = :sid
 order by s.sid`)
		if !reflect.DeepEqual(args, []any{37}) {
			t.Errorf("args %v", args)
		}
		return [][]any{{"/u01/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc", int64(37), int64(4711), "MTK"},
			{`D:\app\diag\rdbms\orcl\orcl\trace\orcl_ora_77.trc`, int64(38), int64(1), nil}}, nil
	}}
	fs, err := NewClient(fc).TraceFiles(ctx, Filter{SID: 37})
	if err != nil {
		t.Fatal(err)
	}
	if len(fs) != 2 || fs[0] != (TraceFile{ADRHome: "/u01/diag/rdbms/cdb1/cdb1", Name: "cdb1_ora_9.trc", Path: "/u01/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_9.trc", SID: 37, Serial: 4711, Username: "MTK", FromProcess: true}) ||
		fs[1].ADRHome != `D:\app\diag\rdbms\orcl\orcl` || fs[1].Name != "orcl_ora_77.trc" {
		t.Errorf("%+v", fs)
	}
	// another error is not a fallback
	fc.query = func(string, []any) ([][]any, error) { return nil, oraErr(1031, "insufficient privileges") }
	if _, err := NewClient(fc).TraceFiles(ctx, Filter{}); !IsORA(err, 1031) {
		t.Errorf("err %v", err)
	}
}

func TestTrace(t *testing.T) {
	fc := &fakeConn{}
	c := NewClient(fc)
	if err := c.Trace(ctx, 37, 4711, true, TraceOptions{Waits: true, Binds: false, PlanStat: "all_executions"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Trace(ctx, 37, 4711, true, TraceOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := c.Trace(ctx, 37, 4711, false, TraceOptions{PlanStat: "bogus"}); err != nil {
		t.Fatal(err)
	}
	if err := c.MyTrace(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := c.MyTrace(ctx, false); err != nil {
		t.Fatal(err)
	}
	en := "begin dbms_monitor.session_trace_enable(session_id => :sid, serial_num => :serial, waits => :w = 1, binds => :b = 1, plan_stat => :ps); end;"
	exp := []call{
		{SQL: en, Args: []any{37, 4711, 1, 0, "ALL_EXECUTIONS"}, Exec: true},
		{SQL: en, Args: []any{37, 4711, 0, 0, nil}, Exec: true},
		{SQL: "begin dbms_monitor.session_trace_disable(session_id => :sid, serial_num => :serial); end;", Args: []any{37, 4711}, Exec: true},
		{SQL: "begin dbms_session.session_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS'); end;", Exec: true},
		{SQL: "begin dbms_session.session_trace_disable; end;", Exec: true},
	}
	if len(fc.calls) != len(exp) {
		t.Fatalf("%d calls: %+v", len(fc.calls), fc.calls)
	}
	for i := range exp {
		want(t, fc.calls[i].SQL, exp[i].SQL)
		if len(exp[i].Args) > 0 && !reflect.DeepEqual(fc.calls[i].Args, exp[i].Args) || !fc.calls[i].Exec {
			t.Errorf("call %d args %v", i, fc.calls[i].Args)
		}
	}
	n := len(fc.calls)
	for _, bad := range []error{
		c.Trace(ctx, 37, 4711, true, TraceOptions{PlanStat: "always"}),
		c.Trace(ctx, 0, 4711, true, TraceOptions{}),
		c.Trace(ctx, 37, 0, false, TraceOptions{}),
	} {
		if bad == nil {
			t.Error("bad trace arguments accepted")
		}
	}
	if len(fc.calls) != n {
		t.Error("invalid arguments reached the database")
	}
	if !ValidPlanStat("FIRST_EXECUTION") || !ValidPlanStat("never") || ValidPlanStat("all") {
		t.Error("ValidPlanStat")
	}
	fc.exec = func(string, []any) error {
		return oraErr(6550, "PLS-00201: identifier 'DBMS_MONITOR' must be declared")
	}
	if err := c.Trace(ctx, 1, 2, true, TraceOptions{}); !IsORA(err, 6550) || !strings.Contains(err.Error(), "session_trace_enable(1, 2)") {
		t.Errorf("err %v", err)
	}
}
