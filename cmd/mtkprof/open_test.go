package main

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDesktopCommand(t *testing.T) {
	noPath := func(string) (string, error) { return "", errors.New("not found") }
	onPath := func(string) (string, error) { return "/usr/bin/mtkprof-desktop", nil }
	env := func(k string) string { return map[string]string{"LOCALAPPDATA": `C:\Users\u\AppData\Local`}[k] }
	installed := filepath.Join(`C:\Users\u\AppData\Local`, "mtkprof", "mtkprof-desktop.exe")
	has := func(p string) bool { return p == installed }
	none := func(string) bool { return false }
	paths := []string{"/t/a.trc", "/t/b.trc"}

	cases := []struct {
		goos, app string
		look      func(string) (string, error)
		exists    func(string) bool
		name      string
		args      []string
		err       bool
	}{
		{"darwin", "", noPath, none, "open", []string{"-a", "mtkprof", "/t/a.trc", "/t/b.trc"}, false},
		{"darwin", "/Applications/x.app", noPath, none, "open", []string{"-a", "/Applications/x.app", "/t/a.trc", "/t/b.trc"}, false},
		{"linux", "", onPath, none, "/usr/bin/mtkprof-desktop", paths, false},
		{"linux", "/opt/m.AppImage", noPath, none, "/opt/m.AppImage", paths, false},
		{"linux", "", noPath, none, "", nil, true},
		{"windows", "", noPath, has, installed, paths, false},
		{"windows", "", noPath, none, "", nil, true},
		{"aix", "", onPath, none, "", nil, true},
	}
	for _, c := range cases {
		name, args, err := desktopCommand(c.goos, c.app, paths, c.look, env, c.exists)
		if (err != nil) != c.err || name != c.name || (!c.err && !reflect.DeepEqual(args, c.args)) {
			t.Errorf("%s %q: got %q %q %v, want %q %q err=%v", c.goos, c.app, name, args, err, c.name, c.args, c.err)
		}
	}
}
