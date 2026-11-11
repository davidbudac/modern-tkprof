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
	const window = HeadWindow
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
	return HeaderName(buf[:n])
}

// HeaderName is headerName of the first bytes of a trace file.
func HeaderName(head []byte) string {
	line := head
	if i := bytes.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	const key = "Trace file "
	if !bytes.HasPrefix(line, []byte(key)) {
		return ""
	}
	return baseName(strings.TrimSpace(string(line[len(key):])))
}

// HeadWindow is how much of the start of a file is searched for its
// "TRACE CONTINUED FROM FILE" marker.
const HeadWindow = 64 << 10

// ContinuedFrom is the file named by the "*** TRACE CONTINUED FROM FILE x
// ***" marker in head (the first HeadWindow bytes of a trace file), ""
// without one.
func ContinuedFrom(head []byte) string { return lastMarker(head, "CONTINUED FROM FILE ") }

// HeadSettled reports whether head, the start of a file still being
// written, holds everything that can carry a TRACE CONTINUED FROM marker:
// Oracle writes the marker after the header block and the session lines
// ("*** ..."), before the first record. So: the marker, a complete line
// after the first blank one that is neither blank nor "*** ...", or
// HeadWindow bytes.
func HeadSettled(head []byte) bool {
	if len(head) >= HeadWindow || ContinuedFrom(head) != "" {
		return true
	}
	blank := false
	for {
		i := bytes.IndexByte(head, '\n')
		if i < 0 {
			return false
		}
		line := bytes.TrimSpace(head[:i])
		head = head[i+1:]
		switch {
		case len(line) == 0:
			blank = true
		case blank && !bytes.HasPrefix(line, []byte("***")):
			return true
		}
	}
}

// maxSiblingScan bounds how many neighbouring files are opened to find a
// chain member by its header name.
const maxSiblingScan = 2000

// FindContinuation finds the file a "TRACE CONTINUES IN FILE ref" (or
// "TRACE CONTINUED FROM FILE ref") marker of the file from names, as
// BuildFiles follows a chain: the path in the marker, a file of that name
// next to from, or a *.trc file next to from whose header names it (renamed
// or copied files); skip excludes files (the chain so far). "" when there is
// none (yet).
func FindContinuation(ref, from string, skip func(string) bool) string {
	dir := filepath.Dir(from)
	ok := func(c string) bool {
		fi, err := os.Stat(c)
		return err == nil && fi.Mode().IsRegular() && !skip(c)
	}
	want := baseName(ref)
	for _, c := range []string{ref, filepath.Join(dir, want)} {
		if ok(c) {
			if abs, err := filepath.Abs(c); err == nil {
				return abs
			}
			return c
		}
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) > maxSiblingScan {
		return ""
	}
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".trc") {
			continue
		}
		if c := filepath.Join(dir, e.Name()); headerName(c) == want && ok(c) {
			return c
		}
	}
	return ""
}

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
	files, notes := DropOptFiles(files)
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
					notes = append(notes, fmt.Sprintf("%s continues in %s: not found", filepath.Base(files[i]), baseName(to)))
				}
			}
			if from != "" {
				if j, ok := resolve(from, dir); ok && j != i {
					if _, taken := next[j]; !taken {
						next[j], prev[i] = i, j
					}
				} else if len(files) > 1 || len(paths) > 1 {
					notes = append(notes, fmt.Sprintf("%s continues %s: not found", filepath.Base(files[i]), baseName(from)))
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
	var prog *progress
	if opts.OnProgress != nil || opts.Ctx != nil {
		prog = &progress{ctx: opts.Ctx, fn: opts.OnProgress, stmts: func() int64 { return int64(len(b.m.Statements)) }}
	}
	var est rowEstimate
	for _, pf := range plan {
		est.add(sampleRows(pf.path))
	}
	b.Reserve(est.calls, est.waits, est.binds, est.bindSets)
	for i, pf := range plan {
		if i > 0 {
			b.NextFile(pf.path, pf.cont)
			fe := &b.m.File.Files[i]
			fe.Chain, fe.Followed = pf.chain, pf.followed
		}
		st, err := parseFile(pf.path, b, prog)
		if err != nil {
			return nil, err
		}
		b.EndFile(st)
		total.Add(st)
	}
	m := b.Finish(total)
	prog.done(total.Bytes, int64(total.Lines), int64(len(m.Statements)))
	m.noteFollowed()
	m.Diag.Notes = append(m.Diag.Notes, notes...)
	return m, nil
}

// noteFollowed notes the files pulled in by following a chain.
func (m *Model) noteFollowed() {
	for _, fe := range m.File.Files {
		if fe.Followed {
			m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("%s: not named, followed as part of the chain", filepath.Base(fe.Path)))
		}
	}
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

// rowEstimate is an expected number of fact rows.
type rowEstimate struct{ calls, waits, binds, bindSets int64 }

func (r *rowEstimate) add(o rowEstimate) {
	r.calls += o.calls
	r.waits += o.waits
	r.binds += o.binds
	r.bindSets += o.bindSets
}

// Sampling the rows of a file: files up to fullScanMax are counted whole, bigger
// ones from sampleN windows of sampleSize bytes spread over the file, scaled to
// the file size with a safety margin. A trace is far from uniform (setup at
// the start, one loop that dominates), so the margin is generous: too much
// capacity is virtual memory nobody touches, too little is a regrow of the
// whole table.
const (
	fullScanMax = 8 << 20
	sampleN     = 8
	sampleSize  = 1 << 20
	sampleSlack = 1.25
)

func sampleRows(path string) rowEstimate {
	f, err := os.Open(path)
	if err != nil {
		return rowEstimate{}
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() < 1<<20 {
		return rowEstimate{}
	}
	size := fi.Size()
	var got rowEstimate
	var sampled int64
	buf := make([]byte, sampleSize)
	read := func(off, n int64) {
		k, _ := f.ReadAt(buf[:n], off)
		got.add(countRows(buf[:k], off > 0))
		sampled += int64(k)
	}
	if size <= fullScanMax {
		for off := int64(0); off < size; off += sampleSize {
			read(off, min(sampleSize, size-off))
		}
		return got // exact
	}
	for i := int64(0); i < sampleN; i++ {
		read((size-sampleSize)*i/(sampleN-1), sampleSize)
	}
	scale := float64(size) / float64(sampled) * sampleSlack
	return rowEstimate{calls: int64(float64(got.calls) * scale), waits: int64(float64(got.waits) * scale),
		binds: int64(float64(got.binds) * scale), bindSets: int64(float64(got.bindSets) * scale)}
}

// countRows counts the lines of buf that become fact rows. When partial the
// first (cut) line is skipped.
func countRows(buf []byte, partial bool) rowEstimate {
	var r rowEstimate
	if partial {
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	for len(buf) > 0 {
		var line []byte
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			line, buf = buf[:i], buf[i+1:]
		} else {
			line, buf = buf, nil
		}
		switch {
		case bytes.HasPrefix(line, []byte("WAIT #")):
			r.waits++
		case bytes.HasPrefix(line, []byte("EXEC #")), bytes.HasPrefix(line, []byte("FETCH #")), bytes.HasPrefix(line, []byte("PARSE #")),
			bytes.HasPrefix(line, []byte("CLOSE #")), bytes.HasPrefix(line, []byte("XCTEND")), bytes.HasPrefix(line, []byte("LOB")):
			r.calls++
		case bytes.HasPrefix(line, []byte(" Bind#")):
			r.binds++
		case bytes.HasPrefix(line, []byte("BINDS #")):
			r.bindSets++
		}
	}
	return r
}
