package engine

import (
	"os"
	"testing"
)

// The slice routes keep their answers (slice.Server's cache). An answer that
// names an object must not survive a reference bundle: line 264 of
// io_waits.trc is a WAIT on obj#=108609, MTK.MTK_CUST in the pasted names.
func TestRefApplyDropsCachedAnswers(t *testing.T) {
	_, ts := newServed(t)
	s := openTS(t, ts, traces+"io_waits.trc")
	at := func() string {
		t.Helper()
		r := call(t, ts, "GET", "/s/"+s.ID+"/api/at?file=0&line=264", nil)
		if r.code != 200 {
			t.Fatalf("at: %d %s", r.code, r.body)
		}
		return decode[struct {
			Object string `json:"object"`
		}](t, r.body).Object
	}
	if o := at(); o != "" {
		t.Fatalf("object %q before any names", o)
	}
	raw, err := os.ReadFile("../ref/testdata/paste_io_waits_sysdba.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := call(t, ts, "POST", "/s/"+s.ID+"/api/ref/paste", map[string]any{"text": string(raw)})
	if r.code != 202 {
		t.Fatalf("paste: %d %s", r.code, r.body)
	}
	if j := waitJob(t, ts, decode[RefPasted](t, r.body).Job.ID); j.State != JobDone {
		t.Fatalf("paste job %+v", j)
	}
	if o := at(); o != "MTK.MTK_CUST" {
		t.Errorf("object %q after the names were applied, want MTK.MTK_CUST (a kept answer from before?)", o)
	}
}
