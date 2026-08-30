package cli

import "github.com/spf13/cobra"

// exactArgs is cobra.ExactArgs with a message that says what the argument is
// for, and an exit status of ExitUsage rather than the generic failure code.
func exactArgs(n int, message string) cobra.PositionalArgs {
	return func(_ *cobra.Command, args []string) error {
		if len(args) != n {
			return failf(ExitUsage, "%s", message)
		}
		return nil
	}
}

// rangeArgs is exactArgs for a command with an optional trailing argument.
func rangeArgs(minimum, maximum int, message string) cobra.PositionalArgs {
	return func(_ *cobra.Command, args []string) error {
		if len(args) < minimum || len(args) > maximum {
			return failf(ExitUsage, "%s", message)
		}
		return nil
	}
}
