package cli

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func newEndpointTrustCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "trust",
		Short: "Manage one endpoint's pinned evidenceDigest values",
		Long: "An endpoint admits exactly the deployments whose evidenceDigest is pinned here.\n" +
			"The list exists so a rollout can be pre-approved: pin the new digest next to the\n" +
			"old one, deploy, then unpin the old one.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(
		newEndpointTrustListCommand(g),
		newEndpointTrustAddCommand(g),
		newEndpointTrustRemoveCommand(g),
	)
	return cmd
}

// pinView is one pinned digest as `endpoint trust list` reports it.
//
// Digest is the human-facing `sha256:<hex>` form — the one string the console,
// the reports and this table all show for a deployment. Canonical is the wire
// form the bundle carries, Hex the bare body for a tool that adds its own
// scheme, and Raw how the file happens to spell it.
type pinView struct {
	Digest    string `json:"digest"`
	Canonical string `json:"digestCanonical"`
	Hex       string `json:"hex"`
	Raw       string `json:"raw"`
}

func newEndpointTrustListCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list <endpoint>",
		Short: "List an endpoint's pinned evidenceDigest values",
		Args:  exactArgs(1, "list takes exactly one argument: the endpoint name"),
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		store, err := g.open()
		if err != nil {
			return err
		}
		ep, ok := store.Endpoint(args[0])
		if !ok {
			return failf(ExitUsage, "no endpoint named %q", args[0])
		}

		views := make([]pinView, 0, len(ep.Pins))
		for _, pin := range ep.Pins {
			views = append(views, pinView{
				Digest:    pin.Digest.Display(),
				Canonical: pin.Digest.String(),
				Hex:       pin.Digest.Hex(),
				Raw:       pin.Raw,
			})
		}

		return g.printer(cmd, *asJSON).emit(views, func(w io.Writer) {
			if len(views) == 0 {
				fmt.Fprintf(w, "%s has no pinned evidenceDigest and cannot admit traffic.\n", ep.Name)
				return
			}
			rows := make([][]string, 0, len(views))
			for _, v := range views {
				rows = append(rows, []string{v.Digest, shortDigest(v.Canonical)})
			}
			// The canonical form is abbreviated: it is here so a pin can be
			// matched against what a bundle carries, not to be copied.
			table(w, []string{"DIGEST", "CANONICAL"}, rows)
		})
	}
	return cmd
}

func newEndpointTrustAddCommand(g *globals) *cobra.Command {
	var (
		fromUpstream bool
		assumeYes    bool
	)

	cmd := &cobra.Command{
		Use:   "add <endpoint> [digest]",
		Short: "Pin an evidenceDigest",
		Long: "add pins a digest you supply, or — with --from-upstream — the one the endpoint\n" +
			"currently publishes.\n\n" +
			"--from-upstream is not trust-on-first-use: it verifies the endpoint cryptographically\n" +
			"first (chain, trusted root, JWS, freshness, observed TLS binding), prints what it\n" +
			"found, and asks before writing. A bundle that fails those stages is never pinned —\n" +
			"a digest from an unverifiable endpoint means nothing. What it does not check is\n" +
			"whether the deployment is one you want; that is the question you are answering.",
		Args: rangeArgs(1, 2, "add takes an endpoint name and either a digest or --from-upstream"),
	}
	cmd.Flags().BoolVar(&fromUpstream, "from-upstream", false,
		"pin the digest the endpoint publishes right now, after review")
	cmd.Flags().BoolVarP(&assumeYes, "yes", "y", false, "do not ask for confirmation")

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		name := args[0]
		switch {
		case fromUpstream && len(args) == 2:
			return failf(ExitUsage, "pass a digest or --from-upstream, not both")
		case !fromUpstream && len(args) != 2:
			return failf(ExitUsage, "add needs a digest, or --from-upstream to take the published one")
		}

		store, err := g.open()
		if err != nil {
			return err
		}
		ep, ok := store.Endpoint(name)
		if !ok {
			return failf(ExitUsage, "no endpoint named %q", name)
		}

		var digest trust.Digest
		if fromUpstream {
			if digest, err = discoveredDigest(cmd, g, ep, assumeYes); err != nil {
				return err
			}
		} else if digest, err = trust.ParseDigest(args[1]); err != nil {
			return failf(ExitUsage, "%s", err)
		}

		added, err := store.AddPin(name, digest)
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if !added {
			fmt.Fprintf(out, "%s is already pinned for %q; nothing to do\n", digest.Display(), name)
			return nil
		}
		fmt.Fprintf(out, "Pinned %s for %q in %s\n", digest.Display(), name, store.Path())
		return nil
	}
	return cmd
}

// discoveredDigest verifies the endpoint, shows the report, and returns the
// digest it publishes once the user has agreed to pin it.
func discoveredDigest(cmd *cobra.Command, g *globals, ep trust.Endpoint, assumeYes bool) (trust.Digest, error) {
	verify, err := g.verifier(cmd.Context())
	if err != nil {
		return "", err
	}
	report, err := verify.Verify(cmd.Context(), status.VerifyRequest{
		Hostname: ep.Hostname, Port: ep.Port, Endpoint: ep.Name,
	})
	if err != nil {
		return "", err
	}
	if !report.Verified {
		return "", failf(ExitDenied,
			"%s failed verification at the %s stage (%s); nothing was pinned",
			ep.Hostname, report.Stage, report.Reason)
	}
	if report.EvidenceDigest == "" {
		return "", failf(ExitError, "%s publishes no evidenceDigest to pin", ep.Hostname)
	}

	printReport(cmd.ErrOrStderr(), report, g.env.now())
	if !assumeYes {
		agreed, err := confirm(g.env, cmd.ErrOrStderr(),
			fmt.Sprintf("Pin %s for %q?", hexDigest(report.EvidenceDigest), ep.Name))
		if err != nil {
			return "", err
		}
		if !agreed {
			return "", failf(ExitError, "cancelled; nothing was pinned")
		}
	}
	return trust.ParseDigest(report.EvidenceDigest)
}

// confirm asks a yes/no question. Without a terminal it refuses rather than
// assuming either answer: a pipeline that meant to pin must say --yes.
func confirm(env *Env, w io.Writer, question string) (bool, error) {
	if !env.isTerminal() {
		return false, failf(ExitUsage, "this is not an interactive terminal; pass --yes to confirm")
	}
	fmt.Fprintf(w, "\n%s [y/N] ", question)
	line, err := bufio.NewReader(env.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return false, nil
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes", nil
}

func newEndpointTrustRemoveCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "rm <endpoint> <digest>",
		Aliases: []string{"remove"},
		Short:   "Unpin an evidenceDigest",
		Long: "rm matches on the normalised digest, so a pin written in hex can be removed by its\n" +
			"canonical name and vice versa.",
		Args: exactArgs(2, "rm takes exactly two arguments: the endpoint name and the digest"),
	}

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		name := args[0]
		digest, err := trust.ParseDigest(args[1])
		if err != nil {
			return failf(ExitUsage, "%s", err)
		}
		store, err := g.open()
		if err != nil {
			return err
		}
		removed, err := store.RemovePin(name, digest)
		if err != nil {
			return err
		}
		if !removed {
			return failf(ExitError, "%s is not pinned for %q", digest.Display(), name)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Unpinned %s from %q in %s\n", digest.Display(), name, store.Path())
		if ep, ok := store.Endpoint(name); ok && len(ep.Pins) == 0 {
			fmt.Fprintf(cmd.ErrOrStderr(),
				"warning: %q has no pins left and can no longer admit traffic\n", name)
		}
		return nil
	}
	return cmd
}

func newEndpointDiscoverCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "discover <endpoint|hostname>",
		Short: "Show what an upstream currently publishes, without trusting it",
		Long: "discover verifies an endpoint and prints its evidence — chain, matched root,\n" +
			"fingerprints, evidenceDigest, container images — so you can review a deployment\n" +
			"before pinning it. It never writes to the configuration.\n\n" +
			"Its argument is a configured endpoint name, or a bare hostname for something not\n" +
			"configured yet.",
		Args: exactArgs(1, "discover takes exactly one argument: an endpoint name or a hostname"),
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		report, err := verifyTarget(cmd, g, args[0])
		if err != nil {
			return err
		}
		return g.printer(cmd, *asJSON).emit(documentOf(report), func(w io.Writer) {
			printReport(w, report, g.env.now())
			if report.Verified && report.EvidenceDigest != "" && !report.Pinned {
				fmt.Fprintf(w, "\nTo accept this deployment:\n  gatekeeper endpoint trust add %s %s\n",
					report.Endpoint, hexDigest(report.EvidenceDigest))
			}
		})
	}
	return cmd
}
