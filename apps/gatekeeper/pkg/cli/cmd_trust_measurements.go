package cli

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/attestedroot"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

func newTrustMeasurementsCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "measurements",
		Aliases: []string{"measurement"},
		Short:   "List, add and remove operator-pinned TEE measurements",
		Long: "A Swarm cloud's certificate authority is normally accepted because its VM's launch\n" +
			"measurement carries a Super Protocol signature. A stand built outside that flow has\n" +
			"no signature to find, and today the only way to use it is `trust roots add` with a\n" +
			"certificate fetched out of band — trust on first use, repeated on every rebuild.\n\n" +
			"Pinning the measurement here replaces exactly one leg of the check: \"Super Protocol\n" +
			"signed this image\" becomes \"I accept this image\". Everything else still has to pass\n" +
			"— the hardware report's signature and vendor chain, the reportData binding to the\n" +
			"certificate's own key, the measurement rebuild from the published build artefacts,\n" +
			"and `attestedRoots.requireNetworkType`. A pin cannot admit a root that is not\n" +
			"running in a real TEE, and it cannot admit any image but the one it names.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(
		newTrustMeasurementsListCommand(g),
		newTrustMeasurementsAddCommand(g),
		newTrustMeasurementsRemoveCommand(g),
	)
	return cmd
}

// measurementView is one pinned measurement as `trust measurements list`
// reports it. Raw is how the file spells it, which matters only when the two
// differ — a pin pasted with a `sha256:` prefix reads back normalised.
type measurementView struct {
	Measurement string `json:"measurement"`
	Raw         string `json:"raw"`
}

func newTrustMeasurementsListCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the operator-pinned measurements",
		Args:  cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		store, err := g.open()
		if err != nil {
			return err
		}
		views := make([]measurementView, 0, len(store.Measurements()))
		for _, m := range store.Measurements() {
			views = append(views, measurementView{Measurement: m.Hex, Raw: m.Raw})
		}

		return g.printer(cmd, *asJSON).emit(views, func(w io.Writer) {
			if len(views) == 0 {
				fmt.Fprintln(w, "No pinned measurements. Only roots whose measurement Super Protocol signed")
				fmt.Fprintln(w, "are accepted on their own evidence. To add one:")
				fmt.Fprintln(w, "  gatekeeper trust measurements add --from-upstream <endpoint>")
				return
			}
			rows := make([][]string, 0, len(views))
			for _, v := range views {
				rows = append(rows, []string{v.Measurement})
			}
			table(w, []string{"MEASUREMENT"}, rows)
		})
	}
	return cmd
}

func newTrustMeasurementsAddCommand(g *globals) *cobra.Command {
	var (
		fromUpstream string
		assumeYes    bool
	)

	cmd := &cobra.Command{
		Use:   "add [measurement]",
		Short: "Pin a TEE measurement",
		Long: "add pins a measurement you supply, or — with --from-upstream — the one the root\n" +
			"certificate of a live endpoint attests to.\n\n" +
			"--from-upstream is not trust-on-first-use. It fetches that host's bundle, runs the\n" +
			"whole attested-root check over the chain's root certificate, prints everything the\n" +
			"hardware said about itself, and asks before writing. A report whose signature does\n" +
			"not verify, or whose reportData does not commit to that certificate's key, is never\n" +
			"pinned: those are the legs pinning does not replace. What you are answering is the\n" +
			"one question left — whether this image is one you accept.\n\n" +
			"Its argument is a configured endpoint name, or a bare hostname.",
		Args: rangeArgs(0, 1, "add takes a measurement, or --from-upstream to take a live one"),
	}
	cmd.Flags().StringVar(&fromUpstream, "from-upstream", "",
		"pin the measurement this endpoint's root attests to right now, after review")
	cmd.Flags().BoolVarP(&assumeYes, "yes", "y", false, "do not ask for confirmation")

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		switch {
		case fromUpstream != "" && len(args) == 1:
			return failf(ExitUsage, "pass a measurement or --from-upstream, not both")
		case fromUpstream == "" && len(args) == 0:
			return failf(ExitUsage,
				"add needs a measurement, or --from-upstream <endpoint> to take the one an endpoint attests to")
		}

		measurement := ""
		if fromUpstream != "" {
			discovered, err := discoveredMeasurement(cmd, g, fromUpstream, assumeYes)
			if err != nil {
				return err
			}
			measurement = discovered
		} else {
			normalized, err := attestedroot.ParseMeasurement(args[0])
			if err != nil {
				return failf(ExitUsage, "%s", err)
			}
			measurement = normalized
		}

		store, err := g.open()
		if err != nil {
			return err
		}
		added, err := store.AddMeasurement(measurement)
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if !added {
			fmt.Fprintf(out, "%s is already pinned; nothing to do\n", measurement)
			return nil
		}
		fmt.Fprintf(out, "Pinned measurement %s in %s\n", measurement, store.Path())
		fmt.Fprintln(cmd.ErrOrStderr(),
			"note: this measurement is accepted because you pinned it, not because Super Protocol "+
				"signed it; reports and policies see it as \"attested (operator-pinned)\"")
		return nil
	}
	return cmd
}

// discoveredMeasurement verifies a live host, shows what its root certificate's
// TEE evidence proved, and returns the measurement once the user has agreed to
// pin it.
//
// The verification is expected to *fail*: the whole point is a root nothing
// vouches for yet, which is a denial at the untrusted-root stage. So the report
// is read for its attested-root panel rather than for its verdict — and every
// leg a pin does not replace is checked here explicitly, because a pin that does
// not make the endpoint verify is worse than a refusal: the command would exit 0
// and the operator would go looking for the problem somewhere else.
func discoveredMeasurement(cmd *cobra.Command, g *globals, target string, assumeYes bool) (string, error) {
	report, err := verifyTarget(cmd, g, target)
	if err != nil {
		return "", err
	}
	// Loaded the same way every editing command loads it: a config being filled
	// in one command at a time is legitimately incomplete (SUP-111).
	cfg, err := g.loadEditable()
	if err != nil {
		return "", err
	}

	attested := report.AttestedRoot
	switch {
	case attested == nil && report.Verified:
		return "", failf(ExitError,
			"%s already verifies against a trusted root, so no measurement was checked; nothing was pinned",
			target)
	case attested == nil && !cfg.AttestedRootsEnabled():
		// Nothing was measured because nothing was asked to measure it. Blaming
		// the upstream here would send the operator to the wrong machine.
		return "", failf(ExitConfig,
			"attestedRoots.enabled is false in %s, so no root was checked against its TEE evidence; "+
				"a pinned measurement would have no effect", g.path())
	case attested == nil:
		return "", failf(ExitDenied,
			"no TEE evidence was read from the root certificate of %s, so there is nothing to measure "+
				"(%s: %s); nothing was pinned", target, report.Stage, report.Reason)
	case !attested.ReportIntegrity:
		return "", failf(ExitDenied,
			"the hardware report of %s does not verify against the CPU vendor's root; nothing was pinned",
			target)
	case !attested.KeyBinding:
		return "", failf(ExitDenied,
			"the hardware report of %s does not commit to that certificate's public key, "+
				"so it attests some other VM; nothing was pinned", target)
	case attested.Measurement == "":
		return "", failf(ExitDenied,
			"no launch measurement could be derived for %s (%s); nothing was pinned", target, attested.Reason)
	case attested.InRegistry:
		return "", failf(ExitError,
			"measurement %s is already signed by Super Protocol, so pinning it would only weaken "+
				"how it is reported; nothing was pinned", attested.Measurement)
	case attested.MeasurementSource == string(attestedroot.SourceOperatorPinned):
		// Already accepted, by this very list. Re-running the command is how a
		// script makes sure of that, so it is a no-op with nothing to review
		// rather than a question about a decision that has been made.
		return attestedroot.ParseMeasurement(attested.Measurement)
	case !attested.MeasurementUnknown:
		// The registry never answered. Pinning on that basis would be a
		// permanent local decision taken because of a transient outage, about an
		// image Super Protocol may well have signed.
		return "", failf(ExitError,
			"the trusted registry could not be consulted, so it is not known whether Super Protocol "+
				"signed measurement %s (%s); nothing was pinned", attested.Measurement, attested.Reason)
	case cfg.AttestedRootsRequireNetworkType() == config.NetworkTypeTrusted &&
		attested.NetworkType != config.NetworkTypeTrusted:
		// requireNetworkType is a leg a pin does not replace, so pinning here
		// would leave the endpoint denied for a reason the operator just told
		// the gatekeeper to enforce.
		return "", failf(ExitDenied,
			"the root of %s declares network type %q and attestedRoots.requireNetworkType is %q, "+
				"so it would still be refused with the measurement pinned; nothing was pinned",
			target, attested.NetworkType, config.NetworkTypeTrusted)
	}

	w := cmd.ErrOrStderr()
	printAttestedRoot(w, attested)
	if !assumeYes {
		agreed, err := confirm(g.env, w,
			fmt.Sprintf("Accept measurement %s on your own authority?", attested.Measurement))
		if err != nil {
			return "", err
		}
		if !agreed {
			return "", failf(ExitError, "cancelled; nothing was pinned")
		}
	}
	return attestedroot.ParseMeasurement(attested.Measurement)
}

func newTrustMeasurementsRemoveCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "rm <measurement>",
		Aliases: []string{"remove"},
		Short:   "Unpin a TEE measurement",
		Long: "rm matches on the normalised value, so a pin written with a `sha256:` prefix or in\n" +
			"upper case can be removed by the hex the reports print.",
		Args: exactArgs(1, "rm takes exactly one argument: the measurement to unpin"),
	}

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		measurement, err := attestedroot.ParseMeasurement(args[0])
		if err != nil {
			return failf(ExitUsage, "%s", err)
		}
		store, err := g.open()
		if err != nil {
			return err
		}
		removed, err := store.RemoveMeasurement(measurement)
		if err != nil {
			return err
		}
		if !removed {
			return failf(ExitError, "%s is not pinned", measurement)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Unpinned measurement %s from %s\n", measurement, store.Path())
		return nil
	}
	return cmd
}
