//go:build !windows

package sshlib

import (
	"errors"
	"io"
	"net"
	"os"
)

// dialAgent connects to the agent at SSH_AUTH_SOCK.
func dialAgent() (io.ReadWriteCloser, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, errors.New("no SSH_AUTH_SOCK")
	}
	return net.Dial("unix", sock)
}
