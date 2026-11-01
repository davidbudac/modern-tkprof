package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// envDesktop names the desktop app's executable (Windows, Linux; on macOS
// the .app bundle or its name), when it is not where `open` looks.
const envDesktop = "MTKPROF_DESKTOP"

// cmdOpen is `mtkprof open <trace...>`: hands the files and directories to
// the desktop app as one trace set (one tab), starting the app if it is not
// running. A running app gets them through its single-instance hand-over
// (Windows, Linux) or as an open-documents event (macOS `open -a`).
func cmdOpen(args []string) error {
	fs := flag.NewFlagSet("open", flag.ExitOnError)
	app := fs.String("app", "", "the desktop app: macOS the .app (or its name), else the mtkprof-desktop executable (default $"+envDesktop+", then the install locations and PATH)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	paths := make([]string, 0, fs.NArg())
	for _, p := range fs.Args() {
		abs, err := filepath.Abs(p)
		if err != nil {
			return err
		}
		if _, err := os.Stat(abs); err != nil {
			return err
		}
		paths = append(paths, abs)
	}
	if *app == "" {
		*app = os.Getenv(envDesktop)
	}
	name, argv, err := desktopCommand(runtime.GOOS, *app, paths, exec.LookPath, os.Getenv, fileExists)
	if err != nil {
		return err
	}
	cmd := exec.Command(name, argv...)
	if runtime.GOOS == "darwin" {
		// `open` returns once the app has the documents; its errors are worth showing
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		return cmd.Run()
	}
	// the app (or its short-lived second instance) runs on after we exit
	return cmd.Start()
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// desktopCommand is the command that hands paths to the desktop app on goos.
// app is the -app flag or $MTKPROF_DESKTOP ("" = look for it).
func desktopCommand(goos, app string, paths []string, lookPath func(string) (string, error), getenv func(string) string, exists func(string) bool) (string, []string, error) {
	switch goos {
	case "darwin":
		if app == "" {
			app = "mtkprof"
		}
		return "open", append([]string{"-a", app}, paths...), nil
	case "windows", "linux":
		if app != "" {
			return app, paths, nil
		}
		var candidates []string
		if goos == "windows" {
			// the NSIS installer (per user), then a machine-wide install
			for _, env := range []string{"LOCALAPPDATA", "ProgramFiles"} {
				if dir := getenv(env); dir != "" {
					candidates = append(candidates, filepath.Join(dir, "mtkprof", "mtkprof-desktop.exe"))
				}
			}
		}
		for _, c := range candidates {
			if exists(c) {
				return c, paths, nil
			}
		}
		if p, err := lookPath("mtkprof-desktop"); err == nil {
			return p, paths, nil
		}
		return "", nil, fmt.Errorf("mtkprof desktop app not found (looked in %v and PATH); give its executable with -app or $%s", candidates, envDesktop)
	default:
		return "", nil, errors.New("the mtkprof desktop app runs on macOS, Windows and Linux only")
	}
}
