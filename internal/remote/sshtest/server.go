// Package sshtest has test doubles for the SSH transports: an in-process
// SSH + SFTP server (x/crypto/ssh, pkg/sftp) that runs exec requests with
// the local sh, and fake ssh/sftp shell scripts that record their argv and
// environment, ask through SSH_ASKPASS like OpenSSH and run the remote
// command locally.
package sshtest

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// KIQuestion is one keyboard-interactive question and the answer it wants.
type KIQuestion struct {
	Q      string
	Echo   bool
	Answer string
}

// Options configure a Server. With no authentication set every client is let in.
type Options struct {
	User                string         // the only user accepted ("" = any)
	Password            string         // password authentication when set
	Keys                []ssh.PublicKey // publickey authentication
	KeyboardInteractive []KIQuestion   // keyboard-interactive authentication when set
	Env                 []string       // extra environment of exec'd commands
}

// Server is an in-process SSH server on 127.0.0.1. Exec requests run with
// `sh -c` on this machine; the sftp subsystem serves the local file system.
type Server struct {
	Host    string
	Port    int
	Addr    string
	HostKey ssh.PublicKey

	o   Options
	cfg *ssh.ServerConfig
	ln  net.Listener
	wg  sync.WaitGroup

	mu     sync.Mutex
	execs    []string
	lingered []string
	logins   int
	conns  map[net.Conn]bool
}

// Start starts a server; it stops at the end of the test.
func Start(t testing.TB, o Options) *Server {
	t.Helper()
	s, err := NewServer(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

// NewServer starts a server; Close stops it.
func NewServer(o Options) (*Server, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	hk, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	s := &Server{o: o, HostKey: hk.PublicKey(), conns: map[net.Conn]bool{}}
	cfg := &ssh.ServerConfig{}
	userOK := func(c ssh.ConnMetadata) bool { return o.User == "" || c.User() == o.User }
	open := o.Password == "" && len(o.Keys) == 0 && len(o.KeyboardInteractive) == 0
	cfg.NoClientAuth = open
	if o.Password != "" {
		cfg.PasswordCallback = func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if userOK(c) && string(pw) == o.Password {
				return nil, nil
			}
			return nil, errors.New("wrong password")
		}
	}
	if len(o.Keys) > 0 {
		cfg.PublicKeyCallback = func(c ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			for _, want := range o.Keys {
				if userOK(c) && bytes.Equal(want.Marshal(), k.Marshal()) {
					return nil, nil
				}
			}
			return nil, errors.New("unknown key")
		}
	}
	if len(o.KeyboardInteractive) > 0 {
		cfg.KeyboardInteractiveCallback = func(c ssh.ConnMetadata, ch ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			var qs []string
			var echos []bool
			for _, q := range o.KeyboardInteractive {
				qs, echos = append(qs, q.Q), append(echos, q.Echo)
			}
			ans, err := ch("", "", qs, echos)
			if err != nil {
				return nil, err
			}
			if !userOK(c) || len(ans) != len(qs) {
				return nil, errors.New("wrong answers")
			}
			for i, q := range o.KeyboardInteractive {
				if ans[i] != q.Answer {
					return nil, errors.New("wrong answers")
				}
			}
			return nil, nil
		}
	}
	cfg.AddHostKey(hk)
	s.cfg = cfg
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s.ln = ln
	s.Addr = ln.Addr().String()
	host, port, _ := net.SplitHostPort(s.Addr)
	s.Host = host
	s.Port, _ = strconv.Atoi(port)
	s.wg.Add(1)
	go s.accept()
	return s, nil
}

// Close stops the server and drops every connection.
func (s *Server) Close() {
	s.ln.Close()
	s.mu.Lock()
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

// Execs are the commands of the exec requests so far.
func (s *Server) Execs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.execs...)
}

// Logins is the number of authenticated connections so far.
func (s *Server) Logins() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logins
}

// DropConnections closes every open connection (a network failure).
func (s *Server) DropConnections() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		c.Close()
	}
}

func (s *Server) accept() {
	defer s.wg.Done()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[c] = true
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.serve(c)
			s.mu.Lock()
			delete(s.conns, c)
			s.mu.Unlock()
			c.Close()
		}()
	}
}

func (s *Server) serve(c net.Conn) {
	sc, chans, reqs, err := ssh.NewServerConn(c, s.cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	s.mu.Lock()
	s.logins++
	s.mu.Unlock()
	go ssh.DiscardRequests(reqs)
	var wg sync.WaitGroup
	for nc := range chans {
		if nc.ChannelType() != "session" {
			nc.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.session(ch, creqs)
		}()
	}
	wg.Wait()
}

// session serves one session channel: exec or the sftp subsystem.
func (s *Server) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for req := range reqs {
		switch req.Type {
		case "exec":
			var p struct{ Command string }
			if ssh.Unmarshal(req.Payload, &p) != nil {
				req.Reply(false, nil)
				continue
			}
			req.Reply(true, nil)
			s.mu.Lock()
			s.execs = append(s.execs, p.Command)
			s.mu.Unlock()
			s.exec(ch, reqs, p.Command)
			return
		case "subsystem":
			var p struct{ Name string }
			if ssh.Unmarshal(req.Payload, &p) != nil || p.Name != "sftp" {
				req.Reply(false, nil)
				continue
			}
			req.Reply(true, nil)
			go ssh.DiscardRequests(reqs)
			srv, err := sftp.NewServer(ch)
			if err != nil {
				return
			}
			srv.Serve()
			srv.Close()
			return
		default:
			req.Reply(false, nil)
		}
	}
}

// exec runs cmd with sh -c in its own process group. Like sshd, when the
// client closes the channel it closes the process's pipes (EOF on stdin,
// SIGPIPE on the next write) but does not kill it; a process still running
// 3 s later is counted as lingering (Lingered) and killed.
func (s *Server) exec(ch ssh.Channel, reqs <-chan *ssh.Request, cmd string) {
	p := exec.Command("sh", "-c", cmd)
	p.Env = append(os.Environ(), s.o.Env...)
	newGroup(p)
	stdin, err1 := p.StdinPipe()
	stdout, err2 := p.StdoutPipe()
	stderr, err3 := p.StderrPipe()
	if err := errors.Join(err1, err2, err3); err != nil {
		return
	}
	if err := p.Start(); err != nil {
		fmt.Fprintf(ch.Stderr(), "sh: %v\n", err)
		ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{127}))
		return
	}
	go func() {
		io.Copy(stdin, ch)
		stdin.Close()
	}()
	var copies sync.WaitGroup
	copies.Add(2)
	go func() { io.Copy(ch, stdout); copies.Done() }()
	go func() { io.Copy(ch.Stderr(), stderr); copies.Done() }()
	exited := make(chan struct{})
	go func() {
		for req := range reqs {
			req.Reply(false, nil)
		}
		// the channel is gone
		stdin.Close()
		stdout.Close()
		stderr.Close()
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			s.mu.Lock()
			s.lingered = append(s.lingered, cmd)
			s.mu.Unlock()
			killGroup(p)
		}
	}()
	copies.Wait()
	err := p.Wait()
	close(exited)
	status := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		status = ee.ExitCode()
		if status < 0 {
			status = 255
		}
	}
	ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(status)}))
}

// Lingered are the commands whose process outlived its channel by 3 s.
func (s *Server) Lingered() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lingered...)
}
