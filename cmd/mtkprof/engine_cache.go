package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/engine"
)

const engineCacheUsage = `usage: mtkprof engine cache ls|rm <identity>|wipe [-cache DIR]

  ls             list the entries of the index cache, most recently used first
  rm <identity>  remove one entry (a unique prefix of the identity is enough)
  wipe           remove every entry`

// cmdEngineCache is `mtkprof engine cache`: support commands for the
// persistent index cache (docs/PLAN-DESKTOP.md § 3).
func cmdEngineCache(args []string) error {
	fs := flag.NewFlagSet("engine cache", flag.ContinueOnError)
	dir := fs.String("cache", "", "cache directory (default: the user cache directory + /mtkprof)")
	fs.Usage = func() { fmt.Fprintln(fs.Output(), engineCacheUsage); fs.PrintDefaults() }
	// flags may come before or after the subcommand and its argument
	var rest []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			break
		}
		rest = append(rest, fs.Arg(0))
		args = fs.Args()[1:]
	}
	if len(rest) == 0 {
		fs.Usage()
		return fmt.Errorf("engine cache: no command")
	}
	c, err := engine.OpenCache(*dir, 0)
	if err != nil {
		return err
	}
	switch cmd := rest[0]; {
	case cmd == "ls" && len(rest) == 1:
		return engineCacheLs(c)
	case cmd == "rm" && len(rest) == 2:
		id, err := engineCacheFind(c, rest[1])
		if err != nil {
			return err
		}
		if err := c.Remove(id); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "removed", id)
		return nil
	case cmd == "wipe" && len(rest) == 1:
		bytes, n, _ := c.Stats()
		if err := c.Wipe(); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "removed %d entries, %.1f MB\n", n, float64(bytes)/1e6)
		return nil
	}
	fs.Usage()
	return fmt.Errorf("engine cache: bad command %q", strings.Join(rest, " "))
}

func engineCacheLs(c *engine.Cache) error {
	es := c.Entries()
	bytes, n, capBytes := c.Stats()
	fmt.Printf("%s: %d entries, %.1f MB of %.1f GB\n", c.Dir(), n, float64(bytes)/1e6, float64(capBytes)/(1<<30))
	if len(es) == 0 {
		return nil
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "IDENTITY\tMB\tLAST USED\tCREATED\tSOURCES")
	for _, e := range es {
		fmt.Fprintf(tw, "%s\t%.1f\t%s\t%s\t%s\n", e.Identity[:16], float64(e.Bytes)/1e6,
			e.LastUsed.Local().Format(time.DateTime), e.Created.Local().Format(time.DateTime), strings.Join(e.Sources, " "))
	}
	return tw.Flush()
}

// engineCacheFind resolves a unique identity prefix.
func engineCacheFind(c *engine.Cache, prefix string) (string, error) {
	var found []string
	for _, e := range c.Entries() {
		if strings.HasPrefix(e.Identity, prefix) {
			found = append(found, e.Identity)
		}
	}
	switch {
	case prefix == "" || len(found) == 0:
		return "", fmt.Errorf("no cache entry %q", prefix)
	case len(found) > 1:
		return "", fmt.Errorf("%q matches %d entries", prefix, len(found))
	}
	return found[0], nil
}
