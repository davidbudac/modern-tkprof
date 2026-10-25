package engine

import (
	"bytes"
	"reflect"
	"regexp"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

var generatedRe = regexp.MustCompile(`"generated":"[^"]*"`)

// outputs is what a model is shown as: the document (generated time masked)
// and the text report.
func outputs(t *testing.T, m *model.Model) (doc, text []byte) {
	t.Helper()
	d, err := report.DocumentBytes(m, report.DocOptions{Packed: true, Slice: true})
	if err != nil {
		t.Fatal(err)
	}
	var tb bytes.Buffer
	if err := report.Text(&tb, m, report.TextOptions{Sort: "elapsed", Binds: 5, Execs: 20, Sys: true, Width: 120}); err != nil {
		t.Fatal(err)
	}
	return generatedRe.ReplaceAll(d, []byte(`"generated":""`)), tb.Bytes()
}

func buildAggregate(t *testing.T, paths []string) *model.Model {
	t.Helper()
	th := analyze.DefaultThresholds()
	m, err := model.BuildFiles(paths, model.Options{Aggregate: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) }})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// roundTrip encodes the model and its accumulator and decodes them again.
func roundTrip(t *testing.T, m *model.Model) *model.Model {
	t.Helper()
	var dims, agg bytes.Buffer
	if err := model.Encode(&dims, m); err != nil {
		t.Fatal(err)
	}
	if err := analyze.AggOf(m).Encode(&agg); err != nil {
		t.Fatal(err)
	}
	d, err := model.Decode(bytes.NewReader(dims.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	a, err := analyze.DecodeAccumulator(bytes.NewReader(agg.Bytes()), d)
	if err != nil {
		t.Fatal(err)
	}
	d.Agg = a
	// deterministic: encoding the decoded model gives the same bytes
	var dims2, agg2 bytes.Buffer
	model.Encode(&dims2, d)
	a.Encode(&agg2)
	if !bytes.Equal(dims.Bytes(), dims2.Bytes()) || !bytes.Equal(agg.Bytes(), agg2.Bytes()) {
		t.Errorf("re-encoding the decoded model gives other bytes")
	}
	return d
}

func sameOutputs(t *testing.T, want, got *model.Model) {
	t.Helper()
	wd, wt := outputs(t, want)
	gd, gt := outputs(t, got)
	if !bytes.Contains(wd, []byte(`"minimap":{`)) {
		t.Errorf("the document has no stats.minimap")
	}
	if !bytes.Equal(wd, gd) {
		t.Errorf("document differs after the round trip\n want %.400s\n got  %.400s", firstDiff(wd, gd), firstDiff(gd, wd))
	}
	if !bytes.Equal(wt, gt) {
		t.Errorf("text report differs after the round trip\n want %.400s\n got  %.400s", firstDiff(wt, gt), firstDiff(gt, wt))
	}
}

// firstDiff is a from the first byte where it differs from b.
func firstDiff(a, b []byte) []byte {
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	return a[max(0, i-80):]
}

func TestModelPersistRoundTrip(t *testing.T) {
	sets := fixtureSets()
	if len(sets) < 20 {
		t.Fatalf("only %d fixture sets", len(sets))
	}
	for _, name := range sortedKeys(sets) {
		t.Run(name, func(t *testing.T) {
			m := buildAggregate(t, sets[name])
			d := roundTrip(t, m)
			sameOutputs(t, m, d)
			if mm := analyze.TraceMinimap(m); mm == nil || !reflect.DeepEqual(mm, analyze.TraceMinimap(d)) {
				t.Errorf("minimap differs after the round trip (or is missing)")
			}
		})
	}
}

func TestModelPersistRoundTripWithRef(t *testing.T) {
	b, err := ref.LoadBundle("../../testdata/reference/bundle")
	if err != nil {
		t.Fatal(err)
	}
	m := buildAggregate(t, []string{"../../testdata/traces/19c/io_waits.trc"})
	model.ApplyRef(m, b)
	if len(m.Objects) == 0 || m.ObjectName(m.Objects[0].ID) == "" {
		t.Fatal("the bundle named no object")
	}
	d := roundTrip(t, m)
	if d.ObjectName(m.Objects[0].ID) != m.ObjectName(m.Objects[0].ID) {
		t.Errorf("object names not indexed after decoding")
	}
	sameOutputs(t, m, d)
}
