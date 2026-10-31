// Package remote reaches traces on other machines: SSH (system binaries or
// the Go library) and Oracle connections (docs/PLAN-DESKTOP.md § 6). Every
// credential is asked for through a Prompter; nothing is stored.
package remote

import (
	"context"
	"strings"
)

// Prompt kinds.
const (
	KindPassword   = "password"
	KindPassphrase = "passphrase"
	KindOTP        = "otp"
	KindHostKey    = "hostkey"
	KindConfirm    = "confirm"
	// KindAPIKey asks for the API key of an assistant provider; Connection is
	// the provider id and Endpoint where the key goes. The answer is held in
	// memory only (assist.Keys).
	KindAPIKey = "apikey"
)

// Prompt is one question to the user: a credential, a one-time code, a host
// key fingerprint to accept, or a yes/no confirmation.
type Prompt struct {
	Connection string // id of the connection asking ("" = none); for KindAPIKey the provider id
	Kind       string // KindPassword, KindPassphrase, KindOTP, KindHostKey, KindConfirm or KindAPIKey
	Text       string // the question as the asking program put it
	Echo       bool   // the answer may be shown while typed
	// Fingerprint is the SHA256 fingerprint of an unknown host key (KindHostKey).
	Fingerprint string
	// Endpoint is where an API key is sent (KindAPIKey): the provider's kind
	// and base URL. A key remembered for a provider id answers only for the
	// same endpoint.
	Endpoint string
}

// ValidKind reports whether k is one of the prompt kinds.
func ValidKind(k string) bool {
	switch k {
	case KindPassword, KindPassphrase, KindOTP, KindHostKey, KindConfirm, KindAPIKey:
		return true
	}
	return false
}

// Answers to KindHostKey and KindConfirm prompts are "yes" to accept;
// anything else declines (Yes).

// Prompter asks the user. Ask blocks until the answer, the user's cancel (an
// error) or the end of ctx. Implementations never store or log answers.
type Prompter interface {
	Ask(ctx context.Context, p Prompt) (string, error)
}

// Yes reports whether a hostkey or confirm answer accepts: "y" or "yes" in
// any case, or the fingerprint itself (as OpenSSH accepts it).
func Yes(answer string, p Prompt) bool {
	a := strings.ToLower(strings.TrimSpace(answer))
	return a == "y" || a == "yes" || (p.Fingerprint != "" && strings.TrimSpace(answer) == p.Fingerprint)
}
