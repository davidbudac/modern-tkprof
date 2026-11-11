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
// can be recovered by brute force. With a salt (RedactBindsSalt, -redact-salt)
// h is the first 8 hex digits of SHA-256(salt + 0x00 + value): equal values
// still match within and across traces redacted with the same salt, but
// tokens cannot be matched against a table of hashes of known values without
// the salt (a guessable value is still brute-forceable by someone who has
// the salt). Memory dumps become "<TYPE dump len=N>".
// NULLs, "no oacdef" duplicates and all bind metadata (type, dty, lengths)
// are kept. SQL text, which can contain literals, is not touched.
//
// BindsNone empties Binds and BindSets and unlinks every call from its bind set.
func RedactBinds(m *Model, mode BindMode) {
	RedactBindsSalt(m, mode, "")
}

// RedactBindsSalt is RedactBinds with a salt for the BindsRedact hash (empty:
// unsalted, as RedactBinds).
func RedactBindsSalt(m *Model, mode BindMode, salt string) {
	switch mode {
	case BindsRedact:
		for i := range m.Binds {
			b := &m.Binds[i]
			if b.IsNull || b.NoDef {
				continue
			}
			b.Value = RedactedValueSalt(b, salt)
		}
		note := "bind values redacted (type, length, stable hash)"
		if salt != "" {
			note = "bind values redacted (type, length, salted hash)"
		}
		m.Diag.Notes = append(m.Diag.Notes, note)
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
	return RedactedValueSalt(b, "")
}

// RedactedValueSalt is RedactedValue with a salted hash (see RedactBindsSalt).
func RedactedValueSalt(b *Bind, salt string) string {
	typ := b.TypeName()
	if typ == "" {
		typ = fmt.Sprintf("dty%d", b.Dty)
	}
	n := int(b.Avl)
	if n <= 0 {
		n = len(b.Value)
	}
	if b.IsDump {
		return fmt.Sprintf("<%s dump len=%d>", typ, n)
	}
	return RedactToken(typ, b.Value, n, salt)
}

// RedactToken is the token "<TYPE len=N h=XXXXXXXX>" of a value of the type
// named typ (length n, the hash of value and salt, see RedactBindsSalt). The
// optimizer (10053) reader redacts a peeked bind with it too, so one value
// has one token in either kind of report.
func RedactToken(typ, value string, n int, salt string) string {
	in := value
	if salt != "" {
		in = salt + "\x00" + in
	}
	sum := sha256.Sum256([]byte(in))
	return fmt.Sprintf("<%s len=%d h=%s>", typ, n, hex.EncodeToString(sum[:4]))
}
