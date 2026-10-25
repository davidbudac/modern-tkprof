package engine

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityFollowsContentNotName(t *testing.T) {
	src, err := os.ReadFile("../../testdata/traces/19c/io_waits.trc")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	a := filepath.Join(dir, "a.trc")
	b := filepath.Join(dir, "sub", "renamed.trc")
	os.MkdirAll(filepath.Dir(b), 0o755)
	os.WriteFile(a, src, 0o600)
	os.WriteFile(b, src, 0o600)
	ia, err := IdentityOfFile(a)
	if err != nil {
		t.Fatal(err)
	}
	ib, _ := IdentityOfFile(b)
	if ia != ib {
		t.Errorf("a copy under another name has another identity")
	}
	moved := filepath.Join(dir, "moved.trc")
	os.Rename(a, moved)
	if im, _ := IdentityOfFile(moved); im != ia {
		t.Errorf("a moved file has another identity")
	}
	changed := append([]byte(nil), src...)
	changed[100] ^= 1
	c := filepath.Join(dir, "c.trc")
	os.WriteFile(c, changed, 0o600)
	if ic, _ := IdentityOfFile(c); ic == ia {
		t.Errorf("different content, same identity")
	}
	os.WriteFile(c, append(src, '\n'), 0o600) // same first MiB, other size
	if ic, _ := IdentityOfFile(c); ic == ia {
		t.Errorf("different size, same identity")
	}
	if _, err := IdentityOfFile(filepath.Join(dir, "nope")); err == nil {
		t.Errorf("identity of a missing file")
	}

	x, y := "1111", "2222"
	if TraceIdentity([]string{x, y}) != TraceIdentity([]string{y, x}) {
		t.Errorf("set identity depends on the order")
	}
	base := IdentityOfSet([]string{x, y}, 1, "kept", "")
	for name, other := range map[string]string{
		"order":  IdentityOfSet([]string{y, x}, 1, "kept", ""),
		"format": IdentityOfSet([]string{x, y}, 2, "kept", ""),
		"binds":  IdentityOfSet([]string{x, y}, 1, "redacted", ""),
		"salt":   IdentityOfSet([]string{x, y}, 1, "redacted", IdentitySaltHash("s")),
		"extra":  IdentityOfSet([]string{x, y}, 1, "kept", "", "nofollow=true"),
		"files":  IdentityOfSet([]string{x}, 1, "kept", ""),
	} {
		if (other == base) != (name == "order") {
			t.Errorf("%s: identity equal = %t", name, other == base)
		}
	}
	if TraceIdentity([]string{x, y}) == base {
		t.Errorf("trace identity equals an options identity")
	}
}
