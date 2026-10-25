package main

import (
	"context"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/engine"
)

func TestEngineCacheCommand(t *testing.T) {
	dir := t.TempDir()
	c, err := engine.OpenCache(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"io_waits.trc", "errors.trc"} {
		op, err := c.OpenTrace(context.Background(), []string{"../../testdata/traces/19c/" + f}, engine.CacheOpenOptions{})
		if err != nil {
			t.Fatal(err)
		}
		op.Close()
	}
	id := c.Entries()[0].Identity
	if err := cmdEngineCache([]string{"ls", "-cache", dir}); err != nil {
		t.Fatal(err)
	}
	if err := cmdEngineCache([]string{"-cache", dir, "rm", id[:10]}); err != nil {
		t.Fatal(err)
	}
	if _, n, _ := c.Stats(); n != 1 {
		t.Fatalf("%d entries after rm", n)
	}
	if err := cmdEngineCache([]string{"rm", "-cache", dir, id[:10]}); err == nil {
		t.Errorf("rm of a removed entry succeeded")
	}
	if err := cmdEngineCache([]string{"wipe", "-cache", dir}); err != nil {
		t.Fatal(err)
	}
	if _, n, _ := c.Stats(); n != 0 {
		t.Fatalf("%d entries after wipe", n)
	}
	if err := cmdEngineCache([]string{"-cache", dir}); err == nil {
		t.Errorf("no command accepted")
	}
	if err := cmdEngineCache([]string{"frob", "-cache", dir}); err == nil {
		t.Errorf("bad command accepted")
	}
}
