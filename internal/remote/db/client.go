// Package db reaches trace files and reference data through an Oracle
// connection (docs/PLAN-DESKTOP.md § 6, docs/REMOTE.md): the ADR views
// V$DIAG_INFO / V$DIAG_TRACE_FILE / V$DIAG_TRACE_FILE_CONTENTS, V$SESSION and
// V$PROCESS, DBMS_MONITOR for trace on/off, and the reference-bundle queries
// of report.RefQueries. Username/password over TCP or TCPS only; the
// password is asked for through a remote.Prompter and kept only inside the
// open connection.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// passwordTries is how many times a wrong password (ORA-01017) is re-asked.
const passwordTries = 3

// Client is one open database session.
type Client struct {
	conn Conn
	spec Spec
	now  func() time.Time // the clock of Fetch's range sizing; nil = time.Now (tests)
}

// Open connects with the go-ora driver; see OpenWith.
func Open(ctx context.Context, s Spec, p remote.Prompter, tls bool) (*Client, error) {
	return OpenWith(ctx, GoOra{}, s, p, tls)
}

// OpenWith asks p for the password (kind password, connection s.ID) and
// connects through d; a rejected password (ORA-01017) is asked again, up to
// three times. tls selects TCPS (see Spec.TLSSkipVerify).
func OpenWith(ctx context.Context, d Driver, s Spec, p remote.Prompter, tls bool) (*Client, error) {
	if s.Host == "" || s.User == "" || s.Service == "" {
		return nil, fmt.Errorf("db: incomplete connection %q", s.String())
	}
	if p == nil {
		return nil, errors.New("db: no prompter for the password")
	}
	text := "Password for " + s.String() + ": "
	for try := 1; ; try++ {
		pw, err := p.Ask(ctx, remote.Prompt{Connection: s.ID, Kind: remote.KindPassword, Text: text})
		if err != nil {
			return nil, err
		}
		c, err := d.Connect(ctx, s, pw, tls)
		if err == nil {
			return &Client{conn: c, spec: s}, nil
		}
		if !IsORA(err, 1017) || try == passwordTries {
			return nil, fmt.Errorf("db: connect %s: %w", s.String(), err)
		}
		text = "Wrong user name or password. Password for " + s.String() + ": "
	}
}

// NewClient wraps an open Conn (tests, other drivers).
func NewClient(c Conn) *Client { return &Client{conn: c} }

// Close ends the session.
func (c *Client) Close() error { return c.conn.Close() }

// IsORA reports whether err is (or wraps) the Oracle error ORA-<code>.
// Matched on the text so it does not depend on the driver's error type.
func IsORA(err error, code int) bool {
	return err != nil && strings.Contains(err.Error(), fmt.Sprintf("ORA-%05d", code))
}

// Version queries, first success wins: V$INSTANCE needs a grant
// (SELECT_CATALOG_ROLE), V$VERSION is readable by every user.
var versionQueries = []string{
	"select version_full from v$instance",
	"select banner_full from v$version where rownum = 1",
	"select banner from v$version where rownum = 1",
}

// Version is the server version: V$INSTANCE.VERSION_FULL (e.g. 19.24.0.0.0),
// else the V$VERSION banner.
func (c *Client) Version(ctx context.Context) (string, error) {
	var errs []error
	for _, q := range versionQueries {
		var v sql.NullString
		ok, err := c.queryRow(ctx, q, nil, &v)
		if err == nil && ok && v.String != "" {
			return strings.Join(strings.Fields(v.String), " "), nil
		}
		if err != nil {
			errs = append(errs, err)
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	return "", fmt.Errorf("db: version: %w", errors.Join(errs...))
}

// DiagInfo is V$DIAG_INFO of the connected instance.
type DiagInfo struct {
	ADRHome          string            `json:"adrHome"`          // ADR Home
	DiagTrace        string            `json:"diagTrace"`        // Diag Trace: the trace directory
	DefaultTraceFile string            `json:"defaultTraceFile"` // Default Trace File: this session's trace file
	All              map[string]string `json:"all"`              // every NAME -> VALUE
}

const diagInfoSQL = "select name, value from v$diag_info"

// DiagInfo reads V$DIAG_INFO.
func (c *Client) DiagInfo(ctx context.Context) (DiagInfo, error) {
	d := DiagInfo{All: map[string]string{}}
	rows, err := c.conn.Query(ctx, diagInfoSQL)
	if err != nil {
		return d, fmt.Errorf("db: v$diag_info: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name, value sql.NullString
		if err := rows.Scan(&name, &value); err != nil {
			return d, err
		}
		d.All[name.String] = value.String
	}
	if err := rows.Err(); err != nil {
		return d, fmt.Errorf("db: v$diag_info: %w", err)
	}
	d.ADRHome, d.DiagTrace, d.DefaultTraceFile = d.All["ADR Home"], d.All["Diag Trace"], d.All["Default Trace File"]
	return d, nil
}

// Session is one V$SESSION row of a user session.
type Session struct {
	SID       int       `json:"sid"`
	Serial    int       `json:"serial"`
	Username  string    `json:"username"`
	OSUser    string    `json:"osuser"`
	Machine   string    `json:"machine"`
	Program   string    `json:"program"`
	Module    string    `json:"module"`
	Action    string    `json:"action"`
	Status    string    `json:"status"`
	SQLID     string    `json:"sqlId"`
	LogonTime time.Time `json:"logonTime"`
	SQLTrace  string    `json:"sqlTrace"`  // V$SESSION.SQL_TRACE: ENABLED / DISABLED
	TraceFile string    `json:"traceFile"` // V$PROCESS.TRACEFILE of its server process
	Self      bool      `json:"self"`      // the session this client runs on
}

const sessionsSQL = `select s.sid, s.serial#, s.username, s.osuser, s.machine, s.program, s.module, s.action, s.status, s.sql_id, s.logon_time, s.sql_trace, p.tracefile,
       case when s.sid = to_number(sys_context('USERENV', 'SID')) then 1 else 0 end
  from v$session s left join v$process p on p.addr = s.paddr
 where s.type = 'USER'
 order by s.logon_time desc, s.sid`

// Sessions lists the user sessions (V$SESSION type USER), newest logon first.
func (c *Client) Sessions(ctx context.Context) ([]Session, error) {
	rows, err := c.conn.Query(ctx, sessionsSQL)
	if err != nil {
		return nil, fmt.Errorf("db: v$session: %w", err)
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var s Session
		var user, osuser, machine, program, module, action, status, sqlID, trc, tf sql.NullString
		var logon sql.NullTime
		var self int64
		if err := rows.Scan(&s.SID, &s.Serial, &user, &osuser, &machine, &program, &module, &action, &status, &sqlID, &logon, &trc, &tf, &self); err != nil {
			return nil, fmt.Errorf("db: v$session: %w", err)
		}
		s.Username, s.OSUser, s.Machine, s.Program = user.String, osuser.String, machine.String, program.String
		s.Module, s.Action, s.Status, s.SQLID = module.String, action.String, status.String, sqlID.String
		s.LogonTime, s.SQLTrace, s.TraceFile, s.Self = logon.Time, trc.String, tf.String, self == 1
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("db: v$session: %w", err)
	}
	return out, nil
}

// Filter narrows TraceFiles. Zero fields do not filter.
type Filter struct {
	SID, Serial int       // only the file of this session's server process
	Since       time.Time // only files modified at or after (ADR list only)
}

// TraceFile is one trace file of the ADR home.
type TraceFile struct {
	ADRHome  string    `json:"adrHome"`
	Name     string    `json:"name"`               // TRACE_FILENAME, the key for Fetch
	Path     string    `json:"path,omitempty"`     // full path, when a live process writes it (V$PROCESS.TRACEFILE)
	Modified time.Time `json:"modified,omitzero"`  // V$DIAG_TRACE_FILE.MODIFY_TIME
	ConID    int       `json:"conId,omitempty"`    // container of the file
	SID      int       `json:"sid,omitempty"`      // session of the process writing it, if any
	Serial   int       `json:"serial,omitempty"`   //
	Username string    `json:"username,omitempty"` //
	// FromProcess: V$DIAG_TRACE_FILE was not readable (ORA-00942) and the
	// row comes from V$PROCESS.TRACEFILE alone: the file a live process
	// would write to; it exists only if something was traced.
	FromProcess bool `json:"fromProcess,omitempty"`
}

// traceFilesSQL lists V$DIAG_TRACE_FILE with the live process and session
// writing each file. V$PROCESS.TRACEFILE is a full path (either separator).
const traceFilesSQL = `select f.adr_home, f.trace_filename, f.modify_time, f.con_id, s.sid, s.serial#, s.username, p.tracefile
  from v$diag_trace_file f
  left join v$process p on substr(p.tracefile, -length(f.trace_filename) - 1) in ('/' || f.trace_filename, '\' || f.trace_filename)
  left join v$session s on s.paddr = p.addr`

const processFilesSQL = `select p.tracefile, s.sid, s.serial#, s.username
  from v$process p join v$session s on s.paddr = p.addr
 where p.tracefile is not null`

// TraceFiles lists trace files, newest first: V$DIAG_TRACE_FILE (12.2+)
// joined to V$PROCESS / V$SESSION for the session writing each. When the
// ADR view is not accessible (ORA-00942) it falls back to V$PROCESS.TRACEFILE
// of the live sessions (Since does not apply there).
func (c *Client) TraceFiles(ctx context.Context, f Filter) ([]TraceFile, error) {
	q, args := traceFilesQuery(f)
	rows, err := c.conn.Query(ctx, q, args...)
	if err != nil {
		if IsORA(err, 942) {
			return c.processFiles(ctx, f)
		}
		return nil, fmt.Errorf("db: v$diag_trace_file: %w", err)
	}
	defer rows.Close()
	var out []TraceFile
	for rows.Next() {
		var t TraceFile
		var adr, name, user, path sql.NullString
		var mod sql.NullTime
		var con, sid, serial sql.NullInt64
		if err := rows.Scan(&adr, &name, &mod, &con, &sid, &serial, &user, &path); err != nil {
			return nil, fmt.Errorf("db: v$diag_trace_file: %w", err)
		}
		t.ADRHome, t.Name, t.Modified, t.ConID = adr.String, name.String, mod.Time, int(con.Int64)
		t.SID, t.Serial, t.Username, t.Path = int(sid.Int64), int(serial.Int64), user.String, path.String
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		if IsORA(err, 942) {
			return c.processFiles(ctx, f)
		}
		return nil, fmt.Errorf("db: v$diag_trace_file: %w", err)
	}
	return out, nil
}

func traceFilesQuery(f Filter) (string, []any) {
	q, args := traceFilesSQL, []any{}
	var where []string
	if f.SID > 0 {
		where, args = append(where, "s.sid = :sid"), append(args, f.SID)
	}
	if f.Serial > 0 {
		where, args = append(where, "s.serial# = :serial"), append(args, f.Serial)
	}
	if !f.Since.IsZero() {
		// seconds since the epoch: no driver time-zone conversion on the bind
		where = append(where, "f.modify_time >= timestamp '1970-01-01 00:00:00 +00:00' + numtodsinterval(:since, 'SECOND')")
		args = append(args, f.Since.Unix())
	}
	if len(where) > 0 {
		q += "\n where " + strings.Join(where, "\n   and ")
	}
	return q + "\n order by f.modify_time desc, f.trace_filename", args
}

func processFilesQuery(f Filter) (string, []any) {
	q, args := processFilesSQL, []any{}
	if f.SID > 0 {
		q, args = q+"\n   and s.sid = :sid", append(args, f.SID)
	}
	if f.Serial > 0 {
		q, args = q+"\n   and s.serial# = :serial", append(args, f.Serial)
	}
	return q + "\n order by s.sid", args
}

func (c *Client) processFiles(ctx context.Context, f Filter) ([]TraceFile, error) {
	q, args := processFilesQuery(f)
	rows, err := c.conn.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("db: v$process: %w", err)
	}
	defer rows.Close()
	var out []TraceFile
	for rows.Next() {
		var path, user sql.NullString
		var sid, serial sql.NullInt64
		if err := rows.Scan(&path, &sid, &serial, &user); err != nil {
			return nil, fmt.Errorf("db: v$process: %w", err)
		}
		dir, name, sep := splitTracePath(path.String)
		out = append(out, TraceFile{ADRHome: strings.TrimSuffix(dir, sep+"trace"), Name: name, Path: path.String,
			SID: int(sid.Int64), Serial: int(serial.Int64), Username: user.String, FromProcess: true})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("db: v$process: %w", err)
	}
	return out, nil
}

// splitTracePath splits a server-side path at its last / or \ (the
// server's OS, not this one's).
func splitTracePath(p string) (dir, name, sep string) {
	i := strings.LastIndexAny(p, `/\`)
	if i < 0 {
		return "", p, "/"
	}
	return p[:i], p[i+1:], p[i : i+1]
}

// Plan statistics levels of DBMS_MONITOR / DBMS_SESSION trace.
var planStats = map[string]bool{"never": true, "first_execution": true, "all_executions": true}

// TraceOptions are the DBMS_MONITOR.SESSION_TRACE_ENABLE parameters.
type TraceOptions struct {
	Waits, Binds bool
	PlanStat     string // never | first_execution | all_executions; "" = the server default (first_execution)
}

const (
	traceEnableSQL  = "begin dbms_monitor.session_trace_enable(session_id => :sid, serial_num => :serial, waits => :w = 1, binds => :b = 1, plan_stat => :ps); end;"
	traceDisableSQL = "begin dbms_monitor.session_trace_disable(session_id => :sid, serial_num => :serial); end;"
	myTraceOnSQL    = "begin dbms_session.session_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS'); end;"
	myTraceOffSQL   = "begin dbms_session.session_trace_disable; end;"
)

// ValidPlanStat reports whether s is a plan_stat value ("" included).
func ValidPlanStat(s string) bool { return s == "" || planStats[strings.ToLower(s)] }

// Trace switches SQL trace of session sid,serial on or off with
// DBMS_MONITOR (needs EXECUTE ON DBMS_MONITOR). o applies to enable only.
// PL/SQL booleans are passed as 1/0 and compared in the block, since 19c
// cannot bind BOOLEAN.
func (c *Client) Trace(ctx context.Context, sid, serial int, enable bool, o TraceOptions) error {
	if sid <= 0 || serial <= 0 {
		return fmt.Errorf("db: trace: want sid and serial# > 0, got %d,%d", sid, serial)
	}
	if !enable {
		if err := c.conn.Exec(ctx, traceDisableSQL, sid, serial); err != nil {
			return fmt.Errorf("db: dbms_monitor.session_trace_disable(%d, %d): %w", sid, serial, err)
		}
		return nil
	}
	if !ValidPlanStat(o.PlanStat) {
		return fmt.Errorf("db: trace: plan_stat %q: want never, first_execution or all_executions", o.PlanStat)
	}
	var ps any // NULL = the default
	if o.PlanStat != "" {
		ps = strings.ToUpper(o.PlanStat)
	}
	if err := c.conn.Exec(ctx, traceEnableSQL, sid, serial, b2i(o.Waits), b2i(o.Binds), ps); err != nil {
		return fmt.Errorf("db: dbms_monitor.session_trace_enable(%d, %d): %w", sid, serial, err)
	}
	return nil
}

// MyTrace switches SQL trace of this client's own session (DBMS_SESSION,
// waits and binds, plan_stat ALL_EXECUTIONS; needs ALTER SESSION).
func (c *Client) MyTrace(ctx context.Context, enable bool) error {
	q := myTraceOffSQL
	if enable {
		q = myTraceOnSQL
	}
	if err := c.conn.Exec(ctx, q); err != nil {
		return fmt.Errorf("db: dbms_session trace: %w", err)
	}
	return nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// queryRow scans the first row of q into dest; ok is false without rows.
func (c *Client) queryRow(ctx context.Context, q string, args []any, dest ...any) (ok bool, err error) {
	rows, err := c.conn.Query(ctx, q, args...)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return false, rows.Err()
	}
	if err := rows.Scan(dest...); err != nil {
		return false, err
	}
	return true, rows.Close()
}
