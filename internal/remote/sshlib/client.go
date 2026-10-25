// Package sshlib reaches a host with golang.org/x/crypto/ssh and
// github.com/pkg/sftp: the fallback when there is no ssh binary, when the
// connection forces transport=lib, or when Windows' ssh.exe ignores
// SSH_ASKPASS (docs/PLAN-DESKTOP.md § 6, docs/REMOTE.md).
//
// Authentication, in order: the agent (SSH_AUTH_SOCK; on Windows the
// OpenSSH agent's pipe \\.\pipe\openssh-ssh-agent), the identity files
// (~/.ssh/config IdentityFile, else id_ed25519, id_ecdsa, id_rsa; a
// passphrase is asked only when the server accepts the key), password, then
// keyboard-interactive. Host keys are checked against ~/.ssh/known_hosts;
// an unknown key is a hostkey prompt with its SHA256 fingerprint and is
// appended only when the user says yes; a changed key is refused. Every
// question goes through the remote.Prompter; passwords and passphrases are
// kept in memory for the client's life (Close forgets them).
package sshlib

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Options configure a Client.
type Options struct {
	Target   remote.Target
	Prompter remote.Prompter
	Conn     string // the connection id prompts carry
	// Home is where .ssh/config, the keys and known_hosts are ("" = the user's home).
	Home string
	// ConfigFile is the ssh config ("" = <home>/.ssh/config, "none" = none).
	ConfigFile string
	// KnownHosts is the known_hosts file read and appended to ("" = <home>/.ssh/known_hosts).
	KnownHosts string
	// IdentityFiles are tried before the config's (or the default) keys.
	IdentityFiles []string
	NoAgent       bool
	Timeout       time.Duration // TCP connect (0 = 15 s)
	PollInterval  time.Duration // Follow's size poll (0 = 500 ms)
}

// Client is an SSH + SFTP connection, dialled on first use and redialled
// when it drops. Safe for concurrent use.
type Client struct {
	o Options

	mu    sync.Mutex
	sc    *ssh.Client
	sf    *sftp.Client
	dead  chan struct{} // closed when sc's connection ends
	creds map[string]string
}

// New returns a client; nothing is dialled yet.
func New(o Options) *Client { return &Client{o: o, creds: map[string]string{}} }

// Transport implements remote.SSH.
func (c *Client) Transport() string { return "lib" }

// ErrHostKeyRejected: the user did not accept an unknown host key.
var ErrHostKeyRejected = errors.New("host key not accepted")

func (c *Client) home() string {
	if c.o.Home != "" {
		return c.o.Home
	}
	h, _ := os.UserHomeDir()
	return h
}

func (c *Client) knownHostsPath() string {
	if c.o.KnownHosts != "" {
		return c.o.KnownHosts
	}
	return filepath.Join(c.home(), ".ssh", "known_hosts")
}

func localUser() string {
	for _, k := range []string{"USER", "USERNAME", "LOGNAME"} {
		if u := os.Getenv(k); u != "" {
			return u
		}
	}
	if u, err := user.Current(); err == nil {
		_, name, _ := strings.Cut(u.Username, `\`) // DOMAIN\user on Windows
		if name != "" {
			return name
		}
		return u.Username
	}
	return ""
}

// endpoint resolves the target through ~/.ssh/config.
type endpoint struct {
	host, user string
	port       int
	keys       []string
}

func (c *Client) endpoint() (endpoint, error) {
	t := c.o.Target
	if err := t.Check(); err != nil {
		return endpoint{}, err
	}
	home := c.home()
	cfgFile := c.o.ConfigFile
	switch cfgFile {
	case "":
		cfgFile = filepath.Join(home, ".ssh", "config")
	case "none":
		cfgFile = ""
	}
	cfg := loadConfig(cfgFile, t.Host)
	e := endpoint{host: t.Host, user: t.User, port: t.Port}
	if cfg.HostName != "" {
		e.host = strings.ReplaceAll(cfg.HostName, "%h", t.Host)
	}
	if e.user == "" {
		e.user = cfg.User
	}
	if e.user == "" {
		e.user = localUser()
	}
	if e.port == 0 {
		e.port = cfg.Port
	}
	if e.port == 0 {
		e.port = 22
	}
	e.keys = append(e.keys, c.o.IdentityFiles...)
	files := cfg.IdentityFile
	if len(files) == 0 {
		files = []string{"~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"}
	}
	for _, f := range files {
		if strings.EqualFold(f, "none") {
			continue
		}
		e.keys = append(e.keys, expand(f, home, localUser(), e.host, e.user, e.port))
	}
	return e, nil
}

func (c *Client) ask(ctx context.Context, p remote.Prompt) (string, error) {
	if c.o.Prompter == nil {
		return "", errors.New("no prompter to ask: " + p.Text)
	}
	p.Connection = c.o.Conn
	return c.o.Prompter.Ask(ctx, p)
}

// connect returns the live connection, dialling it if needed.
func (c *Client) connect(ctx context.Context) (*ssh.Client, *sftp.Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sc != nil {
		select {
		case <-c.dead:
			c.sf.Close()
			c.sc.Close()
			c.sc, c.sf = nil, nil
		default:
			return c.sc, c.sf, nil
		}
	}
	e, err := c.endpoint()
	if err != nil {
		return nil, nil, err
	}
	addr := net.JoinHostPort(e.host, strconv.Itoa(e.port))
	used := map[string]bool{} // cached answers offered in this dial
	var methods []ssh.AuthMethod
	signers, closeAgent := c.signers(ctx, e)
	defer closeAgent()
	if len(signers) > 0 {
		methods = append(methods, ssh.PublicKeys(signers...))
	}
	pwKey := "password\x00" + e.user + "@" + e.host
	password := func() (string, error) {
		if a, ok := c.creds[pwKey]; ok && !used[pwKey] {
			used[pwKey] = true
			return a, nil
		}
		used[pwKey] = true
		a, err := c.ask(ctx, remote.Prompt{Kind: remote.KindPassword, Text: e.user + "@" + e.host + "'s password: "})
		if err == nil {
			c.creds[pwKey] = a
		}
		return a, err
	}
	methods = append(methods, ssh.RetryableAuthMethod(ssh.PasswordCallback(password), 3))
	methods = append(methods, ssh.RetryableAuthMethod(ssh.KeyboardInteractive(
		func(name, instruction string, questions []string, echos []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i, q := range questions {
				kind, _ := remote.ClassifyPrompt(q)
				if kind == remote.KindPassword {
					a, err := password()
					if err != nil {
						return nil, err
					}
					answers[i] = a
					continue
				}
				if kind != remote.KindPassphrase {
					kind = remote.KindOTP // free text: one-time codes and anything else the server asks
				}
				text := q
				if instruction = strings.TrimSpace(instruction); instruction != "" {
					text = instruction + "\n" + q
				}
				a, err := c.ask(ctx, remote.Prompt{Kind: kind, Text: text, Echo: i < len(echos) && echos[i]})
				if err != nil {
					return nil, err
				}
				answers[i] = a
			}
			return answers, nil
		}), 3))
	timeout := c.o.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	cfg := &ssh.ClientConfig{User: e.user, Auth: methods, HostKeyCallback: c.hostKeyCallback(ctx),
		HostKeyAlgorithms: c.knownAlgorithms(addr), Timeout: timeout}
	d := net.Dialer{Timeout: timeout}
	nc, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, nil, err
	}
	stop := context.AfterFunc(ctx, func() { nc.Close() }) // a prompt may be waiting
	conn, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
	stop()
	if err != nil {
		nc.Close()
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			delete(c.creds, pwKey) // a cached password that no longer works
		}
		return nil, nil, fmt.Errorf("ssh %s: %w", addr, err)
	}
	sc := ssh.NewClient(conn, chans, reqs)
	sf, err := sftp.NewClient(sc)
	if err != nil {
		sc.Close()
		return nil, nil, fmt.Errorf("sftp %s: %w", addr, err)
	}
	dead := make(chan struct{})
	go func() {
		sc.Wait()
		close(dead)
	}()
	c.sc, c.sf, c.dead = sc, sf, dead
	return sc, sf, nil
}

// signers are the agent's keys, then the identity files (encrypted ones
// unlocked on first use).
func (c *Client) signers(ctx context.Context, e endpoint) ([]ssh.Signer, func()) {
	var out []ssh.Signer
	seen := map[string]bool{}
	closer := func() {}
	if !c.o.NoAgent {
		if conn, err := dialAgent(); err == nil {
			closer = func() { conn.Close() }
			if ss, err := agent.NewClient(conn).Signers(); err == nil {
				for _, s := range ss {
					seen[string(s.PublicKey().Marshal())] = true
					out = append(out, s)
				}
			}
		}
	}
	for _, path := range e.keys {
		pem, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		s, err := ssh.ParsePrivateKey(pem)
		var pm *ssh.PassphraseMissingError
		switch {
		case err == nil:
		case errors.As(err, &pm):
			pub := pm.PublicKey
			if pub == nil {
				if b, err := os.ReadFile(path + ".pub"); err == nil {
					pub, _, _, _, _ = ssh.ParseAuthorizedKey(b)
				}
			}
			if pub == nil {
				continue // no public half to offer before unlocking
			}
			s = &lockedSigner{c: c, ctx: ctx, path: path, pem: pem, pub: pub}
		default:
			continue
		}
		if k := string(s.PublicKey().Marshal()); !seen[k] {
			seen[k] = true
			out = append(out, s)
		}
	}
	return out, closer
}

// lockedSigner is a passphrase-protected key: the server is offered its
// public key, and the passphrase is asked only when it accepts it.
type lockedSigner struct {
	c    *Client
	ctx  context.Context
	path string
	pem  []byte
	pub  ssh.PublicKey
	s    ssh.Signer
}

func (l *lockedSigner) PublicKey() ssh.PublicKey { return l.pub }

func (l *lockedSigner) unlock() (ssh.Signer, error) {
	if l.s != nil {
		return l.s, nil
	}
	key := "passphrase\x00" + l.path
	if pp, ok := l.c.creds[key]; ok {
		if s, err := ssh.ParsePrivateKeyWithPassphrase(l.pem, []byte(pp)); err == nil {
			l.s = s
			return s, nil
		}
		delete(l.c.creds, key)
	}
	for try := 0; try < 3; try++ {
		pp, err := l.c.ask(l.ctx, remote.Prompt{Kind: remote.KindPassphrase, Text: "Enter passphrase for key '" + l.path + "': "})
		if err != nil {
			return nil, err
		}
		s, err := ssh.ParsePrivateKeyWithPassphrase(l.pem, []byte(pp))
		if err == nil {
			l.c.creds[key] = pp
			l.s = s
			return s, nil
		}
	}
	return nil, fmt.Errorf("%s: wrong passphrase", l.path)
}

func (l *lockedSigner) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	s, err := l.unlock()
	if err != nil {
		return nil, err
	}
	return s.Sign(rand, data)
}

func (l *lockedSigner) SignWithAlgorithm(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	s, err := l.unlock()
	if err != nil {
		return nil, err
	}
	if as, ok := s.(ssh.AlgorithmSigner); ok {
		return as.SignWithAlgorithm(rand, data, algorithm)
	}
	return s.Sign(rand, data)
}

// hostKeyCallback checks known_hosts and asks about unknown keys.
func (c *Client) hostKeyCallback(ctx context.Context) ssh.HostKeyCallback {
	return func(hostname string, remoteAddr net.Addr, key ssh.PublicKey) error {
		kh := c.knownHostsPath()
		if _, err := os.Stat(kh); err == nil {
			cb, err := knownhosts.New(kh)
			if err != nil {
				return err
			}
			err = cb(hostname, remoteAddr, key)
			var ke *knownhosts.KeyError
			switch {
			case err == nil:
				return nil
			case !errors.As(err, &ke):
				return err // revoked
			case len(ke.Want) > 0:
				w := ke.Want[0]
				return fmt.Errorf("the host key of %s has changed (%s %s, %s:%d has %s %s): refusing to connect; remove the line if the change is expected",
					knownhosts.Normalize(hostname), key.Type(), ssh.FingerprintSHA256(key), w.Filename, w.Line, w.Key.Type(), ssh.FingerprintSHA256(w.Key))
			}
		}
		fp := ssh.FingerprintSHA256(key)
		host := knownhosts.Normalize(hostname)
		p := remote.Prompt{Kind: remote.KindHostKey, Echo: true, Fingerprint: fp,
			Text: fmt.Sprintf("The authenticity of host '%s (%s)' can't be established.\n%s key fingerprint is %s.\nAre you sure you want to continue connecting (yes/no)? ",
				host, remoteAddr, keyName(key.Type()), fp)}
		ans, err := c.ask(ctx, p)
		if err != nil {
			return err
		}
		if !remote.Yes(ans, p) {
			return ErrHostKeyRejected
		}
		return appendKnownHost(kh, host, key)
	}
}

func keyName(t string) string {
	switch {
	case strings.Contains(t, "ed25519"):
		return "ED25519"
	case strings.Contains(t, "ecdsa"):
		return "ECDSA"
	case strings.Contains(t, "rsa"):
		return "RSA"
	}
	return strings.ToUpper(t)
}

// appendKnownHost adds "host key" to known_hosts (creating ~/.ssh 0700 and
// the file 0600 when missing).
func appendKnownHost(path, host string, key ssh.PublicKey) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	line := knownhosts.Line([]string{host}, key) + "\n"
	if fi, err := f.Stat(); err == nil && fi.Size() > 0 {
		// start on a new line if the file does not end with one
		if b := lastByte(path); b != '\n' {
			line = "\n" + line
		}
	}
	_, err = f.WriteString(line)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func lastByte(path string) byte {
	f, err := os.Open(path)
	if err != nil {
		return '\n'
	}
	defer f.Close()
	var b [1]byte
	if fi, err := f.Stat(); err == nil && fi.Size() > 0 {
		f.ReadAt(b[:], fi.Size()-1)
		return b[0]
	}
	return '\n'
}

// probeKey is a key no known_hosts holds; checking it lists the known keys of a host.
var probeKey = func() ssh.PublicKey {
	k, _ := ssh.NewPublicKey(ed25519.PublicKey(make([]byte, ed25519.PublicKeySize)))
	return k
}()

// knownAlgorithms are the host key algorithms of the keys known_hosts has
// for addr, so the server is asked for one of those (nil: unknown host, any).
func (c *Client) knownAlgorithms(addr string) []string {
	kh := c.knownHostsPath()
	cb, err := knownhosts.New(kh)
	if err != nil {
		return nil
	}
	err = cb(addr, &net.TCPAddr{IP: net.IPv4zero, Port: 22}, probeKey)
	var ke *knownhosts.KeyError
	if !errors.As(err, &ke) || len(ke.Want) == 0 {
		return nil
	}
	var algos []string
	add := func(a ...string) {
		for _, x := range a {
			if !contains(algos, x) {
				algos = append(algos, x)
			}
		}
	}
	for _, w := range ke.Want {
		switch t := w.Key.Type(); t {
		case ssh.KeyAlgoRSA:
			add(ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA)
		default:
			add(t)
		}
	}
	return algos
}

func contains(s []string, x string) bool {
	for _, y := range s {
		if y == x {
			return true
		}
	}
	return false
}

// Close implements remote.SSH: drops the connection and forgets the credentials.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sf != nil {
		c.sf.Close()
	}
	if c.sc != nil {
		c.sc.Close()
	}
	c.sc, c.sf = nil, nil
	clear(c.creds)
	return nil
}
