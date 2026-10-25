package sshcli

import (
	"testing"
	"time"
)

// realSample is OpenSSH 9.6's sftp -b output for `ls -ln dir` against
// pkg/sftp's server (link counts unknown: "?").
const realSample = `sftp> ls -ln /tmp/TestZZSample268708101/001
-rw-r-----    ? 1000     1000       123456 Oct 25 09:11 /tmp/TestZZSample268708101/001/a.trc
-rw-r--r--    ? 1000     1000           99 Oct 25 09:11 /tmp/TestZZSample268708101/001/kh
lrwxrwxrwx    ? 1000     1000            5 Oct 25 09:11 /tmp/TestZZSample268708101/001/link.trc
-rw-r--r--    ? 1000     1000            2 Oct 25 09:11 /tmp/TestZZSample268708101/001/star*.trc
drwxr-xr-x    ? 1000     1000            6 Oct 25 09:11 /tmp/TestZZSample268708101/001/sub
-rw-r--r--    ? 1000     1000            1 Mar  5  2023 /tmp/TestZZSample268708101/001/with space.trc
`

// oldSample: OpenSSH 8.0 (link counts from the server), a relative
// directory, a single-digit day, a size wider than the column.
const oldSample = `sftp> ls -ln trace
-rw-r-----    1 54321    54321    12345678901 Jan  2 23:59 trace/cdb1_ora_4711.trc
drwxr-x---    2 54321    54321        4096 Dec 31  2024 trace/cdump
`

func TestParseLs(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	ents, err := ParseLs(realSample, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 6 {
		t.Fatalf("%d entries", len(ents))
	}
	type want struct {
		name, path, mode string
		size             int64
		dir, link        bool
		mod              time.Time
	}
	dir := "/tmp/TestZZSample268708101/001/"
	for i, w := range []want{
		{"a.trc", dir + "a.trc", "-rw-r-----", 123456, false, false, time.Date(2026, 10, 25, 9, 11, 0, 0, time.UTC)},
		{"kh", dir + "kh", "-rw-r--r--", 99, false, false, time.Date(2026, 10, 25, 9, 11, 0, 0, time.UTC)},
		{"link.trc", dir + "link.trc", "lrwxrwxrwx", 5, false, true, time.Date(2026, 10, 25, 9, 11, 0, 0, time.UTC)},
		{"star*.trc", dir + "star*.trc", "-rw-r--r--", 2, false, false, time.Date(2026, 10, 25, 9, 11, 0, 0, time.UTC)},
		{"sub", dir + "sub", "drwxr-xr-x", 6, true, false, time.Date(2026, 10, 25, 9, 11, 0, 0, time.UTC)},
		{"with space.trc", dir + "with space.trc", "-rw-r--r--", 1, false, false, time.Date(2023, 3, 5, 0, 0, 0, 0, time.UTC)},
	} {
		e := ents[i]
		if e.Name != w.name || e.Path != w.path || e.Mode != w.mode || e.Size != w.size || e.Dir != w.dir || e.Link != w.link || !e.ModTime.Equal(w.mod) {
			t.Errorf("entry %d: %+v, want %+v", i, e, w)
		}
	}

	ents, err = ParseLs(oldSample, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 2 || ents[0].Path != "trace/cdb1_ora_4711.trc" || ents[0].Size != 12345678901 ||
		!ents[0].ModTime.Equal(time.Date(2026, 1, 2, 23, 59, 0, 0, time.UTC)) || !ents[1].Dir ||
		!ents[1].ModTime.Equal(time.Date(2024, 12, 31, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("old sample: %+v", ents)
	}
	// a date in "the future" (beyond tomorrow) belongs to last year
	ents, _ = ParseLs("-rw-r--r--    1 0 0 1 Dec 24 10:00 /x\n", now)
	if len(ents) != 1 || ents[0].ModTime.Year() != 2025 {
		t.Errorf("year inference: %+v", ents)
	}
	if ents, err := ParseLs("sftp> ls -ln /empty\n", now); err != nil || len(ents) != 0 {
		t.Errorf("empty dir: %v %v", ents, err)
	}
	for _, bad := range []string{"total 12\n", "-rw-r--r-- 1 0 0 x Dec 24 10:00 /x\n", "-rw-r--r-- 1 0 0 1 Foo 24 10:00 /x\n", "-rw-r--r-- 1 0 0 1 Dec 24 10:00\n"} {
		if _, err := ParseLs(bad, now); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
