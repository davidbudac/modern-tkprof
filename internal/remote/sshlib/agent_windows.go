//go:build windows

package sshlib

import (
	"io"
	"os"
)

// agentPipe is the named pipe of Windows' OpenSSH agent service.
const agentPipe = `\\.\pipe\openssh-ssh-agent`

// dialAgent opens the OpenSSH agent's named pipe (os.OpenFile opens a pipe
// in synchronous mode, enough for the agent's request/response protocol).
// Unverified on a real machine: to check in S6.
func dialAgent() (io.ReadWriteCloser, error) {
	return os.OpenFile(agentPipe, os.O_RDWR, 0)
}
