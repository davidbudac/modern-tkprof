package assist

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
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
	BaseURL string            `json:"baseUrl,omitempty"` // openai: up to /v1, without /chat/completions
	Model   string            `json:"model,omitempty"`   // claude, codex: "" is the CLI's default
	Headers map[string]string `json:"headers,omitempty"` // openai: extra request headers, none secret
	Auth    string            `json:"auth,omitempty"`    // one of the kind's auth modes; "" is its default
}

// Provider auth modes.
const (
	AuthBearer = "bearer" // a key from the key prompt: openai's Authorization, codex's CODEX_API_KEY
	AuthNone   = "none"   // no key (a local server)
	AuthLogin  = "login"  // the CLI's own login
)

// BackendKind is a provider kind: how its providers are checked and its
// backend is made.
type BackendKind struct {
	New          func(Provider) (Backend, error)
	HTTP         bool     // an HTTP endpoint: baseUrl and model are required, headers allowed
	Auth         []string // the auth modes it takes, its default first
	Command      string   // the CLI agent it runs ("" none)
	Experimental bool     // labelled experimental in the app
	// Login asks the CLI at path whether it is logged in, and how.
	Login func(ctx context.Context, path string) (ok bool, how string, err error)
}

// Backends are the provider kinds by name.
var Backends = map[string]BackendKind{
	"openai": {New: newOpenAI, HTTP: true, Auth: []string{AuthBearer, AuthNone}},
	"claude": {New: newClaudeCLI, Command: "claude", Auth: []string{AuthLogin}, Login: claudeLogin},
	"codex":  {New: newCodexCLI, Command: "codex", Auth: []string{AuthLogin, AuthBearer}, Experimental: true, Login: codexLogin},
}

// BackendKinds are the names of Backends, sorted.
func BackendKinds() []string {
	var kinds []string
	for k := range Backends {
		kinds = append(kinds, k)
	}
	slices.Sort(kinds)
	return kinds
}

var (
	reProviderID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	reHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$")
	reCLIModel   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$`) // a CLI argument, never an option
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
func (p Provider) needsKey() bool { return p.Auth != AuthNone && p.Auth != AuthLogin }

// endpoint is where the provider's key is sent: its kind and, for an HTTP
// kind, its base URL ("openai https://api.example.com/v1", "codex"). A key is
// bound to it, so a provider id reused for another endpoint asks again.
func (p Provider) endpoint() string {
	if p.BaseURL == "" {
		return p.Kind
	}
	return p.Kind + " " + p.BaseURL
}

// Check validates a provider definition and sets the default auth; an error
// says what is wrong.
func (p *Provider) Check() error {
	if !reProviderID.MatchString(p.ID) {
		return fmt.Errorf("provider.id: want 1 to 128 letters, digits and . _ : - (starting with a letter or digit)")
	}
	k, ok := Backends[p.Kind]
	if !ok {
		return fmt.Errorf("provider.kind: %q is not one of %s", p.Kind, strings.Join(BackendKinds(), ", "))
	}
	switch {
	case p.Auth == "":
		p.Auth = k.Auth[0]
	case !slices.Contains(k.Auth, p.Auth):
		return fmt.Errorf("provider.auth: kind %s takes %s", p.Kind, strings.Join(k.Auth, " or "))
	}
	if len(p.Name) > 200 {
		return fmt.Errorf("provider.name: more than 200 bytes")
	}
	if !k.HTTP {
		switch {
		case p.BaseURL != "" || len(p.Headers) > 0:
			return fmt.Errorf("provider: kind %s runs the %s CLI and takes no baseUrl or headers", p.Kind, k.Command)
		case p.Model != "" && !reCLIModel.MatchString(p.Model):
			return fmt.Errorf("provider.model: want a model name of letters, digits and . _ : / @ [ ] -")
		}
		return nil
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

// Keys holds the API keys of the providers in memory, by provider id and
// bound to the provider's endpoint, for as long as the engine runs or until
// Forget. A key comes only from a prompt (kind apikey, Prompt.Connection = the
// provider id, Prompt.Endpoint = Provider.endpoint) and is never written or
// logged.
type Keys struct {
	Prompter remote.Prompter

	mu     sync.Mutex
	held   map[string]heldKey
	asking map[heldSlot]*keyAsk // one prompt per provider and endpoint at a time
}

type heldKey struct{ endpoint, key string }

type heldSlot struct{ id, endpoint string }

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
	slot := heldSlot{p.ID, p.endpoint()}
	for {
		k.mu.Lock()
		if h, ok := k.held[p.ID]; ok && h.endpoint == slot.endpoint {
			k.mu.Unlock()
			return h.key, nil
		}
		a := k.asking[slot]
		mine := a == nil
		if mine {
			a = &keyAsk{done: make(chan struct{})}
			if k.asking == nil {
				k.asking = map[heldSlot]*keyAsk{}
			}
			k.asking[slot] = a
		}
		k.mu.Unlock()
		if wait != nil {
			wait()
			wait = nil
		}
		if mine {
			return k.ask(ctx, p, slot, a)
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

func (k *Keys) ask(ctx context.Context, p Provider, slot heldSlot, a *keyAsk) (string, error) {
	where := p.BaseURL
	if where == "" {
		where = "the " + Backends[p.Kind].Command + " CLI"
	}
	key, err := k.Prompter.Ask(ctx, remote.Prompt{Connection: p.ID, Kind: remote.KindAPIKey, Endpoint: slot.endpoint,
		Text: fmt.Sprintf("API key for %s (%s)", p.label(), where)})
	key = strings.TrimSpace(key)
	if err == nil && key == "" {
		err = errors.New("empty key")
	}
	k.mu.Lock()
	delete(k.asking, slot)
	if err == nil {
		if k.held == nil {
			k.held = map[string]heldKey{}
		}
		k.held[p.ID] = heldKey{slot.endpoint, key}
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
