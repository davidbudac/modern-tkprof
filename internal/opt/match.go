package opt

import (
	"bytes"
	"strconv"
	"unicode/utf8"
)

// Small byte-level matchers. The dump is read line by line at a hundred megabytes a second, so nothing here
// uses a regular expression: each helper is the hand-written form of the pattern named beside it.

func hp(b []byte, s string) bool { return len(b) >= len(s) && string(b[:len(s)]) == s }

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v'
}

func isWord(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func trimB(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && isSpace(b[i]) {
		i++
	}
	for j > i && isSpace(b[j-1]) {
		j--
	}
	return b[i:j]
}

func trimRightB(b []byte) []byte {
	j := len(b)
	for j > 0 && isSpace(b[j-1]) {
		j--
	}
	return b[:j]
}

// skipSpace returns b without its leading white space.
func skipSpace(b []byte) []byte {
	i := 0
	for i < len(b) && isSpace(b[i]) {
		i++
	}
	return b[i:]
}

// token returns the leading run of non-space bytes (\S+) and the rest after it.
func token(b []byte) (tok, rest []byte) {
	i := 0
	for i < len(b) && !isSpace(b[i]) {
		i++
	}
	return b[:i], b[i:]
}

// digits returns the leading run of digits and the rest.
func digits(b []byte) (d, rest []byte) {
	i := 0
	for i < len(b) && isDigit(b[i]) {
		i++
	}
	return b[:i], b[i:]
}

func atoi(b []byte) int {
	n, err := strconv.Atoi(string(b))
	if err != nil {
		return 0
	}
	return n
}

func isBlank(b []byte) bool {
	for _, c := range b {
		if !isSpace(c) {
			return false
		}
	}
	return true
}

// leadWord returns the length of the leading \w+ of b when it is followed by ": " ... i.e. the index of the
// colon, or -1 ("^\w+:").
func leadWord(b []byte) int {
	i := 0
	for i < len(b) && isWord(b[i]) {
		i++
	}
	if i == 0 || i >= len(b) || b[i] != ':' {
		return -1
	}
	return i
}

// indentOf counts the leading blanks of b.
func indentOf(b []byte) int {
	i := 0
	for i < len(b) && (b[i] == ' ' || b[i] == '\t') {
		i++
	}
	return i
}

// runeLen is the length of the trimmed text in characters (the mock-up compares JavaScript string lengths).
func runeLen(b []byte) int { return utf8.RuneCount(trimB(b)) }

// classify computes the three shape flags of a line: blank, a separator line (^\s*[*=-]{3,}\s*$) and an
// underline (^\s*[=-]{3,}\s*$).
func classify(b []byte) (blank, sep, under bool) {
	n := len(b)
	i := 0
	for i < n && isSpace(b[i]) {
		i++
	}
	if i == n {
		return true, false, false
	}
	c := b[i]
	if c != '*' && c != '=' && c != '-' {
		return false, false, false
	}
	j := i
	for j < n && (b[j] == '*' || b[j] == '=' || b[j] == '-') {
		j++
	}
	run := j - i
	k := j
	for k < n && isSpace(b[k]) {
		k++
	}
	if k != n || run < 3 {
		return false, false, false
	}
	under = !bytes.Contains(b[i:j], []byte{'*'})
	return false, true, under
}

// isHeadingDash matches the "----- X -----" heading shape (^-{3,} .+ -{3,}\s*$).
func isHeadingDash(b []byte) bool {
	if len(b) < 9 || b[0] != '-' || b[1] != '-' || b[2] != '-' {
		return false
	}
	t := trimRightB(b)
	n := len(t)
	if n < 9 || t[n-1] != '-' || t[n-2] != '-' || t[n-3] != '-' {
		return false
	}
	i := 0
	for i < n && t[i] == '-' {
		i++
	}
	if i >= n || t[i] != ' ' {
		return false
	}
	j := n
	for j > 0 && t[j-1] == '-' {
		j--
	}
	return j > i && t[j-1] == ' ' && j-1 > i
}
