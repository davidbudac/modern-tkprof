package engine

import (
	"os"
	"path/filepath"
	"slices"
	"time"
)

// The in-memory listing of the cache. A scan (readdir plus one manifest read
// per entry) builds it; it is trusted while the mtime of the index directory
// is the one it was built at, and the cache's own commits, removals and
// touches update it in place. Entries are created and removed by renames and
// removals in that directory, so any other process's `add` or `rm` moves the
// mtime and is noticed by the next call. A change within cacheSettle of the
// mtime is not trusted yet (coarse file system clocks): the next call scans.

// cacheSettle is how old a directory mtime must be, at the time the listing
// was stamped, for the listing to be trusted.
const cacheSettle = 50 * time.Millisecond

type listing struct {
	mtime time.Time // of the index directory when the listing was last known to match
	at    time.Time // when it was stamped
	items map[string]CacheEntrySummary
}

func summaryOf(m *Manifest) CacheEntrySummary {
	s := CacheEntrySummary{Identity: m.Identity, Bytes: m.Bytes, Created: m.Created, LastUsed: m.LastUsed}
	for _, src := range m.Sources {
		s.Sources = append(s.Sources, src.Path)
	}
	return s
}

// dirStamp is the mtime of the index directory (zero if it cannot be read).
func (c *Cache) dirStamp() time.Time {
	fi, err := os.Stat(c.dir)
	if err != nil {
		return time.Time{}
	}
	return fi.ModTime()
}

// invalidate drops the listing: the next Entries scans.
func (c *Cache) invalidate() {
	c.mu.Lock()
	c.list = nil
	c.mu.Unlock()
}

// noteChange applies a change the cache made to the index directory to the
// listing; pre is dirStamp() from before the change. If the directory had
// moved before that (someone else's change, or a scan in flight), the listing
// is dropped instead.
func (c *Cache) noteChange(pre time.Time, apply func(items map[string]CacheEntrySummary)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.noteChangeLocked(pre, apply)
}

func (c *Cache) noteChangeLocked(pre time.Time, apply func(items map[string]CacheEntrySummary)) {
	if c.list == nil {
		return
	}
	post := c.dirStamp()
	if pre.IsZero() || post.IsZero() || !c.list.mtime.Equal(pre) {
		c.list = nil
		return
	}
	if apply != nil {
		apply(c.list.items)
	}
	c.list.mtime, c.list.at = post, time.Now()
}

// entries is Entries: the listing, scanned when missing or stale.
func (c *Cache) entries() []CacheEntrySummary {
	stamp := c.dirStamp()
	if stamp.IsZero() {
		return nil
	}
	c.mu.Lock()
	l := c.list
	if l == nil || !l.mtime.Equal(stamp) || l.at.Sub(stamp) < cacheSettle {
		l = &listing{mtime: stamp, at: time.Now(), items: c.scanLocked()}
		c.list = l
	}
	open := c.refs
	out := make([]CacheEntrySummary, 0, len(l.items))
	for id, it := range l.items {
		it.Open = open[id] > 0
		out = append(out, it)
	}
	c.mu.Unlock()
	slices.SortFunc(out, func(a, b CacheEntrySummary) int {
		if d := b.LastUsed.Compare(a.LastUsed); d != 0 {
			return d
		}
		return cmpString(a.Identity, b.Identity)
	})
	return out
}

func cmpString(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// scanLocked reads the directory and the manifests (the listing without the
// Open flag). c.mu is held so a concurrent change of the cache's own cannot
// slip between the scan and the stamp.
func (c *Cache) scanLocked() map[string]CacheEntrySummary {
	c.scans++
	items := map[string]CacheEntrySummary{}
	ents, err := os.ReadDir(c.dir)
	if err != nil {
		return items
	}
	for _, e := range ents {
		if !e.IsDir() || !validIdentity(e.Name()) {
			continue
		}
		m, err := readManifest(filepath.Join(c.dir, e.Name()))
		if err != nil || m.Identity != e.Name() {
			continue
		}
		items[m.Identity] = summaryOf(m)
	}
	return items
}
