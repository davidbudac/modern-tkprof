package slice

import (
	"fmt"
	"testing"
)

func TestAnswerCacheInvalidate(t *testing.T) {
	m, _ := setup(t)
	srv := New(m)
	hh := srv.Handler()
	if code := get(t, hh, "/api/statements", nil); code != 200 {
		t.Fatalf("statements: %d", code)
	}
	if len(srv.cache) != 1 || srv.cacheBytes == 0 {
		t.Fatalf("after one answer: %d kept, %d bytes", len(srv.cache), srv.cacheBytes)
	}
	_, _, gen := srv.cached("x")
	srv.Invalidate()
	if len(srv.cache) != 0 || len(srv.order) != 0 || srv.cacheBytes != 0 {
		t.Fatalf("after Invalidate: %d kept, %d in order, %d bytes", len(srv.cache), len(srv.order), srv.cacheBytes)
	}
	srv.store("x", []byte("computed before"), gen)
	if _, ok, _ := srv.cached("x"); ok {
		t.Error("an answer computed before Invalidate was kept")
	}
	if code := get(t, hh, "/api/statements", nil); code != 200 || len(srv.cache) != 1 {
		t.Errorf("after Invalidate the server keeps answers again: %d, %d kept", code, len(srv.cache))
	}
}

func TestAnswerCacheByteCap(t *testing.T) {
	srv := &Server{cache: map[string][]byte{}}
	body := make([]byte, 3<<20)
	for i := 0; i < 20; i++ {
		srv.store(fmt.Sprintf("k%d", i), body, 0)
	}
	sum := 0
	for _, b := range srv.cache {
		sum += len(b)
	}
	if srv.cacheBytes != sum || sum > maxCacheTotal || len(srv.cache) != len(srv.order) {
		t.Fatalf("%d bytes counted, %d kept (cap %d), %d answers, %d in order", srv.cacheBytes, sum, maxCacheTotal, len(srv.cache), len(srv.order))
	}
	if len(srv.cache) != maxCacheTotal/len(body) {
		t.Errorf("%d answers of 3 MiB kept, want %d", len(srv.cache), maxCacheTotal/len(body))
	}
	if _, ok, _ := srv.cached("k0"); ok {
		t.Error("the oldest answer was kept")
	}
	if _, ok, _ := srv.cached("k19"); !ok {
		t.Error("the newest answer was not kept")
	}
	srv.store("big", make([]byte, maxCacheBytes+1), 0)
	if _, ok, _ := srv.cached("big"); ok {
		t.Error("an answer above maxCacheBytes was kept")
	}
}
