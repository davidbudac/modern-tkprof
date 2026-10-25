package db

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// DefaultPort is the listener port when a spec names none.
const DefaultPort = 1521

// Spec says where to connect: Easy Connect host:port/service and the user.
// It never holds a password.
type Spec struct {
	ID      string // connection id, passed to the Prompter ("" for the CLI)
	User    string
	Host    string
	Port    int // 0 = DefaultPort
	Service string

	// TCPS only: accept any server certificate (go-ora "SSL Verify=false").
	// Without it the certificate must verify against the system roots and
	// match Host.
	TLSSkipVerify bool
	// PrefetchRows is go-ora's PREFETCH_ROWS (rows per round trip); 0 = 1000.
	PrefetchRows int
}

// ParseSpec reads user@host[:port]/service. host may be a bracketed IPv6
// address. A password (user/pw@..., user:pw@...) is rejected: passwords are
// prompted, never part of a spec.
func ParseSpec(s string) (Spec, error) {
	at := strings.LastIndexByte(s, '@')
	if at < 0 {
		return Spec{}, fmt.Errorf("db spec %q: want user@host[:port]/service", s)
	}
	user, rest := s[:at], s[at+1:]
	if strings.ContainsAny(user, "/:@") {
		return Spec{}, fmt.Errorf("db spec %q: looks like it contains a password; give user@host[:port]/service, the password is prompted", redactSpec(s))
	}
	if user == "" {
		return Spec{}, fmt.Errorf("db spec %q: no user", s)
	}
	slash := strings.IndexByte(rest, '/')
	if strings.HasPrefix(rest, "[") {
		if end := strings.IndexByte(rest, ']'); end >= 0 {
			if i := strings.IndexByte(rest[end:], '/'); i >= 0 {
				slash = end + i
			} else {
				slash = -1
			}
		}
	}
	if slash < 0 || slash == len(rest)-1 {
		return Spec{}, fmt.Errorf("db spec %q: no service (want user@host[:port]/service)", s)
	}
	hostport, service := rest[:slash], rest[slash+1:]
	if strings.ContainsAny(service, " /?") {
		return Spec{}, fmt.Errorf("db spec %q: bad service name %q", s, service)
	}
	sp := Spec{User: user, Service: service, Port: DefaultPort}
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		// no port
		host = strings.TrimSuffix(strings.TrimPrefix(hostport, "["), "]")
		if strings.ContainsAny(host, "[]") || (strings.Contains(host, ":") && !strings.HasPrefix(hostport, "[")) {
			return Spec{}, fmt.Errorf("db spec %q: bad host %q", s, hostport)
		}
	} else {
		n, err := strconv.Atoi(port)
		if err != nil || n <= 0 || n > 65535 {
			return Spec{}, fmt.Errorf("db spec %q: bad port %q", s, port)
		}
		sp.Port = n
	}
	if host == "" {
		return Spec{}, fmt.Errorf("db spec %q: no host", s)
	}
	sp.Host = host
	return sp, nil
}

// redactSpec hides what looks like a password in an error message.
func redactSpec(s string) string {
	at := strings.LastIndexByte(s, '@')
	if at < 0 {
		return s
	}
	user := s[:at]
	if i := strings.IndexAny(user, "/:"); i >= 0 {
		user = user[:i] + "/***"
	}
	return user + s[at:]
}

// String is user@host:port/service.
func (s Spec) String() string {
	return s.User + "@" + net.JoinHostPort(s.Host, strconv.Itoa(s.port())) + "/" + s.Service
}

func (s Spec) port() int {
	if s.Port == 0 {
		return DefaultPort
	}
	return s.Port
}
