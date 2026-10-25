package engine

import (
	"os"
	"reflect"
	"testing"
	"time"
)

// freshEntries is Entries from a scan of a new Cache over the same directory.
func freshEntries(t *testing.T, c *Cache) []CacheEntrySummary {
	t.Helper()
	f := &Cache{dir: c.dir, cap: c.cap, refs: c.refs, building: map[string]chan struct{}{}}
	return f.entries()
}

func sameListing(t *testing.T, c *Cache, what string) {
	t.Helper()
	got, want := c.Entries(), freshEntries(t, c)
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: listing\n%+v\nfresh scan\n%+v", what, got, want)
	}
}

// settle waits until the listing is old enough to be trusted.
func settle() { time.Sleep(2 * cacheSettle) }

// TestCacheListingMatchesScan: the in-memory listing equals a fresh scan after
// every kind of change, and is served without a scan while nothing changes.
func TestCacheListingMatchesScan(t *testing.T) {
	c := openCache(t, t.TempDir(), 0)
	sameListing(t, c, "empty")
	a := openTrace(t, c, []string{fx + "io_waits.trc"}, CacheOpenOptions{})
	sameListing(t, c, "after add")
	b := openTrace(t, c, []string{fx + "errors.trc"}, CacheOpenOptions{})
	b.Close()
	sameListing(t, c, "after second add")
	if es := c.Entries(); len(es) != 2 || !(es[0].Open || es[1].Open) {
		t.Errorf("entries %+v", es)
	}
	settle()
	c.Entries()
	n := c.scans
	for i := 0; i < 5; i++ {
		c.Entries()
		c.Stats()
	}
	if c.scans != n {
		t.Errorf("%d scans for unchanged listings", c.scans-n)
	}

	if err := c.Touch(b.Identity); err != nil {
		t.Fatal(err)
	}
	sameListing(t, c, "after touch")
	if c.Entries()[0].Identity != b.Identity {
		t.Errorf("touched entry not first")
	}
	if c.scans != n {
		t.Errorf("touch caused %d scans", c.scans-n)
	}

	a.Close()
	if err := c.Remove(a.Identity); err != nil {
		t.Fatal(err)
	}
	sameListing(t, c, "after remove")
	if es := c.Entries(); len(es) != 1 || es[0].Identity != b.Identity {
		t.Errorf("after remove %+v", es)
	}
	settle()
	c.Entries()
	n = c.scans
	c.Entries()
	if c.scans != n {
		t.Errorf("scan after a remove settled")
	}
	if err := c.Wipe(); err != nil {
		t.Fatal(err)
	}
	sameListing(t, c, "after wipe")
	if len(c.Entries()) != 0 {
		t.Errorf("entries after wipe")
	}
}

// TestCacheListingSeesOtherProcess: a removal or an addition by another Cache
// over the same directory (`mtkprof engine cache rm`) is noticed.
func TestCacheListingSeesOtherProcess(t *testing.T) {
	dir := t.TempDir()
	c := openCache(t, dir, 0)
	a := openTrace(t, c, []string{fx + "io_waits.trc"}, CacheOpenOptions{})
	a.Close()
	settle()
	if len(c.Entries()) != 1 {
		t.Fatal("want one entry")
	}
	other := openCache(t, dir, 0)
	b := openTrace(t, other, []string{fx + "errors.trc"}, CacheOpenOptions{})
	b.Close()
	if es := c.Entries(); len(es) != 2 {
		t.Errorf("addition by another process not seen: %+v", es)
	}
	settle()
	c.Entries()
	if err := other.Remove(a.Identity); err != nil {
		t.Fatal(err)
	}
	es := c.Entries()
	if len(es) != 1 || es[0].Identity != b.Identity {
		t.Errorf("removal by another process not seen: %+v", es)
	}
	sameListing(t, c, "after the external changes")
	os.RemoveAll(c.entryDir(b.Identity))
	if es := c.Entries(); len(es) != 0 {
		t.Errorf("rm -r not seen: %+v", es)
	}
}
