package slice

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/davidbudac/modern-tkprof/internal/binfmt"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// A persisted spill (SpillOptions.Persist) adds spill.idx to the files: what
// diskSource needs besides the files and that the build only kept in memory.
// OpenSpill reads it back and serves the directory without writing.

// SpillIdxVersion is the format version of spill.idx. The record layouts of
// the other files (layout.go) are covered by it too: a change there bumps it.
const SpillIdxVersion = 1

const spillIdxMagic = "MTKPSIDX"

// SpillFiles are the files of a persisted spill directory.
var SpillFiles = []string{"calls.bin", "waits.bin", "bindsets.bin", "binds.bin", "bindvals.bin", "calls.stmt", "waits.stmt", "spill.idx"}

// spillIdx is the content of spill.idx.
type spillIdx struct {
	nCalls, nWaits, nSets, nBinds, nVal int64
	cstarts, wstarts                    []int64
	callCtx, waitCtx                    []rowRange
}

func codeSpillIdx(c *binfmt.Codec, x *spillIdx) {
	recs := []int64{callRec, waitRec, setRec, bindRec}
	for i := range recs {
		v := recs[i]
		c.I64(&v)
		if c.Reading() && v != recs[i] {
			c.R.Failf("record size %d, want %d", v, recs[i])
		}
	}
	for _, p := range []*int64{&x.nCalls, &x.nWaits, &x.nSets, &x.nBinds, &x.nVal} {
		c.I64(p)
	}
	binfmt.Slice(c, &x.cstarts, c.I64)
	binfmt.Slice(c, &x.wstarts, c.I64)
	rr := func(r *rowRange) { c.I64(&r.lo); c.I64(&r.hi) }
	binfmt.Slice(c, &x.callCtx, rr)
	binfmt.Slice(c, &x.waitCtx, rr)
}

func (s *Spill) writeIdx(d *diskSource) error {
	f, err := os.OpenFile(filepath.Join(s.dir, "spill.idx"), os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	x := spillIdx{nCalls: d.nCalls, nWaits: d.nWaits, nSets: d.nSets, nBinds: d.nBinds, nVal: s.nVal,
		cstarts: d.cstmt.starts, wstarts: d.wstmt.starts, callCtx: d.callCtx, waitCtx: d.waitCtx}
	w := binfmt.NewWriter(f)
	w.Header(spillIdxMagic, SpillIdxVersion)
	codeSpillIdx(binfmt.Encoder(w), &x)
	err = w.Flush()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// OpenSpill serves the spill directory dir written by a build with
// SpillOptions.Persist, for model m (the decoded dimensions of that build).
// Nothing is written; Close of the source closes the files and keeps them.
// A directory that does not match (missing or truncated files, another
// format version, another model) fails with an error wrapping
// binfmt.ErrFormat, or an fs error.
func OpenSpill(dir string, m *model.Model) (FactSource, error) {
	s := &Spill{m: m, dir: dir, opts: SpillOptions{Dir: dir, Persist: true}}
	fail := func(err error) (FactSource, error) {
		s.Close()
		return nil, err
	}
	files := map[string]*os.File{}
	sizes := map[string]int64{}
	for _, name := range SpillFiles {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			return fail(err)
		}
		s.files = append(s.files, f)
		fi, err := f.Stat()
		if err != nil {
			return fail(err)
		}
		files[name], sizes[name] = f, fi.Size()
	}
	var x spillIdx
	r := binfmt.NewReader(files["spill.idx"])
	r.Header(spillIdxMagic, SpillIdxVersion)
	codeSpillIdx(binfmt.Decoder(r), &x)
	if err := r.End(); err != nil {
		return fail(err)
	}
	nst := len(m.Statements)
	last := func(a []int64) int64 {
		if len(a) == 0 {
			return -1
		}
		return a[len(a)-1]
	}
	for _, c := range []struct {
		name string
		want int64
	}{
		{"calls.bin", x.nCalls * callRec}, {"waits.bin", x.nWaits * waitRec}, {"bindsets.bin", x.nSets * setRec},
		{"binds.bin", x.nBinds * bindRec}, {"bindvals.bin", x.nVal}, {"calls.stmt", last(x.cstarts) * 4}, {"waits.stmt", last(x.wstarts) * 4},
	} {
		if sizes[c.name] != c.want {
			return fail(fmt.Errorf("%w: spill %s: %d bytes, want %d", binfmt.ErrFormat, c.name, sizes[c.name], c.want))
		}
	}
	if len(x.cstarts) != nst+1 || len(x.wstarts) != nst+1 {
		return fail(fmt.Errorf("%w: spill index of %d statements, the model has %d", binfmt.ErrFormat, len(x.cstarts)-1, nst))
	}
	d := &diskSource{sp: s, m: m, calls: files["calls.bin"], waits: files["waits.bin"], nCalls: x.nCalls, nWaits: x.nWaits,
		sets: files["bindsets.bin"], binds: files["binds.bin"], vals: files["bindvals.bin"], nSets: x.nSets, nBinds: x.nBinds,
		cstmt: &stmtIndex{f: files["calls.stmt"], starts: x.cstarts}, wstmt: &stmtIndex{f: files["waits.stmt"], starts: x.wstarts},
		callCtx: x.callCtx, waitCtx: x.waitCtx, sem: make(chan struct{}, scanSlots), kinds: newKindCache(files["calls.bin"], x.nCalls)}
	s.nSets, s.nBinds, s.nVal = x.nSets, x.nBinds, x.nVal
	s.src = d
	return d, nil
}
