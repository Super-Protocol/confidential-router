package cli

import (
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

//go:embed starter.yaml
var starterConfig string

// starterMode matches the mode config.Document saves with: the file holds trust
// anchors, so it is owner-only from the moment it exists.
const starterMode os.FileMode = 0o600

func newInitCommand(g *globals) *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "init",
		Short: "Write a starter configuration file",
		Long: "init writes a commented configuration skeleton at the resolved config path.\n\n" +
			"The file it writes is deliberately not runnable yet: it has no trusted roots and\n" +
			"no endpoints, because there is no trust-on-first-use — you add both explicitly.\n" +
			"`gatekeeper config validate` tells you what is still missing.",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
	}
	asJSON := jsonFlag(cmd)
	cmd.Flags().BoolVar(&force, "force", false, "overwrite an existing configuration file")

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		path := g.path()
		p := g.printer(cmd, *asJSON)

		created, err := writeStarter(path, force)
		if err != nil {
			return err
		}

		return p.emit(map[string]any{"path": path, "created": created}, func(w io.Writer) {
			if !created {
				fmt.Fprintf(w, "Configuration already exists at %s; nothing was written.\n", path)
				nextStep(w, "check what is still missing", "gatekeeper config validate")
				fmt.Fprintln(w, "\nTo start over from a fresh starter file: gatekeeper init --force")
				return
			}
			fmt.Fprintf(w, "Configuration created at %s\n", path)
			nextStep(w, "front the endpoint you want to verify", addEndpointExample())
		})
	}
	return cmd
}

// writeStarter creates the config file, reporting whether it wrote one. Without
// --force an existing file is left alone rather than overwritten: that file
// holds the user's trust anchors, and `init` is exactly the command someone
// runs twice by accident.
func writeStarter(path string, force bool) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		if !force {
			return false, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	if err := os.WriteFile(path, []byte(starterConfig), starterMode); err != nil {
		return false, err
	}
	// WriteFile honours the mode only when it creates the file, so --force over
	// a world-readable file would keep the old permissions.
	if err := os.Chmod(path, starterMode); err != nil {
		return false, err
	}
	return true, nil
}
