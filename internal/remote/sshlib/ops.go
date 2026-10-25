package sshlib

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// run executes a remote command and returns its stdout (at most 4 MB).
func (c *Client) run(ctx context.Context, cmd string) (string, error) {
	sc, _, err := c.connect(ctx)
	if err != nil {
		return "", err
	}
	s, err := sc.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	var out, errb bytes.Buffer
	s.Stdout, s.Stderr = &limitWriter{w: &out, n: 4 << 20}, &limitWriter{w: &errb, n: 4 << 10}
	stop := context.AfterFunc(ctx, func() { s.Close() })
	defer stop()
	if err := s.Run(cmd); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if msg := strings.TrimSpace(errb.String()); msg != "" {
			return out.String(), fmt.Errorf("%w: %s", err, msg)
		}
		return out.String(), err
	}
	return out.String(), nil
}

// Test implements remote.SSH: the host's uname -sr and the server version.
func (c *Client) Test(ctx context.Context) (string, error) {
	out, err := c.run(ctx, remote.ShCommand("uname -sr"))
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	ver := ""
	if c.sc != nil {
		ver = string(c.sc.ServerVersion())
	}
	c.mu.Unlock()
	s := strings.TrimSpace(out)
	if ver != "" {
		s += " (" + ver + ")"
	}
	return s, nil
}

// Diag implements remote.SSH (remote.DiagScript over an exec session).
func (c *Client) Diag(ctx context.Context) ([]string, error) {
	out, err := c.run(ctx, remote.ShCommand(remote.DiagScript))
	if err != nil {
		return nil, err
	}
	return remote.ParseDiag(out), nil
}

// Ls implements remote.SSH: the directory's entries (symbolic links not
// followed), or the one file p names.
func (c *Client) Ls(ctx context.Context, p string) ([]remote.Entry, error) {
	_, sf, err := c.connect(ctx)
	if err != nil {
		return nil, err
	}
	fi, err := sf.Stat(p)
	if err != nil {
		return nil, fmt.Errorf("ls %s: %w", p, err)
	}
	if !fi.IsDir() {
		return []remote.Entry{entry(p, fi)}, nil
	}
	fis, err := sf.ReadDir(p)
	if err != nil {
		return nil, fmt.Errorf("ls %s: %w", p, err)
	}
	out := make([]remote.Entry, 0, len(fis))
	for _, fi := range fis {
		if fi.Name() == "." || fi.Name() == ".." || strings.HasPrefix(fi.Name(), ".") {
			continue // as sftp's ls without -a
		}
		out = append(out, entry(path.Join(p, fi.Name()), fi))
	}
	return out, nil
}

func entry(p string, fi os.FileInfo) remote.Entry {
	m := fi.Mode()
	return remote.Entry{Name: path.Base(p), Path: p, Size: fi.Size(), Mode: remote.ModeString(m),
		ModTime: fi.ModTime().Truncate(time.Second), Dir: m.IsDir(), Link: m&os.ModeSymlink != 0}
}

// Fetch implements remote.SSH: an SFTP read from o.From (NoGzip does not
// apply: SFTP is not compressed).
func (c *Client) Fetch(ctx context.Context, p string, w io.Writer, o remote.FetchOptions) error {
	_, sf, err := c.connect(ctx)
	if err != nil {
		return err
	}
	f, err := sf.Open(p)
	if err != nil {
		return fmt.Errorf("%s: %w", p, err)
	}
	defer f.Close()
	if _, err := f.Seek(o.From, io.SeekStart); err != nil {
		return err
	}
	stop := context.AfterFunc(ctx, func() { f.Close() })
	defer stop()
	pw := &progressWriter{ctx: ctx, w: w, pos: o.From, fn: o.Progress}
	_, err = f.WriteTo(pw) // concurrent reads from the offset on
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if pw.werr != nil {
		return pw.werr
	}
	if err != nil {
		return fmt.Errorf("fetch %s: %w", p, err)
	}
	return nil
}

// Follow implements remote.SSH: polls the size every PollInterval and
// streams what was appended. A file that shrinks ends the stream with an
// error.
func (c *Client) Follow(ctx context.Context, p string, from int64) (io.ReadCloser, error) {
	_, sf, err := c.connect(ctx)
	if err != nil {
		return nil, err
	}
	f, err := sf.Open(p)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	interval := c.o.PollInterval
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	ctx, cancel := context.WithCancel(ctx)
	pr, pw := io.Pipe()
	go func() {
		defer f.Close()
		err := follow(ctx, f, pw, from, interval)
		if ctx.Err() != nil {
			err = nil
		}
		pw.CloseWithError(err)
	}()
	return &pipeCloser{PipeReader: pr, cancel: cancel}, nil
}

func follow(ctx context.Context, f *sftp.File, w io.Writer, off int64, interval time.Duration) error {
	buf := make([]byte, 256<<10)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		if fi.Size() < off {
			return fmt.Errorf("the file shrank from %d to %d bytes", off, fi.Size())
		}
		for off < fi.Size() {
			n, err := f.ReadAt(buf[:min(int64(len(buf)), fi.Size()-off)], off)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return werr
				}
				off += int64(n)
			}
			if err != nil && err != io.EOF {
				return err
			}
			if n == 0 {
				break
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

type pipeCloser struct {
	*io.PipeReader
	cancel context.CancelFunc
}

func (p *pipeCloser) Close() error {
	p.cancel()
	return p.PipeReader.Close()
}

// progressWriter counts, reports and stops at the end of ctx.
type progressWriter struct {
	ctx  context.Context
	w    io.Writer
	pos  int64
	fn   func(int64)
	werr error
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.w.Write(b)
	p.pos += int64(n)
	if err != nil {
		p.werr = err
		return n, err
	}
	if p.fn != nil {
		p.fn(p.pos)
	}
	return n, nil
}

type limitWriter struct {
	w io.Writer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if len(p) > l.n {
		return 0, fmt.Errorf("output too large")
	}
	l.n -= len(p)
	return l.w.Write(p)
}

var _ remote.SSH = (*Client)(nil)
var _ ssh.AlgorithmSigner = (*lockedSigner)(nil)
