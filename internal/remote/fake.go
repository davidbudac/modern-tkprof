package remote

import (
	"context"
	"errors"
	"sync"
)

// ErrNoAnswer is what FakePrompter returns when its script has no answer.
var ErrNoAnswer = errors.New("fake prompter: no answer scripted")

// FakePrompter is a scripted Prompter for tests: it records every prompt
// and answers from Answers (in order), then from ByKind; Err (when set) is
// returned instead of an answer.
type FakePrompter struct {
	Answers []string
	ByKind  map[string]string
	Err     error

	mu    sync.Mutex
	asked []Prompt
}

// Ask implements Prompter.
func (f *FakePrompter) Ask(ctx context.Context, p Prompt) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, p)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if f.Err != nil {
		return "", f.Err
	}
	if len(f.Answers) > 0 {
		a := f.Answers[0]
		f.Answers = f.Answers[1:]
		return a, nil
	}
	if a, ok := f.ByKind[p.Kind]; ok {
		return a, nil
	}
	return "", ErrNoAnswer
}

// Prompts are the prompts asked so far.
func (f *FakePrompter) Prompts() []Prompt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Prompt(nil), f.asked...)
}

// Kinds are the kinds of the prompts asked so far, in order.
func (f *FakePrompter) Kinds() []string {
	var out []string
	for _, p := range f.Prompts() {
		out = append(out, p.Kind)
	}
	return out
}
