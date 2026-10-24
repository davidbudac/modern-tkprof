package slice

import (
	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// FactSource is where the endpoints read the fact rows from: calls and waits
// as analyze.Facts, and bind values by bind set. memSource reads the tables
// of a full model, diskSource the spill files of an aggregation-only build
// (spill.go). The endpoints do not know which one they have; the JSON is the
// same.
type FactSource interface {
	analyze.Facts
	// Binds are the binds of bind set id in position order (nil when there are none).
	Binds(set model.ID) []model.Bind
	// BindSetLine is the trace line of the BINDS block.
	BindSetLine(set model.ID) (line int, ok bool)
	// Close releases the source (the spill files are removed).
	Close() error
}

// MemSource is the FactSource of a model that holds its calls, waits and binds.
func MemSource(m *model.Model) FactSource { return memSource{Facts: analyze.ModelFacts(m), m: m} }

type memSource struct {
	analyze.Facts
	m *model.Model
}

func (s memSource) Binds(set model.ID) []model.Bind {
	m := s.m
	if set < 0 || int(set) >= len(m.BindSets) {
		return nil
	}
	bs := &m.BindSets[set]
	first, n := int(bs.First), int(bs.N)
	if first < 0 || first+n > len(m.Binds) {
		return nil
	}
	return m.Binds[first : first+n]
}

func (s memSource) BindSetLine(set model.ID) (int, bool) {
	if set < 0 || int(set) >= len(s.m.BindSets) {
		return 0, false
	}
	return s.m.BindSets[set].Line, true
}

func (memSource) Close() error { return nil }
