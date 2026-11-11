package opt

import (
	"strings"
	"unicode/utf8"
)

// The pretty-printer of docs/mockups/10053-reader/src/sqlfmt.js: one-line SQL with clause keywords on new
// lines, AND / OR of a WHERE on their own lines, subqueries indented, long lists broken at their top-level
// commas. It is not a parser: it reads tokens and parentheses only.

type sqlTok struct {
	t byte // 'q' quoted identifier, 's' string, 'c' comment, 'w' white space, 'b' bind, 'k' keyword, 'i' word, 'n' number, 'p' punctuation
	v string
}

var sqlKW = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range strings.Fields("SELECT FROM WHERE AND OR NOT IN EXISTS ANY ALL SOME GROUP BY ORDER HAVING UNION INTERSECT MINUS JOIN LEFT RIGHT OUTER " +
		"INNER FULL CROSS ON AS CASE WHEN THEN ELSE END NULL IS LIKE BETWEEN DISTINCT WITH CONNECT START PRIOR DESC ASC NULLS FIRST LAST " +
		"OVER PARTITION ROWNUM LATERAL APPLY FETCH OFFSET ROWS ONLY") {
		m[k] = true
	}
	return m
}()

func isWordStart(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' || c == '$' || c == '#'
}

func isWordPart(c byte) bool { return isWordStart(c) || isDigit(c) }

func sqlTokens(s string) []sqlTok {
	var out []sqlTok
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case c == '"':
			j := strings.IndexByte(s[i+1:], '"')
			e := n
			if j >= 0 {
				e = i + 1 + j + 1
			}
			out = append(out, sqlTok{'q', s[i:e]})
			i = e
		case c == '\'':
			j := i + 1
			for j < n && !(s[j] == '\'' && !(j+1 < n && s[j+1] == '\'')) {
				if s[j] == '\'' {
					j += 2
				} else {
					j++
				}
			}
			e := j + 1
			if e > n {
				e = n
			}
			out = append(out, sqlTok{'s', s[i:e]})
			i = e
		case c == '/' && i+1 < n && s[i+1] == '*':
			j := strings.Index(s[i+2:], "*/")
			e := n
			if j >= 0 {
				e = i + 2 + j + 2
			}
			out = append(out, sqlTok{'c', s[i:e]})
			i = e
		case c == '-' && i+1 < n && s[i+1] == '-':
			j := strings.IndexByte(s[i:], '\n')
			e := n
			if j >= 0 {
				e = i + j
			}
			out = append(out, sqlTok{'c', s[i:e]})
			i = e
		case isSpace(c):
			j := i
			for j < n && isSpace(s[j]) {
				j++
			}
			out = append(out, sqlTok{'w', s[i:j]})
			i = j
		case c == ':' && i+1 < n && isWord(s[i+1]):
			j := i + 1
			for j < n && j < i+40 && isWord(s[j]) {
				j++
			}
			out = append(out, sqlTok{'b', s[i:j]})
			i = j
		case isWordStart(c):
			j := i
			for j < n && j < i+200 && isWordPart(s[j]) {
				j++
			}
			w := s[i:j]
			t := byte('i')
			if sqlKW[strings.ToUpper(w)] {
				t = 'k'
			}
			out = append(out, sqlTok{t, w})
			i = j
		case isDigit(c):
			j := i
			for j < n && j < i+40 && isDigit(s[j]) {
				j++
			}
			if j+1 < n && s[j] == '.' && isDigit(s[j+1]) {
				j++
				for j < n && j < i+40 && isDigit(s[j]) {
					j++
				}
			}
			if j < n && (s[j] == 'e' || s[j] == 'E') {
				k := j + 1
				if k < n && (s[k] == '+' || s[k] == '-') {
					k++
				}
				if k < n && isDigit(s[k]) {
					for k < n && k < i+40 && isDigit(s[k]) {
						k++
					}
					j = k
				}
			}
			out = append(out, sqlTok{'n', s[i:j]})
			i = j
		default:
			// one character, whole when it is a multi-byte one
			_, w := utf8.DecodeRuneInString(s[i:])
			out = append(out, sqlTok{'p', s[i : i+w]})
			i += w
		}
	}
	return out
}

var sqlClauses = [][]string{{"SELECT"}, {"FROM"}, {"WHERE"}, {"GROUP", "BY"}, {"HAVING"}, {"ORDER", "BY"}, {"UNION", "ALL"}, {"UNION"},
	{"INTERSECT"}, {"MINUS"}, {"CONNECT", "BY"}, {"START", "WITH"}}

type sqlLevel struct {
	paren  int
	clause string
}

// FormatSQL pretty-prints one statement; the lines are joined with "\n".
func FormatSQL(stmt string) string { return strings.Join(FormatSQLLines(stmt), "\n") }

// FormatSQLLines pretty-prints one statement and returns its lines.
func FormatSQLLines(stmt string) []string {
	tk := sqlTokens(strings.TrimSpace(stmt))
	var lines []string
	cur := ""
	lvl := []sqlLevel{{}}
	depth := 0
	ind := func(n int) string { return strings.Repeat("  ", n) }
	brk := func(indent string) {
		if strings.TrimSpace(cur) != "" {
			lines = append(lines, strings.TrimRight(cur, " \t\r\n\f\v"))
		}
		cur = indent
	}
	kwAt := func(k int) (string, int, bool) {
		for _, c := range sqlClauses {
			j := k
			ok := true
			for _, part := range c {
				for j < len(tk) && tk[j].t == 'w' {
					j++
				}
				if j >= len(tk) || strings.ToUpper(tk[j].v) != part {
					ok = false
					break
				}
				j++
			}
			if ok {
				return strings.Join(c, " "), j, true
			}
		}
		return "", 0, false
	}
	for k := 0; k < len(tk); k++ {
		t := tk[k]
		L := len(lvl) - 1
		top := &lvl[L]
		if t.t == 'w' {
			if cur != "" && !strings.HasSuffix(cur, " ") {
				cur += " "
			}
			continue
		}
		if t.t == 'k' || t.t == 'i' {
			if depth == top.paren {
				if c, end, ok := kwAt(k); ok {
					brk(ind(2 * L))
					cur += c
					top.clause = c
					k = end - 1
					continue
				}
			}
			u := strings.ToUpper(t.v)
			if (u == "AND" || u == "OR") && depth == top.paren {
				switch top.clause {
				case "WHERE", "HAVING", "START WITH", "CONNECT BY":
					brk(ind(2*L + 1))
					cur += u
					continue
				}
			}
		}
		if t.v == "(" {
			j := k + 1
			for j < len(tk) && tk[j].t == 'w' {
				j++
			}
			depth++
			if j < len(tk) && strings.ToUpper(tk[j].v) == "SELECT" {
				cur += "("
				lvl = append(lvl, sqlLevel{paren: depth})
				continue
			}
			cur += "("
			continue
		}
		if t.v == ")" {
			if len(lvl) > 1 && lvl[L].paren == depth {
				lvl = lvl[:L]
				cur = strings.TrimRight(cur, " \t\r\n\f\v") + ")"
				depth--
				continue
			}
			depth--
			cur = strings.TrimRight(cur, " \t\r\n\f\v") + ")"
			continue
		}
		if t.v == "," && depth == top.paren && top.clause == "FROM" {
			cur += ","
			brk(ind(2*L + 1))
			continue
		}
		cur += t.v
	}
	brk("")
	// long SELECT / GROUP BY / ORDER BY lines: one item per line at their top-level commas
	var out []string
	for _, l := range lines {
		if utf8.RuneCountInString(l) <= 96 {
			out = append(out, l)
			continue
		}
		lead, kw, rest, ok := splitClause(l)
		if !ok {
			out = append(out, l)
			continue
		}
		parts := splitTop(rest)
		if len(parts) < 2 {
			out = append(out, l)
			continue
		}
		out = append(out, lead+kw+" "+parts[0]+",")
		pad := strings.Repeat(" ", len(kw)+1)
		for k, p := range parts[1:] {
			s := lead + pad + strings.TrimSpace(p)
			if k < len(parts)-2 {
				s += ","
			}
			out = append(out, s)
		}
	}
	return out
}

// splitClause matches ^(\s*)(SELECT|GROUP BY|ORDER BY)\s and returns the pieces.
func splitClause(l string) (lead, kw, rest string, ok bool) {
	i := 0
	for i < len(l) && isSpace(l[i]) {
		i++
	}
	for _, k := range []string{"SELECT", "GROUP BY", "ORDER BY"} {
		if strings.HasPrefix(l[i:], k) && i+len(k) < len(l) && isSpace(l[i+len(k)]) {
			return l[:i], k, l[i+len(k)+1:], true
		}
	}
	return
}

func splitTop(s string) []string {
	var parts []string
	d := 0
	var q byte
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == q {
				q = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			q = c
		case '(':
			d++
		case ')':
			d--
		case ',':
			if d == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, s[start:])
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}
