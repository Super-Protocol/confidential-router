package cli

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/version"
)

func newVersionCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print the build identity",
		Args:  cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		info := version.Get()
		return g.printer(cmd, *asJSON).emit(info, func(w io.Writer) {
			fmt.Fprintln(w, info.String())
		})
	}
	return cmd
}
