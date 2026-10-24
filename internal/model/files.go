package model

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// plannedFile is one file of the trace set, in parse order.
type plannedFile struct {
	path     string
	chain    int  // files of one continuation chain share the number
	cont     bool // continues the previous file (same process, state is kept)
	followed bool // found by following a chain marker, not named by the user
}

// ExpandInputs turns the paths given on the command line into files: a
// directory contributes all its *.trc files (not recursive, sorted by name).
func ExpandInputs(paths []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		key := p
		if abs, err := filepath.Abs(p); err == nil {
			key = abs
		}
		if !seen[key] {
			seen[key] = true
			out = append(out, p)
		}
	}
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if !fi.IsDir() {
			add(p)
			continue
		}
		ents, err := os.ReadDir(p)
		if err != nil {
			return nil, err
		}
		var names []string
		for _, e := range ents {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".trc") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		if len(names) == 0 {
			return nil, fmt.Errorf("%s: no *.trc files", p)
		}
		for _, n := range names {
			add(filepath.Join(p, n))
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no trace files given")
	}
	return out, nil
}

// probeChain reads the chain markers of a file without parsing it:
// "*** TRACE CONTINUED FROM FILE x ***" near the start and
// "*** TRACE CONTINUES IN FILE x ***" at the end.
func probeChain(path string) (from, to string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", "", err
	}
	const window = 64 << 10
	head := make([]byte, window)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", "", err
	}
	from = lastMarker(head[:n], "CONTINUED FROM FILE ")
	if fi.Size() <= window {
		return from, lastMarker(head[:n], "CONTINUES IN FILE "), nil
	}
	tail := make([]byte, window)
	n, err = f.ReadAt(tail, fi.Size()-window)
	if err != nil && err != io.EOF {
		return "", "", err
	}
	return from, lastMarker(tail[:n], "CONTINUES IN FILE "), nil
}

// lastMarker returns the file name of the last "*** ... <key><name> ***" line.
func lastMarker(b []byte, key string) string {
	val := ""
	for len(b) > 0 {
		line := b
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			line, b = b[:i], b[i+1:]
		} else {
			b = nil
		}
		if !bytes.HasPrefix(line, []byte("*** ")) {
			continue
		}
		if i := bytes.Index(line, []byte(key)); i >= 0 {
			v := strings.TrimSpace(string(line[i+len(key):]))
			v = strings.TrimSpace(strings.TrimSuffix(v, "***"))
			if v != "" {
				val = v
			}
		}
	}
	return val
}

// headerName returns the base name in the file's own "Trace file <path>"
// header line (the name Oracle gave it, which chain markers refer to even
// after the file was renamed or copied), or "".
func headerName(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 1024)
	n, _ := f.Read(buf)
	line := buf[:n]
	if i := bytes.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	const key = "Trace file "
	if !bytes.HasPrefix(line, []byte(key)) {
		return ""
	}
	return baseName(strings.TrimSpace(string(line[len(key):])))
}

// maxSiblingScan bounds how many neighbouring files are opened to find a
// chain member by its header name.
const maxSiblingScan = 2000

// baseName is filepath.Base that also splits Windows separators, since a
// trace written on a Windows server may be analysed on Linux.
func baseName(p string) string {
	return filepath.Base(strings.ReplaceAll(p, `\`, "/"))
}

// planFiles expands the inputs, follows continuation chains and orders the
// files: every chain in order of its first member, independent files in input
// order.
func planFiles(paths []string, opts Options) ([]plannedFile, []string, error) {
	files, err := ExpandInputs(paths)
	if err != nil {
		return nil, nil, err
	}
	var notes []string
	keyOf := func(p string) string {
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
		return p
	}
	idx := map[string]int{} // abs path -> index in files
	for i, p := range files {
		idx[keyOf(p)] = i
	}
	followed := map[int]bool{}
	next, prev := map[int]int{}, map[int]int{}
	resolve := func(ref, dir string) (int, bool) {
		cands := []string{ref}
		if b := baseName(ref); b != "" {
			cands = append(cands, filepath.Join(dir, b))
		}
		for _, c := range cands {
			if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
				k := keyOf(c)
				if i, ok := idx[k]; ok {
					return i, true
				}
				files = append(files, c)
				idx[k] = len(files) - 1
				followed[len(files)-1] = true
				return len(files) - 1, true
			}
		}
		want := baseName(ref)
		for i, p := range files { // among the given inputs, by name
			if filepath.Base(p) == want {
				return i, true
			}
		}
		for i, p := range files { // ... or by the name in the file's own header
			if headerName(p) == want {
				return i, true
			}
		}
		// next to the current file, by header name (renamed or copied files)
		ents, _ := os.ReadDir(dir)
		if len(ents) > maxSiblingScan {
			return 0, false
		}
		for _, e := range ents {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".trc") {
				continue
			}
			c := filepath.Join(dir, e.Name())
			if _, known := idx[keyOf(c)]; known {
				continue
			}
			if headerName(c) == want {
				files = append(files, c)
				idx[keyOf(c)] = len(files) - 1
				followed[len(files)-1] = true
				return len(files) - 1, true
			}
		}
		return 0, false
	}
	if !opts.NoFollow {
		for i := 0; i < len(files); i++ { // files grows while following
			from, to, err := probeChain(files[i])
			if err != nil {
				return nil, nil, err
			}
			dir := filepath.Dir(files[i])
			if to != "" {
				if j, ok := resolve(to, dir); ok && j != i {
					if _, taken := prev[j]; !taken {
						next[i], prev[j] = j, i
					}
				} else if len(files) > 1 || len(paths) > 1 {
					notes = append(notes, fmt.Sprintf("%s continues in %s, which was not found", filepath.Base(files[i]), baseName(to)))
				}
			}
			if from != "" {
				if j, ok := resolve(from, dir); ok && j != i {
					if _, taken := next[j]; !taken {
						next[j], prev[i] = i, j
					}
				} else if len(files) > 1 || len(paths) > 1 {
					notes = append(notes, fmt.Sprintf("%s continues %s, which was not found", filepath.Base(files[i]), baseName(from)))
				}
			}
		}
	}
	var out []plannedFile
	done := make([]bool, len(files))
	chain := 0
	emit := func(start int) {
		first := true
		for i := start; !done[i]; {
			done[i] = true
			out = append(out, plannedFile{path: files[i], chain: chain, cont: !first, followed: followed[i]})
			first = false
			n, ok := next[i]
			if !ok {
				break
			}
			i = n
		}
		chain++
	}
	for i := range files { // heads first, in input order
		if _, hasPrev := prev[i]; !hasPrev && !done[i] {
			emit(i)
		}
	}
	for i := range files { // chains without a head (a cycle)
		if !done[i] {
			emit(i)
		}
	}
	return out, notes, nil
}

// BuildFiles parses a set of trace files into one Model. Directories
// contribute their *.trc files. Files linked by "TRACE CONTINUES IN FILE" /
// "TRACE CONTINUED FROM FILE" markers (looked up by the path in the marker,
// then by name next to the file, then among the inputs) form a chain that is
// parsed as one stream in order, so cursors opened before the split keep their
// statement; unless Options.NoFollow is set. Independent files become
// separate session contexts (Context.FileIdx, File.Files). PX slave traces are
// attached to their query coordinator (see attachPX). For a single file with
// no chain the result is identical to a plain single-file parse.
func BuildFiles(paths []string, opts Options) (*Model, error) {
	plan, notes, err := planFiles(paths, opts)
	if err != nil {
		return nil, err
	}
	b := NewBuilder(plan[0].path, opts)
	b.multi = len(plan) > 1
	b.m.File.Files[0].Chain = plan[0].chain
	b.m.File.Files[0].Followed = plan[0].followed
	var total trace.Stats
	for i, pf := range plan {
		if i > 0 {
			b.NextFile(pf.path, pf.cont)
			fe := &b.m.File.Files[i]
			fe.Chain, fe.Followed = pf.chain, pf.followed
		}
		st, err := trace.ParseFile(pf.path, b)
		if err != nil {
			return nil, err
		}
		b.EndFile(st)
		total.Add(st)
	}
	m := b.Finish(total)
	for i, pf := range plan {
		if pf.followed {
			m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("%s was not named but is part of the chain; followed", filepath.Base(plan[i].path)))
		}
	}
	m.Diag.Notes = append(m.Diag.Notes, notes...)
	return m, nil
}

var (
	pxImageRe = regexp.MustCompile(`\((P[0-9A-Z]{3}|PZ[0-9]{2})\)`)
	pxNameRe  = regexp.MustCompile(`_(p[0-9]{3}|pz[0-9]{2})_`)
)

// isPXImage: the header line "Unix process pid: 8505, image: oracle@host (P000)".
func isPXImage(v string) bool { return pxImageRe.MatchString(v) }

// isPXName: a trace file name like cdb1_p000_8505.trc.
func isPXName(v string) bool { return pxNameRe.MatchString(filepath.Base(v)) }

func leadingDigits(v string) string {
	v = strings.TrimSpace(v)
	i := 0
	for i < len(v) && v[i] >= '0' && v[i] <= '9' {
		i++
	}
	return v[:i]
}
