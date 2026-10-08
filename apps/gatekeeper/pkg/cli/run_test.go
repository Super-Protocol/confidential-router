package cli_test

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func TestRunHandsTheDashboardWhatItNeeds(t *testing.T) {
	h := configured(t)
	supervisor := &fakeSupervisor{snapshot: liveSnapshot()}
	h.env.Supervisor = supervisor

	var handed cli.DashboardOptions
	h.env.RunDashboard = func(_ context.Context, opts cli.DashboardOptions) error {
		handed = opts
		return nil
	}

	h.mustRun("run")
	if handed.Supervisor != status.Supervisor(supervisor) {
		t.Error("the dashboard was not given the running supervisor")
	}
	if handed.Store == nil {
		t.Error("the dashboard was not given a writable trust store, so `trust this deployment` cannot work")
	}
	if !strings.HasSuffix(handed.ConfigPath, "config.yaml") {
		t.Errorf("ConfigPath = %q, want the config this run is about", handed.ConfigPath)
	}
	if handed.Endpoints != 1 {
		t.Errorf("Endpoints = %d, want 1", handed.Endpoints)
	}
}

func TestRunDrainsOnShutdown(t *testing.T) {
	h := configured(t)
	supervisor := &fakeSupervisor{snapshot: liveSnapshot()}
	h.env.Supervisor = supervisor
	h.env.RunDashboard = func(ctx context.Context, _ cli.DashboardOptions) error {
		<-ctx.Done()
		return ctx.Err()
	}

	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()

	got := h.runCtx(ctx, "run")
	if got.code != cli.ExitOK {
		t.Fatalf("exit = %d, want a clean shutdown (stderr: %s)", got.code, got.stderr)
	}
	// Every configured endpoint is drained, not just the ones that happened to
	// be running.
	if len(supervisor.stopped) != 1 || supervisor.stopped[0] != "llama-33-70b" {
		t.Errorf("stopped = %v, want every endpoint drained", supervisor.stopped)
	}
	if !strings.Contains(got.stderr, "gatekeeper stopped") {
		t.Errorf("stderr = %q, want the shutdown reported", got.stderr)
	}
}

func TestRunDemoIsLoudAboutBeingFake(t *testing.T) {
	h := configured(t)

	ctx, cancel := context.WithTimeout(t.Context(), 1200*time.Millisecond)
	defer cancel()

	got := h.runCtx(ctx, "run", "--demo", "--headless")
	if got.code != cli.ExitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", got.code, cli.ExitOK, got.stderr)
	}
	if !strings.Contains(got.stderr, "every verdict on screen is invented") {
		t.Errorf("stderr = %q, want an unmissable warning", got.stderr)
	}
	// Headless is the container/systemd shape: log lines on stdout, nothing else.
	if !strings.Contains(got.stdout, "llama-33-70b") {
		t.Errorf("stdout = %q, want the endpoint's log lines", got.stdout)
	}
}

func TestRunDemoCannotWriteToTheRealConfig(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}

	var handed cli.DashboardOptions
	h.env.RunDashboard = func(_ context.Context, opts cli.DashboardOptions) error {
		handed = opts
		return nil
	}

	// Everything --demo shows is invented, so the keys that pin a digest or add
	// a root must have nothing to write through: otherwise a demo run could put
	// fiction into a real trust configuration.
	h.mustRun("run", "--demo")
	if handed.Store != nil {
		t.Error("the demo dashboard was given a writable trust store")
	}

	// Without --demo it gets one, or `trust this deployment` could never work.
	h.mustRun("run")
	if handed.Store == nil {
		t.Error("a real run was not given a writable trust store")
	}
}

func TestRunRejectsANonPositiveDrainTimeout(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}
	h.env.RunDashboard = func(context.Context, cli.DashboardOptions) error { return nil }

	// A zero deadline would make the drain context expire before it was used,
	// so nothing would drain and the flag would look like it worked.
	got := h.run("run", "--drain-timeout", "0")
	if got.code != cli.ExitUsage {
		t.Errorf("exit = %d, want %d (stderr: %s)", got.code, cli.ExitUsage, got.stderr)
	}
}

func TestRunDrainsEvenWhenTheDashboardFails(t *testing.T) {
	h := configured(t)
	supervisor := &fakeSupervisor{snapshot: liveSnapshot()}
	h.env.Supervisor = supervisor
	h.env.RunDashboard = func(context.Context, cli.DashboardOptions) error {
		return errors.New("the terminal went away")
	}

	got := h.run("run")
	if got.code != cli.ExitError {
		t.Fatalf("exit = %d, want the failure reported", got.code)
	}
	// Listeners must not be left bound because the UI fell over.
	if len(supervisor.stopped) != 1 {
		t.Errorf("stopped = %v, want every endpoint drained anyway", supervisor.stopped)
	}
}

// reloadableSupervisor is a [fakeSupervisor] that also records what a SIGHUP
// handed it, so a test can assert on the configuration that was applied rather
// than on a log line.
type reloadableSupervisor struct {
	fakeSupervisor
	reloaded chan *config.Config
}

func (r *reloadableSupervisor) Reload(_ context.Context, cfg *config.Config) error {
	r.reloaded <- cfg
	return nil
}

// A control loop renders this file (ADR-008 §5), and a render that admits
// nothing is an instruction, not a mistake: an admin has withdrawn their last
// trusted cloud, or unregistered their last external endpoint. Refusing to
// apply it would keep the listeners and the verdicts that are being revoked
// running — fail-open, out of caution. Startup still refuses an incomplete
// configuration, which is where that rule helps a person.
func TestSighupAppliesAConfigurationThatAdmitsNothing(t *testing.T) {
	h := configured(t)
	supervisor := &reloadableSupervisor{
		fakeSupervisor: fakeSupervisor{snapshot: liveSnapshot()},
		reloaded:       make(chan *config.Config, 1),
	}
	h.env.Supervisor = supervisor
	up := make(chan struct{})
	h.env.RunDashboard = func(ctx context.Context, _ cli.DashboardOptions) error {
		close(up)
		<-ctx.Done()
		return ctx.Err()
	}

	// SIGHUP's default disposition kills a process, and `run` only installs its
	// handler once it is up. A registration of this test's own closes that
	// window, and the signal is then sent until the handler answers.
	guard := make(chan os.Signal, 8)
	signal.Notify(guard, syscall.SIGHUP)
	defer signal.Stop(guard)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	done := make(chan result, 1)
	go func() { done <- h.runCtx(ctx, "run") }()
	select {
	case <-up:
	case <-ctx.Done():
		t.Fatalf("run never started: %s", (<-done).stderr)
	}

	// The configuration the loop renders next: no endpoints at all, which
	// `Validate` calls incomplete and the gatekeeper has to apply anyway.
	writeFile(t, h.configPath, "version: 1\ntrustedRoots: []\nendpoints: []\n")

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for applied := false; !applied; {
		if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
			t.Fatalf("sending SIGHUP: %v", err)
		}
		select {
		case cfg := <-supervisor.reloaded:
			if len(cfg.Endpoints) != 0 {
				t.Errorf("the reload applied %d endpoint(s), want the empty rendering", len(cfg.Endpoints))
			}
			applied = true
		case <-ticker.C:
		case <-ctx.Done():
			cancel()
			t.Fatalf("SIGHUP never reached the supervisor: %s", (<-done).stderr)
		}
	}

	cancel()
	if got := <-done; got.code != cli.ExitOK {
		t.Fatalf("exit = %d (stderr: %s)", got.code, got.stderr)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}
