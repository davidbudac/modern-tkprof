//go:build !windows

package engine

import (
	"os"
	"syscall"
)

// processAlive reports whether a process with this pid exists.
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || err == syscall.EPERM
}
