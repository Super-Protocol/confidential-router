package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/tui"
)

// DashboardOptions is what `run` hands the TUI. It is an alias so that a caller
// substituting Env.RunDashboard builds the same value the real dashboard takes.
type DashboardOptions = tui.Options

// defaultDrainTimeout bounds a graceful shutdown. Past it, listeners are closed
// with requests still in flight rather than hanging a systemd stop.
const defaultDrainTimeout = 30 * time.Second

func newRunCommand(g *globals) *cobra.Command {
	var (
		headless bool
		demo     bool
		drain    time.Duration
	)

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the gatekeeper",
		Long: "run starts every configured endpoint and keeps them attested.\n\n" +
			"With a terminal it opens the dashboard; --headless streams log lines instead, which\n" +
			"is what a container or a systemd unit wants. SIGHUP reloads the configuration in\n" +
			"place; SIGINT and SIGTERM drain the listeners and exit.",
		Args: cobra.NoArgs,
	}
	cmd.Flags().BoolVar(&headless, "headless", false, "log to stdout instead of opening the dashboard")
	cmd.Flags().BoolVar(&demo, "demo", false,
		"drive the dashboard from invented data instead of a real proxy — nothing is fetched or verified")
	cmd.Flags().DurationVar(&drain, "drain-timeout", defaultDrainTimeout,
		"how long a graceful shutdown waits for in-flight requests")

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		cfg, err := g.load()
		if err != nil {
			return err
		}

		supervisor := g.env.Supervisor
		if demo {
			// --demo replaces whatever this build has: the point is to see the
			// dashboard, not to half-run a real proxy.
			supervisor = status.NewDemo(cfg)
			fmt.Fprintln(cmd.ErrOrStderr(),
				"warning: --demo — no evidence is fetched, verified or proxied; every verdict on screen is invented")
		}
		if supervisor == nil {
			return failf(ExitUnavailable,
				"this build has no proxy data plane wired in, so there is nothing to run\n"+
					"       (try `gatekeeper run --demo` to see the dashboard; see apps/gatekeeper/README.md)")
		}

		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()

		// The dashboard owns the terminal while it is up, so a reload writes
		// nothing: the new configuration shows up in the next snapshot, and a
		// stray line here would tear a hole in the alternate screen.
		reloadLog := io.Discard
		if headless {
			reloadLog = cmd.ErrOrStderr()
		}
		go watchHangup(ctx, g, reloadLog, supervisor)

		if headless {
			err = runHeadless(ctx, cmd.OutOrStdout(), supervisor)
		} else {
			// --demo deliberately gets no trust store: its digests and roots
			// are invented, and the keys that pin them would otherwise write
			// fiction into the user's real configuration.
			store := openStoreOrNil(g)
			if demo {
				store = nil
			}
			err = g.dashboard(ctx, tui.Options{
				Supervisor: supervisor,
				Store:      store,
				ConfigPath: g.path(),
				Endpoints:  len(cfg.Endpoints),
			})
		}
		// A context that is already done is the shutdown signal, not a failure:
		// whatever the dashboard or the event loop returned on the way out —
		// context.Canceled, a deadline, bubbletea's own kill error — describes
		// the exit that was asked for.
		if err != nil && ctx.Err() == nil {
			return err
		}

		// The signal context is already done here, so the drain gets a deadline
		// of its own rather than inheriting a cancelled one.
		drainCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), drain)
		defer cancel()
		shutdown(drainCtx, cmd.ErrOrStderr(), supervisor, cfg)
		return nil
	}
	return cmd
}

// dashboard launches the TUI, through Env.RunDashboard when one was supplied.
func (g *globals) dashboard(ctx context.Context, opts tui.Options) error {
	if g.env.RunDashboard != nil {
		return g.env.RunDashboard(ctx, opts)
	}
	return tui.Run(ctx, opts)
}

// openStoreOrNil is the editable trust store the dashboard's "trust this
// deployment" and "add this root" keys write through. A config that cannot be
// opened for editing is not fatal — the dashboard is still worth showing, it
// just cannot change anything.
func openStoreOrNil(g *globals) *trust.Store {
	store, err := trust.Open(g.path())
	if err != nil {
		return nil
	}
	return store
}

// runHeadless streams the supervisor's log lines until the context is done.
func runHeadless(ctx context.Context, w io.Writer, supervisor status.Supervisor) error {
	events := supervisor.Events(ctx)
	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-events:
			if !ok {
				return nil
			}
			if event.Kind == status.EventLog && event.Log != nil {
				fmt.Fprintf(w, "%s %-5s %-16s %s\n",
					event.Log.At.UTC().Format(time.RFC3339), event.Log.Level,
					event.Log.Endpoint, event.Log.Message)
			}
		}
	}
}

// watchHangup reloads the configuration on SIGHUP.
//
// A reload that fails to load or validate changes nothing: the running
// configuration is a working one, and replacing it with a broken one because
// someone saved a file mid-edit would take the proxy down for a typo.
func watchHangup(ctx context.Context, g *globals, w io.Writer, supervisor status.Supervisor) {
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)

	for {
		select {
		case <-ctx.Done():
			return
		case <-hup:
		}

		cfg, err := g.load()
		if err != nil {
			fmt.Fprintf(w, "SIGHUP: keeping the running configuration — %v\n", err)
			continue
		}
		reloader, ok := supervisor.(status.Reloader)
		if !ok {
			fmt.Fprintln(w, "SIGHUP: this gatekeeper cannot reload in place; restart to apply changes")
			continue
		}
		if err := reloader.Reload(ctx, cfg); err != nil {
			fmt.Fprintf(w, "SIGHUP: reload failed, keeping the running configuration — %v\n", err)
			continue
		}
		fmt.Fprintf(w, "SIGHUP: reloaded %s\n", g.path())
	}
}

// shutdown stops every endpoint, giving each the remaining drain budget.
func shutdown(ctx context.Context, w io.Writer, supervisor status.Supervisor, cfg *config.Config) {
	for _, ep := range cfg.Endpoints {
		if err := supervisor.Stop(ctx, ep.Name); err != nil {
			fmt.Fprintf(w, "stopping %s: %v\n", ep.Name, err)
		}
	}
	fmt.Fprintln(w, "gatekeeper stopped")
}
