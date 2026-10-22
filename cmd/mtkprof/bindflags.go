package main

import (
	"flag"
	"fmt"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// bindFlags collects the bind-value handling flags shared by report, html,
// json, export and serve. When several are given the most restrictive wins
// (none > redact > keep).
type bindFlags struct {
	mode model.BindMode
}

const bindModeHelp = "keep|redact|none: redact replaces values with type, length and a stable hash " +
	"(for correlating equal values across executions, not secrecy: short values can be brute-forced; SQL text is not redacted); none drops bind values"

func (b *bindFlags) set(v string) error {
	var m model.BindMode
	switch v {
	case "keep", "kept":
		m = model.BindsKeep
	case "redact", "redacted":
		m = model.BindsRedact
	case "none":
		m = model.BindsNone
	default:
		return fmt.Errorf("want keep, redact or none")
	}
	if m > b.mode {
		b.mode = m
	}
	return nil
}

func (b *bindFlags) register(fs *flag.FlagSet) {
	fs.BoolFunc("redact-binds", "shorthand for -bind-values redact", func(v string) error {
		on, err := strconv.ParseBool(v)
		if err != nil {
			return err
		}
		if on {
			return b.set("redact")
		}
		return nil
	})
	fs.Func("bind-values", bindModeHelp+" (default keep)", b.set)
}

// addBindFlags registers -redact-binds, -bind-values and -binds keep|redact|none.
func addBindFlags(fs *flag.FlagSet) *bindFlags {
	b := &bindFlags{}
	b.register(fs)
	fs.Func("binds", "same as -bind-values: keep|redact|none", b.set)
	return b
}

// addReportBindFlags is addBindFlags for the text report, where -binds also
// takes the number of bind sets to print per statement (N, default *n).
func addReportBindFlags(fs *flag.FlagSet, n *int) *bindFlags {
	b := &bindFlags{}
	b.register(fs)
	fs.Func("binds", fmt.Sprintf("N bind sets to print per statement (0 = none, default %d), or keep|redact|none as for -bind-values", *n), func(v string) error {
		if k, err := strconv.Atoi(v); err == nil {
			if k < 0 {
				return fmt.Errorf("negative count")
			}
			*n = k
			return nil
		}
		if err := b.set(v); err != nil {
			return fmt.Errorf("want a count N, keep, redact or none")
		}
		return nil
	})
	return b
}

// apply redacts or drops the model's bind values as requested.
func (b *bindFlags) apply(m *model.Model) {
	model.RedactBinds(m, b.mode)
}
