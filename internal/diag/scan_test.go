package diag

import (
	"path/filepath"
	"testing"
)

func TestSnapshots(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			r := readerOf(t, fx)
			compareSnap(t, filepath.Join(snapDir, fixtureName(fx)+".outline.txt"), outlineText(t, r))
		})
	}
}

func TestInvariants(t *testing.T) {
	for _, fx := range fixtures(t) {
		fx := fx
		t.Run(fixtureName(fx), func(t *testing.T) {
			r := readerOf(t, fx)
			checkTiling(t, fixtureName(fx), r.Scan)
			checkNodes(t, fixtureName(fx), r, 4)
		})
	}
}
