//go:build !windows

package sshcli

import "syscall"

// sysProcAttr starts ssh in a new session without a controlling terminal,
// so it cannot read a password from the tty and asks SSH_ASKPASS instead.
func sysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// multiplexDefault: ControlMaster connection sharing (not in Windows' OpenSSH).
const multiplexDefault = true
