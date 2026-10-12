package cli

import (
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func newTrustCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "trust",
		Short: "Manage the global trust anchors: roots and TEE measurements",
		Args:  cobra.NoArgs,
		RunE:  func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	roots := &cobra.Command{
		Use:   "roots",
		Short: "List, add and remove trusted roots (\"Trusted Clouds\")",
		Long: "Trusted roots are global, not per endpoint: a root identifies a cloud, an endpoint\n" +
			"identifies a deployment. A bundle is accepted only if its certificate chain ends in\n" +
			"one of these, matched by the SHA-256 of the root's DER.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	roots.AddCommand(newTrustRootsListCommand(g), newTrustRootsAddCommand(g), newTrustRootsRemoveCommand(g))
	cmd.AddCommand(roots, newTrustMeasurementsCommand(g))
	return cmd
}

// rootView is one trusted root as `trust roots list` reports it.
type rootView struct {
	Name string `json:"name"`
	// Fingerprint is the human-facing `sha256:<hex>` form, Canonical the
	// `sha256/<base64url>` one a bundle's chain is matched against.
	Fingerprint string    `json:"fingerprint"`
	Canonical   string    `json:"fingerprintCanonical"`
	Subject     string    `json:"subject"`
	NotBefore   time.Time `json:"notBefore"`
	NotAfter    time.Time `json:"notAfter"`
	// Expired is derived rather than left to the reader: an expired trust
	// anchor is the kind of thing that explains a whole afternoon.
	Expired bool `json:"expired"`
}

func newTrustRootsListCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the trusted roots",
		Args:  cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		store, err := g.open()
		if err != nil {
			return err
		}
		now := g.env.now()

		views := make([]rootView, 0, len(store.Roots()))
		for _, root := range store.Roots() {
			views = append(views, rootView{
				Name:        root.Name,
				Fingerprint: root.Fingerprint.Display(),
				Canonical:   root.Fingerprint.String(),
				Subject:     root.Certificate.Subject.String(),
				NotBefore:   root.Certificate.NotBefore,
				NotAfter:    root.Certificate.NotAfter,
				Expired:     now.After(root.Certificate.NotAfter),
			})
		}

		p := g.printer(cmd, *asJSON)
		return p.emit(views, func(w io.Writer) {
			if len(views) == 0 {
				printNoRoots(w, store.Path(), g.attestedRootsOn())
				return
			}
			rows := make([][]string, 0, len(views))
			for _, v := range views {
				expiry := v.NotAfter.Format(time.DateOnly)
				if v.Expired {
					expiry += " (EXPIRED)"
				}
				rows = append(rows, []string{v.Name, shortDigest(v.Fingerprint), v.Subject, expiry})
			}
			table(w, []string{"NAME", "FINGERPRINT", "SUBJECT", "EXPIRES"}, rows)
		})
	}
	return cmd
}

// printNoRoots explains an empty trustedRoots list, which is two completely
// different situations.
//
// With the attested-root anchor on — the default — an empty list is the normal,
// finished state: a Swarm cloud's CA is accepted on its own TEE evidence, so
// 99% of readers never add a root at all. This is the one place that note
// belongs. `gatekeeper init` used to print it on its success path, where it was
// the entire output of a command whose own result it never mentioned (SUP-300);
// the starter file it writes carries the same explanation as a comment, next to
// the `trustedRoots: []` it is about.
//
// With the anchor off, an empty list really does mean nothing can ever be
// verified, and saying so is the whole point of the message.
func printNoRoots(w io.Writer, path string, attestedRootsOn bool) {
	if !attestedRootsOn {
		fmt.Fprintf(w, "No trusted roots in %s, and attestedRoots is off.\n", path)
		fmt.Fprintln(w, "Every endpoint is denied at the untrusted-root stage until one is added.")
		nextStep(w, "trust the cloud's root certificate",
			"gatekeeper trust roots add <name> --pem-file <root.pem>")
		return
	}
	fmt.Fprintf(w, "No manually trusted roots in %s.\n", path)
	// Wrapped on its own rather than around the path: the path's length is not
	// known here, and a sentence broken to fit one machine reads broken on the
	// next.
	fmt.Fprintln(w, "\nA Swarm cloud needs none — its certificate authority is accepted on its own TEE")
	fmt.Fprintln(w, "evidence (attestedRoots). Add a root only to pin one particular cloud, or to trust")
	fmt.Fprintln(w, "a CA that publishes no evidence:")
	fmt.Fprintln(w, "  gatekeeper trust roots add <name> --pem-file <root.pem>")
}

func newTrustRootsAddCommand(g *globals) *cobra.Command {
	var pemFile string

	cmd := &cobra.Command{
		Use:   "add <name> --pem-file <file>",
		Short: "Add a trusted root",
		Long: "add reads a PEM certificate and records it under a name. Pass `-` as the file to\n" +
			"read it from standard input.\n\n" +
			"Adding a root that is already trusted under another name is a no-op — roots are\n" +
			"identified by their fingerprint, not by what you called them. Replacing one is an\n" +
			"explicit `rm` followed by an `add`.",
		Args: exactArgs(1, "add takes exactly one argument: the name to record the root under"),
	}
	cmd.Flags().StringVar(&pemFile, "pem-file", "", "PEM certificate file, or `-` for standard input")
	_ = cmd.MarkFlagRequired("pem-file")

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		name := args[0]
		pemBytes, err := readPEM(g.env, pemFile)
		if err != nil {
			return err
		}
		store, err := g.open()
		if err != nil {
			return err
		}

		added, err := store.AddRoot(name, pemBytes)
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if !added {
			fingerprint, _ := trust.FingerprintPEM(pemBytes)
			existing, _ := store.RootByFingerprint(fingerprint)
			fmt.Fprintf(out, "Already trusted as %q (%s) in %s; nothing to do.\n",
				existing.Name, fingerprint.Display(), store.Path())
			return nil
		}
		fingerprint, _ := trust.FingerprintPEM(pemBytes)
		fmt.Fprintf(out, "Added trusted root %q (%s) to %s\n", name, fingerprint.Display(), store.Path())
		nextStep(out, "check that the endpoint it vouches for now verifies",
			"gatekeeper verify <endpoint>")
		return nil
	}
	return cmd
}

func newTrustRootsRemoveCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "rm <name>",
		Aliases: []string{"remove"},
		Short:   "Remove a trusted root",
		Args:    exactArgs(1, "rm takes exactly one argument: the name of the root to remove"),
	}

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		name := args[0]
		store, err := g.open()
		if err != nil {
			return err
		}
		removed, err := store.RemoveRoot(name)
		if err != nil {
			return err
		}
		if !removed {
			return failf(ExitError, "no trusted root named %q", name)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed trusted root %q from %s\n", name, store.Path())
		// Removing the last root is allowed — resetting the trust store is a
		// real operation — but what is left behind differs enough to be worth
		// saying out loud rather than discovering at runtime.
		if len(store.Roots()) == 0 {
			if g.attestedRootsOn() {
				fmt.Fprintln(cmd.ErrOrStderr(),
					"warning: no trusted roots remain; only roots that prove they are Super Swarm roots "+
						"will be accepted (attestedRoots)")
			} else {
				fmt.Fprintln(cmd.ErrOrStderr(),
					"warning: no trusted roots remain and attestedRoots is off; "+
						"every endpoint will be denied at the untrusted-root stage")
			}
		}
		return nil
	}
	return cmd
}

// readPEM reads a certificate from a file or, for `-`, from standard input.
func readPEM(env *Env, path string) ([]byte, error) {
	if path == "-" {
		if env.Stdin == nil {
			return nil, failf(ExitUsage, "`--pem-file -` was given but there is no standard input to read")
		}
		return io.ReadAll(io.LimitReader(env.Stdin, maxPEMSize))
	}
	data, err := os.ReadFile(path) //nolint:gosec // operator-supplied path by design
	if err != nil {
		return nil, err
	}
	return data, nil
}

// maxPEMSize caps a certificate read from stdin. A root CA is a couple of
// kilobytes.
const maxPEMSize = 1 << 20
