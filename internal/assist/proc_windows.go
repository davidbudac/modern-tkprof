//go:build windows

package assist

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000 // CREATE_NO_WINDOW

// sysProcAttr starts a CLI agent without a console window.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
}

// killGroup ends the agent; its MCP server exits when its stdin closes.
func killGroup(c *exec.Cmd) error { return c.Process.Kill() }
