package cli

import (
	"fmt"
	"io"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func newEndpointCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "endpoint",
		Short: "Manage the proxied endpoints and their pinned evidence",
		Args:  cobra.NoArgs,
		RunE:  func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(
		newEndpointListCommand(g),
		newEndpointAddCommand(g),
		newEndpointRemoveCommand(g),
		newEndpointTrustCommand(g),
		newEndpointDiscoverCommand(g),
	)
	return cmd
}

// endpointView is one endpoint as `endpoint list` reports it.
type endpointView struct {
	Name     string `json:"name"`
	Listen   string `json:"listen"`
	Upstream string `json:"upstream"`
	FailMode string `json:"failMode"`
	// Pins are the canonical forms of the pinned evidenceDigest values.
	Pins []string `json:"trustedEvidence"`
}

func newEndpointListCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the configured endpoints",
		Args:  cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		store, err := g.open()
		if err != nil {
			return err
		}
		endpoints := store.Endpoints()
		views := make([]endpointView, 0, len(endpoints))
		for _, ep := range endpoints {
			pins := make([]string, 0, len(ep.Pins))
			for _, pin := range ep.Pins {
				pins = append(pins, pin.Digest.String())
			}
			views = append(views, endpointView{
				Name: ep.Name, Listen: ep.Listen, Upstream: ep.Upstream,
				FailMode: ep.FailMode, Pins: pins,
			})
		}

		return g.printer(cmd, *asJSON).emit(views, func(w io.Writer) {
			if len(views) == 0 {
				fmt.Fprintln(w, "No endpoints. Add one:")
				fmt.Fprintln(w, "  gatekeeper endpoint add <name> --listen 127.0.0.1:8443 --upstream https://<host>")
				return
			}
			rows := make([][]string, 0, len(views))
			for _, v := range views {
				pins := strconv.Itoa(len(v.Pins))
				if len(v.Pins) == 0 {
					pins = "0 (never admits)"
				}
				rows = append(rows, []string{v.Name, v.Listen, v.Upstream, v.FailMode, pins})
			}
			table(w, []string{"NAME", "LISTEN", "UPSTREAM", "FAIL MODE", "PINS"}, rows)
		})
	}
	return cmd
}

func newEndpointAddCommand(g *globals) *cobra.Command {
	var (
		listen   string
		upstream string
		failMode string
		pins     []string
	)

	cmd := &cobra.Command{
		Use:   "add <name> --listen <host:port> --upstream <https://host>",
		Short: "Add an endpoint",
		Long: "add appends a local listener for one upstream. It is written without pins unless\n" +
			"--trust is given; until the endpoint has at least one pinned evidenceDigest it can\n" +
			"never admit traffic, and `gatekeeper config validate` says so.\n\n" +
			"The usual next step is to look at what the upstream publishes and pin it:\n" +
			"  gatekeeper endpoint discover <name>\n" +
			"  gatekeeper endpoint trust add <name> --from-upstream",
		Args: exactArgs(1, "add takes exactly one argument: the endpoint name"),
	}
	cmd.Flags().StringVar(&listen, "listen", "", "local `host:port` to bind, e.g. 127.0.0.1:8443")
	cmd.Flags().StringVar(&upstream, "upstream", "", "`https://host` of the router endpoint")
	cmd.Flags().StringVar(&failMode, "fail-mode", "",
		"`closed` or `open` for this endpoint; omit to inherit the global default")
	cmd.Flags().StringArrayVar(&pins, "trust", nil,
		"pinned evidenceDigest; repeatable, accepts sha256/<base64url>, sha256:<hex> or bare hex")
	_ = cmd.MarkFlagRequired("listen")
	_ = cmd.MarkFlagRequired("upstream")

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		name := args[0]

		// Normalise the pins here so that a typo is rejected before anything is
		// written, and so the file always holds the canonical spelling.
		canonical := make([]string, 0, len(pins))
		for _, raw := range pins {
			digest, err := trust.ParseDigest(raw)
			if err != nil {
				return failf(ExitUsage, "--trust %s", err)
			}
			canonical = append(canonical, digest.String())
		}

		store, err := g.open()
		if err != nil {
			return err
		}
		if err := store.AddEndpoint(config.EndpointSpec{
			Name: name, Listen: listen, Upstream: upstream,
			FailMode: failMode, TrustedEvidence: canonical,
		}); err != nil {
			return err
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Added endpoint %q (%s → %s) to %s\n", name, listen, upstream, store.Path())
		if len(canonical) == 0 {
			fmt.Fprintf(cmd.ErrOrStderr(),
				"warning: %q has no pinned evidenceDigest and cannot admit traffic yet; "+
					"pin one with `gatekeeper endpoint trust add %s --from-upstream`\n", name, name)
		}
		return nil
	}
	return cmd
}

func newEndpointRemoveCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "rm <name>",
		Aliases: []string{"remove"},
		Short:   "Remove an endpoint and its pins",
		Args:    exactArgs(1, "rm takes exactly one argument: the endpoint name"),
	}

	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		name := args[0]
		store, err := g.open()
		if err != nil {
			return err
		}
		removed, err := store.RemoveEndpoint(name)
		if err != nil {
			return err
		}
		if !removed {
			return failf(ExitError, "no endpoint named %q", name)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed endpoint %q from %s\n", name, store.Path())
		return nil
	}
	return cmd
}
