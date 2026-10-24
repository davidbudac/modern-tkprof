package slice

import "os"

// processAlive reports whether a process with this pid exists (on Windows
// FindProcess fails for a pid that is gone).
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	p.Release()
	return true
}
