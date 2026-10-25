//go:build windows

package sshtest

import "os/exec"

func newGroup(c *exec.Cmd) {}

func killGroup(c *exec.Cmd) { c.Process.Kill() }
