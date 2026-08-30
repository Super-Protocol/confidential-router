package cli

import (
	"fmt"
	"io"
	"time"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func newStatusCommand(g *globals) *cobra.Command {
	var endpoint string

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Report what a running gatekeeper is doing",
		Long: "status asks the running gatekeeper for the state of every endpoint: whether its\n" +
			"listener is up, what its last verdict was, and how much traffic it is carrying.\n\n" +
			"It reports; it does not verify. `gatekeeper verify` is the command that forms a\n" +
			"fresh verdict.",
		Args: cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)
	cmd.Flags().StringVar(&endpoint, "endpoint", "", "show the full report for one endpoint")

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if err := g.requireSupervisor(); err != nil {
			return err
		}
		snapshot := g.env.Supervisor.Snapshot(cmd.Context())
		p := g.printer(cmd, *asJSON)
		now := g.env.now()

		if endpoint != "" {
			ep, ok := snapshot.Endpoint(endpoint)
			if !ok {
				return failf(ExitUsage, "no endpoint named %q", endpoint)
			}
			return p.emit(ep, func(w io.Writer) {
				printEndpointDetail(w, ep, now)
			})
		}

		return p.emit(snapshot, func(w io.Writer) {
			printSnapshot(w, snapshot, now)
		})
	}
	return cmd
}

// printSnapshot renders one row per endpoint — the CLI's version of the
// dashboard's table.
func printSnapshot(w io.Writer, snapshot status.Snapshot, now time.Time) {
	if len(snapshot.Endpoints) == 0 {
		fmt.Fprintln(w, "No endpoints are configured.")
		return
	}
	rows := make([][]string, 0, len(snapshot.Endpoints))
	for _, ep := range snapshot.Endpoints {
		rows = append(rows, []string{
			ep.Name,
			ep.Listen,
			ep.Upstream,
			healthCell(ep),
			ago(now, ep.LastAttestAt),
			fmt.Sprintf("%.1f", ep.RequestsPerSecond),
			humanBytes(ep.BytesIn) + "/" + humanBytes(ep.BytesOut),
		})
	}
	table(w, []string{"NAME", "LISTEN", "UPSTREAM", "STATUS", "LAST ATTEST", "REQ/S", "IN/OUT"}, rows)

	// A fail-open endpoint carrying traffic without a verdict is the one thing
	// a glance at this table must not miss.
	for _, ep := range snapshot.Endpoints {
		if ep.Health == status.NonConfidential {
			fmt.Fprintf(w, "\n! %s is proxying WITHOUT a valid verdict (failMode: open): %s\n", ep.Name, ep.Reason)
		}
	}
}

// healthCell renders an endpoint's state, with its reason when it has one.
func healthCell(ep status.Endpoint) string {
	if ep.Health.Trusted() || ep.Reason == "" {
		return ep.Health.Label()
	}
	return ep.Health.Label() + " (" + truncate(ep.Reason, 48) + ")"
}

// printEndpointDetail renders one endpoint in full: its state, then the
// verification behind it.
func printEndpointDetail(w io.Writer, ep status.Endpoint, now time.Time) {
	fields(w, [][2]string{
		{"Endpoint", ep.Name},
		{"Listen", ep.Listen},
		{"Upstream", ep.Upstream},
		{"Fail mode", ep.FailMode},
		{"Status", healthCell(ep)},
		{"Last attestation", ago(now, ep.LastAttestAt)},
		{"Next attestation", until(now, ep.NextAttestAt)},
		{"Traffic", fmt.Sprintf("%.1f req/s, %s in, %s out",
			ep.RequestsPerSecond, humanBytes(ep.BytesIn), humanBytes(ep.BytesOut))},
	})
	if ep.Report == nil {
		fmt.Fprintln(w, "\nNo verification has completed for this endpoint yet.")
		return
	}
	fmt.Fprintln(w)
	printReport(w, ep.Report, now)
}

// until is [ago] the other way round, for a scheduled time.
func until(now, then time.Time) string {
	if then.IsZero() {
		return "not scheduled"
	}
	d := then.Sub(now)
	if d <= 0 {
		return "due"
	}
	if d < time.Minute {
		return fmt.Sprintf("in %ds", int(d.Seconds()))
	}
	return fmt.Sprintf("in %dm", int(d.Minutes()))
}

// truncate shortens a reason to fit a table cell.
func truncate(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit-1]) + "…"
}
