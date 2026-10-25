//go:build !nooracle

package db

import (
	"strings"
	"testing"
)

func TestGoOraURL(t *testing.T) {
	s := Spec{User: "mtk", Host: "dbmint", Port: 1521, Service: "pdb1.world"}
	if u := (GoOra{}).URL(s, "p@ss/w:rd", false); u != "oracle://mtk:p@ss%2Fw:rd@dbmint:1521/pdb1.world?PREFETCH_ROWS=1000" {
		t.Errorf("tcp URL %q", u)
	}
	s.TLSSkipVerify, s.PrefetchRows = true, 5000
	u := (GoOra{}).URL(s, "pw", true)
	for _, want := range []string{"oracle://mtk:pw@dbmint:1521/pdb1.world?", "SSL=true", "SSL VERIFY=false", "PREFETCH_ROWS=5000"} {
		if !strings.Contains(u, strings.ReplaceAll(want, " ", "+")) && !strings.Contains(u, want) {
			t.Errorf("tcps URL %q lacks %q", u, want)
		}
	}
}
