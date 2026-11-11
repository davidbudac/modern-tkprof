package engine

import (
	"fmt"
	"runtime/debug"
)

// guarded runs fn and turns a panic into its error. The engine's own
// goroutines run their work through it: a panic there would end the process,
// and with it every open session (net/http contains only a handler's).
func guarded(what string, fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("internal error in %s: %v\n%s", what, r, debug.Stack())
		}
	}()
	return fn()
}
