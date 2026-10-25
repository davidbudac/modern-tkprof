package db

import (
	"context"
	"database/sql"
	"strconv"

	goora "github.com/sijms/go-ora/v2"
)

// Conn is one database session. The Client runs every statement on the
// same session: DBMS_SESSION tracing and sys_context('USERENV','SID') are
// per session, so a pool would mix them up. Binds are positional (:a, :b in
// order of appearance).
type Conn interface {
	Query(ctx context.Context, query string, args ...any) (Rows, error)
	Exec(ctx context.Context, query string, args ...any) error
	Close() error
}

// Rows is the subset of *sql.Rows the client uses. Scan takes pointers to
// string, int64, int, time.Time, sql.NullString, sql.NullInt64, sql.NullTime.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close() error
}

// Driver opens a Conn. GoOra is the only production driver; it stays behind
// this interface so oracle/go-oracledb (or a test fake) can replace it.
type Driver interface {
	Connect(ctx context.Context, s Spec, password string, tls bool) (Conn, error)
}

// GoOra is the pure-Go thin driver github.com/sijms/go-ora/v2 over
// database/sql.
type GoOra struct{}

// URL is the go-ora connection URL for s (it holds the password: never log it).
func (GoOra) URL(s Spec, password string, tls bool) string {
	prefetch := s.PrefetchRows
	if prefetch <= 0 {
		prefetch = 1000
	}
	opts := map[string]string{"PREFETCH_ROWS": strconv.Itoa(prefetch)}
	if tls {
		opts["SSL"] = "true"
		if s.TLSSkipVerify {
			opts["SSL VERIFY"] = "false"
		}
	}
	return goora.BuildUrl(s.Host, s.port(), s.Service, s.User, password, opts)
}

// Connect opens a pool of one and pins its session.
func (g GoOra) Connect(ctx context.Context, s Spec, password string, tls bool) (Conn, error) {
	pool, err := sql.Open("oracle", g.URL(s, password, tls))
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(1)
	c, err := pool.Conn(ctx)
	if err != nil {
		pool.Close()
		return nil, err
	}
	return &sqlConn{pool: pool, c: c}, nil
}

// sqlConn adapts a pinned *sql.Conn.
type sqlConn struct {
	pool *sql.DB
	c    *sql.Conn
}

func (s *sqlConn) Query(ctx context.Context, q string, args ...any) (Rows, error) {
	return s.c.QueryContext(ctx, q, args...)
}

func (s *sqlConn) Exec(ctx context.Context, q string, args ...any) error {
	_, err := s.c.ExecContext(ctx, q, args...)
	return err
}

func (s *sqlConn) Close() error {
	err := s.c.Close()
	if e := s.pool.Close(); err == nil {
		err = e
	}
	return err
}
