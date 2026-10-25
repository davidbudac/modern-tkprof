package remote

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net"
	"strconv"
	"strings"
	"time"
)

// Target is where an SSH connection goes. Empty fields come from
// ~/.ssh/config (Host, HostName, User, Port) or the ssh defaults.
type Target struct {
	Host string
	Port int // 0 = config or 22
	User string
}

// ParseTarget reads "[user@]host[:port]" ("[::1]:2200" for IPv6 with a port).
func ParseTarget(spec string) (Target, error) {
	var t Target
	rest := spec
	if i := strings.LastIndexByte(rest, '@'); i >= 0 {
		t.User, rest = rest[:i], rest[i+1:]
	}
	host, port := rest, ""
	if strings.HasPrefix(rest, "[") {
		j := strings.IndexByte(rest, ']')
		if j < 0 {
			return t, fmt.Errorf("%q: unclosed [", spec)
		}
		host, rest = rest[1:j], rest[j+1:]
		if rest != "" {
			if rest[0] != ':' {
				return t, fmt.Errorf("%q: want [host]:port", spec)
			}
			port = rest[1:]
		}
	} else if strings.Count(rest, ":") == 1 {
		host, port, _ = strings.Cut(rest, ":")
	}
	if port != "" {
		p, err := strconv.Atoi(port)
		if err != nil || p <= 0 || p > 65535 {
			return t, fmt.Errorf("%q: bad port %q", spec, port)
		}
		t.Port = p
	}
	t.Host = host
	if err := t.Check(); err != nil {
		return t, fmt.Errorf("%q: %v", spec, err)
	}
	return t, nil
}

// Check rejects a target that could be read as an option or would break a
// command line.
func (t Target) Check() error {
	if t.Host == "" {
		return fmt.Errorf("no host")
	}
	for _, s := range []string{t.Host, t.User} {
		if strings.HasPrefix(s, "-") || strings.ContainsAny(s, " \t\r\n'\"\\@/") {
			return fmt.Errorf("bad host or user %q", s)
		}
	}
	if t.Port < 0 || t.Port > 65535 {
		return fmt.Errorf("bad port %d", t.Port)
	}
	return nil
}

// String is "user@host:port" (the parts that are set).
func (t Target) String() string {
	s := t.Host
	if t.Port > 0 {
		s = net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	}
	if t.User != "" {
		s = t.User + "@" + s
	}
	return s
}

// Entry is one file of a remote directory listing.
type Entry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`    // as ls -l prints it: -rw-r-----, drwxr-x---, lrwxrwxrwx
	ModTime time.Time `json:"modTime"` // minute precision from sftp ls -l (day precision for older files)
	Dir     bool      `json:"dir"`
	Link    bool      `json:"link"` // a symbolic link (not followed)
}

// FetchOptions are the options of SSH.Fetch.
type FetchOptions struct {
	From     int64           // first byte to read (the local partial file's size when resuming)
	NoGzip   bool            // sshcli: do not compress on the host even when it has gzip
	Progress func(pos int64) // the absolute offset reached (From + bytes written); may be nil
}

// SSH is a connection to a host over SSH: the system binaries
// (internal/remote/sshcli) or the Go library (internal/remote/sshlib);
// internal/remote/sshconn chooses. Credentials are asked through the
// Prompter the implementation was made with.
type SSH interface {
	// Transport is "cli" or "lib".
	Transport() string
	// Test connects and returns the host's `uname -sr` (and the server
	// version where the transport knows it).
	Test(ctx context.Context) (string, error)
	// Ls lists a directory (or the one file path names).
	Ls(ctx context.Context, path string) ([]Entry, error)
	// Diag returns candidate trace directories of the host
	// ($ORACLE_BASE/diag/rdbms/*/*/trace and the ones derived from oratab).
	Diag(ctx context.Context) ([]string, error)
	// Fetch writes the remote file from byte o.From on to w.
	Fetch(ctx context.Context, path string, w io.Writer, o FetchOptions) error
	// Follow streams the remote file from byte from on and keeps reading
	// what is appended (tail -f) until ctx ends or the reader is closed.
	Follow(ctx context.Context, path string, from int64) (io.ReadCloser, error)
	// Close drops the connection and every credential held for it.
	Close() error
}

// ShQuote quotes s for a POSIX shell: in single quotes, each embedded quote
// closed, escaped and reopened as quote-backslash-quote-quote.
func ShQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ShCommand is the remote command line running script with sh -c: every
// remote command goes through sh so a csh or other login shell does not
// change its meaning. The script must be one line (csh rejects a newline
// inside quotes).
func ShCommand(script string) string { return "sh -c " + ShQuote(script) }

// DiagScript prints candidate trace directories, one per line (duplicates
// possible): $ORACLE_BASE/diag/rdbms/*/*/trace, then for every home in
// /etc/oratab (/var/opt/oracle/oratab on Solaris) the trace directories
// under its ORACLE_BASE ($ORACLE_HOME/bin/orabase, else the home up to
// /product/), then /u01/app/oracle/diag/rdbms/*/*/trace. Bourne-shell
// syntax only (backquotes, no $(...), no `command`): Solaris 10's /bin/sh.
const DiagScript = `for d in "$ORACLE_BASE"/diag/rdbms/*/*/trace; do [ -d "$d" ] && echo "$d"; done; ` +
	`for t in /etc/oratab /var/opt/oracle/oratab; do [ -r "$t" ] || continue; ` +
	"for h in `sed -n 's/^[^#:][^:]*:\\([^:]*\\).*$/\\1/p' \"$t\"`; do " +
	"b=`ORACLE_HOME=\"$h\" \"$h\"/bin/orabase 2>/dev/null`; [ -n \"$b\" ] || b=`echo \"$h\" | sed 's#/product/.*##'`; " +
	`for d in "$b"/diag/rdbms/*/*/trace; do [ -d "$d" ] && echo "$d"; done; done; done; ` +
	`ls -d /u01/app/oracle/diag/rdbms/*/*/trace 2>/dev/null; exit 0`

// ParseDiag returns the directories DiagScript printed, without duplicates,
// in the order first seen.
func ParseDiag(out string) []string {
	seen := map[string]bool{}
	dirs := []string{}
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimRight(l, "\r")
		if !strings.HasPrefix(l, "/") || !strings.HasSuffix(l, "/trace") || seen[l] {
			continue
		}
		seen[l] = true
		dirs = append(dirs, l)
	}
	return dirs
}

// ModeString formats a file mode as ls -l does (-rw-r--r--, drwxr-xr-x,
// lrwxrwxrwx; setuid/setgid/sticky as s/S, t/T).
func ModeString(m fs.FileMode) string {
	b := []byte("----------")
	switch {
	case m&fs.ModeDir != 0:
		b[0] = 'd'
	case m&fs.ModeSymlink != 0:
		b[0] = 'l'
	case m&fs.ModeNamedPipe != 0:
		b[0] = 'p'
	case m&fs.ModeSocket != 0:
		b[0] = 's'
	case m&fs.ModeCharDevice != 0:
		b[0] = 'c'
	case m&fs.ModeDevice != 0:
		b[0] = 'b'
	}
	const rwx = "rwxrwxrwx"
	for i := 0; i < 9; i++ {
		if m&(1<<uint(8-i)) != 0 {
			b[1+i] = rwx[i]
		}
	}
	special := func(i int, on bool, set, unset byte) {
		if !on {
			return
		}
		if b[i] == 'x' {
			b[i] = set
		} else {
			b[i] = unset
		}
	}
	special(3, m&fs.ModeSetuid != 0, 's', 'S')
	special(6, m&fs.ModeSetgid != 0, 's', 'S')
	special(9, m&fs.ModeSticky != 0, 't', 'T')
	return string(b)
}
