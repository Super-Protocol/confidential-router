package status_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func demoConfig(t *testing.T) *config.Config {
	t.Helper()
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
		t.Fatalf("parsing the demo config: %v", err)
	}
	return cfg
}

func TestDemoReflectsTheRealConfig(t *testing.T) {
	demo := status.NewDemo(demoConfig(t))
	snapshot := demo.Snapshot(t.Context())

	if len(snapshot.Endpoints) != 2 {
		t.Fatalf("endpoints = %d, want 2", len(snapshot.Endpoints))
	}
	// Names, addresses and fail modes are the user's; only the state is
	// invented.
	if snapshot.Endpoints[0].Name != "llama-33-70b" || snapshot.Endpoints[0].Listen != "127.0.0.1:8443" {
		t.Errorf("endpoint = %+v, want the configured one", snapshot.Endpoints[0])
	}
	if snapshot.Endpoints[1].FailMode != config.FailOpen {
		t.Errorf("fail mode = %q, want the configured one", snapshot.Endpoints[1].FailMode)
	}
	for _, ep := range snapshot.Endpoints {
		if ep.Health != status.Attesting {
			t.Errorf("%s starts as %q, want attesting", ep.Name, ep.Health)
		}
	}
}

func TestDemoMarksEverythingItInvents(t *testing.T) {
	demo := status.NewDemo(demoConfig(t))
	report, err := demo.Verify(t.Context(), status.VerifyRequest{Endpoint: "llama-33-70b"})
	if err != nil {
		t.Fatal(err)
	}
	// Nothing the demo produces may be mistaken for a real verdict.
	if len(report.Warnings) == 0 || !strings.Contains(report.Warnings[0], "DEMO DATA") {
		t.Errorf("warnings = %v, want the report labelled as invented", report.Warnings)
	}
}

func TestDemoIsReproducible(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return at }

	first := status.NewDemo(demoConfig(t)).WithClock(clock)
	second := status.NewDemo(demoConfig(t)).WithClock(clock)
	for range 6 {
		if _, err := first.Reattest(t.Context(), "llama-33-70b"); err != nil {
			t.Fatal(err)
		}
		if _, err := second.Reattest(t.Context(), "llama-33-70b"); err != nil {
			t.Fatal(err)
		}
	}
	// Two demos of the same age must show the same screen, or the dashboard
	// cannot be screenshotted or asserted on.
	a, b := first.Snapshot(t.Context()), second.Snapshot(t.Context())
	if len(a.Endpoints) != len(b.Endpoints) {
		t.Fatal("the two demos disagree on how many endpoints there are")
	}
	for i := range a.Endpoints {
		if a.Endpoints[i].Health != b.Endpoints[i].Health {
			t.Errorf("%s: %q vs %q", a.Endpoints[i].Name, a.Endpoints[i].Health, b.Endpoints[i].Health)
		}
		if a.Endpoints[i].PublishedDigest != b.Endpoints[i].PublishedDigest {
			t.Errorf("%s: digests differ between runs", a.Endpoints[i].Name)
		}
	}
}

func TestDemoStartAndStop(t *testing.T) {
	demo := status.NewDemo(demoConfig(t))
	if err := demo.Stop(t.Context(), "llama-33-70b"); err != nil {
		t.Fatal(err)
	}
	ep, _ := demo.Snapshot(t.Context()).Endpoint("llama-33-70b")
	if ep.Health != status.Stopped {
		t.Errorf("health = %q, want stopped", ep.Health)
	}
	if err := demo.Stop(t.Context(), "nope"); err == nil {
		t.Error("stopping an endpoint that does not exist should fail")
	}
}

func TestDemoReloadKeepsProgress(t *testing.T) {
	demo := status.NewDemo(demoConfig(t))
	if _, err := demo.Reattest(t.Context(), "llama-33-70b"); err != nil {
		t.Fatal(err)
	}
	before, _ := demo.Snapshot(t.Context()).Endpoint("llama-33-70b")

	if err := demo.Reload(t.Context(), demoConfig(t)); err != nil {
		t.Fatal(err)
	}
	after, _ := demo.Snapshot(t.Context()).Endpoint("llama-33-70b")
	// A SIGHUP must not blink every surviving endpoint back to "attesting".
	if after.Health != before.Health {
		t.Errorf("health after reload = %q, want %q", after.Health, before.Health)
	}
}

func TestDemoEventsPublishSnapshots(t *testing.T) {
	demo := status.NewDemo(demoConfig(t))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	var sawSnapshot, sawLog bool
	for event := range demo.Events(ctx) {
		switch event.Kind {
		case status.EventSnapshot:
			sawSnapshot = true
		case status.EventLog:
			sawLog = true
		}
		if sawSnapshot && sawLog {
			break
		}
	}
	if !sawSnapshot || !sawLog {
		t.Errorf("snapshot=%v log=%v, want both kinds of event", sawSnapshot, sawLog)
	}
}
