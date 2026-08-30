package cli

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	policytesting "github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy/testing"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func newPolicyCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "policy",
		Short: "Inspect and exercise the policy layer",
		Long: "A request is admitted only if every loaded package's `allow` is true: the built-in\n" +
			"evidenceDigest pin policy plus each of your `policies[]`. A policy can narrow trust,\n" +
			"never widen it.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(newPolicyListCommand(g), newPolicyTestCommand(g))
	return cmd
}

// policyView is one loaded Rego package as `policy list` reports it.
type policyView struct {
	// Name is policies[].name; empty for the built-in policy.
	Name    string `json:"name,omitempty"`
	Package string `json:"package"`
	// File is where the module came from, or "(built-in)"/"(generated)".
	File     string `json:"file"`
	Builtin  bool   `json:"builtin"`
	Endpoint string `json:"-"`
}

func newPolicyListCommand(g *globals) *cobra.Command {
	var showTrustModule bool

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the policy packages that would be evaluated",
		Long: "list compiles the whole policy set — the trust module generated from your config,\n" +
			"the built-in pin policy and every user policy — and lists what came out. A module\n" +
			"that does not compile, or that declares no `allow` rule, fails here rather than on\n" +
			"the first request.",
		Args: cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)
	cmd.Flags().BoolVar(&showTrustModule, "show-trust-module", false,
		"also print the generated gatekeeper.trust module")

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		cfg, err := g.load()
		if err != nil {
			return err
		}
		store, err := trust.New(cfg)
		if err != nil {
			return wrap(ExitConfig, err)
		}
		modules, err := policy.LoadModules(cfg)
		if err != nil {
			return wrap(ExitConfig, err)
		}
		engine, err := policy.New(cmd.Context(), policy.Options{Store: store, Modules: modules})
		if err != nil {
			return wrap(ExitConfig, err)
		}

		// The engine reports its packages in load order; the config supplies
		// the name and file each one came from.
		views := make([]policyView, 0, len(engine.Packages()))
		for i, pkg := range engine.Packages() {
			view := policyView{Package: pkg, File: "(built-in)", Builtin: true}
			if i > 0 && i-1 < len(cfg.Policies) {
				view = policyView{
					Name:    cfg.Policies[i-1].Name,
					Package: pkg,
					File:    cfg.Resolve(cfg.Policies[i-1].File),
				}
			}
			views = append(views, view)
		}

		p := g.printer(cmd, *asJSON)
		payload := map[string]any{"packages": views}
		if showTrustModule {
			payload["trustModule"] = engine.TrustModule()
		}
		return p.emit(payload, func(w io.Writer) {
			rows := make([][]string, 0, len(views))
			for _, v := range views {
				name := v.Name
				if name == "" {
					name = "(built-in)"
				}
				rows = append(rows, []string{name, v.Package, v.File})
			}
			table(w, []string{"NAME", "PACKAGE", "FILE"}, rows)
			fmt.Fprintf(w, "\nAll %d package(s) must allow for a request to be admitted.\n", len(views))
			if showTrustModule {
				fmt.Fprintf(w, "\nGenerated data.gatekeeper.trust:\n\n%s\n", engine.TrustModule())
			}
		})
	}
	return cmd
}

// policyTestResult is the JSON shape of `policy test`.
type policyTestResult struct {
	Bundle   string `json:"bundle"`
	Endpoint string `json:"endpoint"`
	// Admitted is the honest bottom line — would the gatekeeper let this
	// through — and requires cryptographic verification as well as a policy
	// allow. PolicyAllow is the policy layer's answer on its own, which is what
	// this command exists to exercise and what the exit status follows.
	Admitted       bool                `json:"admitted"`
	CryptoVerified bool                `json:"cryptoVerified"`
	PolicyAllow    bool                `json:"policyAllow"`
	Reason         string              `json:"reason"`
	Packages       []policyTestPackage `json:"packages"`
	Warnings       []string            `json:"warnings,omitempty"`
	Input          map[string]any      `json:"input,omitempty"`
}

type policyTestPackage struct {
	Package string `json:"package"`
	Policy  string `json:"policy,omitempty"`
	Allow   bool   `json:"allow"`
	Error   string `json:"error,omitempty"`
}

func newPolicyTestCommand(g *globals) *cobra.Command {
	var (
		endpoint  string
		showInput bool
	)

	cmd := &cobra.Command{
		Use:   "test <bundle.json>",
		Short: "Evaluate your policies against a saved evidence bundle",
		Long: "test answers \"would my policies admit this payload?\" offline, against a bundle you\n" +
			"saved from an endpoint.\n\n" +
			"Unless this build has an attestation pipeline wired in the run is POLICY-ONLY: the\n" +
			"JWS signature, the certificate chain and the bundle's freshness are not checked, and\n" +
			"there is no live TLS channel to bind to. `Admitted` is therefore false whatever the\n" +
			"policies said, and every shortcut taken is listed. The exit status follows the policy\n" +
			"decision — 0 for allow, 3 for deny — because that is what the command tests.",
		Args: exactArgs(1, "test takes exactly one argument: the path of a saved bundle"),
	}
	asJSON := jsonFlag(cmd)
	cmd.Flags().StringVar(&endpoint, "endpoint", "",
		"evaluate as this endpoint; default: the one whose upstream matches the bundle")
	cmd.Flags().BoolVar(&showInput, "show-input", false, "also print the exact input document the policies saw")

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		bundlePath := args[0]
		result, err := policytesting.EvaluateFile(cmd.Context(), bundlePath, g.path(), policytesting.Options{
			Endpoint: endpoint,
			Verify:   verifyFuncFor(g),
		})
		if err != nil {
			return err
		}

		out := policyTestResult{
			Bundle:         bundlePath,
			Endpoint:       result.Endpoint,
			Admitted:       result.Admitted,
			CryptoVerified: result.CryptoVerified,
			PolicyAllow:    result.Decision.Allow,
			Reason:         result.Decision.Reason,
			Warnings:       result.Warnings,
			Packages:       make([]policyTestPackage, 0, len(result.Decision.Packages)),
		}
		for _, decision := range result.Decision.Packages {
			out.Packages = append(out.Packages, policyTestPackage{
				Package: decision.Package, Policy: decision.Policy,
				Allow: decision.Allow, Error: decision.Error,
			})
		}
		if showInput {
			out.Input = result.Input
		}

		p := g.printer(cmd, *asJSON)
		if err := p.emit(out, func(w io.Writer) { printPolicyTest(w, out) }); err != nil {
			return err
		}
		if !out.PolicyAllow {
			return silentf(ExitDenied)
		}
		return nil
	}
	return cmd
}

func printPolicyTest(w io.Writer, r policyTestResult) {
	fmt.Fprintf(w, "Admitted: %s\n", admittedLine(r))
	fields(w, [][2]string{
		{"Endpoint", r.Endpoint},
		{"Bundle", r.Bundle},
		{"Policy decision", allowLine(r.PolicyAllow) + " — " + r.Reason},
	})

	fmt.Fprintln(w, "\nPackages")
	rows := make([][]string, 0, len(r.Packages))
	for _, pkg := range r.Packages {
		name := pkg.Policy
		if name == "" {
			name = "(built-in)"
		}
		verdict := allowLine(pkg.Allow)
		if pkg.Error != "" {
			verdict = "ERROR: " + pkg.Error
		}
		rows = append(rows, []string{name, pkg.Package, verdict})
	}
	table(w, []string{"  POLICY", "PACKAGE", "RESULT"}, indent(rows))

	for _, warning := range r.Warnings {
		fmt.Fprintf(w, "\n! %s\n", warning)
	}
	if r.Input != nil {
		fmt.Fprintln(w, "\nInput document")
		writeJSON(w, r.Input)
	}
}

func admittedLine(r policyTestResult) string {
	switch {
	case r.Admitted:
		return "yes"
	case !r.CryptoVerified:
		return "no — this was a policy-only run, so admission was never established"
	default:
		return "no"
	}
}

func allowLine(allow bool) string {
	if allow {
		return "allow"
	}
	return "DENY"
}

// verifyFuncFor decides whether `policy test` runs the cryptographic pipeline.
//
// It returns nil — policy-only — on purpose. Offline there is no TLS handshake
// to observe, and observed channel binding is the only binding the gatekeeper
// accepts (ADR-003 §1), so a run that checked the chain, the signature and the
// freshness would still not be an admission and reporting it as one would be
// worse than not checking. `gatekeeper verify` is the command that answers
// "would this be let through"; this one answers "do my policies say yes".
func verifyFuncFor(_ *globals) policytesting.VerifyFunc { return nil }
