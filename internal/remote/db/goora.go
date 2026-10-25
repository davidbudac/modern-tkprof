//go:build !nooracle

package db

import (
	"context"
	"database/sql"
	"strconv"

	goora "github.com/sijms/go-ora/v2"
)

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
