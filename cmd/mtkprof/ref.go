package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// refFlag registers -ref dir (report, html, serve, json, export, pivot, plan).
func refFlag(fs *flag.FlagSet) *string {
	return fs.String("ref", "", "reference bundle directory spooled by the script that mtkprof refscript writes (names for obj#, file#, user ids; DBMS_XPLAN text)")
}

// applyRef loads the bundle in dir (if any) and applies it to the model.
func applyRef(m *model.Model, dir string) error {
	if dir == "" {
		return nil
	}
	b, err := ref.LoadBundle(dir)
	if err != nil {
		return err
	}
	if b.Empty() {
		fmt.Fprintf(os.Stderr, "warning: reference bundle %s has no usable files (want objects.csv, datafiles.csv, users.csv, plans/<sql_id>.txt)\n", dir)
		return nil
	}
	model.ApplyRef(m, b)
	fmt.Fprintf(os.Stderr, "reference bundle %s: %s\n", dir, b.Summary())
	return nil
}
