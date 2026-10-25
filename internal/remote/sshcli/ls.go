package sshcli

import (
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// ParseLs reads the output of `sftp -b -` running `ls -ln dir`. OpenSSH's
// client formats each line itself (sftp-common.c ls_file), whatever the
// server's OS:
//
//	-rw-r-----    1 54321    54321      123456 Oct 25 09:11 /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_123.trc
//	-rw-r-----    ? 1000     1000       123456 Oct 25 09:11 /tmp/a.trc         (9.x: link count unknown)
//	-rw-r--r--    ? 1000     1000            1 Mar  5  2023 /tmp/with space.trc (older than 6 months: year)
//
// mode, links, uid, gid, size, date (`%b %e %H:%M`, or `%b %e  %Y` outside
// the last 6 months, client's local time, C-locale month), then the name,
// which may hold spaces: the path as sftp resolved it (absolute for an
// absolute argument, else relative to the login directory). The "sftp> cmd"
// echo lines are skipped. now places dates without a year (the most recent
// such date not after now+1d).
func ParseLs(out string, now time.Time) ([]remote.Entry, error) {
	entries := []remote.Entry{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "sftp> ") {
			continue
		}
		e, err := parseLsLine(line, now)
		if err != nil {
			return nil, err
		}
		e.Path, e.Name = e.Name, path.Base(e.Name)
		if e.Name == "." || e.Name == ".." {
			continue
		}
		entries = append(entries, e)
	}
	return entries, nil
}

func parseLsLine(line string, now time.Time) (remote.Entry, error) {
	var e remote.Entry
	bad := func(why string) (remote.Entry, error) {
		return e, fmt.Errorf("sftp ls: %s in %q", why, line)
	}
	// the first 8 whitespace-separated fields; the name is what follows the
	// single space after the 8th
	var f [8]string
	pos := 0
	for i := range f {
		for pos < len(line) && line[pos] == ' ' {
			pos++
		}
		start := pos
		for pos < len(line) && line[pos] != ' ' {
			pos++
		}
		if start == pos {
			return bad("short line")
		}
		f[i] = line[start:pos]
	}
	if pos+1 >= len(line) {
		return bad("no name")
	}
	e.Name = line[pos+1:]
	mode := f[0]
	if len(mode) < 10 || !strings.ContainsRune("-dlpscbD", rune(mode[0])) {
		return bad("mode")
	}
	e.Mode = mode[:10]
	e.Dir, e.Link = mode[0] == 'd', mode[0] == 'l'
	size, err := strconv.ParseInt(f[4], 10, 64)
	if err != nil || size < 0 {
		return bad("size")
	}
	e.Size = size
	mon, err := time.Parse("Jan", f[5])
	if err != nil {
		return bad("month")
	}
	day, err := strconv.Atoi(f[6])
	if err != nil || day < 1 || day > 31 {
		return bad("day")
	}
	if hh, mm, ok := strings.Cut(f[7], ":"); ok {
		h, err1 := strconv.Atoi(hh)
		m, err2 := strconv.Atoi(mm)
		if err1 != nil || err2 != nil {
			return bad("time")
		}
		t := time.Date(now.Year(), mon.Month(), day, h, m, 0, 0, now.Location())
		if t.After(now.Add(24 * time.Hour)) {
			t = t.AddDate(-1, 0, 0)
		}
		e.ModTime = t
	} else {
		y, err := strconv.Atoi(f[7])
		if err != nil {
			return bad("year")
		}
		e.ModTime = time.Date(y, mon.Month(), day, 0, 0, 0, 0, now.Location())
	}
	return e, nil
}
