package db

import (
	"context"
	"database/sql"
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
