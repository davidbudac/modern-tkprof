package model

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// BindMode says what happens to captured bind values before any output is
// produced.
type BindMode int

const (
	BindsKeep   BindMode = iota // values as traced (default)
	BindsRedact                 // values replaced by type, length and a stable hash
	BindsNone                   // bind tables dropped entirely
)

var bindModeNames = [...]string{"kept", "redacted", "none"}

// String is the Diagnostics.BindMode value: kept|redacted|none.
func (m BindMode) String() string {
	if int(m) >= 0 && int(m) < len(bindModeNames) {
		return bindModeNames[m]
	}
	return "bindmode?"
}

// RedactBinds is a post-pass over the bind tables so that every output (text
// report, JSON/HTML document, CSV export, UI) sees the same thing. BindsKeep
// leaves the model untouched.
//
// BindsRedact replaces each non-null value with "<TYPE len=N h=XXXXXXXX>",
// where N is the traced actual length (avl, or the value length when avl is
// absent) and h is the first 8 hex digits of the SHA-256 of the original
// value. The hash is unsalted and stable across runs and platforms, so equal
// values stay recognisable as equal (executions can be correlated); it is not
// meant to keep secrets: short or low-entropy values (numbers, codes, dates)
// can be recovered by brute force. Memory dumps become "<TYPE dump len=N>".
// NULLs, "no oacdef" duplicates and all bind metadata (type, dty, lengths)
// are kept. SQL text, which can contain literals, is not touched.
//
// BindsNone empties Binds and BindSets and unlinks every call from its bind set.
func RedactBinds(m *Model, mode BindMode) {
	switch mode {
	case BindsRedact:
		for i := range m.Binds {
			b := &m.Binds[i]
			if b.IsNull || b.NoDef {
				continue
			}
			b.Value = RedactedValue(b)
		}
		m.Diag.Notes = append(m.Diag.Notes, "bind values redacted (type, length and a stable hash are kept)")
	case BindsNone:
		m.Binds = []Bind{}
		m.BindSets = []BindSet{}
		for i := range m.Calls {
			m.Calls[i].BindSet = None
		}
		m.Diag.Notes = append(m.Diag.Notes, "bind values dropped")
	default:
		return
	}
	m.Diag.BindMode = mode.String()
}

// RedactedValue is the token that replaces a bind value under BindsRedact.
func RedactedValue(b *Bind) string {
	typ := b.TypeName
	if typ == "" {
		typ = fmt.Sprintf("dty%d", b.Dty)
	}
	n := b.Avl
	if n <= 0 {
		n = len(b.Value)
	}
	if b.IsDump {
		return fmt.Sprintf("<%s dump len=%d>", typ, n)
	}
	sum := sha256.Sum256([]byte(b.Value))
	return fmt.Sprintf("<%s len=%d h=%s>", typ, n, hex.EncodeToString(sum[:4]))
}
