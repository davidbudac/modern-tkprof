package engine

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestGuarded(t *testing.T) {
	if err := guarded("x", func() error { return nil }); err != nil {
		t.Errorf("nil: %v", err)
	}
	want := errors.New("plain")
	if err := guarded("x", func() error { return want }); err != want {
		t.Errorf("an error passes through: %v", err)
	}
	err := guarded("the names job", func() error {
		var m map[string]int
		m["a"] = 1 // panics
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "internal error in the names job") || !strings.Contains(err.Error(), "guard_test.go") {
		t.Errorf("a panic: %v", err)
	}
}

// A remote job whose work panics ends failed, and the engine goes on.
func TestRemoteJobPanic(t *testing.T) {
	e := newEnv(t)
	j, err := e.srv.remoteJob("fetch", "bytes", "", nil, func(*Job) error { panic("boom") })
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for j.running() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if info := j.Info(); info.State != JobFailed || !strings.Contains(info.Message, "internal error in fetch: boom") {
		t.Errorf("job %+v", info)
	}
	if r := e.req("GET", "/engine/jobs", nil); r.code != 200 {
		t.Errorf("the engine after the panic: %d", r.code)
	}
}
