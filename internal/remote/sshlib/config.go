package sshlib

import (
	"bufio"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// hostConfig is what the minimal ~/.ssh/config reader understands: Host
// blocks with HostName, User, Port and IdentityFile. Match blocks are
// skipped, Include is ignored; the first value of a keyword wins (as in
// ssh), IdentityFile accumulates.
type hostConfig struct {
	HostName     string
	User         string
	Port         int
	IdentityFile []string
}

// readConfig reads the settings that apply to alias from r.
func readConfig(r io.Reader, alias string) hostConfig {
	var c hostConfig
	active := true // before the first Host line
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		key, val := splitKV(line)
		switch strings.ToLower(key) {
		case "host":
			active = hostMatches(strings.Fields(val), alias)
			continue
		case "match":
			active = false
			continue
		}
		if !active || val == "" {
			continue
		}
		switch strings.ToLower(key) {
		case "hostname":
			if c.HostName == "" {
				c.HostName = val
			}
		case "user":
			if c.User == "" {
				c.User = val
			}
		case "port":
			if c.Port == 0 {
				c.Port, _ = strconv.Atoi(val)
			}
		case "identityfile":
			c.IdentityFile = append(c.IdentityFile, strings.Trim(val, `"`))
		}
	}
	return c
}

// splitKV splits "Key value", "Key=value" and "Key = value".
func splitKV(line string) (string, string) {
	i := strings.IndexAny(line, " \t=")
	if i < 0 {
		return line, ""
	}
	key, rest := line[:i], strings.TrimLeft(line[i:], " \t")
	rest = strings.TrimPrefix(rest, "=")
	return key, strings.TrimSpace(rest)
}

// hostMatches applies a Host line's patterns (*, ?, !negation) to alias.
func hostMatches(patterns []string, alias string) bool {
	match := false
	for _, p := range patterns {
		neg := strings.HasPrefix(p, "!")
		p = strings.TrimPrefix(p, "!")
		ok, _ := path.Match(strings.ToLower(p), strings.ToLower(alias))
		if ok && neg {
			return false
		}
		if ok {
			match = true
		}
	}
	return match
}

// expand resolves ~ and the tokens %d (home), %u (local user), %h (host),
// %r (remote user), %p (port) and %% in an IdentityFile.
func expand(p, home, localUser, host, user string, port int) string {
	if strings.HasPrefix(p, "~/") || p == "~" {
		p = home + p[1:]
	}
	p = strings.NewReplacer("%%", "%", "%d", home, "%u", localUser, "%h", host, "%r", user, "%p", strconv.Itoa(port)).Replace(p)
	if !filepath.IsAbs(p) {
		p = filepath.Join(home, ".ssh", p)
	}
	return p
}

// loadConfig reads file ("" = none) for alias.
func loadConfig(file, alias string) hostConfig {
	if file == "" {
		return hostConfig{}
	}
	f, err := os.Open(file)
	if err != nil {
		return hostConfig{}
	}
	defer f.Close()
	return readConfig(f, alias)
}
