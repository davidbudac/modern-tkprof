package slice

import (
	"context"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/cut"
)

// A check that panics answers an error and frees the gate for the next one.
func TestCutCheckPanic(t *testing.T) {
	m, _ := setup(t)
	s := New(m)
	_, err := s.runCheck(context.Background(), "a", func(context.Context) (*cut.Check, error) { panic("boom") })
	if err == nil || !strings.Contains(err.Error(), "internal error in the cut check: boom") {
		t.Fatalf("the panicking check: %v", err)
	}
	ck, err := s.runCheck(context.Background(), "b", func(context.Context) (*cut.Check, error) { return &cut.Check{OK: true}, nil })
	if err != nil || ck == nil || !ck.OK {
		t.Fatalf("the check after it: %+v, %v", ck, err)
	}
}
