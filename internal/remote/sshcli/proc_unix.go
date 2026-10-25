//go:build !windows

package sshcli

import (
	"os/exec"
	"syscall"
)

// sysProcAttr starts ssh in a new session without a controlling terminal,
// so it cannot read a password from the tty and asks SSH_ASKPASS instead.
func sysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// multiplexDefault: ControlMaster connection sharing (not in Windows' OpenSSH).
const multiplexDefault = true

// kill ends ssh and whatever it started in its session (a ProxyCommand);
// a ControlPersist master has detached into its own session and stays.
func kill(c *exec.Cmd) error { return syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
