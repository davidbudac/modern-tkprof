//go:build windows

package sshcli

import "syscall"

const createNoWindow = 0x08000000 // CREATE_NO_WINDOW

// sysProcAttr starts ssh without a console window (and so without a console
// to read a password from).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
}

// multiplexDefault: Windows' OpenSSH has no ControlMaster.
const multiplexDefault = false
