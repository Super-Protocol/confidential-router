package tui

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

var fixedNow = time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)

// TestMain forces colour off. The dashboard's styling is adaptive, so a test
// that rendered it would otherwise depend on the terminal the suite happens to
// run in.
func TestMain(m *testing.M) {
	lipgloss.SetColorProfile(termenv.Ascii)
	os.Exit(m.Run())
}

// fakeSupervisor is a supervisor whose whole state the test writes.
type fakeSupervisor struct {
	mu       sync.Mutex
	snapshot status.Snapshot
	events   chan status.Event

	started  []string
	stopped  []string
	reattest []string

	reattestReport *status.Report
	reattestErr    error
	startErr       error
}

func newFakeSupervisor(endpoints ...status.Endpoint) *fakeSupervisor {
	return &fakeSupervisor{
		snapshot: status.Snapshot{At: fixedNow, Endpoints: endpoints},
		events:   make(chan status.Event, 8),
	}
}

func (f *fakeSupervisor) Snapshot(context.Context) status.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshot
}

func (f *fakeSupervisor) Events(context.Context) <-chan status.Event { return f.events }

func (f *fakeSupervisor) Start(_ context.Context, endpoint string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, endpoint)
	return f.startErr
}

func (f *fakeSupervisor) Stop(_ context.Context, endpoint string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, endpoint)
	return nil
}

func (f *fakeSupervisor) Reattest(_ context.Context, endpoint string) (*status.Report, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reattest = append(f.reattest, endpoint)
	return f.reattestReport, f.reattestErr
}

// newModel builds a dashboard already sized and populated, which is the state
// every interaction test is about.
func newModel(t *testing.T, supervisor status.Supervisor, opts ...func(*Options)) Model {
	t.Helper()
	options := Options{
		Supervisor: supervisor,
		ConfigPath: "/home/u/.config/confidential-gatekeeper/config.yaml",
		Now:        func() time.Time { return fixedNow },
	}
	for _, apply := range opts {
		apply(&options)
	}
	m := New(options)
	m = update(m, tea.WindowSizeMsg{Width: 120, Height: 40})
	return update(m, snapshotMsg(supervisor.Snapshot(context.Background())))
}

// update applies one message and returns the new model, dropping the command.
func update(m Model, msg tea.Msg) Model {
	next, _ := m.Update(msg)
	return next.(Model)
}

// key builds a KeyMsg for a single character or a named key.
func keyMsg(k string) tea.KeyMsg {
	switch k {
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
}

// press applies a key and runs whatever command it produced, feeding the
// resulting message back in — which is how bubbletea's runtime would behave.
func press(t *testing.T, m Model, key string) Model {
	t.Helper()
	next, cmd := m.Update(keyMsg(key))
	m = next.(Model)
	if cmd == nil {
		return m
	}
	if msg := cmd(); msg != nil {
		m = update(m, msg)
	}
	return m
}

func confidentialEndpoint(name string) status.Endpoint {
	return status.Endpoint{
		Name: name, Listen: "127.0.0.1:8443", Upstream: "https://" + name + ".tee.swarm.cloud",
		FailMode: "closed", Health: status.Confidential,
		LastAttestAt: fixedNow.Add(-45 * time.Second), NextAttestAt: fixedNow.Add(4 * time.Minute),
		RequestsPerSecond: 3.5, BytesIn: 4096, BytesOut: 65536,
		PublishedDigest: "sha256/SwSl8nkqLsNHn9rsW7Dfek9mGTeDePm8MsHPQ3Z-490",
		Report: &status.Report{
			Endpoint: name, Hostname: name + ".tee.swarm.cloud", CheckedAt: fixedNow.Add(-45 * time.Second),
			Verified: true, Admitted: true, Pinned: true,
			Root:                   "swarm-cloud-prod",
			RootFingerprint:        "sha256/4rDDqk4QaXWLKrWi1GJt1yqZaFoZmQGxU6HcvHAGdKQ",
			ObservedTLSFingerprint: "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0",
			CertFingerprint:        "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0",
			EvidenceDigest:         "sha256/SwSl8nkqLsNHn9rsW7Dfek9mGTeDePm8MsHPQ3Z-490",
			Images:                 []string{"ghcr.io/super-protocol/vllm@sha256:aaaa"},
			Chain: []status.Certificate{
				{Subject: "CN=" + name + ".tee.swarm.cloud", Fingerprint: "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0"},
				{Subject: "CN=swarm-cloud-prod-root", Fingerprint: "sha256/4rDDqk4QaXWLKrWi1GJt1yqZaFoZmQGxU6HcvHAGdKQ", Root: true},
			},
			Policies: []status.PolicyResult{{Package: "gatekeeper.default", Allow: true}},
		},
	}
}

// withStore attaches a real, writable trust store to the dashboard, so the
// keys that edit the configuration take the path they would in production.
func withStore(t *testing.T) func(*Options) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	pem, err := os.ReadFile("testdata/root.pem")
	if err != nil {
		t.Fatalf("reading the test root: %v", err)
	}
	document := "version: 1\ntrustedRoots:\n  - name: swarm-cloud-prod\n    pem: |\n" +
		indentPEM(string(pem)) +
		"endpoints:\n  - name: llama-33-70b\n    listen: 127.0.0.1:8443\n" +
		"    upstream: https://llama-33-70b.tee.swarm.cloud\n    trustedEvidence:\n" +
		"      - sha256/SwSl8nkqLsNHn9rsW7Dfek9mGTeDePm8MsHPQ3Z-490\n"
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := trust.Open(path)
	if err != nil {
		t.Fatalf("opening the trust store: %v", err)
	}
	return func(o *Options) { o.Store = store }
}

func indentPEM(pem string) string {
	var b strings.Builder
	for _, line := range strings.Split(strings.TrimRight(pem, "\n"), "\n") {
		b.WriteString("      " + line + "\n")
	}
	return b.String()
}
