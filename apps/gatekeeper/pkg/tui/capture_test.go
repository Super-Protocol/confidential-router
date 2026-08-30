package tui

import (
	"os"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// TestCaptureDashboard writes the screens embedded in apps/gatekeeper/README.md.
// It is a generator, not an assertion: run it with -capture after changing the
// layout so the documented screens are the ones the code actually draws.
func TestCaptureDashboard(t *testing.T) {
	if os.Getenv("GATEKEEPER_CAPTURE") == "" {
		t.Skip("set GATEKEEPER_CAPTURE=1 to regenerate the documented screens")
	}

	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	cfg, err := config.Parse(strings.NewReader(`version: 1
trustedRoots: []
endpoints:
  - name: llama-33-70b
    listen: 127.0.0.1:8443
    upstream: https://llama-33-70b.tee.swarm.cloud
    trustedEvidence: []
  - name: qwen25-72b
    listen: 127.0.0.1:8444
    upstream: https://qwen25-72b.tee.swarm.cloud
    failMode: open
    trustedEvidence: []
`), "config.yaml")
	if err != nil {
		t.Fatal(err)
	}

	demo := status.NewDemo(cfg).WithClock(func() time.Time { return at })
	for range 8 {
		if _, err := demo.Reattest(t.Context(), "llama-33-70b"); err != nil {
			t.Fatal(err)
		}
		if _, err := demo.Reattest(t.Context(), "qwen25-72b"); err != nil {
			t.Fatal(err)
		}
	}

	m := New(Options{
		Supervisor: demo,
		ConfigPath: "~/.config/confidential-gatekeeper/config.yaml",
		Now:        func() time.Time { return at },
	})
	m = update(m, tea.WindowSizeMsg{Width: 98, Height: 30})
	m = update(m, snapshotMsg(demo.Snapshot(t.Context())))
	// A live subscription, so the status bar reads the way it does in use
	// rather than warning that nothing is arriving.
	m = update(m, subscribedMsg{events: make(chan status.Event)})

	var b strings.Builder
	b.WriteString("Dashboard — the detail pane follows the cursor\n\n")
	b.WriteString(m.View())

	logs := update(m, logMsg(status.LogLine{
		At: at, Level: "warn", Endpoint: "qwen25-72b",
		Message: "verdict deny: the published evidenceDigest is not pinned",
	}))
	logs = update(logs, logMsg(status.LogLine{
		At: at, Level: "info", Endpoint: "llama-33-70b", Message: "re-attested: admitted",
	}))
	logs = press(t, logs, "l")
	b.WriteString("\n\nThe log tail, on `l`\n\n")
	b.WriteString(logs.View())
	b.WriteString("\n")

	if err := os.WriteFile("testdata/dashboard.txt", []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}
