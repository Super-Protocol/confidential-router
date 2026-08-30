package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// jsonFlag adds `--json` to a read command and returns the bound value.
//
// Every command that only reports has it, so the CLI is scriptable without
// parsing tables. Commands that change the config deliberately do not: their
// result is the file, and a machine-readable echo of an edit invites treating
// "it printed something" as "it was written".
func jsonFlag(cmd *cobra.Command) *bool {
	return cmd.Flags().Bool("json", false, "print the result as JSON")
}

// printer writes a command's result in whichever form was asked for.
type printer struct {
	out  io.Writer
	err  io.Writer
	json bool
}

func (g *globals) printer(cmd *cobra.Command, asJSON bool) printer {
	return printer{out: cmd.OutOrStdout(), err: cmd.ErrOrStderr(), json: asJSON}
}

// emit writes the JSON form when --json was given and calls text otherwise.
func (p printer) emit(value any, text func(w io.Writer)) error {
	if !p.json {
		text(p.out)
		return nil
	}
	enc := json.NewEncoder(p.out)
	enc.SetIndent("", "  ")
	// Escaping is off because these documents carry certificate subjects and
	// upstream URLs, and < in a fingerprint helps nobody.
	enc.SetEscapeHTML(false)
	return enc.Encode(value)
}

// note writes a human-facing aside — a warning, a "what next" hint. It goes to
// stderr and is suppressed under --json so that stdout stays a clean document
// and a piped `--json` run stays parseable.
func (p printer) note(format string, args ...any) {
	if p.json {
		return
	}
	fmt.Fprintf(p.err, format+"\n", args...)
}

// table renders aligned columns. Header cells are upper-cased; a nil row slice
// prints the header alone, which is how "nothing configured" reads best next to
// a populated run.
func table(w io.Writer, header []string, rows [][]string) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(header, "\t"))
	for _, row := range rows {
		fmt.Fprintln(tw, strings.Join(row, "\t"))
	}
	_ = tw.Flush()
}

// fields renders a `label: value` block, aligned. It is the shape every detail
// view in the CLI uses.
func fields(w io.Writer, pairs [][2]string) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, p := range pairs {
		if p[0] == "" {
			fmt.Fprintln(tw)
			continue
		}
		fmt.Fprintf(tw, "%s\t%s\n", p[0], p[1])
	}
	_ = tw.Flush()
}

// shortDigest abbreviates a `sha256/<43 chars>` fingerprint for a table cell.
// The full value is always available from --json or the detail view; a table
// that wraps is worse than one that elides.
func shortDigest(d string) string {
	body := strings.TrimPrefix(d, "sha256/")
	if len(body) <= 16 {
		return d
	}
	return "sha256/" + body[:8] + "…" + body[len(body)-6:]
}

// ago renders a timestamp the way a dashboard should: how long ago, not when.
func ago(now, then time.Time) string {
	if then.IsZero() {
		return "never"
	}
	d := now.Sub(then)
	switch {
	case d < time.Second:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// humanBytes renders a byte counter in the units an operator reads.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 4; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "KMGTP"[exp])
}

// yesNo renders a boolean the way a report reads.
func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

// writeJSON prints a document as indented JSON, for the `--show-input` style
// flags where the JSON is part of the human output rather than all of it.
func writeJSON(w io.Writer, value any) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
}
