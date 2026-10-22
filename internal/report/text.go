package report

import (
	"io"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// TextOptions control the text report.
type TextOptions struct {
	Sort  string
	Top   int
	Binds int
	Execs int // executions listed per statement: 0 = none, -1 = all
	Sys   bool
	Width int
}

// Text writes the human-readable report (implemented in text_report.go).
func Text(w io.Writer, m *model.Model, o TextOptions) error {
	return writeText(w, m, o)
}
