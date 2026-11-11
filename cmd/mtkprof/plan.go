package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// planVizFlag registers -plan-viz-url (html, serve, json).
func planVizFlag(fs *flag.FlagSet) *string {
	return fs.String("plan-viz-url", report.DefaultPlanVizURL, "base URL of the plan visualizer for \"Open in plan viz\" links (empty = the UI's own default)")
}

func cmdPlan(args []string) error {
	fs := flag.NewFlagSet("plan", flag.ExitOnError)
	rf := refFlag(fs)
	out := fs.String("o", "", "output file (default stdout)")
	sqlID := fs.String("sql_id", "", "statement to export (required unless -list)")
	hash := fs.String("plan-hash", "", "plan hash value (default: every plan hash of the statement; with several, the output is a JSON object keyed by plan hash)")
	execN := fs.Int("exec", 0, "N-th STAT dump of the plan hash, 1-based (default: the latest)")
	list := fs.Bool("list", false, "list statements that have plans and exit")
	viz := fs.Bool("viz", false, "print the \"Open in plan viz\" URL instead of the JSON (one `hash<TAB>url` line per plan when several)")
	base := planVizFlag(fs)
	nf := addFollowFlag(fs)
	files := parseArgs(fs, args)
	m, err := buildTrace("no STAT plans to extract", files, *nf)
	if err != nil {
		return err
	}
	if err := applyRef(m, *rf); err != nil {
		return err
	}
	w, err := openOut(*out)
	if err != nil {
		return err
	}
	defer w.Close()
	if *list {
		return listPlans(w, m)
	}
	if *sqlID == "" {
		return fmt.Errorf("-sql_id is required (use -list to see statements with plans)")
	}
	stmt := model.None
	for i := range m.Statements {
		if m.Statements[i].SQLID == *sqlID {
			stmt = model.ID(i)
			break
		}
	}
	if stmt == model.None {
		return fmt.Errorf("sql_id %s not found in %s", *sqlID, strings.Join(files, " "))
	}
	plans, err := report.SelectPlans(m, stmt, *hash, *execN)
	if err != nil {
		return err
	}

	if *viz {
		for _, p := range plans {
			rows, err := report.PlanJSON(m, p)
			if err != nil {
				return err
			}
			u, err := report.PlanVizURL(*base, rows)
			if err != nil {
				return fmt.Errorf("plan hash %d: %w", p.PLH, err)
			}
			if len(plans) == 1 {
				fmt.Fprintln(w, u)
			} else {
				fmt.Fprintf(w, "%d\t%s\n", p.PLH, u)
			}
		}
		return nil
	}
	if len(plans) == 1 {
		js, err := report.PlanJSON(m, plans[0])
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(w, "%s\n", js)
		return err
	}
	// several hashes: {"<hash>": [rows], ...} in first-seen order
	compact, err := report.PlansJSON(m, plans)
	if err != nil {
		return err
	}
	var ind bytes.Buffer
	if err := json.Indent(&ind, compact, "", "  "); err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s\n", ind.Bytes())
	return err
}

func listPlans(w interface{ Write([]byte) (int, error) }, m *model.Model) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "sql_id\tplan_hash\tdumps\tlines\troot_cost\troot_time_ms")
	for i := range m.Statements {
		id := model.ID(i)
		all := report.PlansOf(m, id)
		for _, p := range report.LatestPlans(m, id) {
			dumps := 0
			for _, q := range all {
				if q.PLH == p.PLH {
					dumps++
				}
			}
			cost, ms := "-", "-"
			if p.N > 0 {
				root := m.PlanLines[p.First]
				if root.HasStats {
					if root.Cost >= 0 {
						cost = strconv.FormatInt(root.Cost, 10)
					}
					ms = strconv.FormatFloat(float64(root.TimeUs)/1000, 'f', 3, 64)
				}
			}
			fmt.Fprintf(tw, "%s\t%d\t%d\t%d\t%s\t%s\n", m.Statements[i].SQLID, p.PLH, dumps, p.N, cost, ms)
		}
	}
	return tw.Flush()
}
