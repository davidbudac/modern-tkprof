package trace

import "bytes"

// atoi parses a decimal integer with optional leading '-' from b.
// It returns ok=false when b is empty or contains anything else.
func atoi(b []byte) (int64, bool) {
	if len(b) == 0 {
		return 0, false
	}
	neg := false
	i := 0
	if b[0] == '-' {
		neg = true
		i = 1
		if len(b) == 1 {
			return 0, false
		}
	}
	var n int64
	for ; i < len(b); i++ {
		c := b[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int64(c-'0')
	}
	if neg {
		n = -n
	}
	return n, true
}

// atou parses an unsigned decimal integer.
func atou(b []byte) (uint64, bool) {
	if len(b) == 0 {
		return 0, false
	}
	var n uint64
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, true
}

// cursorNumber parses "#123" at the start of b and returns the number and the
// remainder after the digits.
func cursorNumber(b []byte) (uint64, []byte, bool) {
	if len(b) == 0 || b[0] != '#' {
		return 0, b, false
	}
	i := 1
	var n uint64
	for i < len(b) && b[i] >= '0' && b[i] <= '9' {
		n = n*10 + uint64(b[i]-'0')
		i++
	}
	if i == 1 {
		return 0, b, false
	}
	return n, b[i:], true
}

// eachKV calls fn for every "key=value" pair in b, where pairs are separated
// by sep (',' for call lines, ' ' for STAT lines). Values never contain sep.
func eachKV(b []byte, sep byte, fn func(key, val []byte)) {
	for len(b) > 0 {
		end := bytes.IndexByte(b, sep)
		var pair []byte
		if end < 0 {
			pair = b
			b = nil
		} else {
			pair = b[:end]
			b = b[end+1:]
		}
		pair = bytes.TrimSpace(pair)
		if len(pair) == 0 {
			continue
		}
		eq := bytes.IndexByte(pair, '=')
		if eq < 0 {
			fn(pair, nil)
			continue
		}
		fn(pair[:eq], pair[eq+1:])
	}
}

// hasPrefix is bytes.HasPrefix with a string needle.
func hasPrefix(b []byte, s string) bool {
	return len(b) >= len(s) && string(b[:len(s)]) == s
}

// trimCR strips a trailing carriage return (Windows trace files).
func trimCR(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\r' {
		return b[:n-1]
	}
	return b
}
