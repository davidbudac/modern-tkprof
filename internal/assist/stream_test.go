package assist

import (
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestStreamCoalesce: the first piece of text goes out at once, the pieces
// after it within 50 ms together, and an event sends the text before it.
func TestStreamCoalesce(t *testing.T) {
	out := &events{}
	s := newStream()
	s.event(StateEvent{Type: "state", State: StateRunning}) // before attach: kept
	s.attach(out, func() error { return nil })
	s.Text("first ")
	if es := out.list(t); len(es) != 2 || es[1].Text != "first " {
		t.Fatalf("the first piece waits: %+v", es)
	}
	var want strings.Builder
	want.WriteString("first ")
	for i := 0; i < 500; i++ {
		p := strconv.Itoa(i) + " "
		want.WriteString(p)
		s.Text(p)
		if i == 250 {
			s.event(UsageEvent{Type: "usage", InputTokens: 1})
		}
	}
	time.Sleep(3 * textEvery)
	s.close(DoneEvent{Type: "done"})
	s.Text("late")
	es := out.list(t)
	if text(es) != want.String() {
		t.Errorf("text %q", text(es))
	}
	n := len(ofType(es, "text"))
	if n > 5 {
		t.Errorf("%d text events for 501 pieces", n)
	}
	got := types(es)
	if !slices.Equal(got, []string{"state", "text", "usage", "text", "done"}) {
		t.Errorf("order %v", got)
	}
	u := slices.IndexFunc(es, func(e ev) bool { return e.Type == "usage" })
	if before := text(es[:u]); !strings.HasSuffix(before, "250 ") {
		t.Errorf("the text before the usage event ends %q", before[len(before)-10:])
	}
}
