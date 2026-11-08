// Package engine is the desktop engine (`mtkprof engine`, docs/PLAN-DESKTOP.md).
//
// # Persistent index cache
//
// The engine always builds in aggregate + spill mode, into a directory of the
// index cache keyed by the content identity of the trace (identity.go), so a
// trace opened again, moved, renamed or fetched again opens without a parse:
//
//	<cache>/index/<identity>/
//	  manifest.json         Manifest: format, sources, options, created, lastUsed, bytes, file sizes
//	  dims.bin              model.Encode: the model without the fact tables
//	  agg.bin               analyze.(*Accumulator).Encode: the aggregates the document is computed from
//	  calls.bin waits.bin bindsets.bin binds.bin bindvals.bin calls.stmt waits.stmt spill.idx
//	                        the spill (slice.SpillOptions.Persist), reopened by slice.OpenSpill
//	  lines-<i>.idx         trace.LineIndex.Save of input file i (model File.Files order)
//
// <cache> is CacheDefaultDir() (os.UserCacheDir()/mtkprof) unless set.
// Directories are 0700, files 0600. An entry is built in <cache>/index/.build-<pid>-<random>
// and renamed into place after its manifest is written and every file is
// synced, so a crash leaves no half entry; OpenCache removes build
// directories of dead processes and entry directories without a valid
// manifest. Lookup validates the manifest (index format, identity from the
// sources and options, file sizes): an entry that does not match is removed
// and is a miss. Any decoding error of Load is a miss too (the caller
// removes the entry and rebuilds): a format change never crashes.
//
// Usage by the engine (one call per open):
//
//	c, err := engine.OpenCache(dir, capBytes)           // dir "" = CacheDefaultDir(); cap <= 0 = CacheDefaultCap
//	o, err := c.OpenTrace(ctx, paths, engine.CacheOpenOptions{BindMode: mode, Salt: salt, Build: build})
//	defer o.Close()                                      // closes the source and line indexes; unpins the entry
//	ref.ApplyRef(o.Model, bundle) ...                    // post-passes that are not part of the identity
//	doc := report.DocumentBytes(o.Model, report.DocOptions{Slice: true, ...})
//	slice.NewServer(o.Model, o.Source)                   // /api/*; o.Lines[i] serves /api/lines?file=i
//
// OpenTrace computes the identity, loads the entry on a hit, or builds it
// (CacheOpenOptions.Build, default model.BuildFiles, with the aggregate +
// spill options it is given), commits it, evicts least recently used
// entries above the cap (never an open one) and loads it like a hit, so a
// hit and a miss answer from the same code. The model is stored before any
// reference bundle is applied (ApplyRef is not part of the identity and is
// not idempotent): apply it to every loaded model.
//
// The lower-level calls (Lookup, Begin/CacheBuild, Load, Touch, Entries,
// Remove, Wipe, Evict, Stats) are what OpenTrace is made of and what
// `mtkprof engine cache ls|rm|wipe` and the settings page use.
package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// CacheIndexFormat is the format of a cache entry as a whole. Bump it with
// any of the formats it is made of (TestCacheIndexFormatCoversParts lists
// them), so old entries are rebuilt instead of misread. 5: the model reads a
// WAIT line's obj#=4294967295 (23ai's "no object") as -1, so the stored
// waits and object aggregates of a 23ai trace changed meaning. 6: the
// aggregates keep the obj# and file# the waits named (analyze.Accumulator
// RefIDs), so a reference bundle names objects and datafiles of an engine
// session, not only the plans' objects. 7: an attribute marker of a
// pre-12.2 trace ("SESSION ID:(15.1335) 2013-05-10 07:26:55.095") no
// longer keeps its time in the value, so such a trace's contexts changed.
const CacheIndexFormat = 7

// cacheParts are the versions of the files of an entry at CacheIndexFormat.
var cacheParts = map[string]int{
	"dims": model.PersistVersion, "agg": analyze.AccumPersistVersion,
	"spill": slice.SpillIdxVersion, "lines": trace.LineIndexVersion,
}

// CacheDefaultCap is the default size limit of the cache.
const CacheDefaultCap int64 = 20 << 30

// ErrCacheInUse is returned by Remove and Wipe for entries that are open.
var ErrCacheInUse = errors.New("cache entry in use")

// ErrCacheStale is returned by Load when the entry cannot serve the files
// (a source file is gone or changed): the caller rebuilds.
var ErrCacheStale = errors.New("cache entry does not match the trace files")

const (
	cacheIndexDir  = "index"
	cacheBuildPfx  = ".build-"
	cacheDimsFile  = "dims.bin"
	cacheAggFile   = "agg.bin"
	cacheLinesFile = "lines-%d.idx"
)

// CacheDefaultDir is <os.UserCacheDir()>/mtkprof.
func CacheDefaultDir() (string, error) {
	d, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "mtkprof"), nil
}

// Cache is the persistent index cache. Safe for concurrent use; several
// processes may share a directory (builds are private until renamed into
// place, the first commit of an identity wins).
type Cache struct {
	dir string // <root>/index
	cap int64

	// Protocol is recorded in the manifests of new entries.
	Protocol int

	mu       sync.Mutex
	refs     map[string]int           // open entries (Load without Close)
	building map[string]chan struct{} // identities being built by OpenTrace
	list     *listing                 // Entries without a readdir while it is fresh (listing.go)
	scans    int                      // readdir + manifest scans done (tests)
}

// CacheEntry is an entry found by Lookup.
type CacheEntry struct {
	Identity string
	Dir      string
	Manifest Manifest
}

// CacheEntrySummary is what Entries lists.
type CacheEntrySummary struct {
	Identity string    `json:"identity"`
	Bytes    int64     `json:"bytes"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"lastUsed"`
	Sources  []string  `json:"sources"` // absolute paths at build time
	Open     bool      `json:"open"`    // loaded by this process
}

// OpenCache opens (creating it 0700) the cache under dir ("" =
// CacheDefaultDir) with a size limit of capBytes (<= 0: CacheDefaultCap),
// and removes what a crash left behind: build directories of dead processes
// and entries without a readable manifest.
func OpenCache(dir string, capBytes int64) (*Cache, error) {
	if dir == "" {
		var err error
		if dir, err = CacheDefaultDir(); err != nil {
			return nil, err
		}
	}
	if capBytes <= 0 {
		capBytes = CacheDefaultCap
	}
	idx := filepath.Join(dir, cacheIndexDir)
	if err := os.MkdirAll(idx, 0o700); err != nil {
		return nil, err
	}
	c := &Cache{dir: idx, cap: capBytes, refs: map[string]int{}, building: map[string]chan struct{}{}}
	c.sweep()
	return c, nil
}

// Dir is the index directory (<root>/index).
func (c *Cache) Dir() string { return c.dir }

// Cap is the size limit in bytes.
func (c *Cache) Cap() int64 { return c.cap }

// sweep removes dead build directories and entries without a manifest.
func (c *Cache) sweep() {
	ents, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		name := e.Name()
		p := filepath.Join(c.dir, name)
		if !e.IsDir() {
			continue
		}
		if strings.HasPrefix(name, cacheBuildPfx) {
			rest := strings.TrimPrefix(name, cacheBuildPfx)
			pid, err := strconv.Atoi(rest[:max(0, strings.IndexByte(rest, '-'))])
			if err == nil && pid != os.Getpid() && slice.ProcessAlive(pid) {
				continue // another engine is building it
			}
			if err == nil && pid == os.Getpid() {
				continue // ours (a second Cache in this process)
			}
			os.RemoveAll(p)
			continue
		}
		if m, err := readManifest(p); err != nil || m.Identity != name {
			os.RemoveAll(p)
		}
	}
}

func (c *Cache) entryDir(identity string) string { return filepath.Join(c.dir, identity) }

func validIdentity(identity string) bool {
	if len(identity) != 64 {
		return false
	}
	_, err := hex.DecodeString(identity)
	return err == nil
}

// Lookup returns the entry of identity if there is a valid one. An invalid
// one (other index format, options that do not give the identity, a missing
// or truncated file) is removed, unless it is open.
func (c *Cache) Lookup(identity string) (*CacheEntry, bool) {
	if !validIdentity(identity) {
		return nil, false
	}
	dir := c.entryDir(identity)
	m, err := readManifest(dir)
	if err == nil {
		err = m.valid(identity)
	}
	if err == nil {
		for name, size := range m.Files {
			fi, serr := os.Stat(filepath.Join(dir, name))
			if serr != nil || fi.Size() != size || filepath.Base(name) != name {
				err = fmt.Errorf("%s: missing or changed", name)
				break
			}
		}
	}
	if err != nil {
		if !os.IsNotExist(err) {
			c.removeUnlessOpen(identity)
		}
		return nil, false
	}
	return &CacheEntry{Identity: identity, Dir: dir, Manifest: *m}, true
}

func (c *Cache) removeUnlessOpen(identity string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.refs[identity] > 0 {
		return false
	}
	pre := c.dirStamp()
	os.RemoveAll(c.entryDir(identity))
	c.noteChangeLocked(pre, func(items map[string]CacheEntrySummary) { delete(items, identity) })
	return true
}

// CacheBuild is an entry being written: spill into Dir, then WriteModel,
// WriteLines and Commit, or Abort.
type CacheBuild struct {
	c        *Cache
	identity string
	dir      string
	done     bool
}

// Begin starts a new entry for identity in a private build directory.
func (c *Cache) Begin(identity string) (*CacheBuild, error) {
	if !validIdentity(identity) {
		return nil, fmt.Errorf("cache: bad identity %q", identity)
	}
	pre := c.dirStamp()
	dir, err := os.MkdirTemp(c.dir, cacheBuildPfx+strconv.Itoa(os.Getpid())+"-")
	if err != nil {
		return nil, err
	}
	c.noteChange(pre, nil)
	return &CacheBuild{c: c, identity: identity, dir: dir}, nil
}

// Dir is the directory to write the entry's files into (the spill's Dir).
func (b *CacheBuild) Dir() string { return b.dir }

// Identity is the identity the entry is built for.
func (b *CacheBuild) Identity() string { return b.identity }

func (b *CacheBuild) create(name string, write func(f *os.File) error) error {
	f, err := os.OpenFile(filepath.Join(b.dir, name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	err = write(f)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// WriteModel writes dims.bin and agg.bin of a finished aggregation-only model.
func (b *CacheBuild) WriteModel(m *model.Model) error {
	a := analyze.AggOf(m)
	if a == nil {
		return fmt.Errorf("cache: the model has no finished accumulator (aggregate build)")
	}
	if err := b.create(cacheDimsFile, func(f *os.File) error { return model.Encode(f, m) }); err != nil {
		return err
	}
	return b.create(cacheAggFile, func(f *os.File) error { return a.Encode(f) })
}

// WriteLines writes lines-<i>.idx of the line index of every input file.
func (b *CacheBuild) WriteLines(lis []*trace.LineIndex) error {
	for i, li := range lis {
		if err := b.create(fmt.Sprintf(cacheLinesFile, i), func(f *os.File) error { return li.Save(f) }); err != nil {
			return err
		}
	}
	return nil
}

// Commit completes the entry: m gives Sources and Options (the rest is
// filled in), every file is synced, manifest.json is written and the
// directory is renamed to the identity. If another process committed the
// same identity first, its entry is kept and this one dropped.
func (b *CacheBuild) Commit(m Manifest) error {
	if b.done {
		return errors.New("cache: build already finished")
	}
	b.done = true
	fail := func(err error) error {
		pre := b.c.dirStamp()
		os.RemoveAll(b.dir)
		b.c.noteChange(pre, nil)
		return err
	}
	now := time.Now().UTC()
	m.Engine, m.IndexFormat, m.Protocol, m.Identity = report.Version, CacheIndexFormat, b.c.Protocol, b.identity
	if m.Created.IsZero() {
		m.Created = now
	}
	m.LastUsed = now
	m.Files, m.Bytes = map[string]int64{}, 0
	ents, err := os.ReadDir(b.dir)
	if err != nil {
		return fail(err)
	}
	for _, e := range ents {
		if e.IsDir() || e.Name() == manifestName {
			continue
		}
		p := filepath.Join(b.dir, e.Name())
		if err := syncFile(p); err != nil {
			return fail(err)
		}
		fi, err := os.Stat(p)
		if err != nil {
			return fail(err)
		}
		m.Files[e.Name()] = fi.Size()
		m.Bytes += fi.Size()
	}
	if err := m.valid(b.identity); err != nil {
		return fail(fmt.Errorf("cache: commit: %w", err))
	}
	if err := writeManifest(b.dir, &m); err != nil {
		return fail(err)
	}
	final := b.c.entryDir(b.identity)
	pre := b.c.dirStamp()
	if err := os.Rename(b.dir, final); err != nil {
		if _, ok := b.c.Lookup(b.identity); ok {
			os.RemoveAll(b.dir) // someone else's commit won
			b.c.invalidate()
			return nil
		}
		if !b.c.removeUnlessOpen(b.identity) {
			return fail(fmt.Errorf("cache: commit: %w", ErrCacheInUse))
		}
		pre = b.c.dirStamp()
		if err := os.Rename(b.dir, final); err != nil {
			return fail(err)
		}
	}
	syncDir(b.c.dir)
	b.c.noteChange(pre, func(items map[string]CacheEntrySummary) { items[b.identity] = summaryOf(&m) })
	return nil
}

// Abort drops the build directory. Safe after Commit (it does nothing then).
func (b *CacheBuild) Abort() {
	if !b.done {
		b.done = true
		pre := b.c.dirStamp()
		os.RemoveAll(b.dir)
		b.c.noteChange(pre, nil)
	}
}

func syncFile(p string) error {
	f, err := os.OpenFile(p, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	err = f.Sync()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// syncDir makes a rename durable where the platform allows it (not on Windows).
func syncDir(dir string) {
	if f, err := os.Open(dir); err == nil {
		f.Sync()
		f.Close()
	}
}

// Load opens an entry: the model (dimensions and aggregates), the fact
// source over its spill and the line index of every input file. paths are
// the files the caller opened (the named ones, any order): input files are
// matched to them by identity, so a moved or renamed trace reads its lines
// from where it is now and the model shows the new paths; a source that is
// not among them is read from its recorded path if it still has its size,
// else Load fails with ErrCacheStale. Closing the source releases the entry
// (until then Evict, Remove and Wipe leave it alone); the line indexes are
// the caller's to close. Decoding errors wrap binfmt.ErrFormat (model.ErrFormat).
func (c *Cache) Load(e *CacheEntry, paths ...string) (*model.Model, slice.FactSource, []*trace.LineIndex, error) {
	m, err := c.loadModel(e)
	if err != nil {
		return nil, nil, nil, err
	}
	srcPaths, err := resolveSources(e, m, paths)
	if err != nil {
		return nil, nil, nil, err
	}
	var lis []*trace.LineIndex
	closeLines := func() {
		for _, li := range lis {
			li.Close()
		}
	}
	for i, p := range srcPaths {
		f, err := os.Open(filepath.Join(e.Dir, fmt.Sprintf(cacheLinesFile, i)))
		if err != nil {
			closeLines()
			return nil, nil, nil, err
		}
		li, err := trace.LoadLineIndex(p, f)
		f.Close()
		if err != nil {
			closeLines()
			return nil, nil, nil, err
		}
		lis = append(lis, li)
	}
	c.mu.Lock()
	c.refs[e.Identity]++
	c.mu.Unlock()
	src, err := slice.OpenSpill(e.Dir, m)
	if err != nil {
		c.release(e.Identity)
		closeLines()
		return nil, nil, nil, err
	}
	return m, &cacheSource{FactSource: src, release: func() { c.release(e.Identity) }}, lis, nil
}

func (c *Cache) loadModel(e *CacheEntry) (*model.Model, error) {
	f, err := os.Open(filepath.Join(e.Dir, cacheDimsFile))
	if err != nil {
		return nil, err
	}
	m, err := model.Decode(f)
	f.Close()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", cacheDimsFile, err)
	}
	f, err = os.Open(filepath.Join(e.Dir, cacheAggFile))
	if err != nil {
		return nil, err
	}
	a, err := analyze.DecodeAccumulator(f, m)
	f.Close()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", cacheAggFile, err)
	}
	m.Agg = a
	return m, nil
}

// resolveSources finds the current path of every input file of the entry
// (a given path of the same identity, else the path the model has, else the
// recorded absolute path) and rewrites the model's file paths where they
// changed.
func resolveSources(e *CacheEntry, m *model.Model, paths []string) ([]string, error) {
	srcs := e.Manifest.Sources
	if len(srcs) != len(m.File.Files) {
		return nil, fmt.Errorf("%w: %d sources in the manifest, %d files in the model", ErrCacheStale, len(srcs), len(m.File.Files))
	}
	have := map[string][]string{} // identity -> given paths not used yet
	for _, p := range paths {
		id, err := IdentityOfFile(p)
		if err != nil {
			return nil, err
		}
		have[id] = append(have[id], p)
	}
	same := func(p string, s ManifestSource) bool {
		if fi, err := os.Stat(p); err != nil || fi.Size() != s.Size {
			return false
		}
		id, err := IdentityOfFile(p)
		return err == nil && id == s.Identity
	}
	out := make([]string, len(srcs))
	for i, s := range srcs {
		switch ps := have[s.Identity]; {
		case len(ps) > 0:
			out[i], have[s.Identity] = ps[0], ps[1:]
		case same(m.File.Files[i].Path, s):
			out[i] = m.File.Files[i].Path
		case same(s.Path, s):
			out[i] = s.Path
		default:
			return nil, fmt.Errorf("%w: %s not found", ErrCacheStale, s.Path)
		}
	}
	for i, p := range out {
		if fe := &m.File.Files[i]; fe.Path != p {
			fe.Path, fe.Name = p, filepath.Base(p)
		}
	}
	m.File.Path = m.File.Files[0].Path
	return out, nil
}

// cacheSource is the FactSource of a loaded entry: Close closes the spill
// files (they stay) and unpins the entry.
type cacheSource struct {
	slice.FactSource
	once    sync.Once
	release func()
}

func (s *cacheSource) Close() error {
	var err error
	s.once.Do(func() {
		err = s.FactSource.Close()
		s.release()
	})
	return err
}

func (c *Cache) release(identity string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.refs[identity]--; c.refs[identity] <= 0 {
		delete(c.refs, identity)
	}
}

// Touch sets the entry's lastUsed to now.
func (c *Cache) Touch(identity string) error {
	if !validIdentity(identity) {
		return fmt.Errorf("cache: bad identity %q", identity)
	}
	dir := c.entryDir(identity)
	m, err := readManifest(dir)
	if err != nil {
		return err
	}
	m.LastUsed = time.Now().UTC()
	if err := writeManifest(dir, m); err != nil {
		return err
	}
	c.mu.Lock()
	if c.list != nil { // the manifest is rewritten in place: the directory's mtime does not move
		if it, ok := c.list.items[identity]; ok {
			it.LastUsed = m.LastUsed
			c.list.items[identity] = it
		}
	}
	c.mu.Unlock()
	return nil
}

// Entries lists the entries with a readable manifest, most recently used
// first. The listing is kept in memory (listing.go): a readdir and a manifest
// read per entry only when the cache directory changed behind the cache's back.
func (c *Cache) Entries() []CacheEntrySummary { return c.entries() }

// Remove deletes an entry (ErrCacheInUse while it is open).
func (c *Cache) Remove(identity string) error {
	if !validIdentity(identity) {
		return fmt.Errorf("cache: bad identity %q", identity)
	}
	if _, err := os.Stat(c.entryDir(identity)); err != nil {
		return err
	}
	if !c.removeUnlessOpen(identity) {
		return ErrCacheInUse
	}
	return nil
}

// Wipe deletes every entry that is not open and every build directory of a
// dead process; it returns ErrCacheInUse (wrapped) when it had to keep some.
func (c *Cache) Wipe() error {
	defer c.invalidate()
	ents, err := os.ReadDir(c.dir)
	if err != nil {
		return err
	}
	kept := 0
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		if validIdentity(e.Name()) {
			if !c.removeUnlessOpen(e.Name()) {
				kept++
			}
			continue
		}
		if !strings.HasPrefix(e.Name(), cacheBuildPfx) {
			os.RemoveAll(filepath.Join(c.dir, e.Name()))
		}
	}
	c.sweep()
	if kept > 0 {
		return fmt.Errorf("%w: %d entries kept", ErrCacheInUse, kept)
	}
	return nil
}

// Evict removes least recently used entries until the cache fits its cap;
// open entries and the pinned identities are never removed. It returns the
// identities it removed.
func (c *Cache) Evict(pinned ...string) []string {
	ents := c.Entries()
	var total int64
	for _, e := range ents {
		total += e.Bytes
	}
	var removed []string
	for i := len(ents) - 1; i >= 0 && total > c.cap; i-- { // oldest last
		e := ents[i]
		if e.Open || slices.Contains(pinned, e.Identity) {
			continue
		}
		if c.removeUnlessOpen(e.Identity) {
			total -= e.Bytes
			removed = append(removed, e.Identity)
		}
	}
	return removed
}

// Stats is the size of the cache, the number of entries and the cap.
func (c *Cache) Stats() (bytes int64, entries int, capBytes int64) {
	for _, e := range c.Entries() {
		bytes += e.Bytes
		entries++
	}
	return bytes, entries, c.cap
}

// ---- OpenTrace -------------------------------------------------------------

// CacheBuildFunc parses the trace files with the given options (an aggregate
// build that spills into the entry) and returns the finished model. It must
// pass mo on unchanged except for adding hooks (progress). Cancellation is
// up to it: OpenTrace checks ctx before and after.
type CacheBuildFunc func(ctx context.Context, paths []string, mo model.Options) (*model.Model, error)

// CacheOpenOptions are the options of OpenTrace. BindMode, Salt, Thresholds
// and NoFollow change what is built and are part of the identity.
type CacheOpenOptions struct {
	BindMode   model.BindMode
	Salt       string
	Thresholds *analyze.Thresholds // nil: analyze.DefaultThresholds()
	NoFollow   bool

	Build CacheBuildFunc // nil: model.BuildFiles
}

func (o *CacheOpenOptions) manifestOptions() (ManifestOptions, analyze.Thresholds) {
	th := analyze.DefaultThresholds()
	if o.Thresholds != nil {
		th = *o.Thresholds
	}
	b, _ := json.Marshal(th)
	h := sha256.Sum256(b)
	return ManifestOptions{BindMode: o.BindMode.String(), SaltHash: IdentitySaltHash(o.Salt), Thresholds: hex.EncodeToString(h[:]), NoFollow: o.NoFollow}, th
}

// CacheIdentity is the identity OpenTrace uses for paths and options.
func CacheIdentity(paths []string, o CacheOpenOptions) (string, error) {
	ids, err := IdentityOfFiles(paths)
	if err != nil {
		return "", err
	}
	mo, _ := o.manifestOptions()
	return IdentityOfSet(ids, CacheIndexFormat, mo.BindMode, mo.SaltHash, mo.extra()...), nil
}

// CacheOpened is an opened trace: close it when the session ends.
type CacheOpened struct {
	Identity string
	Hit      bool // loaded from the cache without a parse
	Entry    *CacheEntry
	Model    *model.Model
	Source   slice.FactSource
	Lines    []*trace.LineIndex // per input file, File.Files order
}

// Close closes the line indexes and the source (unpinning the entry).
func (o *CacheOpened) Close() error {
	var err error
	for _, li := range o.Lines {
		li.Close()
	}
	if o.Source != nil {
		err = o.Source.Close()
	}
	return err
}

// OpenTrace opens the trace set paths from the cache, building the entry on
// a miss (see the package comment). Concurrent opens of the same identity in
// this process wait for one build.
func (c *Cache) OpenTrace(ctx context.Context, paths []string, o CacheOpenOptions) (*CacheOpened, error) {
	if len(paths) == 0 {
		return nil, errors.New("no trace files")
	}
	ids, err := IdentityOfFiles(paths)
	if err != nil {
		return nil, err
	}
	mopts, th := o.manifestOptions()
	identity := IdentityOfSet(ids, CacheIndexFormat, mopts.BindMode, mopts.SaltHash, mopts.extra()...)
	failed := false // a hit that could not be loaded is rebuilt, not looked up again
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if e, ok := c.Lookup(identity); ok && !failed {
			opened, err := c.open(e, paths, true)
			if err == nil {
				return opened, nil
			}
			failed = true
			c.removeUnlessOpen(identity) // undecodable or stale: rebuild
		}
		c.mu.Lock()
		wait, busy := c.building[identity]
		if !busy {
			c.building[identity] = make(chan struct{})
		}
		c.mu.Unlock()
		if !busy {
			break
		}
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	defer func() {
		c.mu.Lock()
		close(c.building[identity])
		delete(c.building, identity)
		c.mu.Unlock()
	}()
	if err := c.build(ctx, identity, paths, ids, mopts, th, o); err != nil {
		return nil, err
	}
	c.Evict(identity)
	e, ok := c.Lookup(identity)
	if !ok {
		return nil, fmt.Errorf("cache: entry %s vanished after its build", identity)
	}
	return c.open(e, paths, false)
}

func (c *Cache) open(e *CacheEntry, paths []string, hit bool) (*CacheOpened, error) {
	m, src, lis, err := c.Load(e, paths...)
	if err != nil {
		return nil, err
	}
	if hit {
		c.Touch(e.Identity)
	}
	return &CacheOpened{Identity: e.Identity, Hit: hit, Entry: e, Model: m, Source: src, Lines: lis}, nil
}

// build parses the trace into a new entry and commits it.
func (c *Cache) build(ctx context.Context, identity string, paths, ids []string, mopts ManifestOptions, th analyze.Thresholds, o CacheOpenOptions) (err error) {
	b, err := c.Begin(identity)
	if err != nil {
		return err
	}
	defer b.Abort()
	sp, err := slice.NewSpill(slice.SpillOptions{Dir: b.Dir(), Persist: true, BindMode: o.BindMode, Salt: o.Salt})
	if err != nil {
		return err
	}
	defer sp.Close()
	mo := model.Options{
		NoFollow: o.NoFollow, NoFacts: true, Aggregate: true, SpillBinds: o.BindMode != model.BindsNone,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  sp.Attach,
	}
	build := o.Build
	if build == nil {
		build = func(_ context.Context, paths []string, mo model.Options) (*model.Model, error) {
			return model.BuildFiles(paths, mo)
		}
	}
	m, err := build(ctx, paths, mo)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := sp.Err(); err != nil {
		return fmt.Errorf("spill: %w", err)
	}
	model.RedactBindsSalt(m, o.BindMode, o.Salt) // as serve -spill: notes and Diag.BindMode (the spill holds the redacted values)
	if err := sp.Close(); err != nil {
		return err
	}
	if err := b.WriteModel(m); err != nil {
		return err
	}
	man := Manifest{Options: mopts, Inputs: ids}
	var lis []*trace.LineIndex
	defer func() {
		for _, li := range lis {
			li.Close()
		}
	}()
	for _, fe := range m.File.Files {
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			return err
		}
		lis = append(lis, li)
		id, err := IdentityOfFile(fe.Path)
		if err != nil {
			return err
		}
		abs, err := filepath.Abs(fe.Path)
		if err != nil {
			abs = fe.Path
		}
		s := ManifestSource{Path: abs, Identity: id, Named: slices.Contains(ids, id)}
		if fi, err := os.Stat(fe.Path); err == nil {
			s.Size, s.Mtime = fi.Size(), fi.ModTime().UTC()
		}
		man.Sources = append(man.Sources, s)
	}
	if err := b.WriteLines(lis); err != nil {
		return err
	}
	return b.Commit(man)
}
