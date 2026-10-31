//go:build !windows

package assist

import (
	"os/exec"
	"syscall"
)

// sysProcAttr starts a CLI agent in a new session, so it and what it starts
// (the MCP server) are one process group without the engine's terminal.
func sysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// killGroup ends the agent and every process of its group.
func killGroup(c *exec.Cmd) error { return syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
