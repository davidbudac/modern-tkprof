package engine

import (
	"path/filepath"
	"sort"
	"strings"
)

// fixtureSets lists every trace fixture of every version as a single-file set,
// plus the multi-file sets (multisession a + b, PX coordinator + slave).
func fixtureSets() map[string][]string {
	sets := map[string][]string{}
	dirs, _ := filepath.Glob("../../testdata/traces/*")
	sort.Strings(dirs)
	for _, d := range dirs {
		v := filepath.Base(d)
		files, _ := filepath.Glob(filepath.Join(d, "*.trc"))
		have := map[string]string{}
		for _, f := range files {
			name := strings.TrimSuffix(filepath.Base(f), ".trc")
			have[name] = f
			sets[v+"/"+name] = []string{f}
		}
		for name, parts := range map[string][2]string{"multi_a_b": {"multisession_a", "multisession_b"}, "px_set": {"parallel", "parallel_slave"}} {
			if a, b := have[parts[0]], have[parts[1]]; a != "" && b != "" {
				sets[v+"/"+name] = []string{a, b}
			}
		}
	}
	return sets
}

func sortedKeys(m map[string][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
