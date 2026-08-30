package tui

import (
	"bytes"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// TestDashboardDrivenAsAProgram runs the dashboard the way bubbletea will: a
// real program loop, a terminal size, keystrokes arriving as input. The
// Update-level tests cover the state transitions; this one covers the wiring
// between them — that Init actually subscribes, that an event published while
// the program is running reaches the screen, and that a keystroke reaches the
// supervisor.
func TestDashboardDrivenAsAProgram(t *testing.T) {
	supervisor := newFakeSupervisor(confidentialEndpoint("llama-33-70b"))
	model := New(Options{
		Supervisor: supervisor,
		ConfigPath: "/home/u/.config/confidential-gatekeeper/config.yaml",
		Now:        func() time.Time { return fixedNow },
	})

	program := teatest.NewTestModel(t, model, teatest.WithInitialTermSize(120, 40))

	teatest.WaitFor(t, program.Output(), func(out []byte) bool {
		return bytes.Contains(out, []byte("llama-33-70b"))
	}, teatest.WithDuration(5*time.Second))

	// An endpoint changes state while the dashboard is up; the event has to
	// arrive without anyone pressing anything.
	degraded := confidentialEndpoint("llama-33-70b")
	degraded.Health = status.Broken
	degraded.Reason = "the chain terminates in an untrusted root"
	snapshot := status.Snapshot{At: fixedNow, Endpoints: []status.Endpoint{degraded}}
	supervisor.events <- status.Event{Kind: status.EventSnapshot, Snapshot: &snapshot}

	teatest.WaitFor(t, program.Output(), func(out []byte) bool {
		return bytes.Contains(out, []byte("broken"))
	}, teatest.WithDuration(5*time.Second))

	program.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	teatest.WaitFor(t, program.Output(), func([]byte) bool {
		supervisor.mu.Lock()
		defer supervisor.mu.Unlock()
		return len(supervisor.reattest) > 0
	}, teatest.WithDuration(5*time.Second))

	program.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	program.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))
}
