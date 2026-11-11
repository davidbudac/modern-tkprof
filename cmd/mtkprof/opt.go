package main

import (
	"fmt"
	"path/filepath"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/opt"
	"github.com/davidbudac/modern-tkprof/internal/report"
	slicepkg "github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The 10053 (optimizer trace) file in the commands: report, html, json, the
// default command and serve read it with internal/opt; the commands that
// have nothing to show for it say so (buildTrace).

// optNotes are the notes of the inputs left out of the last model buildModel
// made (10053 files of a mixed set, the 10053 files after the first of a set
// of them).
var optNotes []string

// buildTrace is buildModel for a command that has nothing to show for a 10053
// file: it fails with one line for it. nothing completes "<name> is a 10053
// file: ", e.g. "nothing to pivot".
func buildTrace(nothing string, files []string, noFollow bool) (*model.Model, error) {
	m, err := buildModel(files, noFollow)
	if err != nil {
		return nil, err
	}
	if m.OptOnly() {
		return nil, fmt.Errorf("%s is a 10053 file: %s; mtkprof report prints its digest", filepath.Base(m.File.Files[0].Path), nothing)
	}
	return m, nil
}

// optInput is the input for the document and the text report of the model of
// a 10053 file, nil for any other model. digest puts the digest in the
// document (a client without a server); lines opens the file for its text
// (digest, and the text report's plan table); the returned function closes
// it.
func optInput(m *model.Model, bf *bindFlags, digest, lines bool) (*report.OptInput, func(), error) {
	sc, err := report.OptScan(m)
	if err != nil || sc == nil {
		return nil, func() {}, err
	}
	in := &report.OptInput{Scan: sc, Digest: digest, Text: report.OptBindText(bf.mode, bf.salt)}
	done := func() {}
	if lines || digest {
		line, closeFn, err := opt.FileLines(m.File.Files[0].Path)
		if err != nil {
			return nil, done, err
		}
		in.Line, done = line, func() { closeFn() }
	}
	return in, done, nil
}

// withOpt adds the 10053 part to the options of a document (o.Opt stays nil
// for any other model). It returns the function that releases what it opened.
func withOpt(o report.DocOptions, m *model.Model, bf *bindFlags, digest bool) (report.DocOptions, func(), error) {
	in, done, err := optInput(m, bf, digest, digest)
	o.Opt = in
	return o, done, err
}

// optServer is the routes of the 10053 file of m for serve, nil for any
// other model; lis is the line index of its file.
func optServer(m *model.Model, in *report.OptInput, lis []*trace.LineIndex) *slicepkg.OptServer {
	if in == nil || len(lis) != 1 {
		return nil
	}
	return slicepkg.NewOptServer(m.File.Files[0].Path, in.Scan, lis[0])
}
