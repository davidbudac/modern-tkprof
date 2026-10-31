package assist

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// Provider is where a conversation's model runs, as the desktop defines it.
// It never holds a secret: the key is asked for through a prompt (Keys).
type Provider struct {
	ID      string            `json:"id"`
	Kind    string            `json:"kind"` // a key of Backends
	Name    string            `json:"name,omitempty"`
	BaseURL string            `json:"baseUrl"` // openai: up to /v1, without /chat/completions
	Model   string            `json:"model"`
	Headers map[string]string `json:"headers,omitempty"` // extra request headers, none secret
	Auth    string            `json:"auth,omitempty"`    // bearer (default): the key goes in Authorization; none: no key (a local server)
}

// Provider auth modes.
const (
	AuthBearer = "bearer"
	AuthNone   = "none"
)

// Backends makes the backend of a provider kind.
var Backends = map[string]func(Provider) Backend{
	"openai": newOpenAI,
}

var (
	reProviderID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	reHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$")
	// header names that carry credentials: the key goes through the key prompt
	secretHeaderWords = []string{"auth", "key", "token", "secret", "password", "cookie"}
)

const maxProviderHeaders = 20

// label is how a prompt names the provider.
func (p Provider) label() string {
	if p.Name != "" {
		return p.Name
	}
	return p.ID
}

// needsKey says whether the provider is given a key.
func (p Provider) needsKey() bool { return p.Auth != AuthNone }

// Check validates a provider definition; an error says what is wrong.
func (p *Provider) Check() error {
	if !reProviderID.MatchString(p.ID) {
		return fmt.Errorf("provider.id: want 1 to 128 letters, digits and . _ : - (starting with a letter or digit)")
	}
	if Backends[p.Kind] == nil {
		var kinds []string
		for k := range Backends {
			kinds = append(kinds, k)
		}
		return fmt.Errorf("provider.kind: %q is not one of %s", p.Kind, strings.Join(kinds, ", "))
	}
	switch p.Auth {
	case "":
		p.Auth = AuthBearer
	case AuthBearer, AuthNone:
	default:
		return fmt.Errorf("provider.auth: want bearer or none")
	}
	u, err := url.Parse(p.BaseURL)
	switch {
	case err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "":
		return fmt.Errorf("provider.baseUrl: want an http or https URL")
	case u.User != nil || u.RawQuery != "" || u.Fragment != "":
		return fmt.Errorf("provider.baseUrl: no user, query or fragment (a key goes through the key prompt)")
	}
	if p.Model == "" || len(p.Model) > 200 {
		return fmt.Errorf("provider.model: want 1 to 200 bytes")
	}
	if len(p.Name) > 200 {
		return fmt.Errorf("provider.name: more than 200 bytes")
	}
	if len(p.Headers) > maxProviderHeaders {
		return fmt.Errorf("provider.headers: more than %d", maxProviderHeaders)
	}
	for k, v := range p.Headers {
		if !reHeaderName.MatchString(k) {
			return fmt.Errorf("provider.headers: %q is not a header name", k)
		}
		lk, lv := strings.ToLower(k), strings.ToLower(strings.TrimSpace(v))
		for _, w := range secretHeaderWords {
			if strings.Contains(lk, w) {
				return fmt.Errorf("provider.headers: %q looks like a credential; the key is asked for through the key prompt", k)
			}
		}
		if strings.HasPrefix(lv, "bearer ") || strings.HasPrefix(lv, "basic ") {
			return fmt.Errorf("provider.headers: the value of %q looks like a credential", k)
		}
		if len(v) > 1000 || strings.ContainsAny(v, "\r\n") {
			return fmt.Errorf("provider.headers: the value of %q is not one line of at most 1000 bytes", k)
		}
	}
	return nil
}

// Keys holds the API keys of the providers in memory, by provider id, for as
// long as the engine runs or until Forget. A key comes only from a prompt
// (kind apikey, Prompt.Connection = the provider id) and is never written or
// logged.
type Keys struct {
	Prompter remote.Prompter

	mu     sync.Mutex
	held   map[string]string
	asking map[string]*keyAsk // one prompt per provider at a time
}

type keyAsk struct {
	done chan struct{}
	key  string
	err  error
}

// Get returns the key of p, asking for it when none is held. wait is called
// once, before Get blocks on a prompt (its own or another turn's). A
// cancelled prompt is a *TurnError with code no_key; the end of ctx is
// ctx.Err().
func (k *Keys) Get(ctx context.Context, p Provider, wait func()) (string, error) {
	for {
		k.mu.Lock()
		if key, ok := k.held[p.ID]; ok {
			k.mu.Unlock()
			return key, nil
		}
		a := k.asking[p.ID]
		mine := a == nil
		if mine {
			a = &keyAsk{done: make(chan struct{})}
			if k.asking == nil {
				k.asking = map[string]*keyAsk{}
			}
			k.asking[p.ID] = a
		}
		k.mu.Unlock()
		if wait != nil {
			wait()
			wait = nil
		}
		if mine {
			return k.ask(ctx, p, a)
		}
		select {
		case <-a.done:
			if a.err == nil {
				return a.key, nil
			}
			if !errors.Is(a.err, context.Canceled) && !errors.Is(a.err, context.DeadlineExceeded) {
				return "", noKey()
			}
			// the turn that asked went away: ask again
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func (k *Keys) ask(ctx context.Context, p Provider, a *keyAsk) (string, error) {
	key, err := k.Prompter.Ask(ctx, remote.Prompt{Connection: p.ID, Kind: remote.KindAPIKey,
		Text: fmt.Sprintf("API key for %s (%s)", p.label(), p.BaseURL)})
	key = strings.TrimSpace(key)
	if err == nil && key == "" {
		err = errors.New("empty key")
	}
	k.mu.Lock()
	delete(k.asking, p.ID)
	if err == nil {
		if k.held == nil {
			k.held = map[string]string{}
		}
		k.held[p.ID] = key
	}
	a.key, a.err = key, err
	close(a.done)
	k.mu.Unlock()
	switch {
	case err == nil:
		return key, nil
	case ctx.Err() != nil:
		return "", ctx.Err()
	}
	return "", noKey()
}

func noKey() error {
	return &TurnError{Code: CodeNoKey, Message: "no API key: the key prompt was cancelled"}
}

// Forget drops the key of provider id; the next turn asks again.
func (k *Keys) Forget(id string) {
	k.mu.Lock()
	delete(k.held, id)
	k.mu.Unlock()
}
