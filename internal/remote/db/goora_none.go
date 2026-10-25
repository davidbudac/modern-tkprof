//go:build nooracle

package db

import (
	"context"
	"errors"
)

// GoOra without the driver: -tags nooracle drops go-ora (about 12 MB of
// character-set tables) from the binary; every connect fails.
type GoOra struct{}

func (GoOra) Connect(context.Context, Spec, string, bool) (Conn, error) {
	return nil, errors.New("db: this mtkprof is built without Oracle support (-tags nooracle)")
}
