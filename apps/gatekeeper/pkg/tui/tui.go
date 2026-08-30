// Package tui is the gatekeeper's dashboard: a bubbletea program over the same
// [status.Supervisor] the `status` command reads.
//
// It knows nothing about the proxy's internals. Everything on screen comes from
// snapshots and events published by the supervisor, and the three keys that
// change something — start/stop, re-attest, "trust this deployment" — go back
// through the supervisor or through the trust store. That is what lets the
// dashboard be driven by the demo supervisor, and tested without a terminal.
package tui

import (
	"context"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// Options configures a dashboard.
type Options struct {
	// Supervisor is the running gatekeeper. Required.
	Supervisor status.Supervisor
	// Store backs the keys that edit the configuration — pinning the published
	// digest, adding an untrusted root. Nil makes those keys report that the
	// configuration is not writable rather than failing halfway.
	Store *trust.Store
	// ConfigPath is shown in the header, so a user with several configs can see
	// which one this dashboard is about.
	ConfigPath string
	// Endpoints is how many endpoints the config declares, used before the
	// first snapshot arrives.
	Endpoints int
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// Run opens the dashboard and blocks until the user quits or ctx is done.
func Run(ctx context.Context, opts Options) error {
	program := tea.NewProgram(
		New(opts),
		tea.WithContext(ctx),
		tea.WithAltScreen(),
		// The mouse is deliberately left alone: capturing it would break
		// select-and-copy, and every action here has a key.
	)
	final, err := program.Run()
	// Quitting with `q` cancels the event subscription on the way out, but a
	// dashboard torn down through ctx never reaches that key handler. Without
	// this the supervisor would keep publishing into a channel nobody reads —
	// harmless for a process that is exiting, a leak for anything embedding it.
	if model, ok := final.(Model); ok {
		model.stop()
	}
	return err
}
