// Package cli is the gatekeeper's command line: every command, its output, and
// its exit code.
//
// It lives under pkg/ rather than in cmd/ so that it can be tested the way it
// is used — the whole binary driven end to end through [Run], with its streams,
// its environment and its two runtime seams supplied by the caller. cmd/gatekeeper
// is four lines on top of it.
//
// Two capabilities are injected rather than imported, because they belong to
// components that are delivered separately: [status.Verifier] (the attestation
// pipeline) and [status.Supervisor] (the running proxy). A build without them
// still offers every configuration command; the commands that need them say so
// and exit with [ExitUnavailable] instead of pretending.
package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// Env is everything the CLI touches outside its own arguments. Filling it in
// is what makes the commands testable without a filesystem-wide fixture, a
// terminal or a network.
type Env struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// Environ is the process environment in `KEY=value` form; nil means
	// os.Environ().
	Environ []string

	// Verifier runs a one-shot verification for `verify` and for
	// `endpoint trust add --from-upstream`. Nil means this build has none.
	Verifier status.Verifier
	// Supervisor is the running proxy behind `status` and `run`. Nil means this
	// build has none.
	Supervisor status.Supervisor

	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// RunDashboard launches the TUI. Nil uses the real bubbletea program; tests
	// substitute a function that records what it was handed.
	RunDashboard func(ctx context.Context, opts DashboardOptions) error
	// IsTerminal reports whether stdout is a terminal. Nil means "no", which is
	// what keeps golden-file output stable.
	IsTerminal func() bool
}

func (e *Env) environ() []string {
	if e.Environ != nil {
		return e.Environ
	}
	return os.Environ()
}

func (e *Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Env) isTerminal() bool {
	return e.IsTerminal != nil && e.IsTerminal()
}

// Execute runs the CLI against the real process and returns the exit status.
func Execute() int {
	return Run(context.Background(), Env{
		Stdin:      os.Stdin,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		IsTerminal: func() bool { return isTerminal(os.Stdout) },
	}, os.Args[1:])
}

// Run executes one command line and returns the exit status. It never panics
// on a user error and never writes to the real process streams unless env says
// so.
func Run(ctx context.Context, env Env, args []string) int {
	if env.Stdout == nil {
		env.Stdout = io.Discard
	}
	if env.Stderr == nil {
		env.Stderr = io.Discard
	}

	root := New(&env)
	root.SetArgs(args)
	err := root.ExecuteContext(ctx)
	if err == nil {
		return ExitOK
	}

	code := codeOf(err)
	if message := err.Error(); message != "" {
		fmt.Fprintln(env.Stderr, "gatekeeper: "+message)
	}
	if code == ExitUsage {
		fmt.Fprintf(env.Stderr, "Run 'gatekeeper %s --help' for usage.\n", commandPath(root, args))
	}
	return code
}

// New builds the command tree.
func New(env *Env) *cobra.Command {
	g := &globals{env: env}

	root := &cobra.Command{
		Use:   "gatekeeper",
		Short: "Attesting proxy for the Confidential Router",
		Long: "gatekeeper verifies the evidence a Confidential Router endpoint publishes and only\n" +
			"then proxies traffic to it. Verification happens here, on your machine: the router\n" +
			"never learns whether, when, or by whom it was attested.",
		SilenceUsage:  true,
		SilenceErrors: true,
		// A bare `gatekeeper` prints help rather than starting a daemon: the
		// daemon has a name (`run`), and an accidental Enter must not open a
		// listening socket.
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
		// Cobra's own "unknown command" error carries no exit code of ours, so
		// a typo would look like a runtime failure instead of a usage one.
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return failf(ExitUsage, "unknown command %q for %q", args[0], cmd.CommandPath())
			}
			return nil
		},
	}
	root.SetIn(env.Stdin)
	root.SetOut(env.Stdout)
	root.SetErr(env.Stderr)
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return wrap(ExitUsage, err) })
	root.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		g.collect(cmd)
		return nil
	}

	g.register(root.PersistentFlags())
	root.AddCommand(
		newInitCommand(g),
		newConfigCommand(g),
		newTrustCommand(g),
		newEndpointCommand(g),
		newPolicyCommand(g),
		newVerifyCommand(g),
		newRunCommand(g),
		newStatusCommand(g),
		newVersionCommand(g),
	)
	return root
}

// commandPath resolves what the user actually typed, so the usage hint points
// at the subcommand that rejected the arguments rather than at the root.
func commandPath(root *cobra.Command, args []string) string {
	cmd, _, err := root.Find(args)
	if err != nil || cmd == nil || cmd == root {
		return ""
	}
	path := cmd.CommandPath()
	return path[len("gatekeeper "):]
}
