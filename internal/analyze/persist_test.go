package analyze

import (
	"reflect"
	"testing"
)

// TestAccumPersistCoversEveryField fails when a struct of the format gains or
// loses a field: add it to persist.go and bump AccumPersistVersion.
func TestAccumPersistCoversEveryField(t *testing.T) {
	for _, v := range []any{Accumulator{}, facts{}, aggStmt{}, StmtStats{}, CallStats{}, Link{}, ContextStats{}, evAgg{},
		idleAcc{}, timeline{}, Bucket{}, PXTotals{}, execAgg{}, execRec{}, planRec{}, keyAgg{}, objKey{}} {
		typ := reflect.TypeOf(v)
		want, ok := accumFields[typ.Name()]
		if !ok {
			t.Errorf("%s: not in accumFields", typ.Name())
			continue
		}
		if got := typ.NumField(); got != want {
			t.Errorf("%s has %d fields, the persist format covers %d: update persist.go and bump AccumPersistVersion", typ.Name(), got, want)
		}
	}
}
