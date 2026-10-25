// Package sshconn chooses the SSH transport of a connection: the system
// binaries (sshcli) when they are there, the Go library (sshlib) otherwise
// or when forced, and a switch to the library for the rest of the
// connection's life when ssh ignores SSH_ASKPASS (sshcli.ErrAskpassIgnored).
// (It is not remote.NewSSH because sshcli and sshlib import remote.)
package sshconn

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshcli"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshlib"
)

// Transports.
const (
	Auto = "auto"
	CLI  = "cli"
	Lib  = "lib"
)

// ValidTransport reports whether t is "", auto, cli or lib.
func ValidTransport(t string) bool { return t == "" || t == Auto || t == CLI || t == Lib }

// Options configure New.
type Options struct {
	Transport string          // auto (""), cli or lib
	Conn      string          // the connection id prompts carry
	Prompter  remote.Prompter // asks for sshlib, and for sshcli through a Bridge when Askpass is unset
	// Askpass is where the spawned ssh asks (the engine); empty: New starts
	// an in-process sshcli.Bridge answering through Prompter (the CLI).
	Askpass sshcli.AskpassEnv
	// CLI and Lib, when set, are the clients to use (tests); their Target
	// is overwritten.
	CLI *sshcli.Client
	Lib *sshlib.Options
	// OnSwitch is called when an auto connection moves to the library.
	OnSwitch func(err error)
}

// New returns the connection to t. Nothing is dialled yet.
func New(t remote.Target, o Options) (remote.SSH, error) {
	if err := t.Check(); err != nil {
		return nil, err
	}
	if !ValidTransport(o.Transport) {
		return nil, fmt.Errorf("transport %q: want auto, cli or lib", o.Transport)
	}
	c := &conn{t: t, o: o}
	switch o.Transport {
	case Lib:
		c.cur = c.newLib()
		return c, nil
	case CLI:
		if _, _, err := sshcli.Locate(); err != nil && o.CLI == nil {
			return nil, fmt.Errorf("transport cli: %w", err)
		}
	default:
		if _, _, err := sshcli.Locate(); err != nil && o.CLI == nil {
			c.cur = c.newLib()
			return c, nil
		}
	}
	cli, err := c.newCLI()
	if err != nil {
		return nil, err
	}
	c.cur, c.cli = cli, cli
	return c, nil
}

// conn is a remote.SSH that may switch from sshcli to sshlib once.
type conn struct {
	t remote.Target
	o Options

	mu       sync.Mutex
	cur      remote.SSH
	cli      *sshcli.Client // nil once switched (or never used)
	verified bool           // the cli transport has authenticated once
	bridge   *sshcli.Bridge
}

func (c *conn) newLib() *sshlib.Client {
	o := sshlib.Options{}
	if c.o.Lib != nil {
		o = *c.o.Lib
	}
	o.Target, o.Prompter, o.Conn = c.t, c.o.Prompter, c.o.Conn
	return sshlib.New(o)
}

func (c *conn) newCLI() (*sshcli.Client, error) {
	cl := &sshcli.Client{}
	if c.o.CLI != nil {
		cl = c.o.CLI
	}
	cl.Target = c.t
	cl.Askpass = c.o.Askpass
	if cl.Askpass.Engine == "" {
		b, err := sshcli.StartBridge(c.o.Prompter)
		if err != nil {
			return nil, err
		}
		c.bridge = b
		cl.Askpass = b.Env(c.o.Conn)
	}
	return cl, nil
}

// Transport implements remote.SSH: the transport in use now.
func (c *conn) Transport() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cur.Transport()
}

// do runs op on the transport in use. An auto connection whose cli
// transport has not authenticated yet moves to the library for good when
// op fails with sshcli.ErrAskpassIgnored, and op runs again there. stream
// ops (Follow), whose failure shows only while reading, first verify the
// cli transport with Test.
func (c *conn) do(ctx context.Context, stream bool, op func(remote.SSH) error) error {
	c.mu.Lock()
	cur, cli, verified := c.cur, c.cli, c.verified
	c.mu.Unlock()
	if cli == nil || verified || c.o.Transport == CLI {
		return op(cur)
	}
	var err error
	if stream {
		if _, err = cli.Test(ctx); err == nil {
			err = op(cli)
		}
	} else {
		err = op(cli)
	}
	switch {
	case err == nil:
		c.mu.Lock()
		c.verified = true
		c.mu.Unlock()
		return nil
	case errors.Is(err, sshcli.ErrAskpassIgnored):
		return op(c.switchToLib(err))
	}
	return err
}

func (c *conn) switchToLib(why error) remote.SSH {
	c.mu.Lock()
	if c.cli == nil {
		cur := c.cur
		c.mu.Unlock()
		return cur
	}
	old := c.cli
	c.cli = nil
	c.cur = c.newLib()
	cur := c.cur
	c.mu.Unlock()
	old.Close()
	if c.o.OnSwitch != nil {
		c.o.OnSwitch(why)
	}
	return cur
}

func (c *conn) Test(ctx context.Context) (out string, err error) {
	err = c.do(ctx, false, func(s remote.SSH) (e error) { out, e = s.Test(ctx); return })
	return
}

func (c *conn) Ls(ctx context.Context, p string) (out []remote.Entry, err error) {
	err = c.do(ctx, false, func(s remote.SSH) (e error) { out, e = s.Ls(ctx, p); return })
	return
}

func (c *conn) Diag(ctx context.Context) (out []string, err error) {
	err = c.do(ctx, false, func(s remote.SSH) (e error) { out, e = s.Diag(ctx); return })
	return
}

func (c *conn) Fetch(ctx context.Context, p string, w io.Writer, o remote.FetchOptions) error {
	return c.do(ctx, false, func(s remote.SSH) error { return s.Fetch(ctx, p, w, o) })
}

func (c *conn) Follow(ctx context.Context, p string, from int64) (r io.ReadCloser, err error) {
	err = c.do(ctx, true, func(s remote.SSH) (e error) { r, e = s.Follow(ctx, p, from); return })
	return
}

// Close implements remote.SSH.
func (c *conn) Close() error {
	c.mu.Lock()
	cur, bridge := c.cur, c.bridge
	c.bridge = nil
	c.mu.Unlock()
	err := cur.Close()
	if bridge != nil {
		bridge.Close()
	}
	return err
}
