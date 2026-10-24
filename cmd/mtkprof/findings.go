package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
)

func findingsFlag(fs *flag.FlagSet) *string {
	return fs.String("findings-config", "", "JSON file overriding finding thresholds (\"-\" = stdin; see `mtkprof findings-config`)")
}

// loadThresholds reads a -findings-config file; "" means the defaults (nil).
func loadThresholds(path string) (*analyze.Thresholds, error) {
	if path == "" {
		return nil, nil
	}
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	th, err := analyze.ParseThresholds(data)
	if err != nil {
		return nil, err
	}
	return &th, nil
}

func cmdFindingsConfig(args []string) error {
	fs := flag.NewFlagSet("findings-config", flag.ExitOnError)
	fs.Parse(args)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(analyze.DefaultThresholds()); err != nil {
		return fmt.Errorf("findings-config: %w", err)
	}
	return nil
}
