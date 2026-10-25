// Package remote reaches traces on other machines: SSH (system binaries or
// the Go library) and Oracle connections (docs/PLAN-DESKTOP.md § 6). Every
// credential is asked for through a Prompter; nothing is stored.
package remote

import "context"

// Prompt kinds.
const (
	KindPassword   = "password"
	KindPassphrase = "passphrase"
	KindOTP        = "otp"
	KindHostKey    = "hostkey"
	KindConfirm    = "confirm"
)

// Prompt is one question to the user: a credential, a one-time code, a host
// key fingerprint to accept, or a yes/no confirmation.
type Prompt struct {
	Connection string // id of the connection asking ("" = none)
	Kind       string // KindPassword, KindPassphrase, KindOTP, KindHostKey or KindConfirm
	Text       string // the question as the asking program put it
	Echo       bool   // the answer may be shown while typed
}

// ValidKind reports whether k is one of the prompt kinds.
func ValidKind(k string) bool {
	switch k {
	case KindPassword, KindPassphrase, KindOTP, KindHostKey, KindConfirm:
		return true
	}
	return false
}

// Prompter asks the user. Ask blocks until the answer, the user's cancel (an
// error) or the end of ctx. Implementations never store or log answers.
type Prompter interface {
	Ask(ctx context.Context, p Prompt) (string, error)
}
