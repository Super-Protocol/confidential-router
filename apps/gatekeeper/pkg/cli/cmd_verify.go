package cli

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func newVerifyCommand(g *globals) *cobra.Command {
	var endpoint string

	cmd := &cobra.Command{
		Use:   "verify <endpoint|hostname>",
		Short: "Verify one endpoint now and print the full report",
		Long: "verify runs the whole pipeline once against a live host — fetch the published\n" +
			"evidence, validate the certificate chain, match it against a trusted root, check the\n" +
			"JWS and its freshness, bind the verdict to the TLS certificate it saw itself — and\n" +
			"then evaluates every policy package over the result.\n\n" +
			"Its argument is a configured endpoint name, or a bare hostname. A hostname that is\n" +
			"not configured has no pins, so it can be verified but never admitted.\n\n" +
			"Exit status is 0 when the endpoint would be admitted and 3 when it would not.",
		Args: exactArgs(1, "verify takes exactly one argument: an endpoint name or a hostname"),
	}
	asJSON := jsonFlag(cmd)
	cmd.Flags().StringVar(&endpoint, "endpoint", "",
		"evaluate against this endpoint's pins when the argument is a bare hostname")

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		target := args[0]
		report, err := verifyTargetAs(cmd, g, target, endpoint)
		if err != nil {
			return err
		}

		p := g.printer(cmd, *asJSON)
		if err := p.emit(report, func(w io.Writer) {
			printReport(w, report, g.env.now())
		}); err != nil {
			return err
		}
		if !report.Admitted {
			return silentf(ExitDenied)
		}
		return nil
	}
	return cmd
}

// verifyTarget resolves an endpoint-name-or-hostname argument and verifies it.
func verifyTarget(cmd *cobra.Command, g *globals, target string) (*status.Report, error) {
	return verifyTargetAs(cmd, g, target, "")
}

// verifyTargetAs is verifyTarget with an explicit endpoint whose pins and
// policies apply — the `--endpoint` of `verify <hostname>`.
func verifyTargetAs(cmd *cobra.Command, g *globals, target, endpoint string) (*status.Report, error) {
	verify, err := g.verifier(cmd.Context())
	if err != nil {
		return nil, err
	}

	req := status.VerifyRequest{Hostname: target, Endpoint: endpoint}
	// A configured endpoint is named, not addressed: its upstream (and port) is
	// the thing to fetch from, and its pins are what the verdict is about.
	if store, storeErr := g.open(); storeErr == nil {
		if ep, ok := store.Endpoint(target); ok {
			req = status.VerifyRequest{Hostname: ep.Hostname, Port: ep.Port, Endpoint: ep.Name}
		} else if endpoint != "" {
			if _, ok := store.Endpoint(endpoint); !ok {
				return nil, failf(ExitUsage, "no endpoint named %q", endpoint)
			}
		}
	}

	report, err := verify.Verify(cmd.Context(), req)
	if err != nil {
		return nil, err
	}
	if report == nil {
		return nil, failf(ExitError, "the verifier returned neither a report nor an error")
	}
	return report, nil
}

// printReport renders one verification the way a human reads it: the verdict
// first, then what it was based on.
func printReport(w io.Writer, r *status.Report, now time.Time) {
	fmt.Fprintln(w, verdictLine(r))
	fmt.Fprintln(w)

	pairs := [][2]string{
		{"Endpoint", orDash(r.Endpoint)},
		{"Upstream", upstreamOf(r)},
		{"Checked", ago(now, r.CheckedAt)},
	}
	if r.Kind != "" {
		pairs = append(pairs, [2]string{"Evidence kind", r.Kind})
	}
	if !r.IssuedAt.IsZero() {
		pairs = append(pairs, [2]string{"Issued", ago(now, r.IssuedAt)})
	}
	pairs = append(pairs,
		[2]string{"", ""},
		[2]string{"Trusted root", rootLine(r)},
		[2]string{"Observed TLS leaf", orDash(r.ObservedTLSFingerprint)},
		[2]string{"Signed certFingerprint", orDash(r.CertFingerprint)},
	)
	if r.QuoteFormat != "" {
		pairs = append(pairs, [2]string{"Root CA TEE quote", r.QuoteFormat + " (displayed, not validated)"})
	}
	pairs = append(pairs,
		[2]string{"", ""},
		[2]string{"evidenceDigest", orDash(r.EvidenceDigest)},
		[2]string{"Pinned for this endpoint", yesNo(r.Pinned)},
	)
	fields(w, pairs)

	if len(r.Chain) > 0 {
		fmt.Fprintln(w, "\nCertificate chain (leaf → root)")
		rows := make([][]string, 0, len(r.Chain))
		for _, cert := range r.Chain {
			role := "intermediate"
			switch {
			case cert.Root:
				role = "root"
			case len(rows) == 0:
				role = "leaf"
			}
			rows = append(rows, []string{
				role, cert.Subject, shortDigest(cert.Fingerprint), cert.NotAfter.Format(time.DateOnly),
			})
		}
		table(w, []string{"  ROLE", "SUBJECT", "FINGERPRINT", "EXPIRES"}, indent(rows))
	}

	if len(r.Images) > 0 {
		fmt.Fprintln(w, "\nContainer images")
		for _, image := range r.Images {
			fmt.Fprintf(w, "  %s\n", image)
		}
	}

	if len(r.Policies) > 0 {
		fmt.Fprintln(w, "\nPolicies")
		rows := make([][]string, 0, len(r.Policies))
		for _, decision := range r.Policies {
			name := decision.Policy
			if name == "" {
				name = "(built-in)"
			}
			verdict := "allow"
			if !decision.Allow {
				verdict = "DENY"
			}
			if decision.Error != "" {
				verdict = "ERROR: " + decision.Error
			}
			rows = append(rows, []string{name, decision.Package, verdict})
		}
		table(w, []string{"  POLICY", "PACKAGE", "RESULT"}, indent(rows))
	}

	for _, warning := range r.Warnings {
		fmt.Fprintf(w, "\n! %s\n", warning)
	}
}

// verdictLine is the one line someone skimming the output has to read.
func verdictLine(r *status.Report) string {
	switch {
	case r.Admitted:
		return "ADMITTED — verified and allowed by every policy"
	case r.Verified:
		return "DENIED — verified, but " + r.Denied()
	default:
		return "DENIED — " + r.Denied()
	}
}

func rootLine(r *status.Report) string {
	switch {
	case r.Root != "":
		return fmt.Sprintf("%s (%s)", r.Root, r.RootFingerprint)
	case r.RootFingerprint != "":
		return r.RootFingerprint + " — NOT a trusted root"
	default:
		return "—"
	}
}

func upstreamOf(r *status.Report) string {
	if r.Hostname == "" {
		return "—"
	}
	if r.Port != 0 && r.Port != 443 {
		return fmt.Sprintf("https://%s:%d", r.Hostname, r.Port)
	}
	return "https://" + r.Hostname
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

// indent prefixes the first cell of every row, so a nested table lines up under
// its heading without the tabwriter treating the indent as its own column.
func indent(rows [][]string) [][]string {
	for i := range rows {
		rows[i][0] = "  " + rows[i][0]
	}
	return rows
}
