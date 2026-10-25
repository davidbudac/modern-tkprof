//go:build !windows

package sshtest

import (
	"os/exec"
	"syscall"
)

func newGroup(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func killGroup(c *exec.Cmd) { syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
