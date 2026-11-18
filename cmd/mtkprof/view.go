package main

import (
	"flag"
	"fmt"
	"path/filepath"

	"github.com/davidbudac/modern-tkprof/internal/diag"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	slicepkg "github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// How a file is read by the commands that show one (report, html, json, the default command, serve): as a
// SQL trace (10046), an optimizer dump file (10053) or a diagnostic dump file (diag). The file decides
// (model.DefaultView); -view opens a single file another way, as the engine's session option "view" does.

// viewReq is the -view flag of the command being run ("" when it has none, or the file decides).
var viewReq string

// inputCount is how many files the last buildModel reads (directories expanded; a 10053 or diag file left
// out of a set is not counted, and a set of files with no 10046 record is its first file).
var inputCount int

type viewFlag struct{}

func (viewFlag) String() string { return viewReq }
func (viewFlag) Set(v string) error {
	if _, err := model.ParseView(v); err != nil {
		return err
	}
	viewReq = v
	return nil
}

// addViewFlag registers -view on fs.
func addViewFlag(fs *flag.FlagSet) {
	viewReq = "" // each command starts from the file's own view
	fs.Var(viewFlag{}, "view", "open a single file as 10046 (SQL trace), 10053 (optimizer dumps, also of a trace that has them interleaved) or diag (an outline of the file, which holds diagnostic dumps or not); default: what the file is")
}

// viewIn is how the model of a command was resolved: the view and, for 10053 and diag, what the document and
// the text report are made from.
type viewIn struct {
	view string
	opt  *report.OptInput
	diag *report.DiagInput
	rd   *diag.Reader
	// dm is the model the document is made of: the model itself, or that of an empty 10046 model when a trace
	// with records is read as 10053 or diag.
	dm   *model.Model
	done func()
}

// options adds the view's part to the options of a document.
func (v *viewIn) options(o report.DocOptions) report.DocOptions {
	o.Opt, o.Diag = v.opt, v.diag
	return o
}

// openView decides how the model is read and opens what that needs: the 10053 scan, or the diag scan with
// its line index. digest puts the digest in the document (a client without a server); lines opens the file
// for its text (the digest, the text report). The returned done releases what was opened.
func openView(m *model.Model, bf *bindFlags, digest, lines bool) (*viewIn, error) {
	v := &viewIn{dm: m, done: func() {}}
	view, err := model.ResolveView(m, viewReq, inputCount)
	if err != nil {
		return nil, err
	}
	switch view {
	case model.View10053:
		in, done, err := optInputView(m, bf, digest, lines, viewReq == model.View10053)
		if err != nil {
			return nil, err
		}
		if in == nil { // not a pure 10053 file: the 10046 trace it is
			if viewReq != "" {
				return nil, fmt.Errorf("%s: no optimizer (10053) dump could be read", filepath.Base(m.File.Files[0].Path))
			}
			view = model.View10046
			break
		}
		v.opt, v.done = in, done
	case model.ViewDiag:
		path := m.File.Files[0].Path
		var rd *diag.Reader
		if lines || digest {
			rd, err = diag.OpenFile(path)
		} else {
			var sc *diag.Scan
			if sc, err = diag.ScanFile(path); err == nil {
				rd = diag.NewReader(sc, nil)
			}
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
		in, err := report.NewDiagInput(rd, digest)
		if err != nil {
			rd.Close()
			return nil, err
		}
		v.diag, v.rd, v.done = in, rd, func() { rd.Close() }
	}
	v.view = view
	if view != model.View10046 {
		v.dm = m.ViewModel()
	}
	return v, nil
}

// diagServer is the routes of the diag file of v for serve, nil for any other view; lis is the line index
// of its file.
func diagServer(m *model.Model, v *viewIn, lis []*trace.LineIndex) *slicepkg.DiagServer {
	if v.diag == nil || len(lis) == 0 {
		return nil
	}
	return slicepkg.NewDiagServer(m.File.Files[0].Path, v.rd.Scan, lis[0])
}

// diagRefusal is the one line for a command that reads SQL traces only, given a file of diagnostic dumps:
// "<name> is a diag file (diagnostic dumps, no SQL trace records): <nothing to ...>; mtkprof report prints
// its digest". "" when the model is not that of one.
func diagRefusal(m *model.Model, nothing string) string {
	if m.HasRecords() || m.HasDumps() || len(m.File.Files) == 0 || len(m.File.Files[0].Sections) == 0 {
		return ""
	}
	return fmt.Sprintf("%s is a diag file (diagnostic dumps, no SQL trace records): %s; mtkprof report prints its digest", filepath.Base(m.File.Files[0].Path), nothing)
}
