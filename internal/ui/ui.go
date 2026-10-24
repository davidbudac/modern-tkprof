// Package ui embeds the single-file web UI built from web/ (see Makefile:
// `make web` writes web/dist/index.html to dist/index.html here).
package ui

import (
	_ "embed"
	"io"
	"strings"
)

//go:embed dist/index.html
var indexHTML string

// Placeholder is replaced by the inline data script in standalone reports.
const Placeholder = "<!--MTKPROF_DATA-->"

// Index returns the UI page without data (the UI then loads /api/doc).
func Index() string { return indexHTML }

// Standalone returns the UI page with the JSON document inlined.
func Standalone(docJSON []byte) string {
	var b strings.Builder
	b.Grow(len(indexHTML) + len(docJSON) + 100)
	i := strings.Index(indexHTML, Placeholder)
	if i < 0 {
		i = strings.Index(indexHTML, "</head>")
		if i < 0 {
			i = 0
		}
		b.WriteString(indexHTML[:i])
		b.WriteString(`<script id="mtkprof-data" type="application/json">`)
		b.Write(docJSON)
		b.WriteString("</script>")
		b.WriteString(indexHTML[i:])
		return b.String()
	}
	b.WriteString(indexHTML[:i])
	b.WriteString(`<script id="mtkprof-data" type="application/json">`)
	b.Write(docJSON) // encoding/json escapes <, > and & so "</script>" cannot occur
	b.WriteString("</script>")
	b.WriteString(indexHTML[i+len(Placeholder):])
	return b.String()
}

// WriteStandalone is Standalone writing to w: the page up to the data, whatever
// doc writes (the JSON document), and the rest of the page. A large document
// is never held in memory next to the page.
func WriteStandalone(w io.Writer, doc func(io.Writer) error) error {
	head, tail := indexHTML, ""
	if i := strings.Index(indexHTML, Placeholder); i >= 0 {
		head, tail = indexHTML[:i], indexHTML[i+len(Placeholder):]
	} else if i := strings.Index(indexHTML, "</head>"); i >= 0 {
		head, tail = indexHTML[:i], indexHTML[i:]
	} else {
		head, tail = "", indexHTML
	}
	if _, err := io.WriteString(w, head+`<script id="mtkprof-data" type="application/json">`); err != nil {
		return err
	}
	if err := doc(w); err != nil { // encoding/json escapes <, > and & so "</script>" cannot occur
		return err
	}
	_, err := io.WriteString(w, "</script>"+tail)
	return err
}

// Built reports whether a real UI build is embedded.
func Built() bool { return !strings.Contains(indexHTML, "has not been built") }
