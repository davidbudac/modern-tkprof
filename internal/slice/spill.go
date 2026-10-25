package slice

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// SpillOptions configure a Spill.
type SpillOptions struct {
	Dir      string         // parent directory of the spill directory ("" = os.TempDir()); with Persist the directory itself
	Key      string         // identity of the trace (SpillKey): stale directories of the same trace are removed
	BindMode model.BindMode // BindsRedact stores the redacted values; BindsNone is not spilled (leave Options.SpillBinds off)
	Salt     string         // redaction salt

	// Persist writes into Dir itself (created 0700; no temporary name, no
	// RemoveStale), adds the in-memory part of the indexes as spill.idx at
	// Finish, and makes Close keep the files: the index cache reopens them
	// with OpenSpill.
	Persist bool
}

// SpillKey identifies a trace set by the path, size and modification time of
// its files, for finding the leftovers of an earlier run on the same trace.
func SpillKey(paths []string) string {
	h := sha256.New()
	for _, p := range paths {
		abs, err := filepath.Abs(p)
		if err != nil {
			abs = p
		}
		var size, mtime int64
		if fi, err := os.Stat(abs); err == nil {
			size, mtime = fi.Size(), fi.ModTime().UnixNano()
		}
		fmt.Fprintf(h, "%s\x00%d\x00%d\x00", abs, size, mtime)
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

const spillPrefix = "mtkprof-spill-"

// Spill is the model.Sink (and BindSink) that writes the facts of an
// aggregation-only build to a set of files while the trace is parsed:
//
//	calls.bin    one fixed-width record per call, by call id (layout.go)
//	waits.bin    one per wait, by wait id
//	bindsets.bin, binds.bin, bindvals.bin   bind sets, binds, and their text
//	calls.stmt, waits.stmt   row numbers grouped by statement (written at the end)
//
// and answers queries from them afterwards (Source). Only the dimension tables
// of the model and a few pages of each file are in memory. Close removes the
// directory, unless SpillOptions.Persist is set: then Finish also writes
//
//	spill.idx    row counts, statement index layout, context row ranges
//
// and OpenSpill serves the directory again without the build.
type Spill struct {
	m    *model.Model
	opts SpillOptions
	dir  string

	calls, waits     *pagedFile
	sets, binds, val *appendFile
	nSets, nBinds    int64
	nVal             int64
	rec              [bindRec + callRec]byte

	callsByCur, waitsByCur []int64
	callCtx, waitCtx       []rowRange
	live                   bool // an Overlay has written: orphan marks may need clearing (spill_live.go)

	mu     sync.Mutex
	err    error
	src    *diskSource
	closed bool
	files  []*os.File
}

// rowRange is the first and last row (+1) of a session context: contexts are
// opened in file order, so the rows of one are adjacent.
type rowRange struct{ lo, hi int64 }

// NewSpill creates the spill directory (removing leftovers of the same trace
// from dead processes) and its files. Attach it to the model with
// model.Options.NewTee: func(m) { return sp.Attach(m) }.
func NewSpill(o SpillOptions) (*Spill, error) {
	if o.Persist {
		if o.Dir == "" {
			return nil, fmt.Errorf("spill: Persist needs a directory")
		}
		if err := os.MkdirAll(o.Dir, 0o700); err != nil {
			return nil, err
		}
		return createSpill(o, o.Dir)
	}
	base := o.Dir
	if base == "" {
		base = os.TempDir()
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, err
	}
	if o.Key != "" {
		RemoveStale(base, o.Key)
	}
	key := o.Key
	if key == "" {
		key = "anon"
	}
	dir, err := os.MkdirTemp(base, spillPrefix+key+"-"+strconv.Itoa(os.Getpid())+"-")
	if err != nil {
		return nil, err
	}
	return createSpill(o, dir)
}

func createSpill(o SpillOptions, dir string) (*Spill, error) {
	var err error
	s := &Spill{opts: o, dir: dir}
	open := func(name string) *os.File {
		if err != nil {
			return nil
		}
		var f *os.File
		f, err = os.OpenFile(filepath.Join(dir, name), os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
		if f != nil {
			s.files = append(s.files, f)
		}
		return f
	}
	s.calls = newPagedFile(open("calls.bin"), callRec, 48)
	s.waits = newPagedFile(open("waits.bin"), waitRec, 48)
	s.sets = newAppendFile(open("bindsets.bin"))
	s.binds = newAppendFile(open("binds.bin"))
	s.val = newAppendFile(open("bindvals.bin"))
	if err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// Attach gives the spill the model whose cursors tell the statement of a row;
// it is the Sink of the build.
func (s *Spill) Attach(m *model.Model) model.Sink {
	s.m = m
	return s
}

// Dir is the spill directory.
func (s *Spill) Dir() string { return s.dir }

// RemoveStale removes the spill directories of the trace identified by key
// that belong to processes that are gone (a crashed run).
func RemoveStale(base, key string) {
	ents, err := os.ReadDir(base)
	if err != nil {
		return
	}
	prefix := spillPrefix + key + "-"
	for _, e := range ents {
		name := e.Name()
		if !e.IsDir() || !strings.HasPrefix(name, prefix) {
			continue
		}
		rest := strings.TrimPrefix(name, prefix)
		pid, err := strconv.Atoi(rest[:max(0, strings.IndexByte(rest, '-'))])
		if err == nil && pid != os.Getpid() && processAlive(pid) {
			continue
		}
		os.RemoveAll(filepath.Join(base, name))
	}
}

func (s *Spill) fail(err error) {
	if err != nil && s.err == nil {
		s.err = err
	}
}

// Err is the first write error (disk full ...); the spill is unusable after one.
func (s *Spill) Err() error { return s.err }

// ---- model.Sink ------------------------------------------------------------

func (s *Spill) Call(c *model.Call) {
	if s.err != nil || c.ID < 0 {
		return
	}
	rec := s.rec[:callRec]
	putCall(rec, c)
	s.calls.put(int64(c.ID), rec)
	count(&s.callsByCur, c.Cursor)
	extend(&s.callCtx, c.Context, int64(c.ID))
}

// Child sets the parent of a call that was written when it completed; the
// parent completes after its children.
func (s *Spill) Child(ch *model.ChildRec, parent *model.Call) {
	if s.err != nil {
		return
	}
	if parent == nil {
		s.calls.patch(int64(ch.ID), cOffOrphan, []byte{1})
		return
	}
	var b [4]byte
	le.PutUint32(b[:], uint32(parent.ID))
	s.calls.patch(int64(ch.ID), cOffParent, b[:])
	if s.live { // a snapshot may have marked it orphan
		s.calls.patch(int64(ch.ID), cOffOrphan, []byte{0})
	}
}

func (s *Spill) Wait(w *model.Wait, _ *model.Call) {
	if s.err != nil || w.ID < 0 {
		return
	}
	rec := s.rec[:waitRec]
	putWait(rec, w)
	s.waits.put(int64(w.ID), rec)
	count(&s.waitsByCur, w.Cursor)
	extend(&s.waitCtx, w.Context, int64(w.ID))
}

// Adopt does nothing: the statement of a row is looked up through its cursor.
func (s *Spill) Adopt(cur, to model.ID) {}

// BindSet (model.BindSink) stores a BINDS block.
func (s *Spill) BindSet(set *model.BindSet, binds []model.Bind) {
	if s.err != nil {
		return
	}
	first := s.nBinds
	for i := range binds {
		b := &binds[i]
		if s.opts.BindMode == model.BindsRedact && !b.IsNull && !b.NoDef {
			b.Value = model.RedactedValueSalt(b, s.opts.Salt)
		}
		rec := s.rec[:bindRec]
		putBind(rec, b, s.nVal)
		s.binds.write(rec)
		s.val.write([]byte(b.Value))
		s.nVal += int64(len(b.Value))
	}
	s.nBinds += int64(len(binds))
	rec := s.rec[:setRec]
	putSet(rec, set, first)
	s.sets.write(rec)
	s.nSets++
}

// Finish flushes the files, writes the statement indexes and opens the
// source. The model's dimension tables are final here.
func (s *Spill) Finish() {
	if s.err != nil {
		return
	}
	s.fail(s.calls.flush())
	s.fail(s.waits.flush())
	s.fail(s.sets.flush())
	s.fail(s.binds.flush())
	s.fail(s.val.flush())
	if s.err != nil {
		return
	}
	d := &diskSource{sp: s, m: s.m, calls: s.calls.f, waits: s.waits.f, nCalls: s.calls.n, nWaits: s.waits.n,
		sets: s.sets.f, binds: s.binds.f, vals: s.val.f, nSets: s.nSets, nBinds: s.nBinds,
		callCtx: s.callCtx, waitCtx: s.waitCtx, sem: make(chan struct{}, scanSlots), kinds: newKindCache(s.calls.f, s.calls.n)}
	var err error
	if d.cstmt, err = s.buildIndex("calls.stmt", s.calls.f, s.calls.n, callRec, cOffCursor, s.callsByCur); err != nil {
		s.fail(err)
		return
	}
	if d.wstmt, err = s.buildIndex("waits.stmt", s.waits.f, s.waits.n, waitRec, wOffCursor, s.waitsByCur); err != nil {
		s.fail(err)
		return
	}
	if s.opts.Persist {
		if err := s.writeIdx(d); err != nil {
			s.fail(err)
			return
		}
	}
	s.src = d
}

// Source is the FactSource over the spilled rows; valid after the build.
func (s *Spill) Source() (FactSource, error) {
	if s.err != nil {
		return nil, s.err
	}
	if s.src == nil {
		return nil, fmt.Errorf("spill: build not finished")
	}
	return s.src, nil
}

// Sizes returns the size of every spill file, in bytes.
func (s *Spill) Sizes() map[string]int64 {
	out := map[string]int64{}
	ents, _ := os.ReadDir(s.dir)
	for _, e := range ents {
		if fi, err := e.Info(); err == nil {
			out[e.Name()] = fi.Size()
		}
	}
	return out
}

// Close closes the files and removes the directory (a persisted spill keeps
// it). Safe to call from a signal handler while the build is still writing
// (its writes then fail).
func (s *Spill) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var err error
	for _, f := range s.files {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if s.opts.Persist {
		return err
	}
	return os.RemoveAll(s.dir)
}

// ProcessAlive reports whether a process with this pid exists (for the
// owners of build directories, as RemoveStale uses it).
func ProcessAlive(pid int) bool { return processAlive(pid) }

func count(by *[]int64, cur model.ID) {
	if cur < 0 {
		return
	}
	for int(cur) >= len(*by) {
		*by = append(*by, 0)
	}
	(*by)[cur]++
}

func extend(rs *[]rowRange, ctx model.ID, row int64) {
	if ctx < 0 {
		return
	}
	for int(ctx) >= len(*rs) {
		*rs = append(*rs, rowRange{lo: -1})
	}
	r := &(*rs)[ctx]
	if r.lo < 0 || row < r.lo {
		r.lo = row
	}
	if row+1 > r.hi {
		r.hi = row + 1
	}
}

// ---- statement index ---------------------------------------------------------

// stmtIndex lists, for every statement, the rows of a fact table in ascending
// order: ids of 4 bytes each, statement s at [starts[s], starts[s+1]) rows.
type stmtIndex struct {
	f      *os.File
	starts []int64
}

func (x *stmtIndex) count(s model.ID) int64 {
	if s < 0 || int(s)+1 >= len(x.starts) {
		return 0
	}
	return x.starts[s+1] - x.starts[s]
}

// buildIndex groups the rows of f by the statement of their cursor (at byte
// curOff of the record): count per cursor is known from the build, so the
// layout is computed up front and one sequential pass places the rows,
// chunk by chunk, with a write per statement and chunk.
func (s *Spill) buildIndex(name string, f *os.File, n int64, recSize, curOff int, byCur []int64) (*stmtIndex, error) {
	nst := len(s.m.Statements)
	x := &stmtIndex{starts: make([]int64, nst+1)}
	for c, k := range byCur {
		if c < len(s.m.Cursors) {
			if st := s.m.Cursors[c].Statement; st >= 0 && int(st) < nst {
				x.starts[st+1] += k
			}
		}
	}
	for i := 0; i < nst; i++ {
		x.starts[i+1] += x.starts[i]
	}
	var err error
	x.f, err = os.OpenFile(filepath.Join(s.dir, name), os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	s.files = append(s.files, x.f)
	if n == 0 || x.starts[nst] == 0 {
		return x, nil
	}
	fill := make([]int64, nst)
	const chunk = 1 << 20
	keys := make([]uint64, 0, chunk)
	var out []byte
	flush := func() error {
		slices.Sort(keys) // statement in the high bits, row number in the low: stable per statement
		for i := 0; i < len(keys); {
			st := int(keys[i] >> 32)
			j := i
			for j < len(keys) && int(keys[j]>>32) == st {
				j++
			}
			out = out[:0]
			for _, k := range keys[i:j] {
				out = le.AppendUint32(out, uint32(k))
			}
			if _, err := x.f.WriteAt(out, (x.starts[st]+fill[st])*4); err != nil {
				return err
			}
			fill[st] += int64(j - i)
			i = j
		}
		keys = keys[:0]
		return nil
	}
	rd := &recReader{f: f, recSize: recSize, buf: make([]byte, (1<<20)/recSize*recSize)}
	for row := int64(0); row < n; row++ {
		b, err := rd.get(row, n)
		if err != nil {
			return nil, err
		}
		cur := model.ID(int32(le.Uint32(b[curOff:])))
		if cur < 0 || int(cur) >= len(s.m.Cursors) {
			continue
		}
		st := s.m.Cursors[cur].Statement
		if st < 0 || int(st) >= nst {
			continue
		}
		keys = append(keys, uint64(st)<<32|uint64(row))
		if len(keys) == chunk {
			if err := flush(); err != nil {
				return nil, err
			}
		}
	}
	return x, flush()
}

// ---- helpers -------------------------------------------------------------------

// appendFile is a sequentially written file.
type appendFile struct {
	f *os.File
	w *bufio.Writer
}

func newAppendFile(f *os.File) *appendFile {
	if f == nil {
		return nil
	}
	return &appendFile{f: f, w: bufio.NewWriterSize(f, 1<<20)}
}

func (a *appendFile) write(b []byte) { a.w.Write(b) }
func (a *appendFile) flush() error   { return a.w.Flush() }

// recReader reads fixed-size records through a window of its buffer.
type recReader struct {
	f       *os.File
	recSize int
	buf     []byte
	lo, hi  int64 // rows in buf: [lo, hi)
}

// get returns row idx of a file of n rows; the slice is valid until the next call.
func (r *recReader) get(idx, n int64) ([]byte, error) {
	if idx < r.lo || idx >= r.hi {
		rows := int64(len(r.buf) / r.recSize)
		if idx+rows > n {
			rows = n - idx
		}
		got, err := r.f.ReadAt(r.buf[:rows*int64(r.recSize)], idx*int64(r.recSize))
		if err != nil && !(err == io.EOF && int64(got) == rows*int64(r.recSize)) {
			return nil, fmt.Errorf("spill: read row %d: %w", idx, err)
		}
		r.lo, r.hi = idx, idx+rows
	}
	o := int(idx-r.lo) * r.recSize
	return r.buf[o : o+r.recSize], nil
}
