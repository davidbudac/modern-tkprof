package db

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// call is one statement the fake received.
type call struct {
	SQL  string
	Args []any
	Exec bool
}

// fakeConn records statements and answers queries from a handler.
type fakeConn struct {
	mu     sync.Mutex
	calls  []call
	query  func(q string, args []any) ([][]any, error)
	exec   func(q string, args []any) error
	closed bool
}

func (f *fakeConn) Query(ctx context.Context, q string, args ...any) (Rows, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.calls = append(f.calls, call{SQL: q, Args: args})
	f.mu.Unlock()
	if f.query == nil {
		return nil, fmt.Errorf("fake: unexpected query %q", q)
	}
	rows, err := f.query(q, args)
	if err != nil {
		return nil, err
	}
	return &fakeRows{rows: rows, i: -1}, nil
}

func (f *fakeConn) Exec(ctx context.Context, q string, args ...any) error {
	f.mu.Lock()
	f.calls = append(f.calls, call{SQL: q, Args: args, Exec: true})
	f.mu.Unlock()
	if f.exec == nil {
		return nil
	}
	return f.exec(q, args)
}

func (f *fakeConn) Close() error { f.closed = true; return nil }

func (f *fakeConn) queries() []string {
	var out []string
	for _, c := range f.calls {
		if !c.Exec {
			out = append(out, c.SQL)
		}
	}
	return out
}

type fakeRows struct {
	rows [][]any
	i    int
}

func (r *fakeRows) Next() bool   { r.i++; return r.i < len(r.rows) }
func (r *fakeRows) Err() error   { return nil }
func (r *fakeRows) Close() error { return nil }

// Scan converts like database/sql does, through its Null* scanners.
func (r *fakeRows) Scan(dest ...any) error {
	row := r.rows[r.i]
	if len(dest) != len(row) {
		return fmt.Errorf("fake: scan %d columns into %d", len(row), len(dest))
	}
	for i, d := range dest {
		v := row[i]
		var err error
		switch d := d.(type) {
		case sql.Scanner:
			err = d.Scan(v)
		case *string:
			var n sql.NullString
			err = n.Scan(v)
			*d = n.String
		case *int64:
			var n sql.NullInt64
			err = n.Scan(v)
			*d = n.Int64
		case *int:
			var n sql.NullInt64
			err = n.Scan(v)
			*d = int(n.Int64)
		case *time.Time:
			var n sql.NullTime
			err = n.Scan(v)
			*d = n.Time
		default:
			err = fmt.Errorf("fake: cannot scan into %T", d)
		}
		if err != nil {
			return fmt.Errorf("fake: column %d: %w", i, err)
		}
	}
	return nil
}

// oraErr mimics a driver error text.
func oraErr(code int, msg string) error { return fmt.Errorf("ORA-%05d: %s", code, msg) }

// fakePrompter answers from a list and records the prompts.
type fakePrompter struct {
	answers []string
	asked   []remote.Prompt
}

func (p *fakePrompter) Ask(ctx context.Context, q remote.Prompt) (string, error) {
	p.asked = append(p.asked, q)
	if len(p.answers) == 0 {
		return "", io.EOF
	}
	a := p.answers[0]
	p.answers = p.answers[1:]
	return a, nil
}

// fakeDriver accepts one password.
type fakeDriver struct {
	password string
	conn     *fakeConn
	got      []string // passwords tried
	tls      bool
}

func (d *fakeDriver) Connect(ctx context.Context, s Spec, pw string, tls bool) (Conn, error) {
	d.got, d.tls = append(d.got, pw), tls
	if pw != d.password {
		return nil, oraErr(1017, "invalid username/password; logon denied")
	}
	return d.conn, nil
}

func want(t *testing.T, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("SQL\n got: %q\nwant: %q", got, want)
	}
}

func lines(s string) []string { return strings.Split(strings.TrimSuffix(s, "\n"), "\n") }
